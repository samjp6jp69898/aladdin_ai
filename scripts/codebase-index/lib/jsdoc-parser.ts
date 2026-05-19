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
    const raw = jsdoc.split('\n');
    const content: string[] = [];
    for (const line of raw) {
        const trimmed = line.trim();
        if (trimmed === '/**' || trimmed === '*/') continue;
        let stripped = trimmed;
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
            const m = line.match(/^- (.+)$/);
            if (m) {
                result[current].bullets.push(m[1]);
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
