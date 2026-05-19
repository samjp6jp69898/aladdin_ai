import { describe, test, expect } from 'bun:test';
import { extractJsdocAbove } from './jsdoc-extractor.ts';

describe('extractJsdocAbove', () => {
    test('extracts JSDoc immediately above declaration', () => {
        const source = [
            '    /**',
            '     * Hello world.',
            '     */',
            '    async methodFoo(): Promise<void> {',
            '    }',
        ].join('\n');
        const result = extractJsdocAbove(source, 4);
        expect(result).not.toBeNull();
        expect(result!.startLine).toBe(1);
        expect(result!.endLine).toBe(3);
        expect(result!.text).toContain('Hello world.');
    });

    test('extracts JSDoc with blank line above declaration', () => {
        const source = [
            '    /**',
            '     * Hello.',
            '     */',
            '',
            '    async methodFoo() {}',
        ].join('\n');
        const result = extractJsdocAbove(source, 5);
        expect(result).not.toBeNull();
        expect(result!.startLine).toBe(1);
        expect(result!.endLine).toBe(3);
    });

    test('returns null when no JSDoc above', () => {
        const source = [
            '    // single line comment',
            '    async methodFoo() {}',
        ].join('\n');
        const result = extractJsdocAbove(source, 2);
        expect(result).toBeNull();
    });

    test('extracts multi-section JSDoc with **業務場景** etc.', () => {
        const source = [
            '    /**',
            '     * Main description.',
            '     *',
            '     * **業務場景**',
            '     * - scenario one',
            '     *',
            '     * **備註**',
            '     * - note one',
            '     */',
            '    async methodFoo() {}',
        ].join('\n');
        const result = extractJsdocAbove(source, 10);
        expect(result).not.toBeNull();
        expect(result!.text).toContain('**業務場景**');
        expect(result!.text).toContain('scenario one');
    });

    test('stops scanning at non-JSDoc code (declaration before)', () => {
        const source = [
            '    private _foo: string;',
            '',
            '    async methodFoo() {}',
        ].join('\n');
        const result = extractJsdocAbove(source, 3);
        expect(result).toBeNull();
    });
});
