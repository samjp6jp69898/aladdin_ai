import { Glob } from 'bun';
import { parseNote, type ParsedNote } from './lib/note-parser.ts';
import { writeFile } from 'node:fs/promises';

const ROOT = '/Users/user/aladdin/obsidian/Codebase';

async function main() {
    const glob = new Glob('**/*.md');
    const notes = new Map<string, ParsedNote>();
    for await (const rel of glob.scan(ROOT)) {
        const note = await parseNote(`${ROOT}/${rel}`);
        if (note) notes.set(note.fqn, note);
    }

    const incoming = new Map<string, Set<string>>();
    for (const note of notes.values()) {
        const outgoing = [
            ...note.calls.managerMethods,
            ...note.calls.rpcCrossServer,
            ...note.calls.otherManagers,
            ...note.calls.dbOperations,
        ];
        for (const target of outgoing) {
            if (!incoming.has(target)) incoming.set(target, new Set());
            incoming.get(target)!.add(note.fqn);
        }
    }

    const methods = [...notes.values()].filter(n => n.type === 'rpc-method' || n.type === 'manager-method');
    const orphans = methods.filter(n => (incoming.get(n.fqn)?.size ?? 0) === 0);

    const lines = [
        '# Orphan Notes Report',
        '',
        `Generated: ${new Date().toISOString()}`,
        `Total methods (rpc + manager): ${methods.length}`,
        `Orphans (no backend callers): ${orphans.length}`,
        '',
        '> 孤立筆記 = 沒有任何後端筆記指向它的 RPC method / manager method。有可能是：(1) 前端 entry point（公開 RPC，由前端呼叫）；(2) 跨 Milestone 呼叫者尚未建立；(3) 真的未被使用。需人工判斷。',
        '',
        '## Orphans by Type',
        '',
        `- RPC methods: ${orphans.filter(o => o.type === 'rpc-method').length}`,
        `- Manager methods: ${orphans.filter(o => o.type === 'manager-method').length}`,
        '',
        '## 完整清單',
        '',
        '| FQN | Type | Access |',
        '|-----|------|--------|',
    ];
    orphans.sort((a, b) => a.fqn.localeCompare(b.fqn));
    for (const o of orphans) {
        lines.push(`| [[${o.fqn}]] | ${o.type} | ${o.frontmatter.access ?? '-'} |`);
    }

    await writeFile(`${ROOT}/_index/orphan-notes-report.md`, lines.join('\n') + '\n');
    console.log(`Wrote orphan-notes-report.md (${orphans.length} orphans)`);
}

await main();
