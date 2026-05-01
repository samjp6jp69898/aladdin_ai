// Audit call-chain integrity: cross-check rpc-method notes' listed calls against source method bodies.
// Usage: bun run audit-call-chain.ts
//
// For each `type: rpc-method` note:
//   1. Read source_file at source_line, extract the full method body (brace-balanced, string/comment aware)
//   2. From body, regex-extract:
//      - Manager calls : `this.<field>Manager.<method>(`  → FQN `Manager.<ManagerName>.<method>`
//      - RPC calls     : `context.remote.<server>.<service>.<Method>(`  → FQN `<server>.<service>.<Method>`
//   3. Compare with note.calls.managerMethods / note.calls.rpcCrossServer (parsed by lib/note-parser.ts)
//   4. Emit:
//      - phantom_call : note lists a fqn but source body doesn't call it
//      - missing_call : source body calls a fqn but note doesn't list it
//
// Output: obsidian/Codebase/_index/audit-call-chain-report.json

import { Glob } from 'bun';
import { readFileSync, writeFileSync } from 'node:fs';
import { parseNote } from './lib/note-parser.ts';

const REPO_ROOT = '/Users/user/aladdin';
const CODEBASE_DIR = `${REPO_ROOT}/obsidian/Codebase`;
const OUT_PATH = `${CODEBASE_DIR}/_index/audit-call-chain-report.json`;

type IssueType = 'missing_call' | 'phantom_call';
type Category = 'manager' | 'rpc';

interface Issue {
    fqn: string;
    notePath: string;
    sourceFile: string;
    sourceLine: number;
    type: IssueType;
    category: Category;
    detail: string;
}

// ---- Brace-balanced method body extraction -----------------------------------

function lineToOffset(content: string, line1: number): number {
    if (line1 < 1) return 0;
    let off = 0;
    let n = 1;
    for (let i = 0; i < content.length && n < line1; i++) {
        if (content[i] === '\n') {
            n++;
            off = i + 1;
        }
    }
    return off;
}

function offsetToLine(content: string, offset: number): number {
    let n = 1;
    for (let i = 0; i < offset && i < content.length; i++) {
        if (content[i] === '\n') n++;
    }
    return n;
}

/**
 * Re-locate a method declaration by name when frontmatter source_line has drifted.
 * Returns the actual line number of `async method<MethodName>(` if found, else original line.
 *
 * `methodName` is the FQN's last segment in PascalCase (e.g., `GetLevels`); source convention
 * is `async methodGetLevels(` (lowercase 'm' + PascalCase). For Manager methods (no `method`
 * prefix), fall back to bare `async <name>(` lookup.
 */
function relocateMethodLine(
    content: string,
    methodName: string,
    originalLine: number,
    isRpcMethod: boolean,
): number {
    const patterns = isRpcMethod
        ? [
            new RegExp(`\\basync\\s+method${methodName}\\s*[(<]`, 'm'),
            new RegExp(`\\bmethod${methodName}\\s*\\(`, 'm'),
        ]
        : [
            new RegExp(`\\basync\\s+${methodName}\\s*[(<]`, 'm'),
            new RegExp(`\\b${methodName}\\s*\\(`, 'm'),
        ];

    for (const re of patterns) {
        const m = re.exec(content);
        if (m && typeof m.index === 'number') {
            const newLine = offsetToLine(content, m.index);
            return newLine;
        }
    }
    return originalLine;
}

/**
 * Extract a TS method body starting at the declaration on `sourceLine`.
 * Strategy:
 *   1. From the start of sourceLine, find the first `(` — this opens the parameter list.
 *   2. Balance parens to find the matching `)`.
 *   3. From there, find the first `{` — this opens the method body.
 *   4. Balance braces (skipping string literals and comments) to find the matching `}`.
 *   5. Return body text including outer braces.
 */
