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

function extractCallsFromBody(
    body: string,
    rpcResolver: (server: string, accessor: string, method: string) => string,
): { managerCalls: Set<string>; rpcCalls: Set<string> } {
    const managerCalls = new Set<string>();
    const rpcCalls = new Set<string>();

    // Manager call patterns observed in agrabah:
    //   1. `this._walletManager.foo(` — instance field, leading `_` private convention
    //   2. `this.walletManager.foo(`  — instance field / getter
    //   3. `localizationManager.foo(` — module-level `const localizationManager = new LocalizationManager()`
    //   4. `walletManager.foo(`       — local variable / parameter
    // Common shape: a token starting with lowercase, ending with `Manager`, optionally `_`-prefixed,
    // followed by `.<method>(`. We strip leading `_` and capitalize first char to derive ManagerName.
    const mgrRe = /\b(_?[a-z][a-zA-Z0-9]*Manager)\.(\w+)\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = mgrRe.exec(body)) !== null) {
        let field = m[1];
        if (field.startsWith('_')) field = field.slice(1);
        const mgr = field.charAt(0).toUpperCase() + field.slice(1);
        const method = m[2];
        managerCalls.add(`Manager.${mgr}.${method}`);
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

        const { managerCalls, rpcCalls } = extractCallsFromBody(body, rpcResolver);

        const noteMgr = new Set(note.calls.managerMethods);
        const noteRpc = new Set(note.calls.rpcCrossServer);

        // missing_call : source has, note doesn't
        for (const c of managerCalls) {
            if (!noteMgr.has(c)) {
                issues.push({
                    fqn: note.fqn,
                    notePath: full,
                    sourceFile,
                    sourceLine,
                    type: 'missing_call',
                    category: 'manager',
                    detail: `Code calls ${c}() but note doesn't list it`,
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

        // phantom_call : note has, source doesn't
        for (const c of noteMgr) {
            if (!managerCalls.has(c)) {
                issues.push({
                    fqn: note.fqn,
                    notePath: full,
                    sourceFile,
                    sourceLine,
                    type: 'phantom_call',
                    category: 'manager',
                    detail: `Note lists [[${c}]] but not found in source method body`,
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
