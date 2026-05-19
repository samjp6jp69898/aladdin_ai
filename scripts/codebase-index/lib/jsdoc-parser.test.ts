import { describe, test, expect } from 'bun:test';
import { parseJsdoc } from './jsdoc-parser.ts';

describe('parseJsdoc', () => {
    test('parses description with single sentence', () => {
        const jsdoc = [
            '/**',
            ' * Single sentence.',
            ' */',
        ].join('\n');
        const result = parseJsdoc(jsdoc);
        expect(result.description.sentences).toEqual(['Single sentence.']);
        expect(result.scenarios.bullets).toEqual([]);
        expect(result.rules.bullets).toEqual([]);
        expect(result.notes.bullets).toEqual([]);
    });

    test('splits description by 。 ； . ;', () => {
        const jsdoc = [
            '/**',
            ' * 主流程。詳細步驟：1) foo；2) bar；3) baz。',
            ' */',
        ].join('\n');
        const result = parseJsdoc(jsdoc);
        expect(result.description.sentences).toEqual([
            '主流程。',
            '詳細步驟：1) foo；',
            '2) bar；',
            '3) baz。',
        ]);
    });

    test('parses bullets under **業務場景** etc.', () => {
        const jsdoc = [
            '/**',
            ' * Main desc.',
            ' *',
            ' * **業務場景**',
            ' * - scenario one',
            ' * - scenario two',
            ' *',
            ' * **相關規則與踩坑**',
            ' * - rule one',
            ' *',
            ' * **備註**',
            ' * - note one',
            ' */',
        ].join('\n');
        const result = parseJsdoc(jsdoc);
        expect(result.description.sentences).toEqual(['Main desc.']);
        expect(result.scenarios.bullets).toEqual(['scenario one', 'scenario two']);
        expect(result.rules.bullets).toEqual(['rule one']);
        expect(result.notes.bullets).toEqual(['note one']);
    });

    test('collects @param/@returns into tags.raw', () => {
        const jsdoc = [
            '/**',
            ' * Desc.',
            ' * @param foo - the foo',
            ' * @returns void',
            ' */',
        ].join('\n');
        const result = parseJsdoc(jsdoc);
        expect(result.description.sentences).toEqual(['Desc.']);
        expect(result.tags.raw).toContain('@param foo - the foo');
        expect(result.tags.raw).toContain('@returns void');
    });

    test('handles trackEvent regression case (real source snippet)', () => {
        const jsdoc = [
            '/**',
            ' * App 會員註冊主流程。',
            ' *',
            ' * 詳細步驟：1) prepareProviderData 守衛；15) 清 otp session、送 trackEvent(userRegister, success) 埋點、送 RecordUserLogin job、updatePlatformStatistic(registerMembers)。',
            ' *',
            ' * **業務場景**',
            ' * - App / H5 前台註冊表單提交',
            ' */',
        ].join('\n');
        const result = parseJsdoc(jsdoc);
        expect(result.description.sentences.some(s => s.includes('送 trackEvent'))).toBe(true);
        expect(result.scenarios.bullets).toEqual(['App / H5 前台註冊表單提交']);
    });
});
