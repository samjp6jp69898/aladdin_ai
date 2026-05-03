#!/usr/bin/env bun
/**
 * db-lookup.ts — Look up DB table schema and ORM classes from source.
 *
 * Sources:
 *   /Users/user/aladdin/agrabah/migrations/<domain>/<YYYYMMDDhhmm>_*.sql
 *   /Users/user/aladdin/agrabah/src/database_types/*.ts (ORM class with `static readonly tableName = '...'`)
 *
 * Subcommands:
 *   list-migrations <table>     List every migration file touching <table>, time-ordered
 *   latest-create <table>       Find the most recent CREATE TABLE statement for <table>
 *   table-history <table>       Full timeline: CREATE + every ALTER / INDEX / DROP
 *   table-orm <table>           Find the ORM class(es) that map to <table>, with parent chain
 *   find-table <keyword>        Fuzzy-find tables by keyword in tableName
 *   find-orm <ClassName>        Reverse: given Db class name, find table + file
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { join } from 'path';

// V5: 支援 ALADDIN_ROOT_AT_DATE env 變數
const ALADDIN = process.env.ALADDIN_ROOT_AT_DATE ?? '/Users/user/aladdin';
const MIGRATIONS_DIR = join(ALADDIN, 'agrabah/migrations');
const DB_TYPES_DIR = join(ALADDIN, 'agrabah/src/database_types');

interface MigrationFile {
    file: string;
    domain: string;
    timestamp: string;
    basename: string;
}

function listAllMigrations(): MigrationFile[] {
    const result: MigrationFile[] = [];
    if (!existsSync(MIGRATIONS_DIR)) { return result; }
    for (const domain of readdirSync(MIGRATIONS_DIR)) {
        const domainDir = join(MIGRATIONS_DIR, domain);
        if (!statSync(domainDir).isDirectory()) { continue; }
        for (const f of readdirSync(domainDir)) {
            if (!f.endsWith('.sql')) { continue; }
            const m = f.match(/^(\d{12,14})_/);
            if (!m) { continue; }
            result.push({
                file: join(domainDir, f),
                domain,
                timestamp: m[1],
                basename: f,
            });
        }
    }
    result.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    return result;
}

interface TableHit {
    file: string;
    domain: string;
    timestamp: string;
    basename: string;
    statementKinds: string[];
    matchedLines: { line: number; text: string }[];
}

/**
 * Scan migration content for SQL statements that touch `tableName`.
 * Tries to classify the statement (CREATE / ALTER / DROP / INDEX) for quick triage.
 */
function scanMigration(file: string, tableName: string): { kinds: string[]; matchedLines: { line: number; text: string }[] } {
    const content = readFileSync(file, 'utf-8');
    const lines = content.split('\n');
    const kinds = new Set<string>();
    const matchedLines: { line: number; text: string }[] = [];

    // Word-boundary table match (avoids substring like `app_user_wallets_logs` matching `app_user_wallets`).
    const tableRe = new RegExp(`\\b${ tableName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }\\b`);

    for (let i = 0; i < lines.length; i++) {
        if (!tableRe.test(lines[i])) { continue; }
        const upper = lines[i].toUpperCase();

        // Classify by SQL verb (best-effort — uses preceding lines for multi-line statements).
        let kind: string | null = null;
        if (/CREATE\s+TABLE/.test(upper)) { kind = 'CREATE TABLE'; }
        else if (/CREATE\s+(UNIQUE\s+)?INDEX/.test(upper)) { kind = 'CREATE INDEX'; }
        else if (/DROP\s+INDEX/.test(upper)) { kind = 'DROP INDEX'; }
        else if (/DROP\s+TABLE/.test(upper)) { kind = 'DROP TABLE'; }
        else if (/ALTER\s+TABLE/.test(upper)) { kind = 'ALTER TABLE'; }
        else if (/INSERT\s+INTO/.test(upper)) { kind = 'INSERT'; }
        else if (/UPDATE\s+/.test(upper)) { kind = 'UPDATE'; }
        else {
            // Walk back up to 8 lines to find the start of the statement
            for (let j = i - 1; j >= Math.max(0, i - 8); j--) {
                const u = lines[j].toUpperCase();
                if (/CREATE\s+TABLE/.test(u)) { kind = 'CREATE TABLE'; break; }
                if (/ALTER\s+TABLE/.test(u)) { kind = 'ALTER TABLE'; break; }
                if (/CREATE\s+(UNIQUE\s+)?INDEX/.test(u)) { kind = 'CREATE INDEX'; break; }
                if (/DROP\s+INDEX/.test(u)) { kind = 'DROP INDEX'; break; }
                if (/DROP\s+TABLE/.test(u)) { kind = 'DROP TABLE'; break; }
            }
        }
        if (kind) { kinds.add(kind); }
        matchedLines.push({ line: i + 1, text: lines[i].trim() });
    }

    return { kinds: [ ...kinds ].sort(), matchedLines };
}

