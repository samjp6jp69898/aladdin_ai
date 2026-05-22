export interface ParsedJsdoc {
    description: { sentences: string[] };
    scenarios: { bullets: string[] };
    rules: { bullets: string[] };
    notes: { bullets: string[] };
    tags: { raw: string }; // joined by '\n', includes @param/@returns/etc. lines
}

const SECTION_HEADERS = {
    scenarios: '**業務場景**',
    rules: '**相關規則與踩坑**',
    notes: '**備註**',
} as const;

type SectionKey = 'description' | 'scenarios' | 'rules' | 'notes';

function stripJsdocSyntax(jsdoc: string): string[] {
    // Strip the block delimiters from the whole comment first, so a single-line
    // `/** text */` — or text sharing a line with `/**` / `*/` — is handled,
    // not only lines that are exactly `/**` or `*/`.
    let body = jsdoc.trim();
    if (body.startsWith('/**')) body = body.slice(3);
    if (body.endsWith('*/')) body = body.slice(0, -2);
    const content: string[] = [];
    for (const line of body.split('\n')) {
        let stripped = line.trim();
        if (stripped.startsWith('* ')) stripped = stripped.slice(2);
        else if (stripped === '*') stripped = '';
        else if (stripped.startsWith('*')) stripped = stripped.slice(1);
        content.push(stripped);
    }
    return content;
}

function splitDescriptionSentences(text: string): string[] {
    const result: string[] = [];
    let buf = '';
    for (const ch of text) {
        buf += ch;
        if (ch === '。' || ch === '；' || ch === '.' || ch === ';') {
            const trimmed = buf.trim();
            if (trimmed) result.push(trimmed);
            buf = '';
        }
    }
    const tail = buf.trim();
    if (tail) result.push(tail);
    return result;
}

export function parseJsdoc(jsdoc: string): ParsedJsdoc {
    const lines = stripJsdocSyntax(jsdoc);
    const result: ParsedJsdoc = {
        description: { sentences: [] },
        scenarios: { bullets: [] },
        rules: { bullets: [] },
        notes: { bullets: [] },
        tags: { raw: '' },
    };

    let current: SectionKey = 'description';
    const descLines: string[] = [];
    const tagLines: string[] = [];

    for (const line of lines) {
        if (line.startsWith('@')) {
            tagLines.push(line);
            continue;
        }
        if (line === SECTION_HEADERS.scenarios) { current = 'scenarios'; continue; }
        if (line === SECTION_HEADERS.rules) { current = 'rules'; continue; }
        if (line === SECTION_HEADERS.notes) { current = 'notes'; continue; }

        if (current === 'description') {
            descLines.push(line);
        } else {
            const m = line.match(/^-\s+(.+)$/);
            if (m) {
                result[current].bullets.push(m[1].trim());
            } else if (line.trim() && result[current].bullets.length === 0) {
                // bare (non-`- `) line in a section — keep it instead of
                // dropping it (e.g. a standalone `[TBD: ...]` note).
                result[current].bullets.push(line.trim());
            }
        }
    }

    const descText = descLines.filter(l => l.trim()).join('\n');
    for (const line of descText.split('\n')) {
        result.description.sentences.push(...splitDescriptionSentences(line));
    }

    result.tags.raw = tagLines.join('\n');
    return result;
}
