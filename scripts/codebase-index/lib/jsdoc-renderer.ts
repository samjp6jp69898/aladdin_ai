import type { ParsedJsdoc } from './jsdoc-parser.ts';

/**
 * Render parsed/merged JSDoc back to a string. `indent` is the per-line indent prefix
 * BEFORE the leading `*` (typically '    ' for class methods).
 */
export function renderJsdoc(parsed: ParsedJsdoc, indent: string): string {
    const out: string[] = [];
    const prefix = `${indent} * `;
    const prefixBare = `${indent} *`;

    out.push(`${indent}/**`);

    const descText = parsed.description.sentences.join('').trim();
    if (descText) {
        out.push(`${prefix}${descText}`);
    }

    const sections: { header: string; bullets: string[] }[] = [
        { header: '**業務場景**', bullets: parsed.scenarios.bullets },
        { header: '**相關規則與踩坑**', bullets: parsed.rules.bullets },
        { header: '**備註**', bullets: parsed.notes.bullets },
    ];
    for (const sec of sections) {
        if (sec.bullets.length === 0) continue;
        out.push(prefixBare);
        out.push(`${prefix}${sec.header}`);
        for (const b of sec.bullets) {
            out.push(`${prefix}- ${b}`);
        }
    }

    if (parsed.tags.raw.trim()) {
        for (const line of parsed.tags.raw.split('\n')) {
            if (line.trim()) out.push(`${prefix}${line}`);
        }
    }

    out.push(`${indent} */`);
    return out.join('\n');
}
