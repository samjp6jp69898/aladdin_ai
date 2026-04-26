#!/usr/bin/env bun
/**
 * deadlock-scanner.ts — Static deadlock risk analyzer for agrabah codebase.
 *
 * Subcommands:
 *   table-locate <server> <tableName>
 *   scan-transactions <server> <tableName> <dbClassesJson>
 *   cross-compare <transactionsJsonFile>
 */

import { readFileSync, existsSync } from "fs";
import { join, relative } from "path";

const ALADDIN_ROOT = "/Users/user/aladdin";
const AGRABAH = join(ALADDIN_ROOT, "agrabah");
const SERVERS_DIR = join(AGRABAH, "src/servers");
const MANAGERS_DIR = join(AGRABAH, "src/managers");
const DB_TYPES_DIR = join(AGRABAH, "src/database_types");

// ─── Shared Utilities ───

function grep(pattern: string, paths: string[], opts: string = ""): string[] {
  const validPaths = paths.filter(p => existsSync(p));
  if (validPaths.length === 0) return [];
  try {
    const args = ["-rn", ...opts.split(" ").filter(Boolean), "-e", pattern, ...validPaths, "--include=*.ts"];
    const result = Bun.spawnSync(["grep", ...args], { stdout: "pipe", stderr: "pipe" });
    const out = result.stdout.toString().trim();
    return out ? out.split("\n") : [];
  } catch {
    return [];
  }
}

function readLines(file: string): string[] {
  try {
    return readFileSync(file, "utf-8").split("\n");
  } catch {
    return [];
  }
}

function isCommentOrImport(line: string): boolean {
  const trimmed = line.trim();
  return (
    trimmed.startsWith("//") ||
    trimmed.startsWith("*") ||
    trimmed.startsWith("/*") ||
    trimmed.startsWith("import ") ||
    trimmed.startsWith("import{") ||
    trimmed.startsWith("export {") ||
    trimmed.startsWith("export type") ||
    trimmed.startsWith("export interface")
  );
}

interface GrepHit {
  file: string;
  line: number;
  content: string;
}

function parseGrepLine(raw: string): GrepHit | null {
  const m = raw.match(/^(.+?):(\d+):(.*)$/);
  if (!m) return null;
  return { file: m[1], line: parseInt(m[2]), content: m[3] };
}

function relPath(absPath: string): string {
  return relative(AGRABAH, absPath);
}

function extractClassAtLine(file: string, line: number): string | null {
  const lines = readLines(file);
  for (let i = line - 1; i >= 0; i--) {
    const m = lines[i].match(/(?:export\s+)?class\s+(\w+)/);
    if (m) return m[1];
  }
  const basename = file.split("/").pop()?.replace(/\.ts$/, "") || null;
  return basename;
}

function extractMethodAtLine(file: string, line: number): string | null {
  const lines = readLines(file);
  const controlKeywords = new Set(["if", "for", "while", "switch", "catch", "else", "return", "throw", "const", "let", "var", "new", "await", "yield"]);
  for (let i = line - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (isCommentOrImport(trimmed)) continue;
    const m = trimmed.match(/^(?:(?:private|public|protected|static|override)\s+)*(?:async\s+)?(\w+)\s*[\(<]/);
    if (m) {
      const name = m[1];
      if (controlKeywords.has(name)) continue;
      if (name === "class" || name === "function" || name === "constructor") {
        if (name === "constructor") return "constructor";
        continue;
      }
      return name;
    }
    const funcMatch = trimmed.match(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(/);
    if (funcMatch) return funcMatch[1];
    if (trimmed.match(/^(?:export\s+)?class\s+/)) break;
  }
  return null;
}

// ─── Build global DbClass → tableName lookup ───

interface DbClassEntry {
  name: string;
  tableName: string;
  file: string;
}

function buildDbClassMap(): Map<string, DbClassEntry> {
  const map = new Map<string, DbClassEntry>();
  const hits = grep("static.*tableName = '", [DB_TYPES_DIR]);
  for (const raw of hits) {
    const hit = parseGrepLine(raw);
    if (!hit) continue;
    const tnMatch = hit.content.match(/tableName\s*=\s*'([^']+)'/);
    if (!tnMatch) continue;
    const className = extractClassAtLine(hit.file, hit.line);
    if (className) {
      map.set(className, { name: className, tableName: tnMatch[1], file: relPath(hit.file) });
    }
  }
  // Also find inheritance-linked classes
  for (const [, entry] of [...map]) {
    const inheritHits = grep(`tableName = ${entry.name}.tableName`, [DB_TYPES_DIR]);
    for (const raw of inheritHits) {
      const hit = parseGrepLine(raw);
      if (!hit) continue;
      const cn = extractClassAtLine(hit.file, hit.line);
      if (cn && !map.has(cn)) {
        map.set(cn, { name: cn, tableName: entry.tableName, file: relPath(hit.file) });
      }
    }
  }
  return map;
}

// ─── Subcommand: table-locate ───

function tableLocate(server: string, tableName: string) {
  let hits = grep(`static.*tableName = '${tableName}'`, [DB_TYPES_DIR]);
  let parsed = hits.map(parseGrepLine).filter(Boolean) as GrepHit[];

  if (parsed.length === 0) {
    hits = grep(`= '${tableName}'`, [DB_TYPES_DIR]);
    parsed = hits.map(parseGrepLine).filter(Boolean) as GrepHit[];
  }

  if (parsed.length === 0) {
    const snake = tableName.replace(/([A-Z])/g, "_$1").toLowerCase().replace(/^_/, "");
    hits = grep(`static.*tableName = '${snake}`, [DB_TYPES_DIR]);
    parsed = hits.map(parseGrepLine).filter(Boolean) as GrepHit[];
  }

  const dbClasses: { name: string; file: string; line: number; tableName: string }[] = [];
  for (const hit of parsed) {
    const className = extractClassAtLine(hit.file, hit.line);
    if (className) {
      const tnMatch = hit.content.match(/tableName\s*=\s*'([^']+)'/);
      dbClasses.push({
        name: className,
        file: relPath(hit.file),
        line: hit.line,
        tableName: tnMatch ? tnMatch[1] : tableName,
      });
    }
  }

  for (const dc of [...dbClasses]) {
    const inheritHits = grep(`tableName = ${dc.name}.tableName`, [DB_TYPES_DIR]);
    for (const raw of inheritHits) {
      const hit = parseGrepLine(raw);
      if (!hit) continue;
      const cn = extractClassAtLine(hit.file, hit.line);
      if (cn && !dbClasses.some(d => d.name === cn)) {
        dbClasses.push({ name: cn, file: relPath(hit.file), line: hit.line, tableName: dc.tableName });
      }
    }
  }

  console.log(JSON.stringify({
    tableName: dbClasses.length > 0 ? dbClasses[0].tableName : tableName,
    dbClasses,
    server,
  }));
}