function findMigrationsTouching(tableName: string): TableHit[] {
    const all = listAllMigrations();
    const hits: TableHit[] = [];
    for (const m of all) {
        const { kinds, matchedLines } = scanMigration(m.file, tableName);
        if (matchedLines.length === 0) { continue; }
        hits.push({
            file: m.file,
            domain: m.domain,
            timestamp: m.timestamp,
            basename: m.basename,
            statementKinds: kinds,
            matchedLines,
        });
    }
    return hits;
}

// ─── Subcommand: list-migrations ───
function listMigrations(tableName: string) {
    const hits = findMigrationsTouching(tableName);
    console.log(JSON.stringify({
        table: tableName,
        migrationCount: hits.length,
        migrations: hits.map(h => ({
            timestamp: h.timestamp,
            domain: h.domain,
            basename: h.basename,
            file: h.file,
            statementKinds: h.statementKinds,
            matchCount: h.matchedLines.length,
        })),
    }, null, 2));
}

// ─── Subcommand: latest-create ───
function latestCreate(tableName: string) {
    const hits = findMigrationsTouching(tableName);
    const creates = hits.filter(h => h.statementKinds.includes('CREATE TABLE'));
    if (creates.length === 0) {
        console.log(JSON.stringify({ table: tableName, error: 'no CREATE TABLE migration found', searchedMigrations: hits.length }, null, 2));
        return;
    }
    // Pick the latest CREATE TABLE (in case of recreate).
    const latest = creates[creates.length - 1];
    const content = readFileSync(latest.file, 'utf-8');
    // Extract just the CREATE TABLE block
    const createBlock = extractCreateBlock(content, tableName);
    console.log(JSON.stringify({
        table: tableName,
        file: latest.file,
        timestamp: latest.timestamp,
        domain: latest.domain,
        createTableBlock: createBlock,
        warning: hits.length > creates.length
            ? `${ hits.length - creates.length } subsequent ALTER/INDEX migrations exist — use 'table-history' for full timeline.`
            : null,
    }, null, 2));
}

function extractCreateBlock(content: string, tableName: string): string | null {
    const lines = content.split('\n');
    const tableRe = new RegExp(`CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?\`?${ tableName }\\b`, 'i');
    let start = -1;
    for (let i = 0; i < lines.length; i++) {
        if (tableRe.test(lines[i])) { start = i; break; }
    }
    if (start < 0) { return null; }
    // Walk to the end of the statement (semicolon at end of line)
    let end = start;
    for (let i = start; i < lines.length; i++) {
        if (lines[i].trim().endsWith(';')) { end = i; break; }
    }
    return lines.slice(start, end + 1).join('\n');
}

// ─── Subcommand: table-history ───
function tableHistory(tableName: string) {
    const hits = findMigrationsTouching(tableName);
    console.log(JSON.stringify({
        table: tableName,
        timeline: hits.map(h => ({
            timestamp: h.timestamp,
            domain: h.domain,
            file: h.file,
            basename: h.basename,
            statementKinds: h.statementKinds,
            matchedLines: h.matchedLines,
        })),
        stats: {
            totalMigrations: hits.length,
            domainsTouched: [ ...new Set(hits.map(h => h.domain)) ],
            firstTouch: hits[0]?.timestamp || null,
            lastTouch: hits[hits.length - 1]?.timestamp || null,
        },
    }, null, 2));
}

