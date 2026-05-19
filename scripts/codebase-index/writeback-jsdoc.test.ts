import { describe, test, expect } from 'bun:test';
import { runWriteback, loadProcessedActions, type WritebackAction } from './writeback-jsdoc.ts';
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

describe('loadProcessedActions parses pending-actions.json', () => {
    test('handles bare array format without throwing', async () => {
        // Save original pending-actions.json, write a minimal one, restore.
        const ORIG_PATH = '/Users/user/aladdin/obsidian/scripts/codebase-index/pending-actions.json';
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