// ─── Lock Classification ───

type LockType =
  | "ROW_X"             // FOR UPDATE with single-row WHERE (id = ?)
  | "RANGE_X"           // FOR UPDATE with range/multi-value WHERE
  | "INSERT_INTENTION"  // INSERT / insertObject
  | "ROW_X_UPDATE"      // UPDATE with single-row WHERE
  | "RANGE_X_UPDATE"    // UPDATE with range WHERE
  | "ROW_X_DELETE"      // DELETE with single-row WHERE
  | "RANGE_X_DELETE"    // DELETE with range WHERE
  | "NO_LOCK"           // plain SELECT / loadObject without FOR UPDATE
  | "UNKNOWN";

function isSingleRowCondition(condition: string): boolean {
  const trimmed = condition.trim();
  // id = ? or pk = ? pattern (single equality on likely-unique column)
  if (/^\s*id\s*=\s*\?/i.test(trimmed)) return true;
  // Multiple ANDed equalities with id: `id = ? AND version = ?`
  if (/\bid\s*=\s*\?/i.test(trimmed) && !/\bIN\s*\(/i.test(trimmed) && !/[<>]/i.test(trimmed) && !/BETWEEN/i.test(trimmed)) return true;
  return false;
}

function isRangeCondition(condition: string): boolean {
  if (/\bIN\s*\(/i.test(condition)) return true;
  if (/[<>]/.test(condition)) return true;
  if (/\bBETWEEN\b/i.test(condition)) return true;
  if (/\bLIKE\b/i.test(condition)) return true;
  return false;
}

function classifyLock(operation: string, content: string, condition: string | null): LockType {
  const upper = content.toUpperCase();

  // FOR UPDATE operations
  if (upper.includes("FOR UPDATE")) {
    if (condition && isSingleRowCondition(condition)) return "ROW_X";
    if (condition && isRangeCondition(condition)) return "RANGE_X";
    if (condition && /\bid\s*=\s*\?/i.test(condition)) return "ROW_X";
    return condition ? "ROW_X" : "RANGE_X"; // no condition = table scan = range
  }

  // INSERT
  if (operation === "insertObject" || operation === "insertObjects" || /INSERT\s+INTO/i.test(content)) {
    return "INSERT_INTENTION";
  }

  // UPDATE SQL
  if (/UPDATE\s+/i.test(content) && /SET\s+/i.test(content)) {
    if (condition && isSingleRowCondition(condition)) return "ROW_X_UPDATE";
    if (condition && isRangeCondition(condition)) return "RANGE_X_UPDATE";
    if (condition) return "ROW_X_UPDATE"; // default to row if has condition
    return "RANGE_X_UPDATE"; // no WHERE = full table
  }
  if (operation === "updateObject") {
    return "ROW_X_UPDATE"; // updateObject uses id
  }

  // DELETE SQL
  if (/DELETE\s+FROM/i.test(content)) {
    if (condition && isSingleRowCondition(condition)) return "ROW_X_DELETE";
    if (condition && isRangeCondition(condition)) return "RANGE_X_DELETE";
    if (condition) return "ROW_X_DELETE";
    return "RANGE_X_DELETE";
  }

  // Plain read
  if (operation === "loadObject" || operation === "loadObjects" || operation === "count" || /^SELECT/i.test(content.trim())) {
    return "NO_LOCK";
  }

  return "UNKNOWN";
}

// ─── Subcommand: scan-transactions ───

interface TableOperation {
  line: number;
  table: string;
  dbClass: string | null;
  operation: string;
  lockType: LockType;
  rawContent: string;
  condition: string | null;
}

interface TransactionScope {
  id: string;
  file: string;
  startLine: number;
  endLine: number;
  ownerClass: string | null;
  ownerMethod: string | null;
  dbSource: string;
  operations: TableOperation[];
  lockedTables: string[];
}

interface NeedsVerification {
  txId: string;
  file: string;
  line: number;
  reason: string;
  content: string;
}

function findTransactionScopeEnd(lines: string[], startLineIdx: number): number {
  let depth = 0;
  let foundOpen = false;
  for (let i = startLineIdx; i < lines.length; i++) {
    const line = lines[i];
    for (const ch of line) {
      if (ch === '{') {
        depth++;
        foundOpen = true;
      } else if (ch === '}') {
        depth--;
        if (foundOpen && depth === 0) {
          return i;
        }
      }
    }
  }
  return Math.min(startLineIdx + 200, lines.length - 1);
}

function extractConditionFromArgs(content: string): string | null {
  // loadObject(DbClass, 'condition', [...])
  const loadMatch = content.match(/loadObjects?\s*\(\s*\w+\s*,\s*(?:'([^']*)'|`([^`]*)`|"([^"]*)")/);
  if (loadMatch) return loadMatch[1] || loadMatch[2] || loadMatch[3] || null;

  // Raw SQL: WHERE ...
  const whereMatch = content.match(/WHERE\s+(.+?)(?:['"`]|$)/i);
  if (whereMatch) return whereMatch[1].trim();

  // UPDATE ... SET ... WHERE ...
  const updateWhereMatch = content.match(/WHERE\s+(.+?)(?:\s*['"`]|\s*\)|\s*$)/i);
  if (updateWhereMatch) return updateWhereMatch[1].trim();

  return null;
}

function extractDbSource(line: string): string {
  if (line.includes("context.engines.getRelationalDatabase(")) {
    const m = line.match(/getRelationalDatabase\(([^)]+)\)/);
    return m ? `getRelationalDatabase(${m[1].trim()})` : "getRelationalDatabase(?)";
  }
  if (line.includes("context.engines.relationalDatabase")) return "context.engines.relationalDatabase";
  if (line.includes("context.relationalDatabase")) return "context.relationalDatabase";
  // Variable-based: extract variable name
  const varMatch = line.match(/(\w+)\.doTransaction/);
  return varMatch ? `${varMatch[1]}.doTransaction` : "unknown";
}

function resolveTableFromDbClass(dbClassName: string, dbClassMap: Map<string, DbClassEntry>): string | null {
  const entry = dbClassMap.get(dbClassName);
  return entry ? entry.tableName : null;
}

function extractOperationsFromScope(
  lines: string[],
  startIdx: number,
  endIdx: number,
  fileAbsPath: string,
  dbClassMap: Map<string, DbClassEntry>,
  targetDbClasses: string[],
  targetTableName: string,
): { operations: TableOperation[]; needsVerify: NeedsVerification[]; txId: string } {
  const operations: TableOperation[] = [];
  const needsVerify: NeedsVerification[] = [];
  const txId = `${relPath(fileAbsPath)}:${startIdx + 1}`;
  const seenLines = new Set<number>();

  // Collect all known Db class names for matching
  const allDbClassNames = [...dbClassMap.keys()];

  for (let i = startIdx; i <= endIdx; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    const lineNum = i + 1;

    if (isCommentOrImport(trimmed)) continue;
    if (seenLines.has(lineNum)) continue;

    // --- Detect ORM operations ---

    // transaction.loadObject(DbXxx, ...)  or  transaction.loadObjects(DbXxx, ...)
    const loadMatch = trimmed.match(/(loadObjects?)\s*\(\s*(Db\w+)/);
    if (loadMatch) {
      seenLines.add(lineNum);
      const operation = loadMatch[1];
      const dbClass = loadMatch[2];
      const table = resolveTableFromDbClass(dbClass, dbClassMap);
      if (table) {
        const condition = extractConditionFromArgs(trimmed);
        const lockType = classifyLock(operation, trimmed, condition);
        operations.push({ line: lineNum, table, dbClass, operation, lockType, rawContent: trimmed, condition });
      }
      continue;
    }

    // transaction.insertObject(...)  or  transaction.insertObjects(...)
    const insertObjMatch = trimmed.match(/(insertObjects?)\s*\(/);
    if (insertObjMatch) {
      seenLines.add(lineNum);
      const operation = insertObjMatch[1];
      // Try to find what's being inserted - look for variable type or new DbXxx above
      let dbClass: string | null = null;
      let table: string | null = null;
      // Check argument: insertObject(dbSomething) - look backwards for its type
      const argMatch = trimmed.match(/insertObjects?\s*\(\s*(\w+)/);
      if (argMatch) {
        const varName = argMatch[1];
        // Search backwards for `new DbXxx` or type annotation
        for (let j = i - 1; j >= Math.max(startIdx, i - 30); j--) {
          const prev = lines[j].trim();
          // new DbXxx()
          const newMatch = prev.match(new RegExp(`${varName}\\s*[=:].*new\\s+(Db\\w+)`));
          if (newMatch) { dbClass = newMatch[1]; break; }
          // const varName: DbXxx  or  const varName = new DbXxx
          const typeMatch = prev.match(new RegExp(`(?:const|let|var)\\s+${varName}\\s*(?::\\s*(Db\\w+)|.*new\\s+(Db\\w+))`));
          if (typeMatch) { dbClass = typeMatch[1] || typeMatch[2]; break; }
          // Also direct: new DbXxx() as argument
          if (prev.includes(`new ${varName}`) && varName.startsWith("Db")) { dbClass = varName; break; }
        }
        // Also check if argument itself is `new DbXxx(...)`
        const inlineNewMatch = trimmed.match(/insertObjects?\s*\(\s*new\s+(Db\w+)/);
        if (inlineNewMatch) dbClass = inlineNewMatch[1];

        // Check if argument starts with Db (it's already the class name)
        if (!dbClass && varName.startsWith("Db")) dbClass = varName;
      }
      if (dbClass) table = resolveTableFromDbClass(dbClass, dbClassMap);
      if (table) {
        operations.push({ line: lineNum, table, dbClass, operation, lockType: "INSERT_INTENTION", rawContent: trimmed, condition: null });
      } else {
        needsVerify.push({ txId, file: relPath(fileAbsPath), line: lineNum, reason: "cannot resolve inserted DbClass", content: trimmed });
      }
      continue;
    }

    // transaction.updateObject(...)
    const updateObjMatch = trimmed.match(/updateObject\s*\(/);
    if (updateObjMatch) {
      seenLines.add(lineNum);
      let dbClass: string | null = null;
      let table: string | null = null;
      const argMatch = trimmed.match(/updateObject\s*\(\s*(\w+)/);
      if (argMatch) {
        const varName = argMatch[1];
        for (let j = i - 1; j >= Math.max(startIdx, i - 30); j--) {
          const prev = lines[j].trim();
          const newMatch = prev.match(new RegExp(`${varName}\\s*[=:].*new\\s+(Db\\w+)`));
          if (newMatch) { dbClass = newMatch[1]; break; }
          const typeMatch = prev.match(new RegExp(`(?:const|let|var)\\s+${varName}\\s*(?::\\s*(Db\\w+)|.*new\\s+(Db\\w+))`));
          if (typeMatch) { dbClass = typeMatch[1] || typeMatch[2]; break; }
          // loadObject result
          const loadResultMatch = prev.match(new RegExp(`${varName}\\s*=.*loadObjects?\\s*\\(\\s*(Db\\w+)`));
          if (loadResultMatch) { dbClass = loadResultMatch[1]; break; }
          // .data pattern: const xxx = result.data (look further for loadObject)
          if (prev.includes(`${varName} =`) && prev.includes(".data")) {
            const resultVarMatch = prev.match(/(\w+)\.data/);
            if (resultVarMatch) {
              for (let k = j - 1; k >= Math.max(startIdx, j - 10); k--) {
                const prevPrev = lines[k].trim();
                const resultLoadMatch = prevPrev.match(new RegExp(`${resultVarMatch[1]}.*loadObjects?\\s*\\(\\s*(Db\\w+)`));
                if (resultLoadMatch) { dbClass = resultLoadMatch[1]; break; }
              }
            }
          }
        }
        if (!dbClass && argMatch[1].startsWith("Db")) dbClass = argMatch[1];
      }
      if (dbClass) table = resolveTableFromDbClass(dbClass, dbClassMap);
      if (table) {
        operations.push({ line: lineNum, table, dbClass, operation: "updateObject", lockType: "ROW_X_UPDATE", rawContent: trimmed, condition: "id = ? (ORM)" });
      } else {
        needsVerify.push({ txId, file: relPath(fileAbsPath), line: lineNum, reason: "cannot resolve updated DbClass", content: trimmed });
      }
      continue;
    }

    // --- Detect raw SQL operations ---

    // transaction.update('...')  or  transaction.query('...')  — single-line or multi-line
    const hasUpdateOrQuery = /\.update\s*\(/.test(trimmed) || /\.query\s*\(/.test(trimmed);
    if (hasUpdateOrQuery && !seenLines.has(lineNum)) {
      // Try single-line match first
      let rawSqlMatch = trimmed.match(/(?:\.update|\.query)\s*\(\s*(?:'([^']*)'|`([^`]*)`|"([^"]*)")/);
      let sql: string | null = rawSqlMatch ? (rawSqlMatch[1] || rawSqlMatch[2] || rawSqlMatch[3] || null) : null;
      let multiLineUsed = false;

      // If no SQL on same line, look at next few lines (multi-line call)
      if (!sql && /\.(?:update|query)\s*\(\s*$/.test(trimmed)) {
        for (let k = i + 1; k <= Math.min(i + 5, endIdx); k++) {
          const nextLine = lines[k].trim();
          const nextMatch = nextLine.match(/^(?:'([^']*)'|`([^`]*)`|"([^"]*)")/);
          if (nextMatch) {
            sql = nextMatch[1] || nextMatch[2] || nextMatch[3] || null;
            multiLineUsed = true;
            break;
          }
          if (nextLine.length > 0 && !nextLine.startsWith("//")) break;
        }
      }

      if (sql) {
        // Skip non-DML
        if (/^(START|COMMIT|ROLLBACK|SET|SHOW|DESCRIBE)/i.test(sql.trim())) continue;

        seenLines.add(lineNum);

        let table: string | null = null;
        let dbClass: string | null = null;

        // Extract table name from SQL
        const updateTableMatch = sql.match(/UPDATE\s+(?:`?(\w+)`?|\$\{(\w+)\.tableName\})/i);
        const insertTableMatch = sql.match(/INSERT\s+INTO\s+(?:`?(\w+)`?|\$\{(\w+)\.tableName\})/i);
        const deleteTableMatch = sql.match(/DELETE\s+FROM\s+(?:`?(\w+)`?|\$\{(\w+)\.tableName\})/i);
        const selectTableMatch = sql.match(/FROM\s+(?:`?(\w+)`?|\$\{(\w+)\.tableName\})/i);

        const tableMatch = updateTableMatch || insertTableMatch || deleteTableMatch || selectTableMatch;
        if (tableMatch) {
          if (tableMatch[1]) {
            table = tableMatch[1];
          } else if (tableMatch[2]) {
            dbClass = tableMatch[2];
            table = resolveTableFromDbClass(tableMatch[2], dbClassMap);
          }
        }

        // Also check template literal with ${DbXxx.tableName}
        if (!table) {
          const templateMatch = sql.match(/\$\{(Db\w+)\.tableName\}/);
          if (templateMatch) {
            dbClass = templateMatch[1];
            table = resolveTableFromDbClass(templateMatch[1], dbClassMap);
          }
        }

        const upperSql = sql.toUpperCase();
        if (table) {
          let operation = "query";
          if (/UPDATE/i.test(upperSql)) operation = "UPDATE SQL";
          else if (/INSERT/i.test(upperSql)) operation = "INSERT SQL";
          else if (/DELETE/i.test(upperSql)) operation = "DELETE SQL";
          else if (/SELECT/i.test(upperSql)) operation = "SELECT SQL";

          const condition = extractConditionFromArgs(sql);
          const lockType = classifyLock(operation, sql, condition);
          operations.push({ line: lineNum, table, dbClass, operation, lockType, rawContent: trimmed, condition });
        } else if (upperSql.includes("UPDATE") || upperSql.includes("INSERT") || upperSql.includes("DELETE") || upperSql.includes("FOR UPDATE")) {
          needsVerify.push({ txId, file: relPath(fileAbsPath), line: lineNum, reason: "cannot resolve table from raw SQL", content: trimmed });
        }
        continue;
      }
    }

    // Multi-line template literal SQL: look for lines with template strings containing SQL keywords
    if (/\$\{(Db\w+)\.tableName\}/.test(trimmed) && !seenLines.has(lineNum)) {
      seenLines.add(lineNum);
      const templateMatch = trimmed.match(/\$\{(Db\w+)\.tableName\}/);
      if (templateMatch) {
        const dbClass = templateMatch[1];
        const table = resolveTableFromDbClass(dbClass, dbClassMap);
        if (table) {
          // Gather context: up to 5 lines above and below for the full SQL
          const contextStart = Math.max(startIdx, i - 5);
          const contextEnd = Math.min(endIdx, i + 5);
          const contextBlock = lines.slice(contextStart, contextEnd + 1).join(" ");

          let operation = "query";
          if (/UPDATE/i.test(contextBlock)) operation = "UPDATE SQL";
          else if (/INSERT/i.test(contextBlock)) operation = "INSERT SQL";
          else if (/DELETE/i.test(contextBlock)) operation = "DELETE SQL";
          else if (/SELECT/i.test(contextBlock)) operation = "SELECT SQL";

          const condition = extractConditionFromArgs(contextBlock);
          const lockType = classifyLock(operation, contextBlock, condition);
          operations.push({ line: lineNum, table, dbClass, operation, lockType, rawContent: trimmed, condition });
        }
      }
      continue;
    }

    // Detect .update(varName, ...) or .query(varName, ...) where SQL is in a variable
    if ((trimmed.includes(".update(") || trimmed.includes(".query(")) && !seenLines.has(lineNum)) {
      const varSqlMatch = trimmed.match(/\.(?:update|query)\s*\(\s*(\w+)\s*[,)]/);
      if (varSqlMatch && !varSqlMatch[1].startsWith("'") && !varSqlMatch[1].startsWith("`") && !varSqlMatch[1].startsWith('"')) {
        seenLines.add(lineNum);
        const varName = varSqlMatch[1];
        // Search backwards for variable definition: let/const varName = '...' or `...`
        let resolvedSql: string | null = null;
        for (let j = i - 1; j >= Math.max(startIdx, i - 30); j--) {
          const prev = lines[j].trim();
          const defMatch = prev.match(new RegExp(`(?:let|const|var)\\s+${varName}\\s*=\\s*(?:'([^']*)'|\`([^\`]*)\`|"([^"]*)")`));
          if (defMatch) {
            resolvedSql = defMatch[1] || defMatch[2] || defMatch[3] || null;
            break;
          }
        }
        if (resolvedSql) {
          let table: string | null = null;
          let dbClass: string | null = null;
          const updateTableMatch = resolvedSql.match(/UPDATE\s+(?:`?(\w+)`?|\$\{(\w+)\.tableName\})/i);
          const insertTableMatch = resolvedSql.match(/INSERT\s+INTO\s+(?:`?(\w+)`?|\$\{(\w+)\.tableName\})/i);
          const deleteTableMatch = resolvedSql.match(/DELETE\s+FROM\s+(?:`?(\w+)`?|\$\{(\w+)\.tableName\})/i);
          const selectTableMatch = resolvedSql.match(/FROM\s+(?:`?(\w+)`?|\$\{(\w+)\.tableName\})/i);
          const tableMatch = updateTableMatch || insertTableMatch || deleteTableMatch || selectTableMatch;
          if (tableMatch) {
            if (tableMatch[1]) table = tableMatch[1];
            else if (tableMatch[2]) { dbClass = tableMatch[2]; table = resolveTableFromDbClass(tableMatch[2], dbClassMap); }
          }
          if (table) {
            let operation = "query";
            if (/UPDATE/i.test(resolvedSql)) operation = "UPDATE SQL";
            else if (/INSERT/i.test(resolvedSql)) operation = "INSERT SQL";
            else if (/DELETE/i.test(resolvedSql)) operation = "DELETE SQL";
            else if (/SELECT/i.test(resolvedSql)) operation = "SELECT SQL";
            const condition = extractConditionFromArgs(resolvedSql);
            const lockType = classifyLock(operation, resolvedSql, condition);
            operations.push({ line: lineNum, table, dbClass, operation, lockType, rawContent: `${trimmed} /* resolved: ${resolvedSql.substring(0, 80)} */`, condition });
          } else {
            needsVerify.push({ txId, file: relPath(fileAbsPath), line: lineNum, reason: "SQL in variable, resolved but cannot extract table", content: `${trimmed} /* ${resolvedSql.substring(0, 80)} */` });
          }
        } else {
          needsVerify.push({ txId, file: relPath(fileAbsPath), line: lineNum, reason: "SQL in variable, cannot resolve statically", content: trimmed });
        }
      }
    }
  }

  return { operations, needsVerify, txId };
}

function scanTransactions(server: string, tableName: string, dbClassesJson: string) {
  const targetDbClasses: string[] = JSON.parse(dbClassesJson);
  const scope = [join(SERVERS_DIR, server), MANAGERS_DIR];

  // Build global DbClass map
  const dbClassMap = buildDbClassMap();

  // Phase 1: Find all doTransaction call sites
  const txHits = grep("doTransaction", scope);
  const parsedTxHits = txHits.map(parseGrepLine).filter(Boolean) as GrepHit[];

  // Deduplicate by file:line
  const uniqueTxHits = new Map<string, GrepHit>();
  for (const hit of parsedTxHits) {
    if (isCommentOrImport(hit.content)) continue;
    if (hit.file.includes("/generated/")) continue;
    const key = `${hit.file}:${hit.line}`;
    if (!uniqueTxHits.has(key)) uniqueTxHits.set(key, hit);
  }

  const transactions: TransactionScope[] = [];
  const allNeedsVerification: NeedsVerification[] = [];

  // Phase 2 & 3: Parse each transaction scope, filter for target table
  for (const [, hit] of uniqueTxHits) {
    const lines = readLines(hit.file);
    const startIdx = hit.line - 1; // 0-based

    // Find the opening brace of the callback
    let callbackStartIdx = startIdx;
    for (let i = startIdx; i < Math.min(startIdx + 5, lines.length); i++) {
      if (lines[i].includes('{')) {
        callbackStartIdx = i;
        break;
      }
    }

    const endIdx = findTransactionScopeEnd(lines, callbackStartIdx);

    // Check if this scope references the target table
    const scopeBody = lines.slice(callbackStartIdx, endIdx + 1).join("\n");
    let matches = false;

    for (const dc of targetDbClasses) {
      if (scopeBody.includes(dc)) { matches = true; break; }
    }
    if (!matches && scopeBody.includes(tableName)) matches = true;
    if (!matches) {
      // Also check ${DbXxx.tableName} patterns
      for (const dc of targetDbClasses) {
        if (scopeBody.includes(`${dc}.tableName`)) { matches = true; break; }
      }
    }

    if (!matches) continue;

    // Phase 4: Extract all operations in this scope
    const { operations, needsVerify } = extractOperationsFromScope(
      lines, callbackStartIdx, endIdx, hit.file, dbClassMap, targetDbClasses, tableName
    );

    const ownerClass = extractClassAtLine(hit.file, hit.line);
    const ownerMethod = extractMethodAtLine(hit.file, hit.line);
    const dbSource = extractDbSource(hit.content);

    const lockedTables = [...new Set(
      operations
        .filter(op => op.lockType !== "NO_LOCK" && op.lockType !== "UNKNOWN")
        .map(op => op.table)
    )];

    const txScope: TransactionScope = {
      id: `${relPath(hit.file)}:${hit.line}`,
      file: relPath(hit.file),
      startLine: hit.line,
      endLine: endIdx + 1,
      ownerClass,
      ownerMethod,
      dbSource,
      operations,
      lockedTables,
    };

    transactions.push(txScope);
    allNeedsVerification.push(...needsVerify);
  }

  console.log(JSON.stringify({
    tableName,
    targetDbClasses,
    server,
    transactions,
    needsVerification: allNeedsVerification,
    stats: {
      totalDoTransactions: uniqueTxHits.size,
      matchingTransactions: transactions.length,
      totalOperations: transactions.reduce((sum, tx) => sum + tx.operations.length, 0),
      needsVerificationCount: allNeedsVerification.length,
    },
  }));
}

// ─── Subcommand: cross-compare ───

interface RiskPair {
  txA: { id: string; file: string; method: string; startLine: number };
  txB: { id: string; file: string; method: string; startLine: number };
  pattern: "LOCK_ORDER_INVERSION" | "GAP_CONTENTION" | "INSERT_VS_GAP";
  sharedTables: string[];
  detail: string;
  severity: "HIGH" | "MEDIUM" | "LOW";
}

function crossCompare(transactionsJsonFile: string) {
  const raw = readFileSync(transactionsJsonFile, "utf-8");
  const data = JSON.parse(raw);
  const transactions: TransactionScope[] = data.transactions;

  const riskPairs: RiskPair[] = [];

  for (let i = 0; i < transactions.length; i++) {
    for (let j = i + 1; j < transactions.length; j++) {
      const txA = transactions[i];
      const txB = transactions[j];

      const txAInfo = { id: txA.id, file: txA.file, method: `${txA.ownerClass}.${txA.ownerMethod}`, startLine: txA.startLine };
      const txBInfo = { id: txB.id, file: txB.file, method: `${txB.ownerClass}.${txB.ownerMethod}`, startLine: txB.startLine };

      // Find shared locked tables
      const sharedLocked = txA.lockedTables.filter(t => txB.lockedTables.includes(t));

      // Pattern 1: Lock Order Inversion
      if (sharedLocked.length >= 2) {
        // Get lock acquisition order for each transaction (by line number)
        const orderA = getFirstLockOrder(txA.operations, sharedLocked);
        const orderB = getFirstLockOrder(txB.operations, sharedLocked);

        // Check if any pair of tables has reversed order
        for (let x = 0; x < orderA.length; x++) {
          for (let y = x + 1; y < orderA.length; y++) {
            const tableX = orderA[x];
            const tableY = orderA[y];
            const posXinB = orderB.indexOf(tableX);
            const posYinB = orderB.indexOf(tableY);
            if (posXinB >= 0 && posYinB >= 0 && posXinB > posYinB) {
              riskPairs.push({
                txA: txAInfo,
                txB: txBInfo,
                pattern: "LOCK_ORDER_INVERSION",
                sharedTables: [tableX, tableY],
                detail: `TX-A locks: ${tableX} → ${tableY}; TX-B locks: ${tableY} → ${tableX}`,
                severity: "HIGH",
              });
            }
          }
        }
      }

      // Pattern 2: Gap Lock Contention
      for (const table of sharedLocked) {
        const aOps = txA.operations.filter(op => op.table === table);
        const bOps = txB.operations.filter(op => op.table === table);

        const aHasRange = aOps.some(op => op.lockType === "RANGE_X" || op.lockType === "RANGE_X_UPDATE" || op.lockType === "RANGE_X_DELETE");
        const bHasRange = bOps.some(op => op.lockType === "RANGE_X" || op.lockType === "RANGE_X_UPDATE" || op.lockType === "RANGE_X_DELETE");

        if (aHasRange && bHasRange) {
          const aConditions = aOps.filter(op => op.lockType.startsWith("RANGE_")).map(op => `${op.operation} WHERE ${op.condition || '?'} (line ${op.line})`);
          const bConditions = bOps.filter(op => op.lockType.startsWith("RANGE_")).map(op => `${op.operation} WHERE ${op.condition || '?'} (line ${op.line})`);
          riskPairs.push({
            txA: txAInfo,
            txB: txBInfo,
            pattern: "GAP_CONTENTION",
            sharedTables: [table],
            detail: `Both acquire range locks on ${table}.\n  TX-A: ${aConditions.join("; ")}\n  TX-B: ${bConditions.join("; ")}`,
            severity: "MEDIUM",
          });
        }
      }

      // Pattern 3: Insert vs Gap Lock
      for (const table of sharedLocked) {
        const aOps = txA.operations.filter(op => op.table === table);
        const bOps = txB.operations.filter(op => op.table === table);

        const aHasInsert = aOps.some(op => op.lockType === "INSERT_INTENTION");
        const bHasInsert = bOps.some(op => op.lockType === "INSERT_INTENTION");
        const aHasGap = aOps.some(op => op.lockType === "RANGE_X" || op.lockType === "RANGE_X_UPDATE" || op.lockType === "RANGE_X_DELETE");
        const bHasGap = bOps.some(op => op.lockType === "RANGE_X" || op.lockType === "RANGE_X_UPDATE" || op.lockType === "RANGE_X_DELETE");

        if ((aHasInsert && bHasGap) || (bHasInsert && aHasGap)) {
          // Don't duplicate if already flagged as GAP_CONTENTION
          const alreadyFlagged = riskPairs.some(rp =>
            rp.pattern === "GAP_CONTENTION" &&
            rp.sharedTables.includes(table) &&
            ((rp.txA.id === txAInfo.id && rp.txB.id === txBInfo.id) || (rp.txA.id === txBInfo.id && rp.txB.id === txAInfo.id))
          );
          if (!alreadyFlagged) {
            const inserter = aHasInsert ? "TX-A" : "TX-B";
            const gapper = aHasInsert ? "TX-B" : "TX-A";
            riskPairs.push({
              txA: txAInfo,
              txB: txBInfo,
              pattern: "INSERT_VS_GAP",
              sharedTables: [table],
              detail: `${inserter} inserts into ${table}, ${gapper} holds range/gap lock on ${table}`,
              severity: "MEDIUM",
            });
          }
        }
      }
    }
  }

  // Deduplicate risk pairs
  const seen = new Set<string>();
  const uniquePairs = riskPairs.filter(rp => {
    const key = [rp.txA.id, rp.txB.id, rp.pattern, rp.sharedTables.sort().join(",")].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const summary = {
    high: uniquePairs.filter(rp => rp.severity === "HIGH").length,
    medium: uniquePairs.filter(rp => rp.severity === "MEDIUM").length,
    low: uniquePairs.filter(rp => rp.severity === "LOW").length,
  };

  console.log(JSON.stringify({ riskPairs: uniquePairs, summary }));
}

function getFirstLockOrder(operations: TableOperation[], tables: string[]): string[] {
  const firstLockLine = new Map<string, number>();
  for (const op of operations) {
    if (op.lockType === "NO_LOCK" || op.lockType === "UNKNOWN") continue;
    if (!tables.includes(op.table)) continue;
    if (!firstLockLine.has(op.table) || op.line < firstLockLine.get(op.table)!) {
      firstLockLine.set(op.table, op.line);
    }
  }
  return [...firstLockLine.entries()]
    .sort((a, b) => a[1] - b[1])
    .map(([table]) => table);
}

// ─── Main ───

const args = process.argv.slice(2);
const cmd = args[0];

switch (cmd) {
  case "table-locate":
    tableLocate(args[1], args[2]);
    break;
  case "scan-transactions":
    scanTransactions(args[1], args[2], args[3]);
    break;
  case "cross-compare":
    crossCompare(args[1]);
    break;
  default:
    console.error("Available: table-locate, scan-transactions, cross-compare");
    process.exit(1);
}