// ─── Subcommand: table-orm ───
interface OrmClass {
    name: string;
    file: string;
    line: number;
    extends: string | null;
    tableName: string;
    fields: string[];
}

function scanOrmFile(file: string): OrmClass[] {
    const content = readFileSync(file, 'utf-8');
    const lines = content.split('\n');
    const classes: OrmClass[] = [];

    for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(/^export\s+class\s+(\w+)(?:\s+extends\s+(\w+))?\s*\{/);
        if (!m) { continue; }
        const className = m[1];
        const parent = m[2] || null;
        // Find tableName + fields within the class body
        let tableName: string | null = null;
        const fields: string[] = [];
        let depth = 0;
        let started = false;
        let endLine = i;
        for (let j = i; j < lines.length; j++) {
            for (const ch of lines[j]) {
                if (ch === '{') { depth++; started = true; }
                else if (ch === '}') { depth--; }
            }
            const tm = lines[j].match(/static\s+readonly\s+tableName\s*=\s*'([^']+)'/);
            if (tm) { tableName = tm[1]; }
            const fm = lines[j].match(/^\s+(\w+):\s*[\w\[\]<>|]+;/);
            if (fm && ![ 'tableName', 'signKey' ].includes(fm[1])) {
                fields.push(fm[1]);
            }
            if (started && depth === 0) { endLine = j; break; }
        }
        if (tableName) {
            classes.push({ name: className, file, line: i + 1, extends: parent, tableName, fields });
        }
    }
    return classes;
}

function listAllOrmClasses(): OrmClass[] {
    if (!existsSync(DB_TYPES_DIR)) { return []; }
    const all: OrmClass[] = [];
    for (const f of readdirSync(DB_TYPES_DIR)) {
        if (!f.endsWith('.ts')) { continue; }
        all.push(...scanOrmFile(join(DB_TYPES_DIR, f)));
    }
    return all;
}

function tableOrm(tableName: string) {
    const all = listAllOrmClasses();
    const matches = all.filter(c => c.tableName === tableName);
    console.log(JSON.stringify({
        table: tableName,
        ormClassCount: matches.length,
        ormClasses: matches,
        note: matches.length === 0 ? 'No ORM class found. The table may exist in DB but have no TypeScript binding, or the tableName string differs from what you searched.' : null,
    }, null, 2));
}

// ─── Subcommand: find-table ───
function findTable(keyword: string) {
    const all = listAllOrmClasses();
    const tableNames = [ ...new Set(all.map(c => c.tableName)) ];
    const lowered = keyword.toLowerCase();
    const matches = tableNames
        .filter(t => t.toLowerCase().includes(lowered))
        .sort()
        .map(t => ({
            tableName: t,
            ormClasses: all.filter(c => c.tableName === t).map(c => `${ c.name } @ ${ c.file }:${ c.line }`),
        }));
    console.log(JSON.stringify({
        keyword,
        tableCount: matches.length,
        tables: matches,
    }, null, 2));
}

// ─── Subcommand: find-orm ───
function findOrm(className: string) {
    const all = listAllOrmClasses();
    const matches = all.filter(c => c.name === className);
    console.log(JSON.stringify({
        className,
        matchCount: matches.length,
        matches,
    }, null, 2));
}

// ─── Main dispatcher ───
const args = process.argv.slice(2);
const cmd = args[0];

switch (cmd) {
    case 'list-migrations': listMigrations(args[1]); break;
    case 'latest-create': latestCreate(args[1]); break;
    case 'table-history': tableHistory(args[1]); break;
    case 'table-orm': tableOrm(args[1]); break;
    case 'find-table': findTable(args[1]); break;
    case 'find-orm': findOrm(args[1]); break;
    default:
        console.error('Usage: bun db-lookup.ts <subcommand> <args>');
        console.error('Subcommands: list-migrations, latest-create, table-history, table-orm, find-table, find-orm');
        console.error('Examples:');
        console.error('  bun db-lookup.ts latest-create app_user_wallets');
        console.error('  bun db-lookup.ts table-history app_user_wallets');
        console.error('  bun db-lookup.ts table-orm app_user_wallets');
        console.error('  bun db-lookup.ts find-table wallet');
        console.error('  bun db-lookup.ts find-orm DbAppUserWallet');
        process.exit(1);
}
