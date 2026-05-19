import { describe, test, expect } from 'bun:test';
import { mergeBullets, mergeDescription } from './section-merger.ts';

describe('mergeBullets', () => {
    test('returns source order when both empty', () => {
        expect(mergeBullets([], [])).toEqual([]);
    });

    test('keeps note order; appends source-only at end', () => {
        const source = ['a', 'c', 'd'];
        const note = ['a', 'b'];
        // common: a; note-only: b; source-only: c, d
        expect(mergeBullets(source, note)).toEqual(['a', 'b', 'c', 'd']);
    });

    test('on conflict (same normalized key, different text), source version wins', () => {
        const source = ['用 `Bun.password.verify`'];
        const note   = ['用 Bun.password.verify']; // same after normalization
        // Note has the unit; source's exact text wins for the common position
        expect(mergeBullets(source, note)).toEqual(['用 `Bun.password.verify`']);
    });

    test('trailing period or other punctuation does not produce duplicate', () => {
        // Note expresses a bullet as a paragraph (with trailing 。);
        // source has it as a bullet (no trailing 。). Should be ONE bullet, not two.
        const source = ['App / H5 前台註冊表單提交'];
        const note   = ['App / H5 前台註冊表單提交。'];
        expect(mergeBullets(source, note)).toEqual(['App / H5 前台註冊表單提交']);
        // source wins on key match → keeps source's no-period form
    });

    test('preserves backticks etc. when source-only', () => {
        const source = ['`backticked` content'];
        const note: string[] = [];
        expect(mergeBullets(source, note)).toEqual(['`backticked` content']);
    });
});

describe('mergeDescription', () => {
    test('returns source sentences when every source sentence is in note', () => {
        const source = ['Foo.', 'Bar.'];
        const note   = ['Foo.', 'Bar.', 'Baz.'];
        expect(mergeDescription(source, note)).toEqual(note);
    });

    test('returns source when source has a sentence not in note (trackEvent regression case)', () => {
        const source = [
            '15) 清 otp session、送 trackEvent(userRegister, success) 埋點、送 RecordUserLogin job。',
        ];
        const note = [
            '15) 清 otp session、送 RecordUserLogin job。',
        ];
        expect(mergeDescription(source, note)).toEqual(source);
    });

    test('returns source on full conflict', () => {
        const source = ['Source way A.'];
        const note   = ['Note way B.'];
        expect(mergeDescription(source, note)).toEqual(source);
    });

    test('uses note when source is empty', () => {
        const source: string[] = [];
        const note   = ['Note sentence.'];
        expect(mergeDescription(source, note)).toEqual(note);
    });
});