function extractMethodBody(content: string, sourceLine: number): string {
    let i = lineToOffset(content, sourceLine);

    // Step 1+2: skip parameter list
    while (i < content.length && content[i] !== '(') i++;
    if (i >= content.length) return '';
    let parenDepth = 0;
    for (; i < content.length; i++) {
        if (content[i] === '(') parenDepth++;
        else if (content[i] === ')') {
            parenDepth--;
            if (parenDepth === 0) { i++; break; }
        }
    }

    // Step 3: find body opener `{`
    while (i < content.length && content[i] !== '{') i++;
    if (i >= content.length) return '';

    // Step 4: balance braces with string/comment awareness
    const start = i;
    let depth = 0;
    while (i < content.length) {
        const ch = content[i];

        // Single-line comment
        if (ch === '/' && content[i + 1] === '/') {
            while (i < content.length && content[i] !== '\n') i++;
            continue;
        }
        // Block comment
        if (ch === '/' && content[i + 1] === '*') {
            i += 2;
            while (i < content.length - 1 && !(content[i] === '*' && content[i + 1] === '/')) i++;
            i += 2;
            continue;
        }
        // String literals
        if (ch === '"' || ch === "'") {
            const q = ch;
            i++;
            while (i < content.length) {
                if (content[i] === '\\') { i += 2; continue; }
                if (content[i] === q) { i++; break; }
                i++;
            }
            continue;
        }
        // Template literal — handle ${...} interpolation
        if (ch === '`') {
            i++;
            while (i < content.length) {
                if (content[i] === '\\') { i += 2; continue; }
                if (content[i] === '$' && content[i + 1] === '{') {
                    i += 2;
                    let d = 1;
                    while (i < content.length && d > 0) {
                        // very rough — ignore strings/comments inside interpolations
                        if (content[i] === '{') d++;
                        else if (content[i] === '}') d--;
                        if (d > 0) i++;
                    }
                    if (content[i] === '}') i++;
                    continue;
                }
                if (content[i] === '`') { i++; break; }
                i++;
            }
            continue;
        }

        if (ch === '{') depth++;
        else if (ch === '}') {
            depth--;
            if (depth === 0) return content.slice(start, i + 1);
        }
        i++;
    }
    return content.slice(start);
}

// ---- Call extraction ---------------------------------------------------------

/**
 * Scan all manager files in `agrabah/src/managers/` to build a class-hierarchy map:
 *   ManagerClass → its parent ManagerClass (recursively).
 * Used to expand `Manager.SubClass.method` to `[Manager.SubClass.method, Manager.Parent.method, ...]`
 * for phantom/missing comparison — because methods may be defined on a parent and inherited.
 */
function buildManagerInheritance(): Map<string, string> {
    const parentOf = new Map<string, string>();
    const glob = new Glob('managers/**/*.ts');
    const ROOT = `${REPO_ROOT}/agrabah/src`;
    const re = /\bclass\s+([A-Z][a-zA-Z0-9]*Manager)\s+extends\s+([A-Z][a-zA-Z0-9]*Manager)\b/g;
    for (const rel of (() => {
        const arr: string[] = [];
        // synchronous-ish scan via Bun.Glob
        const it = glob.scanSync({ cwd: ROOT });
        for (const x of it) arr.push(x);
        return arr;
    })()) {
        const path = `${ROOT}/${rel}`;
        let content: string;
        try { content = readFileSync(path, 'utf-8'); }
        catch { continue; }
        let m: RegExpExecArray | null;
        while ((m = re.exec(content)) !== null) {
            parentOf.set(m[1], m[2]);
        }
    }
    return parentOf;
}

/** Walk the inheritance chain to enumerate `[self, parent, grandparent, ...]`. */
function ancestors(cls: string, parentOf: Map<string, string>): string[] {
    const chain = [cls];
    let cur = cls;
    const seen = new Set([cls]);
    while (parentOf.has(cur)) {
        const p = parentOf.get(cur)!;
        if (seen.has(p)) break; // guard cycles
        chain.push(p);
        seen.add(p);
        cur = p;
    }
    return chain;
}

/**
 * Build a `fieldName → ManagerClassName` mapping from the source file by scanning:
 *   - `private _xxxManager: YyyManager;` (instance field declaration)
 *   - `protected xxxManager: YyyManager;`
 *   - `private _xxxManager!: YyyManager;`  (definite-assignment)
 *   - `xxxManager: YyyManager;`
 *   - constructor params: `xxxManager: YyyManager`
 *   - module-level: `const xxxManager = new YyyManager(`
 *
 * Stripped `_` from key so both `_userManager` and `userManager` look up to the same class.
 */
function buildFieldToClassMap(content: string): Map<string, string> {
    const map = new Map<string, string>();

    // Pattern A: field declaration (with optional access modifier, optional `!`/`?`, optional `=`)
    //   private _userManager: AppUserManager;
    //   protected fooManager!: BarManager;
    //   activityConfigManager: ActivityConfigManager
    const fieldRe = /(?:private|protected|public|readonly|\s)+\s*(_?[a-z][a-zA-Z0-9]*Manager)\s*[!?]?\s*:\s*([A-Z][a-zA-Z0-9]*Manager)\b/g;
    let m: RegExpExecArray | null;
    while ((m = fieldRe.exec(content)) !== null) {
        const fieldKey = m[1].replace(/^_/, '');
        map.set(fieldKey, m[2]);
    }

    // Pattern B: module-level / class-level `const xxxManager = new YyyManager(`
    const constRe = /\b(?:const|let|var)\s+(_?[a-z][a-zA-Z0-9]*Manager)\s*=\s*new\s+([A-Z][a-zA-Z0-9]*Manager)\b/g;
    while ((m = constRe.exec(content)) !== null) {
        const fieldKey = m[1].replace(/^_/, '');
        if (!map.has(fieldKey)) map.set(fieldKey, m[2]);
    }

    // Pattern C: untyped property assignment `this._xxxManager = yyyManager;` where
    // yyyManager was declared elsewhere — covers cross-file injection. Skip; out of scope.

    // Pattern D: constructor parameter `(xxxManager: YyyManager)` (overlaps Pattern A regex due to
    // colon-typed token; already captured).

    return map;
}

