import { Glob } from 'bun';
import { parseNote, type ParsedNote } from './lib/note-parser.ts';
import { readFile, writeFile } from 'node:fs/promises';

const ROOT = '/Users/user/aladdin/obsidian/Codebase';

const AUTO_MARKER = '<!-- AUTO-GENERATED BACKLINKS -->';

function updateSection(raw: string, sectionHeader: string, newContent: string): string | null {
    const lines = raw.split('\n');
    const start = lines.findIndex(l => l.trim() === sectionHeader);
    if (start === -1) return null;

    const end = lines.findIndex((l, i) => i > start && /^#{1,4}\s/.test(l));
    const realEnd = end === -1 ? lines.length : end;

    // Replace the entire section body. Any obsolete placeholder comments
    // (e.g., "<!-- Phase 3 will fill this -->") are intentionally dropped so
    // readers aren't misled into thinking backlinks haven't been populated yet.
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

    const calledBy = new Map<string, Set<string>>();
    const usedBy = new Map<string, Set<string>>();
    const accessedBy = new Map<string, Set<string>>();

    function add(map: Map<string, Set<string>>, target: string, source: string) {
        if (!map.has(target)) map.set(target, new Set());
        map.get(target)!.add(source);
    }

    const brokenLinks: Array<{ from: string; to: string; kind: string }> = [];

    for (const note of notes.values()) {
        const recordCall = (target: string, kind: string) => {
            if (!notes.has(target)) {
                brokenLinks.push({ from: note.fqn, to: target, kind });
                return;
            }
            const targetType = notes.get(target)!.type;
            if (targetType === 'rpc-method' || targetType === 'manager-method') {
                add(calledBy, target, note.fqn);
            } else if (targetType === 'model' || targetType === 'enum') {
                add(usedBy, target, note.fqn);
            } else if (targetType === 'db-orm') {
                add(usedBy, target, note.fqn);
            } else if (targetType === 'db-schema') {
                add(accessedBy, target, note.fqn);
            }
        };

        for (const c of note.calls.managerMethods) recordCall(c, 'manager-method');
        for (const c of note.calls.rpcCrossServer) recordCall(c, 'rpc');
        for (const c of note.calls.otherManagers) recordCall(c, 'manager-method');
        for (const c of note.calls.dbOperations) recordCall(c, 'db-orm');

        for (const link of note.otherOutgoingLinks) {
            if (!notes.has(link)) continue;
            const linkType = notes.get(link)!.type;
            if (linkType === 'model' || linkType === 'enum') {
                add(usedBy, link, note.fqn);
            } else if (linkType === 'db-orm') {
                add(usedBy, link, note.fqn);
            } else if (linkType === 'db-schema') {
                add(accessedBy, link, note.fqn);
            }
        }
    }

    let modifiedCount = 0;
    for (const [targetFqn, targetNote] of notes) {
        let raw = await readFile(targetNote.path, 'utf-8');
        let modified = false;

        if (targetNote.type === 'rpc-method' || targetNote.type === 'manager-method') {
            const sources = [...(calledBy.get(targetFqn) ?? [])].sort();
            const content = sources.length ? sources.map(s => `- [[${s}]]`).join('\n') : '（無後端呼叫者，可能是前端 entry point 或尚未被呼叫）';
            const updated = updateSection(raw, '### Called By', content);
            if (updated && updated !== raw) {
                raw = updated;
                modified = true;
            }
        }

        if (targetNote.type === 'model' || targetNote.type === 'enum' || targetNote.type === 'db-orm') {
            const sources = [...(usedBy.get(targetFqn) ?? [])].sort();
            const content = sources.length ? sources.map(s => `- [[${s}]]`).join('\n') : '（無呼叫者記錄）';
            let updated = updateSection(raw, '## Used By Methods', content);
            if (!updated) updated = updateSection(raw, '## Used By', content);
            if (updated && updated !== raw) {
                raw = updated;
                modified = true;
            }
        }

        if (targetNote.type === 'db-schema') {
            const sources = [...(accessedBy.get(targetFqn) ?? [])].sort();
            const content = sources.length ? sources.map(s => `- [[${s}]]`).join('\n') : '（無讀寫記錄）';
            const updated = updateSection(raw, '## Accessed By', content);
            if (updated && updated !== raw) {
                raw = updated;
                modified = true;
            }
        }

        if (modified) {
            await writeFile(targetNote.path, raw);
            modifiedCount++;
        }
    }

    console.log(`Modified ${modifiedCount} files`);
    console.log(`Broken links: ${brokenLinks.length}`);

    const brokenReport = [
        '# Broken Links Report',
        '',
        `Generated: ${new Date().toISOString()}`,
        `Total broken: ${brokenLinks.length}`,
        '',
        '> 斷裂連結 = 來源筆記引用了尚未建立的目標筆記。Milestone 1 僅建立 wallet/app/core/payment 4 個 server + common/service_common + WalletManager/CurrencyManager + Wallet DB。其他 server / manager 的連結會斷裂，屬預期行為，全面展開後會補齊。',
        '',
        '| Source FQN | Target FQN | Kind |',
        '|------------|------------|------|',
        ...brokenLinks.sort((a, b) => a.to.localeCompare(b.to)).map(b => `| \`${b.from}\` | \`${b.to}\` | ${b.kind} |`),
    ].join('\n');
    await writeFile(`${ROOT}/_index/broken-links-report.md`, brokenReport);
    console.log(`Wrote broken links report`);
}

await main();
