import { describe, test, expect } from 'bun:test';
import { runWriteback, type WritebackAction } from './writeback-jsdoc.ts';
import { readFile, copyFile } from 'node:fs/promises';
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
