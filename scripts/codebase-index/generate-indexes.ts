import { Glob } from 'bun';
import { parseNote, type ParsedNote } from './lib/note-parser.ts';
import { writeFile } from 'node:fs/promises';

const ROOT = '/Users/user/aladdin/obsidian/Codebase';
const INDEX_DIR = `${ROOT}/_index`;

async function main() {
    const glob = new Glob('**/*.md');
    const byType = new Map<string, ParsedNote[]>();
    for await (const rel of glob.scan(ROOT)) {
        const note = await parseNote(`${ROOT}/${rel}`);
        if (!note || !note.fqn || !note.type) continue;
        if (!byType.has(note.type)) byType.set(note.type, []);
        byType.get(note.type)!.push(note);
    }

    const indexes = [
        { file: 'servers-index.md', types: ['server-overview'], title: 'Servers' },
        { file: 'services-index.md', types: ['service-overview'], title: 'Services' },
        { file: 'rpc-methods-index.md', types: ['rpc-method'], title: 'RPC Methods' },
        { file: 'managers-index.md', types: ['manager-overview', 'manager-method'], title: 'Managers' },
        { file: 'models-index.md', types: ['model'], title: 'Models' },
        { file: 'enums-index.md', types: ['enum'], title: 'Enums' },
        { file: 'db-tables-index.md', types: ['db-orm', 'db-schema'], title: 'DB Tables' },
        { file: 'rajah-files-index.md', types: ['rajah-file'], title: 'Rajah Files' },
    ];

    for (const spec of indexes) {
        const items: ParsedNote[] = [];
        for (const t of spec.types) items.push(...(byType.get(t) ?? []));
        items.sort((a, b) => a.fqn.localeCompare(b.fqn));
        const lines = [
            `# ${spec.title} Index`,
            '',
            `Generated: ${new Date().toISOString()}`,
            `Total: ${items.length} entries`,
            '',
            '| FQN | Type | Source File |',
            '|-----|------|-------------|',
            ...items.map(n => `| [[${n.fqn}]] | \`${n.type}\` | \`${n.frontmatter.source_file ?? ''}\` |`),
        ];
        await writeFile(`${INDEX_DIR}/${spec.file}`, lines.join('\n') + '\n');
        console.log(`Wrote ${spec.file} (${items.length} entries)`);
    }

    // Type summary
    const summaryLines = [
        '# Codebase Index — Overview',
        '',
        `Generated: ${new Date().toISOString()}`,
        '',
        '## 類型統計',
        '',
        '| Type | Count | Index |',
        '|------|-------|-------|',
    ];
    for (const spec of indexes) {
        const count = spec.types.reduce((s, t) => s + (byType.get(t)?.length ?? 0), 0);
        summaryLines.push(`| ${spec.title} | ${count} | [[${spec.file.replace('.md', '')}]] |`);
    }
    summaryLines.push('');
    summaryLines.push('## 其他索引');
    summaryLines.push('');
    summaryLines.push('- [[cross-server-rpc-graph]] — 跨服務 RPC 呼叫圖');
    summaryLines.push('- [[broken-links-report]] — 斷裂連結（跨 Milestone 範疇的預期斷裂）');
    summaryLines.push('- [[orphan-notes-report]] — 孤立筆記（無呼叫者的 RPC method）');
    summaryLines.push('');

    await writeFile(`${INDEX_DIR}/overview.md`, summaryLines.join('\n') + '\n');
    console.log('Wrote overview.md');
}

await main();