function extractCallsFromBody(
    body: string,
    rpcResolver: (server: string, accessor: string, method: string) => string,
    fieldToClass: Map<string, string>,
    parentOf: Map<string, string>,
): { managerCalls: Map<string, string[]>; rpcCalls: Set<string> } {
    // managerCalls maps "primary FQN" → "expanded ancestor-FQN list" (incl. self).
    // For phantom-check we ask: does note's listed FQN match any in the expanded list?
    // For missing-check we ask: does note list any of the expanded list?
    const managerCalls = new Map<string, string[]>();
    const rpcCalls = new Set<string>();

    // Manager call patterns observed in agrabah:
    //   1. `this._walletManager.foo(` — instance field, leading `_` private convention
    //   2. `this.walletManager.foo(`  — instance field / getter
    //   3. `localizationManager.foo(` — module-level `const localizationManager = new LocalizationManager()`
    //   4. `walletManager.foo(`       — local variable / parameter
    // Resolution order: lookup in fieldToClass map (built from source-file declarations);
    // if absent, fallback to capitalize-first-char heuristic.
    const mgrRe = /\b(_?[a-z][a-zA-Z0-9]*Manager)\.(\w+)\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = mgrRe.exec(body)) !== null) {
        let field = m[1];
        if (field.startsWith('_')) field = field.slice(1);
        const fromMap = fieldToClass.get(field);
        const mgr = fromMap ?? (field.charAt(0).toUpperCase() + field.slice(1));
        const method = m[2];
        const primary = `Manager.${mgr}.${method}`;
        const expanded = ancestors(mgr, parentOf).map(c => `Manager.${c}.${method}`);
        if (!managerCalls.has(primary)) managerCalls.set(primary, expanded);
    }

    // RPC cross-server: `context.remote.<server>.<accessor>.<Method>(`
    // The runtime accessor (e.g. `main`) often differs from the rajah service name (e.g. `platform`),
    // so we resolve through rpcResolver against the rpc-method note inventory.
    const rpcRe = /context\.remote\.(\w+)\.(\w+)\.(\w+)\s*\(/g;
    while ((m = rpcRe.exec(body)) !== null) {
        rpcCalls.add(rpcResolver(m[1], m[2], m[3]));
    }

    return { managerCalls, rpcCalls };
}

// ---- Main --------------------------------------------------------------------

