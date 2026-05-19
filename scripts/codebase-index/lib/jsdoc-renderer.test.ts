import { describe, test, expect } from 'bun:test';
import { renderJsdoc } from './jsdoc-renderer.ts';

describe('renderJsdoc', () => {
    test('renders single-section description only', () => {
        const out = renderJsdoc({
            description: { sentences: ['Hello world.'] },
            scenarios: { bullets: [] },
            rules: { bullets: [] },
            notes: { bullets: [] },
            tags: { raw: '' },
        }, '    ');
        expect(out).toBe([
            '    /**',
            '     * Hello world.',
            '     */',
        ].join('\n'));
    });

    test('renders all four sections in fixed order', () => {
        const out = renderJsdoc({
            description: { sentences: ['Desc.'] },
            scenarios: { bullets: ['s1', 's2'] },
            rules: { bullets: ['r1'] },
            notes: { bullets: ['n1'] },
            tags: { raw: '' },
        }, '    ');
        expect(out).toBe([
            '    /**',
            '     * Desc.',
            '     *',
            '     * **業務場景**',
            '     * - s1',
            '     * - s2',
            '     *',
            '     * **相關規則與踩坑**',
            '     * - r1',
            '     *',
            '     * **備註**',
            '     * - n1',
            '     */',
        ].join('\n'));
    });

    test('omits empty bullet sections', () => {
        const out = renderJsdoc({
            description: { sentences: ['Desc.'] },
            scenarios: { bullets: ['s1'] },
            rules: { bullets: [] },
            notes: { bullets: [] },
            tags: { raw: '' },
        }, '');
        expect(out).toBe([
            '/**',
            ' * Desc.',
            ' *',
            ' * **業務場景**',
            ' * - s1',
            ' */',
        ].join('\n'));
    });

    test('joins sentences in description with separators preserved', () => {
        const out = renderJsdoc({
            description: { sentences: ['Main。', '詳細步驟：1) foo；', '2) bar。'] },
            scenarios: { bullets: [] },
            rules: { bullets: [] },
            notes: { bullets: [] },
            tags: { raw: '' },
        }, '');
        expect(out).toContain('Main。詳細步驟：1) foo；2) bar。');
    });

    test('passes through @param/@returns from tags.raw at end', () => {
        const out = renderJsdoc({
            description: { sentences: ['Desc.'] },
            scenarios: { bullets: [] },
            rules: { bullets: [] },
            notes: { bullets: [] },
            tags: { raw: '@param foo - the foo\n@returns void' },
        }, '');
        expect(out).toBe([
            '/**',
            ' * Desc.',
            ' * @param foo - the foo',
            ' * @returns void',
            ' */',
        ].join('\n'));
    });

    test('inserts blank * separator between bullets and tags (idempotency for real methods)', () => {
        const out = renderJsdoc({
            description: { sentences: ['Desc.'] },
            scenarios: { bullets: ['s1'] },
            rules: { bullets: [] },
            notes: { bullets: [] },
            tags: { raw: '@param foo - the foo' },
        }, '');
        expect(out).toBe([
            '/**',
            ' * Desc.',
            ' *',
            ' * **業務場景**',
            ' * - s1',
            ' *',
            ' * @param foo - the foo',
            ' */',
        ].join('\n'));
    });
});
