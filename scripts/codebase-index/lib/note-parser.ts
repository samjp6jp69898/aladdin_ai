import matter from 'gray-matter';
import { readFile } from 'node:fs/promises';

export interface ParsedNote {
    path: string;
    fqn: string;
    type: string;
    frontmatter: Record<string, unknown>;
    content: string;
    body: string;
    calls: {
        managerMethods: string[];
        rpcCrossServer: string[];
        internalHelpers: string[];
        otherManagers: string[];
        dbOperations: string[];
    };
    otherOutgoingLinks: string[];
}

const LINK_RE = /\[\[([^\]|#]+?)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g;

function extractLinks(text: string): string[] {
    const out: string[] = [];
    let m: RegExpExecArray | null;
    LINK_RE.lastIndex = 0;
    while ((m = LINK_RE.exec(text)) !== null) {
        out.push(m[1].trim());
    }
    return out;
}

function extractSection(body: string, header: string): string {
    const lines = body.split('\n');
    const start = lines.findIndex(l => l.trim() === header);
    if (start === -1) return '';
    const end = lines.findIndex((l, i) => i > start && /^#{1,4}\s/.test(l));
    const sectionLines = lines.slice(start + 1, end === -1 ? lines.length : end);
    return sectionLines.join('\n');
}

export async function parseNote(path: string): Promise<ParsedNote | null> {
    const raw = await readFile(path, 'utf-8');
    const { data, content } = matter(raw);
    if (!data.fqn || typeof data.fqn !== 'string') return null;

    return {
        path,
        fqn: data.fqn,
        type: (data.type as string) ?? '',
        frontmatter: data,
        content: raw,
        body: content,
        calls: {
            managerMethods: extractLinks(extractSection(content, '### Calls Manager Methods')),
            rpcCrossServer: extractLinks(extractSection(content, '### Calls RPC Cross-Server')),
            internalHelpers: extractLinks(extractSection(content, '### Calls Internal Helpers')),
            otherManagers: extractLinks(extractSection(content, '### Calls Other Managers')),
            dbOperations: extractLinks(extractSection(content, '### Calls DB Operations')),
        },
        otherOutgoingLinks: extractLinks(content),
    };
}
