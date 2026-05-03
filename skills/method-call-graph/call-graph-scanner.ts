#!/usr/bin/env bun
/**
 * call-graph-scanner.ts — Static call graph scanner for agrabah codebase.
 *
 * Subcommands:
 *   resolve-method <ServiceClass.method | filePath:method>
 *   same-server-callers <file> <class> <method> <server> [--base-class=X] [--base-method=Y]
 *   cross-server-callers <method> <server> <rajahServiceName>
 *   frontend-callers <method>
 *   detect-entries
 *   reverse-bfs-to-entries <file> <class> <method> <server> [--entries-json=<path>]
 *   table-locate <server> <tableName>
 *   table-crud <server> <tableName> <dbClassesJson>
 *   table-bfs <server> <targetsJson>
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { join, relative, resolve } from 'path';

// Resolve agrabah root robustly: works both from agrabah/.claude/skills/method-call-graph/
// (SCRIPT_DIR/../../.. = agrabah) AND from obsidian/skills/method-call-graph/ where that
// relative path lands outside agrabah. Walk up looking for a directory that contains
// `src/servers` and `rajah/`; fall back to absolute /Users/user/aladdin/agrabah.
const SCRIPT_DIR = import.meta.dir;
function findAgrabahRoot(): string {
    let dir = SCRIPT_DIR;
    for (let i = 0; i < 6; i++) {
        const candidate = resolve(dir);
        try {
            const fs = require('fs');
            if (fs.existsSync(join(candidate, 'src/servers')) && fs.existsSync(join(candidate, 'rajah/base_server.json'))) {
                return candidate;
            }
        } catch {}
        dir = resolve(dir, '..');
    }
    return '/Users/user/aladdin/agrabah';
}
// V5: 支援 ALADDIN_ROOT_AT_DATE env 變數,讓 bug-tracer 可指向 ticket 時間點的 worktree 集合
const ALADDIN_ROOT = process.env.ALADDIN_ROOT_AT_DATE ?? resolve(findAgrabahRoot(), '..');
const AGRABAH = join(ALADDIN_ROOT, 'agrabah');
const SERVERS_DIR = join(AGRABAH, 'src/servers');
const MANAGERS_DIR = join(AGRABAH, 'src/managers');
const DB_TYPES_DIR = join(AGRABAH, 'src/database_types');
const RAJAH_DIR = join(AGRABAH, 'rajah');

function grep(pattern: string, paths: string[], opts: string = ''): string[] {
    const validPaths = paths.filter(p => existsSync(p));
    if (validPaths.length === 0) { return []; }
    try {
        const args = [ '-rn', ...opts.split(' ').filter(Boolean), '-e', pattern, ...validPaths, '--include=*.ts' ];
        const result = Bun.spawnSync([ 'grep', ...args ], { stdout: 'pipe', stderr: 'pipe' });
        const out = result.stdout.toString().trim();
        return out ? out.split('\n') : [];
    } catch {
        return [];
    }
}

function grepVue(pattern: string, paths: string[]): string[] {
    const validPaths = paths.filter(p => existsSync(p));
    if (validPaths.length === 0) { return []; }
    try {
        const args = [ '-rn', '-e', pattern, ...validPaths, '--include=*.ts', '--include=*.vue' ];
        const result = Bun.spawnSync([ 'grep', ...args ], { stdout: 'pipe', stderr: 'pipe' });
        const out = result.stdout.toString().trim();
        return out ? out.split('\n') : [];
    } catch {
        return [];
    }
}

function readLines(file: string): string[] {
    try {
        return readFileSync(file, 'utf-8').split('\n');
    } catch {
        return [];
    }
}

function isCommentOrImport(line: string): boolean {
    const trimmed = line.trim();
    return (
        trimmed.startsWith('//') ||
    trimmed.startsWith('*') ||
    trimmed.startsWith('/*') ||
    trimmed.startsWith('import ') ||
    trimmed.startsWith('import{') ||
    trimmed.startsWith('export {') ||
    trimmed.startsWith('export type') ||
    trimmed.startsWith('export interface')
    );
}

function isInString(line: string, methodName: string): boolean {
    const singleQ = new RegExp(`'[^']*${ methodName }[^']*'`);
    const doubleQ = new RegExp(`"[^"]*${ methodName }[^"]*"`);
    const template = new RegExp('`[^`]*' + methodName + '[^`]*`');
    const idx = line.indexOf(`.${ methodName }`);
    if (idx < 0) { return false; }
    const before = line.slice(0, idx);
    const singleBefore = (before.match(/'/g) || []).length;
    const doubleBefore = (before.match(/"/g) || []).length;
    if (singleBefore % 2 !== 0 || doubleBefore % 2 !== 0) { return true; }
    return false;
}

interface GrepHit {
    file: string;
    line: number;
    content: string;
}

function parseGrepLine(raw: string): GrepHit | null {
    // V9:strip 行尾 CR(處理 CRLF line endings — 部分舊檔如 abu/platform/src/initializes/reflection.ts 是 CRLF)
    const cleaned = raw.replace(/\r$/, '');
    const m = cleaned.match(/^(.+?):(\d+):(.*)$/);
    if (!m) { return null; }
    return { file: m[1], line: parseInt(m[2]), content: m[3].replace(/\r$/, '') };
}

function filterHits(hits: GrepHit[], methodName: string, excludeFile?: string, excludeLine?: number): GrepHit[] {
    return hits.filter(h => {
        if (isCommentOrImport(h.content)) { return false; }
        if (isInString(h.content, methodName)) { return false; }
        if (excludeFile && h.file === excludeFile && excludeLine && h.line === excludeLine) { return false; }
        if (h.content.includes('/generated/')) { return false; }
        if (h.file.includes('/generated/')) { return false; }
        return true;
    });
}

interface ClassInfo {
    name: string;
    extends: string | null;
    file: string;
    line: number;
}

function findClassInFile(file: string): ClassInfo[] {
    const lines = readLines(file);
    const results: ClassInfo[] = [];
    for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(/(?:export\s+)?class\s+(\w+)(?:\s+extends\s+(\w+))?/);
        if (m) {
            results.push({ name: m[1], extends: m[2] || null, file, line: i + 1 });
        }
    }
    return results;
}

function findMethodLine(file: string, method: string): number {
    const lines = readLines(file);
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].match(new RegExp(`\\b(async\\s+)?${ method }\\s*\\(`)) && !isCommentOrImport(lines[i])) {
            return i + 1;
        }
    }
    return -1;
}

function extractClassAtLine(file: string, line: number): string | null {
    const lines = readLines(file);
    for (let i = line - 1; i >= 0; i--) {
        const m = lines[i].match(/(?:export\s+)?class\s+(\w+)/);
        if (m) { return m[1]; }
    }
    // Fallback: use filename as module name (e.g. "wallet.ts" → "wallet")
    const basename = file.split('/').pop()?.replace(/\.ts$/, '') || null;
    return basename;
}

function extractContextFromFile(file: string, line: number, radius: number = 30): string[] {
    const lines = readLines(file);
    const start = Math.max(0, line - 1 - radius);
    const end = Math.min(lines.length, line - 1 + radius + 1);
    return lines.slice(start, end);
}

function relPath(absPath: string): string {
    return relative(AGRABAH, absPath);
}

// ─── Subcommand: resolve-method ───

function resolveMethod(input: string) {
    let targetFile: string;
    let methodName: string;

    if (input.includes(':')) {
        const parts = input.split(':');
        methodName = parts.pop()!;
        targetFile = parts.join(':');
        if (!targetFile.startsWith('/')) { targetFile = join(ALADDIN_ROOT, targetFile); }
    } else {
        const [ className, method ] = input.split('.');
        methodName = method;
        const results = grep(`class ${ className }\\b`, [ join(AGRABAH, 'src/servers'), MANAGERS_DIR ]);
        const files = results.map(r => parseGrepLine(r)?.file).filter(Boolean) as string[];
        const uniqueFiles = [ ...new Set(files) ];
        if (uniqueFiles.length === 0) {
            console.log(JSON.stringify({ error: `class ${ className } not found` }));
            return;
        }
        targetFile = uniqueFiles[0];
    }

    const line = findMethodLine(targetFile, methodName);
    if (line < 0) {
        console.log(JSON.stringify({ error: `method ${ methodName } not found in ${ targetFile }` }));
        return;
    }

    const classes = findClassInFile(targetFile);
    let targetClass: ClassInfo | null = null;
    for (const c of classes) {
        if (c.line <= line) { targetClass = c; }
    }

    const serverMatch = targetFile.match(/servers\/([^/]+)\//);
    const server = serverMatch ? serverMatch[1] : null;

    let rajahServiceName: string | null = null;
    if (targetClass?.extends) {
        const baseMatch = targetClass.extends.match(/^(\w+?)BaseService$/);
        if (baseMatch) { rajahServiceName = baseMatch[1]; }
    }

    console.log(JSON.stringify({
        targetFile,
        targetLine: line,
        targetClass: targetClass?.name || null,
        baseClass: targetClass?.extends || null,
        targetMethod: methodName,
        targetServer: server,
        rajahServiceName,
    }));
}

// ─── Subcommand: same-server-callers (BFS) ───

interface CallerHit {
    file: string;
    line: number;
    className: string | null;
    methodName: string | null;
    content: string;
    level: number;
    calledBy: string | null;
    receiverType: string;
    needsVerification: boolean;
}

function sameServerCallers(
    targetFile: string,
    targetClass: string,
    targetMethod: string,
    server: string,
    baseClass?: string,
    baseMethod?: string
) {
    const scope = [ join(SERVERS_DIR, server), MANAGERS_DIR ];
    const visited = new Set<string>();
    const queue: { method: string; file: string; className: string; line: number; level: number; calledBy: string | null }[] = [];
    const results: CallerHit[] = [];

    queue.push({ method: targetMethod, file: targetFile, className: targetClass, line: findMethodLine(targetFile, targetMethod), level: 0, calledBy: null });
    visited.add(`${ targetFile }:${ targetClass }.${ targetMethod }`);

    if (baseMethod && baseMethod !== targetMethod) {
    // also track base method name
    }

    while (queue.length > 0) {
        const current = queue.shift()!;
        const methods = [ current.method ];
        if (current.level === 0 && baseMethod && baseMethod !== targetMethod) {
            methods.push(baseMethod);
        }

        for (const searchMethod of methods) {
            const rawHits = grep(`\\.${ searchMethod }\\s*(`, scope);
            const parsed = rawHits.map(parseGrepLine).filter(Boolean) as GrepHit[];
            const filtered = filterHits(parsed, searchMethod, current.level === 0 ? current.file : undefined, current.level === 0 ? current.line : undefined);

            // Also filter out the definition itself for this method
            const finalFiltered = filtered.filter(h => {
                // skip if it's a method definition (async methodName( or methodName()
                const defPattern = new RegExp(`(async\\s+)?${ searchMethod }\\s*\\(`);
                const trimmed = h.content.trim();
                if (trimmed.match(defPattern) && !trimmed.includes(`.${ searchMethod }`)) { return false; }
                // skip context.remote calls
                if (h.content.includes('context.remote.')) { return false; }
                return true;
            });

            for (const hit of finalFiltered) {
                const callerClass = extractClassAtLine(hit.file, hit.line);
                const callerMethod = extractMethodAtLine(hit.file, hit.line);
                const key = `${ hit.file }:${ callerClass }.${ callerMethod }`;

                if (visited.has(key)) { continue; }

                let receiverType = 'unknown';
                let needsVerification = false;

                if (hit.content.includes('this.')) {
                    receiverType = 'this';
                    needsVerification = false;
                } else if (hit.content.match(/this\._\w+\./)) {
                    receiverType = 'this._field';
                    needsVerification = true;
                } else {
                    const varMatch = hit.content.match(/(\w+)\.${searchMethod}/);
                    if (varMatch) {
                        receiverType = `var:${ varMatch[1] }`;
                        needsVerification = true;
                    }
                }

                const callerHit: CallerHit = {
                    file: hit.file,
                    line: hit.line,
                    className: callerClass,
                    methodName: callerMethod,
                    content: hit.content.trim(),
                    level: current.level + 1,
                    calledBy: current.level === 0 ? `${ current.className }.${ current.method }` : `${ current.className }.${ current.method }`,
                    receiverType,
                    needsVerification,
                };

                results.push(callerHit);
                visited.add(key);

                if (callerMethod && callerClass) {
                    queue.push({
                        method: callerMethod,
                        file: hit.file,
                        className: callerClass,
                        line: hit.line,
                        level: current.level + 1,
                        calledBy: `${ callerClass }.${ callerMethod }`,
                    });
                }
            }
        }
    }

    const maxLevel = results.reduce((max, r) => Math.max(max, r.level), 0);
    const directCount = results.filter(r => r.level === 1).length;
    const transitiveCount = results.filter(r => r.level > 1).length;
    const needsVerification = results.filter(r => r.needsVerification);

    console.log(JSON.stringify({
        callers: results.map(r => ({
            file: relPath(r.file),
            line: r.line,
            className: r.className,
            methodName: r.methodName,
            content: r.content,
            level: r.level,
            calledBy: r.calledBy,
            receiverType: r.receiverType,
            needsVerification: r.needsVerification,
        })),
        stats: { directCount, transitiveCount, maxLevel, visitedTotal: visited.size },
        needsVerification: needsVerification.map(r => ({
            file: relPath(r.file),
            line: r.line,
            content: r.content,
            receiverType: r.receiverType,
        })),
    }));
}

function extractMethodAtLine(file: string, line: number): string | null {
    const lines = readLines(file);
    const controlKeywords = new Set([ 'if', 'for', 'while', 'switch', 'catch', 'else', 'return', 'throw', 'const', 'let', 'var', 'new', 'await', 'yield' ]);
    for (let i = line - 1; i >= 0; i--) {
        const trimmed = lines[i].trim();
        if (isCommentOrImport(trimmed)) { continue; }
        // Match: (optional access modifier) (optional async) methodName(
        const m = trimmed.match(/^(?:(?:private|public|protected|static|override)\s+)*(?:async\s+)?(\w+)\s*[\(<]/);
        if (m) {
            const name = m[1];
            if (controlKeywords.has(name)) { continue; }
            if (name === 'class' || name === 'function' || name === 'constructor') {
                if (name === 'constructor') { return 'constructor'; }
                continue;
            }
            return name;
        }
        // Also match standalone functions in non-class files
        const funcMatch = trimmed.match(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(/);
        if (funcMatch) { return funcMatch[1]; }
        // Stop at class boundary
        if (trimmed.match(/^(?:export\s+)?class\s+/)) { break; }
    }
    return null;
}

// ─── Subcommand: cross-server-callers ───

function crossServerCallers(method: string, server: string, rajahServiceName: string) {
    // Read all server_*.json to find which servers depend on the target service
    const serverJsonFiles = readdirSync(RAJAH_DIR).filter(f => f.startsWith('server_') && f.endsWith('.json') && !f.endsWith('.gen.json'));
    const baseServerJson = JSON.parse(readFileSync(join(RAJAH_DIR, 'base_server.json'), 'utf-8'));

    interface ServerDep {
        serverName: string;
        groups: Record<string, string[]>;
    }

    const dependentServers: ServerDep[] = [];

    for (const f of serverJsonFiles) {
        const config = JSON.parse(readFileSync(join(RAJAH_DIR, f), 'utf-8'));
        const serverName = f.replace('server_', '').replace('.json', '');
        if (serverName === server) { continue; }

        const groups = { ...baseServerJson.rajahClientServiceGroups, ...config.rajahClientServiceGroups };
        for (const [ groupKey, services ] of Object.entries(groups)) {
            if (Array.isArray(services) && services.some((s: string) => s === rajahServiceName || s.toLowerCase().includes(rajahServiceName.toLowerCase()))) {
                dependentServers.push({ serverName, groups });
                break;
            }
        }
    }

    interface CrossServerHit {
        server: string;
        file: string;
        line: number;
        className: string | null;
        methodName: string | null;
        content: string;
        gRpcPath: string | null;
        needsVerification: boolean;
    }

    const results: CrossServerHit[] = [];
    const seenKeys = new Set<string>();

    function addHit(hit: GrepHit) {
        const key = `${ hit.file }:${ hit.line }`;
        if (seenKeys.has(key)) { return; }
        seenKeys.add(key);

        if (hit.file.includes(`/servers/${ server }/`)) { return; }
        const trimmed = hit.content.trim();
        if (trimmed.match(new RegExp(`(async\\s+)?${ method }\\s*\\(`)) && !trimmed.includes(`.${ method }`)) { return; }
        if (isCommentOrImport(trimmed)) { return; }

        const callerClass = extractClassAtLine(hit.file, hit.line);
        const callerMethod = extractMethodAtLine(hit.file, hit.line);

        let gRpcPath: string | null = null;
        let needsVerification = false;

        const remoteMatch = hit.content.match(/context\.remote\.(\w+)\.(\w+)\.(\w+)/);
        if (remoteMatch) {
            gRpcPath = `context.remote.${ remoteMatch[1] }.${ remoteMatch[2] }.${ remoteMatch[3] }`;
        } else if (hit.content.includes('context.remote.')) {
            gRpcPath = 'context.remote.<partial>';
            needsVerification = true;
        } else {
            needsVerification = true;
        }

        const hitServer = hit.file.match(/servers\/([^/]+)\//)?.[1] || 'managers';

        results.push({
            server: hitServer,
            file: relPath(hit.file),
            line: hit.line,
            className: callerClass,
            methodName: callerMethod,
            content: trimmed,
            gRpcPath,
            needsVerification,
        });
    }

    // Search each dependent server directory (NOT managers — searched separately)
    for (const dep of dependentServers) {
        const paths = [ join(SERVERS_DIR, dep.serverName) ];
        const rawHits = grep(`\\.${ method }\\s*(`, paths);
        const parsed = rawHits.map(parseGrepLine).filter(Boolean) as GrepHit[];
        const filtered = filterHits(parsed, method);
        for (const hit of filtered) { addHit(hit); }
    }

    // Search managers once (context.remote pattern only)
    const managerHits = grep(`\\.${ method }\\s*(`, [ MANAGERS_DIR ]);
    const parsedMgr = managerHits.map(parseGrepLine).filter(Boolean) as GrepHit[];
    const filteredMgr = filterHits(parsedMgr, method);
    for (const hit of filteredMgr) {
        // Only include if it's a context.remote call (not a local method call)
        if (hit.content.includes('context.remote.') || hit.content.includes(`.${ method }(`)) {
            addHit(hit);
        }
    }

    const serverSet = new Set(results.map(r => r.server));

    console.log(JSON.stringify({
        callers: results,
        stats: { totalCallers: results.length, serverCount: serverSet.size },
        dependentServers: dependentServers.map(d => d.serverName),
        needsVerification: results.filter(r => r.needsVerification).map(r => ({
            file: r.file,
            line: r.line,
            content: r.content,
        })),
    }));
}

// ─── Subcommand: frontend-callers ───

function normalizeMethodCandidates(method: string): { candidates: string[]; warnings: string[] } {
    // V9:介面誤用容錯 — input 含空格、逗號、斜線時拆 token,各自跑 normalize 後合併
    const warnings: string[] = [];
    const tokens = method.split(/[\s,\/]+/).filter(Boolean);
    if (tokens.length > 1) {
        warnings.push(`input contains ${ tokens.length } whitespace-separated tokens; treating each as a candidate method name`);
    }

    const candidates = new Set<string>();
    for (const tok of tokens) {
    // 拆 namespace dot path:除了取最後一段,也試「中段」「整段去點」三種
        const segments = tok.split('.').filter(Boolean);
        const segmentSources: string[] = [];
        if (segments.length === 0) { continue; }
        segmentSources.push(segments[segments.length - 1]);   // last
        if (segments.length >= 2) {
            segmentSources.push(segments.join(''));               // dotPathStripped (e.g. ApplicationsPlatformActivateAgent)
        }
        for (const seg of segmentSources) {
            if (!seg || !/^\w+$/.test(seg)) { continue; }
            candidates.add(seg);
            // PascalCase → camelCase
            candidates.add(seg[0].toLowerCase() + seg.slice(1));
            // camelCase → PascalCase
            candidates.add(seg[0].toUpperCase() + seg.slice(1));
        }
    }
    return { candidates: Array.from(candidates), warnings };
}

function frontendCallers(method: string) {
    const frontendProjects = [
        { name: 'abu-admin', generated: join(ALADDIN_ROOT, 'abu/admin/src/generated/remote.gen.ts'), src: join(ALADDIN_ROOT, 'abu/admin/src') },
        { name: 'abu-platform', generated: join(ALADDIN_ROOT, 'abu/platform/src/generated/remote.gen.ts'), src: join(ALADDIN_ROOT, 'abu/platform/src') },
        { name: 'abu-common', generated: join(ALADDIN_ROOT, 'abu/common/generated/remote.gen.ts'), src: join(ALADDIN_ROOT, 'abu/common') },
        { name: 'lago-n8', generated: join(ALADDIN_ROOT, 'lago/n8-gaming/src/generated/remote.gen.ts'), src: join(ALADDIN_ROOT, 'lago/n8-gaming/src') },
        { name: 'lago-ny', generated: join(ALADDIN_ROOT, 'lago/ny-gaming/src/generated/remote.gen.ts'), src: join(ALADDIN_ROOT, 'lago/ny-gaming/src') },
        { name: 'lago-pk', generated: join(ALADDIN_ROOT, 'lago/pk-gaming/src/generated/remote.gen.ts'), src: join(ALADDIN_ROOT, 'lago/pk-gaming/src') },
        { name: 'lago-agent', generated: join(ALADDIN_ROOT, 'lago/agent-backend/src/generated/remote.gen.ts'), src: join(ALADDIN_ROOT, 'lago/agent-backend/src') },
        { name: 'lago-common', generated: join(ALADDIN_ROOT, 'lago/common/generated/remote.gen.ts'), src: join(ALADDIN_ROOT, 'lago/common') },
    ];

    const { candidates, warnings } = normalizeMethodCandidates(method);

    interface FrontendHit {
        project: string;
        hasMethod: boolean;
        matchedAs: string[];
        hits: { file: string; line: number; content: string }[];
        note?: string;
    }

    const results: FrontendHit[] = [];

    for (const proj of frontendProjects) {
        let hasMethod = false;
        const matchedAs: string[] = [];
        if (existsSync(proj.generated)) {
            for (const cand of candidates) {
                try {
                    const out = execSync(`grep -c "async ${ cand }\\b" "${ proj.generated }"`, { encoding: 'utf-8' });
                    if (parseInt(out.trim()) > 0) {
                        hasMethod = true;
                        matchedAs.push(cand);
                    }
                } catch {
                    // grep no match returns exit 1
                }
            }
        }

        const projResult: FrontendHit = { project: proj.name, hasMethod, matchedAs, hits: [] };

        if (hasMethod) {
            const allHits: GrepHit[] = [];
            for (const cand of matchedAs) {
                const rawHits = grepVue(`\\.${ cand }\\s*(`, [ proj.src ]);
                const parsed = rawHits.map(parseGrepLine).filter(Boolean) as GrepHit[];
                allHits.push(...parsed);
            }
            const filtered = allHits.filter(h => {
                if (h.file.includes('/generated/')) { return false; }
                if (isCommentOrImport(h.content)) { return false; }
                return true;
            });
            const seen = new Set<string>();
            const dedup: GrepHit[] = [];
            for (const h of filtered) {
                const key = `${ h.file }:${ h.line }`;
                if (!seen.has(key)) {
                    seen.add(key);
                    dedup.push(h);
                }
            }
            projResult.hits = dedup.map(h => ({
                file: relative(ALADDIN_ROOT, h.file),
                line: h.line,
                content: h.content.trim(),
            }));
        }

        // V9:當 generated 看到 method 但 src 無實際 caller,加 note 提醒(避免子代理誤判 totalHits=0 為「方法不存在」)
        if (projResult.hasMethod && projResult.hits.length === 0) {
            projResult.note = 'RPC stub exists in this project\'s generated client but no src caller found — method may be server-only or shared via another project';
        }

        results.push(projResult);
    }

    const totalHits = results.reduce((sum, r) => sum + r.hits.length, 0);
    const projectsWithMethod = results.filter(r => r.hasMethod).map(r => r.project);
    const projectsWithHits = results.filter(r => r.hits.length > 0).map(r => r.project);

    // V9:輸出層級 hint — 區分「真實 0 hit」與「找不到 method 名」兩種失敗模式
    const hints: string[] = [ ...warnings ];
    if (projectsWithMethod.length === 0) {
        hints.push('no project\'s generated client contains a method matching the candidates — verify the method name (PascalCase RPC name expected, e.g. ChangeUserBalance not methodChangeUserBalance)');
    } else if (projectsWithHits.length === 0) {
        hints.push('candidates exist as RPC stubs but no src caller found in any frontend project — method may be server-only / dead RPC, or check if caller uses an alias');
    }

    console.log(JSON.stringify({
        input: method,
        candidates,
        projects: results,
        stats: { totalHits, projectsWithMethod, projectsWithHits },
        hints,
    }));
}

// ─── Subcommand: detect-entries ───

function detectEntries() {
    // Pattern A: handleRaw* methods
    const rawCallbacks = grep('async handleRaw', [ SERVERS_DIR ]);
    const callbackEntries: { file: string; methods: string[] }[] = [];
    const fileMethodMap = new Map<string, string[]>();

    for (const line of rawCallbacks) {
        const hit = parseGrepLine(line);
        if (!hit) { continue; }
        const m = hit.content.match(/async\s+(handleRaw\w+)\s*\(/);
        if (!m) { continue; }
        const methods = fileMethodMap.get(hit.file) || [];
        methods.push(m[1]);
        fileMethodMap.set(hit.file, methods);
    }

    for (const [ file, methods ] of fileMethodMap) {
        callbackEntries.push({ file: relPath(file), methods });
    }

    // Pattern B: Vendor-related jobs
    let pullJobEntries: { file: string; method: string }[] = [];
    try {
        const jobFiles = execSync(
            `find ${ SERVERS_DIR } -path "*/jobs/*.ts" -exec grep -l "adapter\\|vendor\\|Vendor\\|external\\|External\\|Adapter" {} \\;`,
            { encoding: 'utf-8' }
        ).trim().split('\n').filter(Boolean);

        pullJobEntries = jobFiles.map(f => ({ file: relPath(f), method: 'handleJob' }));
    } catch {}

    console.log(JSON.stringify({ callbackEntries, pullJobEntries }));
}

// ─── Subcommand: reverse-bfs-to-entries ───

function reverseBfsToEntries(
    targetFile: string,
    targetClass: string,
    targetMethod: string,
    server: string,
    entriesJsonPath?: string,
    rpcName?: string
) {
    let entries: { callbackEntries: { file: string; methods: string[] }[]; pullJobEntries: { file: string; method: string }[] };

    if (entriesJsonPath) {
        entries = JSON.parse(readFileSync(entriesJsonPath, 'utf-8'));
    } else {
    // inline detect
        const rawCallbacks = grep('async handleRaw', [ SERVERS_DIR ]);
        const fileMethodMap = new Map<string, string[]>();
        for (const line of rawCallbacks) {
            const hit = parseGrepLine(line);
            if (!hit) { continue; }
            const m = hit.content.match(/async\s+(handleRaw\w+)\s*\(/);
            if (!m) { continue; }
            const methods = fileMethodMap.get(relPath(hit.file)) || [];
            methods.push(m[1]);
            fileMethodMap.set(relPath(hit.file), methods);
        }
        const callbackEntries = [ ...fileMethodMap.entries() ].map(([ file, methods ]) => ({ file, methods }));
        let pullJobEntries: { file: string; method: string }[] = [];
        try {
            const jobFiles = execSync(
                `find ${ SERVERS_DIR } -path "*/jobs/*.ts" -exec grep -l "adapter\\|vendor\\|Vendor\\|external\\|External\\|Adapter" {} \\;`,
                { encoding: 'utf-8' }
            ).trim().split('\n').filter(Boolean);
            pullJobEntries = jobFiles.map(f => ({ file: relPath(f), method: 'handleJob' }));
        } catch {}
        entries = { callbackEntries, pullJobEntries };
    }

    // Build entry lookup
    const entryLookup = new Map<string, { type: string; method: string }>();
    for (const e of entries.callbackEntries) {
        for (const m of e.methods) {
            entryLookup.set(`${ e.file }:${ m }`, { type: 'callback', method: m });
        }
    }
    for (const e of entries.pullJobEntries) {
        entryLookup.set(`${ e.file }:${ e.method }`, { type: 'pull_job', method: e.method });
    }

    interface BfsPath {
        chain: { file: string; line: number; className: string | null; methodName: string | null }[];
        entryType: string | null;
        entryMethod: string | null;
    }

    const allScope = [ join(AGRABAH, 'src') ];
    const visited = new Set<string>();
    const matchedPaths: BfsPath[] = [];
    const noHitPaths: BfsPath[] = [];

    interface BfsNode {
        method: string;
        file: string;
        className: string | null;
        line: number;
        chain: { file: string; line: number; className: string | null; methodName: string | null }[];
    }

    const startNode: BfsNode = {
        method: targetMethod,
        file: targetFile,
        className: targetClass,
        line: findMethodLine(targetFile, targetMethod),
        chain: [ { file: relPath(targetFile), line: findMethodLine(targetFile, targetMethod), className: targetClass, methodName: targetMethod } ],
    };

    // Check if target itself is an entry
    const targetRelPath = relPath(targetFile);
    const targetEntryKey = `${ targetRelPath }:${ targetMethod }`;
    if (entryLookup.has(targetEntryKey)) {
        const entry = entryLookup.get(targetEntryKey)!;
        matchedPaths.push({
            chain: startNode.chain,
            entryType: entry.type,
            entryMethod: entry.method,
        });
        console.log(JSON.stringify({ matchedPaths, noHitPaths, stats: { matchedEntries: 1, matchedPathCount: 1, bfsLayers: 0, visitedTotal: 1 } }));
        return;
    }

    visited.add(`${ targetFile }:${ targetClass }.${ targetMethod }`);
    const queue: BfsNode[] = [ startNode ];
    let maxLayer = 0;

    // For the initial target, also search by RPC name (e.g. ChangeUserBalance vs methodChangeUserBalance)
    const rpcMethodName = rpcName || (targetMethod.startsWith('method')
        ? targetMethod.slice(6)  // methodChangeUserBalance → ChangeUserBalance
        : null);

    while (queue.length > 0) {
        const current = queue.shift()!;
        const searchNames = [ current.method ];
        // Add RPC name only for the initial target
        if (current.chain.length === 1 && rpcMethodName && rpcMethodName !== current.method) {
            searchNames.push(rpcMethodName);
        }

        let allFilteredHits: GrepHit[] = [];
        for (const searchName of searchNames) {
            const rawHits = grep(`\\.${ searchName }\\s*(`, allScope);
            const parsed = rawHits.map(parseGrepLine).filter(Boolean) as GrepHit[];
            const filtered = filterHits(parsed, searchName);
            allFilteredHits.push(...filtered);
        }
        // Deduplicate by file:line
        const seenHitKeys = new Set<string>();
        allFilteredHits = allFilteredHits.filter(h => {
            const k = `${ h.file }:${ h.line }`;
            if (seenHitKeys.has(k)) { return false; }
            seenHitKeys.add(k);
            return true;
        });

        const finalFiltered = allFilteredHits.filter(h => {
            const trimmed = h.content.trim();
            // Skip method definitions for any of the search names
            for (const sn of searchNames) {
                if (trimmed.match(new RegExp(`(async\\s+)?${ sn }\\s*\\(`)) && !trimmed.includes(`.${ sn }`)) { return false; }
            }
            return true;
        });

        let foundCallers = false;

        for (const hit of finalFiltered) {
            const callerClass = extractClassAtLine(hit.file, hit.line);
            const callerMethod = extractMethodAtLine(hit.file, hit.line);
            const key = `${ hit.file }:${ callerClass }.${ callerMethod }`;

            if (visited.has(key)) { continue; }
            visited.add(key);
            foundCallers = true;

            const newChain = [
                { file: relPath(hit.file), line: hit.line, className: callerClass, methodName: callerMethod },
                ...current.chain,
            ];

            const hitRelPath = relPath(hit.file);
            const entryKey1 = `${ hitRelPath }:${ callerMethod }`;
            let isEntry = entryLookup.has(entryKey1);

            // Also check handleRaw* pattern
            if (!isEntry && callerMethod?.startsWith('handleRaw')) {
                for (const e of entries.callbackEntries) {
                    if (hitRelPath === e.file && e.methods.includes(callerMethod)) {
                        isEntry = true;
                        break;
                    }
                }
            }

            // Check handleJob
            if (!isEntry && callerMethod === 'handleJob') {
                for (const e of entries.pullJobEntries) {
                    if (hitRelPath === e.file) {
                        isEntry = true;
                        break;
                    }
                }
            }

            if (isEntry) {
                const entry = entryLookup.get(entryKey1);
                matchedPaths.push({
                    chain: newChain,
                    entryType: entry?.type || (callerMethod?.startsWith('handleRaw') ? 'callback' : 'pull_job'),
                    entryMethod: callerMethod,
                });
            } else {
                if (callerMethod) {
                    const layer = newChain.length;
                    if (layer > maxLayer) { maxLayer = layer; }
                    if (layer < 10 && visited.size < 300) { // safety: depth 10, max 300 nodes
                        queue.push({
                            method: callerMethod,
                            file: hit.file,
                            className: callerClass,
                            line: hit.line,
                            chain: newChain,
                        });
                    }
                }
            }
        }

        if (!foundCallers && current.chain.length > 1) {
            noHitPaths.push({ chain: current.chain, entryType: null, entryMethod: null });
        }
    }

    const matchedEntries = new Set(matchedPaths.map(p => p.entryMethod)).size;

    console.log(JSON.stringify({
        matchedPaths,
        noHitPaths: noHitPaths.slice(0, 10),
        stats: { matchedEntries, matchedPathCount: matchedPaths.length, bfsLayers: maxLayer, visitedTotal: visited.size },
    }));
}

// ─── Subcommand: table-locate ───

function tableLocate(server: string, tableName: string) {
    // Phase 1: exact match
    let hits = grep(`static readonly tableName = '${ tableName }'`, [ DB_TYPES_DIR ]);
    let parsed = hits.map(parseGrepLine).filter(Boolean) as GrepHit[];

    if (parsed.length === 0) {
    // Phase 2A: constant reference
        hits = grep(`= '${ tableName }'`, [ DB_TYPES_DIR ]);
        parsed = hits.map(parseGrepLine).filter(Boolean) as GrepHit[];
    }

    if (parsed.length === 0) {
    // Phase 2B: fuzzy (convert to snake_case and prefix search)
        const snake = tableName.replace(/([A-Z])/g, '_$1').toLowerCase().replace(/^_/, '');
        hits = grep(`static readonly tableName = '${ snake }`, [ DB_TYPES_DIR ]);
        parsed = hits.map(parseGrepLine).filter(Boolean) as GrepHit[];
    }

    // Extract Db class names
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

    // Phase 3: find inheritance-linked classes sharing same tableName
    for (const dc of [ ...dbClasses ]) {
        const inheritHits = grep(`tableName = ${ dc.name }.tableName`, [ DB_TYPES_DIR ]);
        for (const raw of inheritHits) {
            const hit = parseGrepLine(raw);
            if (!hit) { continue; }
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

// ─── Subcommand: table-crud ───

interface CrudHit {
    file: string;
    line: number;
    className: string | null;
    methodName: string | null;
    crudType: string;
    operation: string;
    confidence: 'high' | 'medium' | 'low';
    hint?: string;
    content: string;
}

interface CrudClassification {
    crudType: string;
    operation: string;
    confidence: 'high' | 'medium' | 'low';
    hint?: string;
}

function classifyWithContext(file: string, line: number, content: string, dbClasses: string[]): CrudClassification {
    const lines = readLines(file);
    const contextRadius = 5;
    const start = Math.max(0, line - 1 - contextRadius);
    const end = Math.min(lines.length, line - 1 + contextRadius + 1);
    const context = lines.slice(start, end).join('\n');
    const trimmed = content.trim();

    if (trimmed.includes('insertObject') || trimmed.includes('insertObjects')) {
        return { crudType: 'C', operation: trimmed.includes('insertObjects') ? 'insertObjects' : 'insertObject', confidence: 'high' };
    }
    // V3:`new Db...()` 或 `Db....create(`(廠場 / factory)在當行視為 C_candidate(medium)
    for (const dc of dbClasses) {
        if (trimmed.includes(`new ${ dc }`)) {
            return { crudType: 'C_candidate', operation: `new ${ dc }()`, confidence: 'medium', hint: 'check if followed by insertObject within same method' };
        }
        if (trimmed.includes(`${ dc }.create(`)) {
            return { crudType: 'C_candidate', operation: `${ dc }.create()`, confidence: 'medium', hint: 'check if followed by insertObject within same method' };
        }
    }
    if (trimmed.includes('loadObject') || trimmed.includes('loadObjects')) {
        return { crudType: 'R', operation: trimmed.includes('loadObjects') ? 'loadObjects' : 'loadObject', confidence: 'high' };
    }
    if (trimmed.includes('count(') && !trimmed.includes('retry_count')) {
        return { crudType: 'R', operation: 'count', confidence: 'high' };
    }
    if (trimmed.includes('updateObject')) {
        return { crudType: 'U', operation: 'updateObject', confidence: 'high' };
    }

    if (/SELECT/i.test(trimmed) || /COALESCE/i.test(trimmed) || /SUM\s*\(/i.test(trimmed)) { return { crudType: 'R', operation: 'SELECT SQL', confidence: 'high' }; }
    if (/UPDATE\s+/i.test(trimmed) && /SET\s+/i.test(trimmed)) { return { crudType: 'U', operation: 'UPDATE SQL', confidence: 'high' }; }
    if (/UPDATE\s+/i.test(trimmed) && !/SET\s+/i.test(trimmed) && /SET/i.test(context)) { return { crudType: 'U', operation: 'UPDATE SQL', confidence: 'high' }; }
    if (/DELETE\s+FROM/i.test(trimmed)) { return { crudType: 'D', operation: 'DELETE SQL', confidence: 'high' }; }
    if (/INSERT\s+INTO/i.test(trimmed)) { return { crudType: 'C', operation: 'INSERT SQL', confidence: 'high' }; }

    // Context-aware: check surrounding lines for multi-line expressions
    if (context.includes('loadObject(') || context.includes('loadObjects(')) {
        const aboveLines = lines.slice(start, line - 1);
        for (let i = aboveLines.length - 1; i >= 0; i--) {
            if (aboveLines[i].includes('loadObject(') || aboveLines[i].includes('loadObjects(')) {
                return { crudType: 'R', operation: aboveLines[i].includes('loadObjects') ? 'loadObjects (multi-line)' : 'loadObject (multi-line)', confidence: 'high' };
            }
        }
    }
    if (context.includes('insertObject(') || context.includes('insertObjects(')) {
        const belowLines = lines.slice(line, end);
        for (const bl of belowLines) {
            if (bl.includes('insertObject(') || bl.includes('insertObjects(')) {
                return { crudType: 'C', operation: bl.includes('insertObjects') ? 'insertObjects (multi-line)' : 'insertObject (multi-line)', confidence: 'high' };
            }
        }
    }

    // V3:檢查同 method body 共現「new DbClass() / DbClass.create()」與「insertObject」
    for (const dc of dbClasses) {
        const triggerCtor = trimmed.includes(`new ${ dc }`);
        const triggerFactory = trimmed.includes(`${ dc }.create(`);
        if (triggerCtor || triggerFactory) {
            const belowLines = lines.slice(line, Math.min(lines.length, line + 20));
            for (const bl of belowLines) {
                if (bl.includes('insertObject(') || bl.includes('insertObjects(')) {
                    const op = triggerFactory ? `${ dc }.create() → insertObject` : `new ${ dc }() → insertObject`;
                    return {
                        crudType: 'C_candidate',
                        operation: op,
                        confidence: 'medium',
                        hint: 'indirect: create + insertObject pattern, please verify same variable',
                    };
                }
                if (bl.match(/^\s*\}/)) { break; } // end of block
            }
        }
    }

    return { crudType: 'ref', operation: 'reference', confidence: 'low' };
}

function tableCrud(server: string, tableName: string, dbClassesJson: string) {
    const dbClasses: string[] = JSON.parse(dbClassesJson);
    const scope = [ join(SERVERS_DIR, server), MANAGERS_DIR ];
    const results: CrudHit[] = [];
    const seenKeys = new Set<string>();

    // Wave 1: search by Db class names
    for (const dbClass of dbClasses) {
        const rawHits = grep(dbClass, scope);
        const parsed = rawHits.map(parseGrepLine).filter(Boolean) as GrepHit[];

        for (const hit of parsed) {
            if (isCommentOrImport(hit.content)) { continue; }
            if (hit.file.includes('/generated/')) { continue; }
            if (hit.content.trim().startsWith('type ') || hit.content.trim().startsWith('interface ')) { continue; }

            const className = extractClassAtLine(hit.file, hit.line);
            const methodName = extractMethodAtLine(hit.file, hit.line);
            const content = hit.content.trim();
            const key = `${ hit.file }:${ hit.line }`;
            if (seenKeys.has(key)) { continue; }
            seenKeys.add(key);

            const cls = classifyWithContext(hit.file, hit.line, hit.content, dbClasses);

            results.push({
                file: relPath(hit.file),
                line: hit.line,
                className,
                methodName,
                crudType: cls.crudType,
                operation: cls.operation,
                confidence: cls.confidence,
                hint: cls.hint,
                content,
            });
        }
    }

    // Wave 2: search by string table name (raw SQL)
    const rawTableHits = grep(tableName, scope);
    const parsedTable = rawTableHits.map(parseGrepLine).filter(Boolean) as GrepHit[];

    for (const hit of parsedTable) {
        const key = `${ hit.file }:${ hit.line }`;
        if (seenKeys.has(key)) { continue; }
        if (isCommentOrImport(hit.content)) { continue; }
        if (hit.file.includes('/generated/')) { continue; }
        seenKeys.add(key);

        const className = extractClassAtLine(hit.file, hit.line);
        const methodName = extractMethodAtLine(hit.file, hit.line);
        const content = hit.content.trim();

        const { crudType, operation } = classifyWithContext(hit.file, hit.line, hit.content, dbClasses);

        results.push({
            file: relPath(hit.file),
            line: hit.line,
            className,
            methodName,
            crudType,
            operation,
            content,
        });
    }

    // Wave 3: search for raw SQL patterns using ${DbClass.tableName}
    for (const dbClass of dbClasses) {
        const sqlHits = grep(`\${${ dbClass }.tableName}`, scope);
        const parsedSql = sqlHits.map(parseGrepLine).filter(Boolean) as GrepHit[];
        for (const hit of parsedSql) {
            const key = `${ hit.file }:${ hit.line }`;
            if (seenKeys.has(key)) { continue; }
            seenKeys.add(key);

            const className = extractClassAtLine(hit.file, hit.line);
            const methodName = extractMethodAtLine(hit.file, hit.line);
            const content = hit.content.trim();

            const cls = classifyWithContext(hit.file, hit.line, hit.content, dbClasses);

            results.push({
                file: relPath(hit.file),
                line: hit.line,
                className,
                methodName,
                crudType: cls.crudType,
                operation: cls.operation,
                confidence: cls.confidence,
                hint: cls.hint,
                content,
            });
        }
    }

    // Group and deduplicate by method
    const methodMap = new Map<string, CrudHit[]>();
    for (const r of results) {
        if (r.crudType === 'ref') { continue; }
        const key = `${ r.className }.${ r.methodName }`;
        const existing = methodMap.get(key) || [];
        existing.push(r);
        methodMap.set(key, existing);
    }

    const create = [ ...methodMap.entries() ].filter(([ _, hits ]) => hits.some(h => h.crudType === 'C' || h.crudType === 'C_candidate'));
    const read = [ ...methodMap.entries() ].filter(([ _, hits ]) => hits.some(h => h.crudType === 'R'));
    const update = [ ...methodMap.entries() ].filter(([ _, hits ]) => hits.some(h => h.crudType === 'U'));
    const del = [ ...methodMap.entries() ].filter(([ _, hits ]) => hits.some(h => h.crudType === 'D'));

    console.log(JSON.stringify({
        crud: {
            C: create.map(([ key, hits ]) => ({ method: key, hits: hits.filter(h => h.crudType === 'C' || h.crudType === 'C_candidate') })),
            R: read.map(([ key, hits ]) => ({ method: key, hits: hits.filter(h => h.crudType === 'R') })),
            U: update.map(([ key, hits ]) => ({ method: key, hits: hits.filter(h => h.crudType === 'U') })),
            D: del.map(([ key, hits ]) => ({ method: key, hits: hits.filter(h => h.crudType === 'D') })),
        },
        allRefs: results.filter(r => r.crudType === 'ref'),
        stats: {
            createMethods: create.length,
            readMethods: read.length,
            updateMethods: update.length,
            deleteMethods: del.length,
            totalCrudMethods: new Set([ ...create, ...read, ...update, ...del ].map(([ k ]) => k)).size,
        },
        bfsTargets: [ ...new Set([ ...create, ...read, ...update, ...del ].map(([ k, hits ]) => {
            const h = hits[0];
            return JSON.stringify({ file: h.file, line: h.line, className: h.className, methodName: h.methodName });
        })) ].map(s => JSON.parse(s)),
    }));
}

// ─── Subcommand: table-bfs ───

function tableBfs(server: string, targetsJson: string) {
    const targets: { file: string; line: number; className: string; methodName: string }[] = JSON.parse(targetsJson);
    const scope = [ join(SERVERS_DIR, server), MANAGERS_DIR ];

    interface TargetBfsResult {
        target: { className: string; methodName: string; file: string; line: number };
        callers: CallerHit[];
        stats: { directCount: number; transitiveCount: number; maxLevel: number };
    }

    const results: TargetBfsResult[] = [];

    for (const target of targets) {
        const visited = new Set<string>();
        const callers: CallerHit[] = [];
        const queue: { method: string; file: string; className: string; line: number; level: number; calledBy: string | null }[] = [];

        const absFile = join(AGRABAH, target.file);
        queue.push({ method: target.methodName, file: absFile, className: target.className, line: target.line, level: 0, calledBy: null });
        visited.add(`${ absFile }:${ target.className }.${ target.methodName }`);

        while (queue.length > 0) {
            const current = queue.shift()!;
            const rawHits = grep(`\\.${ current.method }\\s*(`, scope);
            const parsed = rawHits.map(parseGrepLine).filter(Boolean) as GrepHit[];
            const filtered = filterHits(parsed, current.method);

            const finalFiltered = filtered.filter(h => {
                const trimmed = h.content.trim();
                if (trimmed.match(new RegExp(`(async\\s+)?${ current.method }\\s*\\(`)) && !trimmed.includes(`.${ current.method }`)) { return false; }
                if (h.content.includes('context.remote.')) { return false; }
                return true;
            });

            for (const hit of finalFiltered) {
                const callerClass = extractClassAtLine(hit.file, hit.line);
                const callerMethod = extractMethodAtLine(hit.file, hit.line);
                const key = `${ hit.file }:${ callerClass }.${ callerMethod }`;

                if (visited.has(key)) { continue; }
                visited.add(key);

                let receiverType = 'this';
                let needsVerification = false;
                if (!hit.content.includes('this.')) {
                    receiverType = 'other';
                    needsVerification = true;
                }

                callers.push({
                    file: relPath(hit.file),
                    line: hit.line,
                    className: callerClass,
                    methodName: callerMethod,
                    content: hit.content.trim(),
                    level: current.level + 1,
                    calledBy: `${ current.className }.${ current.method }`,
                    receiverType,
                    needsVerification,
                });

                if (callerMethod && callerClass && current.level < 10) {
                    queue.push({
                        method: callerMethod,
                        file: hit.file,
                        className: callerClass,
                        line: hit.line,
                        level: current.level + 1,
                        calledBy: `${ callerClass }.${ callerMethod }`,
                    });
                }
            }
        }

        const maxLevel = callers.reduce((max, c) => Math.max(max, c.level), 0);
        results.push({
            target: { className: target.className, methodName: target.methodName, file: target.file, line: target.line },
            callers: callers.map(c => ({ ...c })),
            stats: { directCount: callers.filter(c => c.level === 1).length, transitiveCount: callers.filter(c => c.level > 1).length, maxLevel },
        });
    }

    console.log(JSON.stringify({ results }));
}

// ─── Main dispatcher ───

const args = process.argv.slice(2);
const cmd = args[0];

function safeRun(label: string, fn: () => void) {
    try {
        fn();
    } catch (err: any) {
        // V3 fix:dispatcher 層 try/catch 防護,輸出可解析 JSON 而非整個 process abort
        console.log(JSON.stringify({
            error: 'subcommand_failed',
            subcommand: label,
            message: err?.message ?? String(err),
            stack: err?.stack?.split('\n').slice(0, 5).join('\n'),
        }));
        process.exit(2);
    }
}

switch (cmd) {
    case 'resolve-method':
        safeRun('resolve-method', () => resolveMethod(args[1]));
        break;

    case 'same-server-callers': {
        const file = args[1];
        const cls = args[2];
        const method = args[3];
        const server = args[4];
        const baseClassArg = args.find(a => a.startsWith('--base-class='));
        const baseMethodArg = args.find(a => a.startsWith('--base-method='));
        safeRun('same-server-callers', () => sameServerCallers(file, cls, method, server, baseClassArg?.split('=')[1], baseMethodArg?.split('=')[1]));
        break;
    }

    case 'cross-server-callers':
        safeRun('cross-server-callers', () => crossServerCallers(args[1], args[2], args[3]));
        break;

    case 'frontend-callers':
        safeRun('frontend-callers', () => frontendCallers(args[1]));
        break;

    case 'detect-entries':
        detectEntries();
        break;

    case 'reverse-bfs-to-entries': {
        const entriesArg = args.find(a => a.startsWith('--entries-json='));
        const rpcNameArg = args.find(a => a.startsWith('--rpc-name='));
        reverseBfsToEntries(args[1], args[2], args[3], args[4], entriesArg?.split('=')[1], rpcNameArg?.split('=')[1]);
        break;
    }

    case 'table-locate':
        tableLocate(args[1], args[2]);
        break;

    case 'table-crud':
        tableCrud(args[1], args[2], args[3]);
        break;

    case 'table-bfs':
        tableBfs(args[1], args[2]);
        break;

    default:
        console.error(`Unknown command: ${ cmd }`);
        console.error('Available: resolve-method, same-server-callers, cross-server-callers, frontend-callers, detect-entries, reverse-bfs-to-entries, table-locate, table-crud, table-bfs');
        process.exit(1);
}
