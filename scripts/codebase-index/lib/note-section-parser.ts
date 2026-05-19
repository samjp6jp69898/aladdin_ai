import matter from 'gray-matter';
import type { ParsedJsdoc } from './jsdoc-parser.ts';

const NOTE_SECTION_MAP: Record<string, keyof Pick<ParsedJsdoc, 'description' | 'scenarios' | 'rules' | 'notes'>> = {
    '功能描述': 'description',
    '業務場景': 'scenarios',
    '相關規則與踩坑': 'rules',
    '備註': 'notes',
};

function normalizeText(text: string): string {
    // [[link]] or [[link|alias]] -> 「link」 (or alias), stripping adjacent whitespace
    text = text.replace(/[^\S\n\r]*\[\[([^\]|]+)(?:\|([^\]]+))?\]\][^\S\n\r]*/g, (_, link, alias) => {
        return `「${(alias ?? link).trim()}」`;
    });
    // `code` -> code
    text = text.replace(/`([^`]+)`/g, '$1');
    // **bold** -> bold
    text = text.replace(/\*\*([^*]+)\*\*/g, '$1');
    return text;
}

function splitSentences(text: string): string[] {
    const result: string[] = [];
    let buf = '';
    for (const ch of text) {
        buf += ch;
        if (ch === '。' || ch === '；' || ch === '.' || ch === ';') {
            const t = buf.trim();
            if (t) result.push(t);
            buf = '';
        }
    }
    const tail = buf.trim();
    if (tail) result.push(tail);
    return result;
}

function compressDescription(rawLines: string[]): string {
    const intro: string[] = [];
    const items: { num: number; text: string }[] = [];
    const tail: string[] = [];

    let phase: 'intro' | 'list' | 'tail' = 'intro';
    for (const line of rawLines) {
        const trimmed = line.trim();
        const m = trimmed.match(/^(\d+)\.\s+(.+)$/);
        if (m) {
            phase = 'list';
            items.push({ num: parseInt(m[1], 10), text: m[2].trim() });
        } else if (phase === 'list') {
            if (trimmed) tail.push(trimmed);
        } else {
            if (trimmed) intro.push(trimmed);
        }
    }

    let result = intro.join(' ').trim();
    if (items.length > 0) {
        result = result.replace(/[:：]\s*$/, '：');
        const listInline = items.map(it => `${it.num}) ${it.text}`).join('；');
        if (!result.endsWith('：')) result += '：';
        result += listInline;
        if (!result.endsWith('；') && !result.endsWith('。')) result += '。';
    }
    if (tail.length > 0) {
        if (result && !/[。；.;]$/.test(result)) result += '。';
        result += tail.join(' ');
    }
    return result;
}

export function parseNote(noteContent: string): ParsedJsdoc {
    const parsed = matter(noteContent);
    const body = parsed.content;

    const result: ParsedJsdoc = {
        description: { sentences: [] },
        scenarios: { bullets: [] },
        rules: { bullets: [] },
        notes: { bullets: [] },
        tags: { raw: '' },
    };

    const lines = body.split('\n');
    let currentH2: string | null = null;
    let sectionLines: string[] = [];

    const flushSection = () => {
        if (currentH2 === null) return;
        const key = NOTE_SECTION_MAP[currentH2];
        if (!key) return; // ignored section
        const norm = normalizeText(sectionLines.join('\n'));
        if (key === 'description') {
            const inlined = compressDescription(norm.split('\n'));
            result.description.sentences = splitSentences(inlined);
        } else {
            const bullets: string[] = [];
            for (const line of norm.split('\n')) {
                const m = line.trim().match(/^-\s+(.+)$/);
                if (m) bullets.push(m[1].trim());
                else if (line.trim() && bullets.length === 0) {
                    // bare paragraph in this section — treat as one bullet
                    bullets.push(line.trim());
                }
            }
            result[key].bullets = bullets;
        }
    };

    for (const line of lines) {
        const h2 = line.match(/^##\s+(.+)$/);
        if (h2) {
            flushSection();
            currentH2 = h2[1].trim();
            sectionLines = [];
        } else if (currentH2 !== null) {
            sectionLines.push(line);
        }
    }
    flushSection();

    return result;
}
