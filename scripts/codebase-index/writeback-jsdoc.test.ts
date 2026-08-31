import { describe, test, expect } from 'bun:test';
import { runWriteback, loadProcessedActions, type WritebackAction } from './writeback-jsdoc.ts';
import { extractJsdocAbove } from './lib/jsdoc-extractor.ts';
import { parseJsdoc } from './lib/jsdoc-parser.ts';
import { renderJsdoc } from './lib/jsdoc-renderer.ts';
import { normalizeKey, mergeBullets } from './lib/section-merger.ts';
import { readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const FIXTURES = resolve(__dirname, 'lib/test-fixtures');
const SOURCE_FIXTURE = resolve(FIXTURES, 'register-source-step15.ts.snippet');
const SOURCE_WORK = resolve(FIXTURES, '_register-source-work.ts.snippet');
const NOTE_FIXTURE = resolve(FIXTURES, 'register-note.md');

async function setupWorkCopy() {
    await copyFile(SOURCE_FIXTURE, SOURCE_WORK);
}

describe('runWriteback (trackEvent regression case)', () => {
    test('preserves source-only "送 trackEvent" through merge', async () => {
        await setupWorkCopy();
        const action: WritebackAction = {
            noteAbsPath: NOTE_FIXTURE,
            sourceAbsPath: SOURCE_WORK,
            declarationLine: 14,
        };
        const report = await runWriteback([action], { dryRun: false });
        expect(report.modified.length + report.unchanged.length).toBe(1);

        const result = await readFile(SOURCE_WORK, 'utf-8');
        expect(result).toContain('送 trackEvent(userRegister, success) 埋點');
        expect(result).toContain('trackEvent、updatePlatformStatistic、RecordUserLogin');
    });

    test('idempotent: running twice produces no second-pass change', async () => {
        await setupWorkCopy();
        const action: WritebackAction = {
            noteAbsPath: NOTE_FIXTURE,
            sourceAbsPath: SOURCE_WORK,
            declarationLine: 14,
        };
        await runWriteback([action], { dryRun: false });
        const after1 = await readFile(SOURCE_WORK, 'utf-8');
        const report2 = await runWriteback([action], { dryRun: false });
        const after2 = await readFile(SOURCE_WORK, 'utf-8');
        expect(after1).toBe(after2);
        expect(report2.unchanged.length).toBe(1);
        expect(report2.modified.length).toBe(0);
    });

    test('dryRun does not write file', async () => {
        await setupWorkCopy();
        const before = await readFile(SOURCE_WORK, 'utf-8');
        const action: WritebackAction = {
            noteAbsPath: NOTE_FIXTURE,
            sourceAbsPath: SOURCE_WORK,
            declarationLine: 14,
        };
        await runWriteback([action], { dryRun: true });
        const after = await readFile(SOURCE_WORK, 'utf-8');
        expect(after).toBe(before);
    });
});

describe('merge engine bug fixes', () => {
    test('single-line JSDoc: description carries no /** or */ literals', () => {
        const source = [
            'class X {',
            '    /** 更新匯率 & 有效位數 & 顯示位數 */',
            '    async methodUpdateRate() {}',
            '}',
        ].join('\n');
        const block = extractJsdocAbove(source, 3);
        expect(block).not.toBeNull();
        const parsed = parseJsdoc(block!.text);
        const desc = parsed.description.sentences.join('');
        expect(desc).not.toContain('/**');
        expect(desc).not.toContain('*/');
        expect(desc).toContain('更新匯率');
        // rendered output must not contain a nested open or a premature close
        const inner = renderJsdoc(parsed, '    ').split('\n').slice(1, -1);
        for (const l of inner) {
            expect(l).not.toContain('*/');
            expect(l).not.toContain('/**');
        }
    });

    test('non-integer declarationLine returns null instead of crashing', () => {
        const source = 'a\nb\nc';
        expect(extractJsdocAbove(source, NaN)).toBeNull();
        expect(extractJsdocAbove(source, '7' as unknown as number)).toBeNull();
    });

    test('normalizeKey: cosmetic variants compare equal', () => {
        const a = normalizeKey('所有 method `@NoPublic`，不可由 Abu 直接呼叫，見 NoPublic、Internal Service。');
        const b = normalizeKey('所有 method @NoPublic，不可由 Abu 直接呼叫，見「NoPublic」、「Internal Service」。');
        expect(a).toBe(b);
    });

    test('mergeBullets: cosmetically reworded bullet does not duplicate', () => {
        const source = ['所有 method `@NoPublic`，不可由 Abu 直接呼叫，見 NoPublic、Internal Service。'];
        const note = ['所有 method @NoPublic，不可由 Abu 直接呼叫，見「NoPublic」、「Internal Service」。'];
        const merged = mergeBullets(source, note);
        expect(merged.length).toBe(1);
        expect(merged[0]).toBe(source[0]); // exact match → source text preserved
    });

    test('mergeBullets: a note that strictly extends a source bullet wins, no dup', () => {
        const source = ['置頂段只出現在第 1 頁：條件 is_pinned = 1 AND pin_expire_at > NOW()'];
        const note = ['置頂段只出現在第 1 頁：條件 is_pinned = 1 AND pin_expire_at > NOW()，前提假設同時有效置頂量小於 pageSize'];
        const merged = mergeBullets(source, note);
        expect(merged.length).toBe(1);
        expect(merged[0]).toBe(note[0]); // note extends source → note wins
    });

    test('mergeBullets: genuinely divergent bullets are both kept (conservative)', () => {
        const source = ['冪等鍵 platform_id work_id 同一個 work_id 不會重發 見 notif_internal.ts:35'];
        const note = ['冪等鍵 platform_id work_id 同一個 work_id 不會重發 見 notif_internal.ts:63'];
        expect(mergeBullets(source, note).length).toBe(2);
    });

    test('parseJsdoc: a bare non-bullet line in a section is preserved', () => {
        const jsdoc = ['/**', ' * **備註**', ' * [TBD: 需開發者補充]', ' */'].join('\n');
        const parsed = parseJsdoc(jsdoc);
        expect(parsed.notes.bullets).toContain('[TBD: 需開發者補充]');
    });
});

describe('loadProcessedActions parses pending-actions.json', () => {
    test('handles bare array format without throwing', async () => {
        // Save original pending-actions.json, write a minimal one, restore.
        const ORIG_PATH = '/Users/user/aladdin/aladdin_ai/scripts/codebase-index/pending-actions.json';
        const BAK_PATH = ORIG_PATH + '.bak-test';
        const orig = await readFile(ORIG_PATH, 'utf-8');
        await writeFile(BAK_PATH, orig);
        try {
            await writeFile(ORIG_PATH, '[]');
            const { loadProcessedActions } = await import('./writeback-jsdoc.ts');
            const actions = await loadProcessedActions();
            expect(Array.isArray(actions)).toBe(true);
            expect(actions.length).toBe(0);
        } finally {
            await writeFile(ORIG_PATH, orig);
            await rm(BAK_PATH);
        }
    });
});