async function main() {
    // ---- Pass 1: collect all rpc-method notes; build (server, method) → [fqn] map ----
    const rpcNotes: Array<{ note: Awaited<ReturnType<typeof parseNote>>; full: string }> = [];
    const fqnByServerMethod = new Map<string, string[]>();

    const glob1 = new Glob('**/*.md');
    for await (const rel of glob1.scan(CODEBASE_DIR)) {
        const full = `${CODEBASE_DIR}/${rel}`;
        const note = await parseNote(full);
        if (!note || note.type !== 'rpc-method') continue;
        rpcNotes.push({ note, full });
        const server = note.frontmatter.server;
        const method = note.frontmatter.method;
        if (typeof server === 'string' && typeof method === 'string') {
            const key = `${server}|${method}`;
            const arr = fqnByServerMethod.get(key);
            if (arr) arr.push(note.fqn);
            else fqnByServerMethod.set(key, [note.fqn]);
        }
    }

    // Resolver: turn (server, accessor, Method) → canonical fqn used in note inventory.
    // Rules:
    //   - If `<server>.<accessor>.<Method>` is itself a note fqn → use it directly.
    //   - Else look up by (server, Method); if exactly one note → use it.
    //   - Else prefer service == server (`<server>.<server>.<Method>`) which is the conventional "main".
    //   - Else fall back to raw `<server>.<accessor>.<Method>` so audit still surfaces the discrepancy.
    function rpcResolver(server: string, accessor: string, method: string): string {
        const key = `${server}|${method}`;
        const candidates = fqnByServerMethod.get(key);
        if (!candidates || candidates.length === 0) return `${server}.${accessor}.${method}`;
        const literal = `${server}.${accessor}.${method}`;
        if (candidates.includes(literal)) return literal;
        if (candidates.length === 1) return candidates[0];
        const conventional = `${server}.${server}.${method}`;
        if (candidates.includes(conventional)) return conventional;
        return literal;
    }

    // ---- Pass 1.5: build manager class-inheritance tree ----
    const parentOf = buildManagerInheritance();

    // ---- Pass 2: audit each rpc-method note ----
    const issues: Issue[] = [];
    let totalRpcNotes = rpcNotes.length;
    let checked = 0;
    let bodyFailures = 0;
    let sourceMissing = 0;

    let relocated = 0;
    for (const { note, full } of rpcNotes) {
        if (!note) continue;
        const sourceFile = note.frontmatter.source_file;
        const originalLine = note.frontmatter.source_line;
        if (typeof sourceFile !== 'string' || typeof originalLine !== 'number' || originalLine < 1) continue;

        const fullSourcePath = `${REPO_ROOT}/${sourceFile}`;
        let content: string;
        try {
            content = readFileSync(fullSourcePath, 'utf-8');
        } catch {
            sourceMissing++;
            continue;
        }

        // Re-locate method by name to defend against stale frontmatter source_line.
        // FQN last segment is the RPC method name in PascalCase.
        const methodName = note.fqn.split('.').pop() || '';
        const sourceLine = relocateMethodLine(content, methodName, originalLine, /* isRpcMethod */ true);
        if (sourceLine !== originalLine) relocated++;

        const body = extractMethodBody(content, sourceLine);
        if (!body || body.length < 2) {
            bodyFailures++;
            continue;
        }
        checked++;

        const fieldToClass = buildFieldToClassMap(content);
        const { managerCalls, rpcCalls } = extractCallsFromBody(body, rpcResolver, fieldToClass, parentOf);

        const noteMgr = new Set(note.calls.managerMethods);
        const noteRpc = new Set(note.calls.rpcCrossServer);

        // For ancestor-aware match: a call is "covered" if note lists ANY of its ancestor FQNs.
        // For "is note's listed FQN matched by any source call": iterate every source call's expanded
        // ancestor list and union — if listed FQN is in that union, it's covered.
        const allAncestorsFromSource = new Set<string>();
        for (const expanded of managerCalls.values()) for (const x of expanded) allAncestorsFromSource.add(x);

        // missing_call : source has a primary, but note lists no FQN in its ancestor chain.
        for (const [primary, expanded] of managerCalls) {
            const matched = expanded.some(x => noteMgr.has(x));
            if (!matched) {
                issues.push({
                    fqn: note.fqn,
                    notePath: full,
                    sourceFile,
                    sourceLine,
                    type: 'missing_call',
                    category: 'manager',
                    detail: `Code calls ${primary}() but note doesn't list it (or any ancestor)`,
                });
            }
        }
        for (const c of rpcCalls) {
            if (!noteRpc.has(c)) {
                issues.push({
                    fqn: note.fqn,
                    notePath: full,
                    sourceFile,
                    sourceLine,
                    type: 'missing_call',
                    category: 'rpc',
                    detail: `Code calls context.remote.${c.replace(/\./g, '.')}() but note doesn't list it`,
                });
            }
        }

        // phantom_call : note lists FQN, but no source call has it in its ancestor chain.
        for (const c of noteMgr) {
            if (!allAncestorsFromSource.has(c)) {
                issues.push({
                    fqn: note.fqn,
                    notePath: full,
                    sourceFile,
                    sourceLine,
                    type: 'phantom_call',
                    category: 'manager',
                    detail: `Note lists [[${c}]] but not found in source method body (or any subclass call)`,
                });
            }
        }
        for (const c of noteRpc) {
            if (!rpcCalls.has(c)) {
                issues.push({
                    fqn: note.fqn,
                    notePath: full,
                    sourceFile,
                    sourceLine,
                    type: 'phantom_call',
                    category: 'rpc',
                    detail: `Note lists [[${c}]] but not found in source method body`,
                });
            }
        }
    }

    const report = {
        timestamp: new Date().toISOString(),
        totalMethods: totalRpcNotes,
        checked,
        bodyExtractionFailures: bodyFailures,
        sourceFileMissing: sourceMissing,
        relocatedByName: relocated,
        issues,
    };
    writeFileSync(OUT_PATH, JSON.stringify(report, null, 2));
    console.log(`[audit] rpc-method notes: ${totalRpcNotes}; checked: ${checked}; body fail: ${bodyFailures}; source missing: ${sourceMissing}; relocated: ${relocated}`);
    console.log(`[audit] issues: ${issues.length}`);
    const byKey: Record<string, number> = {};
    for (const i of issues) {
        const k = `${i.type}/${i.category}`;
        byKey[k] = (byKey[k] ?? 0) + 1;
    }
    console.log('[audit] breakdown:', byKey);
    console.log(`[audit] report → ${OUT_PATH}`);
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
