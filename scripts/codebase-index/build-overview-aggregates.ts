import { Glob } from 'bun';
import { parseNote, type ParsedNote } from './lib/note-parser.ts';
import { readFile, writeFile } from 'node:fs/promises';

const ROOT = '/Users/user/aladdin/obsidian/Codebase';
const AUTO_MARKER = '<!-- AUTO-GENERATED AGGREGATE -->';

function updateSection(raw: string, sectionHeader: string, newContent: string): string | null {
    const lines = raw.split('\n');
    const start = lines.findIndex(l => l.trim() === sectionHeader);
    if (start === -1) return null;

    const end = lines.findIndex((l, i) => i > start && /^#{1,4}\s/.test(l));
    const realEnd = end === -1 ? lines.length : end;

    const before = lines.slice(0, start + 1).join('\n');
    const after = lines.slice(realEnd).join('\n');
    const body = [AUTO_MARKER, newContent].join('\n');
    return [before, body, after].filter(s => s !== '').join('\n');
}

async function main() {
    const glob = new Glob('**/*.md');
    const notes = new Map<string, ParsedNote>();

    for await (const rel of glob.scan(ROOT)) {
        const path = `${ROOT}/${rel}`;
        const note = await parseNote(path);
        if (note) notes.set(note.fqn, note);
    }
    console.log(`Loaded ${notes.size} notes`);

    // Server name → set of DB ORM FQNs
    const serverDbOrms = new Map<string, Set<string>>();
    // Server name → set of DB schema FQNs
    const serverDbSchemas = new Map<string, Set<string>>();
    // Service FQN → set of RPC method FQNs
    const serviceMethods = new Map<string, Set<string>>();
    // Manager FQN → set of manager method FQNs
    const managerMethods = new Map<string, Set<string>>();

    for (const note of notes.values()) {
        const fm = note.frontmatter;

        if (note.type === 'db-orm' && fm.server) {
            if (!serverDbOrms.has(fm.server)) serverDbOrms.set(fm.server, new Set());
            serverDbOrms.get(fm.server)!.add(note.fqn);
        }

        if (note.type === 'db-schema' && fm.server) {
            if (!serverDbSchemas.has(fm.server)) serverDbSchemas.set(fm.server, new Set());
            serverDbSchemas.get(fm.server)!.add(note.fqn);
        }

        if (note.type === 'rpc-method') {
            // FQN = Server.Service.method → service FQN = Server.Service
            const parts = note.fqn.split('.');
            if (parts.length >= 3) {
                const serviceFqn = parts.slice(0, 2).join('.');
                if (!serviceMethods.has(serviceFqn)) serviceMethods.set(serviceFqn, new Set());
                serviceMethods.get(serviceFqn)!.add(note.fqn);
            }
        }

        if (note.type === 'manager-method') {
            // FQN = Manager.X.method → manager FQN = Manager.X
            const parts = note.fqn.split('.');
            if (parts.length >= 3) {
                const managerFqn = parts.slice(0, 2).join('.');
                if (!managerMethods.has(managerFqn)) managerMethods.set(managerFqn, new Set());
                managerMethods.get(managerFqn)!.add(note.fqn);
            }
        }
    }

    let modifiedCount = 0;

    for (const [fqn, note] of notes) {
        let raw = await readFile(note.path, 'utf-8');
        let modified = false;

        if (note.type === 'server-overview') {
            const serverName = note.frontmatter.server ?? fqn;

            const orms = [...(serverDbOrms.get(serverName) ?? [])].sort();
            const ormContent = orms.length
                ? orms.map(o => `- [[${o}]]`).join('\n')
                : '（尚無 DB ORM 筆記；待 Milestone 擴展時補齊）';
            const updated1 = updateSection(raw, '## 擁有的 DB tables', ormContent);
            if (updated1 && updated1 !== raw) {
                raw = updated1;
                modified = true;
            }

            // Jobs/Messages 不在 Milestone 1 範疇;改寫誠實的訊息而非錯誤的 Phase 3 佔位
            const jobMsg = '（Jobs / Messages 尚未納入本 Milestone 掃描範疇；將於後續 Milestone 補齊）';
            const updated2 = updateSection(raw, '## 擁有的 Jobs / Messages', jobMsg);
            if (updated2 && updated2 !== raw) {
                raw = updated2;
                modified = true;
            }
        }

        if (note.type === 'service-overview') {
            const methods = [...(serviceMethods.get(fqn) ?? [])].sort();
            const content = methods.length
                ? methods.map(m => `- [[${m}]]`).join('\n')
                : '（無 RPC method 筆記）';
            const updated = updateSection(raw, '## Methods', content);
            if (updated && updated !== raw) {
                raw = updated;
                modified = true;
            }

            // Used By: 聚合本 service 下所有 method 的 caller 所屬 server(非 self)
            const ownMethods = serviceMethods.get(fqn) ?? new Set();
            const callerServers = new Set<string>();
            const ownServer = note.frontmatter.server ?? fqn.split('.')[0];
            for (const note2 of notes.values()) {
                if (note2.type !== 'rpc-method' && note2.type !== 'manager-method') continue;
                const callees = [
                    ...note2.calls.managerMethods,
                    ...note2.calls.rpcCrossServer,
                    ...note2.calls.otherManagers,
                ];
                for (const callee of callees) {
                    if (ownMethods.has(callee)) {
                        const callerServer = note2.fqn.startsWith('Manager.')
                            ? null
                            : note2.fqn.split('.')[0];
                        if (callerServer && callerServer !== ownServer) callerServers.add(callerServer);
                    }
                }
            }
            const callers = [...callerServers].sort();
            const ubContent = callers.length
                ? callers.map(s => `- [[${s}]]`).join('\n')
                : '（目前尚無本 Milestone 範疇內的跨 server 呼叫者；隨其他 server 納入會補齊）';
            const updated2 = updateSection(raw, '## Used By', ubContent);
            if (updated2 && updated2 !== raw) {
                raw = updated2;
                modified = true;
            }
        }

        if (note.type === 'manager-overview') {
            // _manager.md 內的 ## Used By Servers : 聚合 manager 所有 method 被哪些 server 的 method 呼叫 → 推回 server 名
            const managerMethodsSet = managerMethods.get(fqn) ?? new Set();
            const callerServers = new Set<string>();
            for (const note2 of notes.values()) {
                if (note2.type !== 'rpc-method' && note2.type !== 'manager-method') continue;
                const callees = [
                    ...note2.calls.managerMethods,
                    ...note2.calls.otherManagers,
                ];
                for (const callee of callees) {
                    if (managerMethodsSet.has(callee)) {
                        const serverName = note2.fqn.split('.')[0];
                        if (serverName && note2.type === 'rpc-method') callerServers.add(serverName);
                    }
                }
            }
            const callers = [...callerServers].sort();
            const content = callers.length
                ? callers.map(s => `- [[${s}]]`).join('\n')
                : '（目前尚無本 Milestone 範疇內的後端呼叫者）';
            const updated = updateSection(raw, '## Used By Servers', content);
            if (updated && updated !== raw) {
                raw = updated;
                modified = true;
            }
        }

        if (modified) {
            await writeFile(note.path, raw);
            modifiedCount++;
        }
    }

    console.log(`Modified ${modifiedCount} overview files`);
}

await main();
