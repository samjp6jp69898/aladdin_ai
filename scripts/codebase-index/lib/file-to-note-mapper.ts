import { Glob } from 'bun';
import { parseNote, type ParsedNote } from './note-parser.ts';

export interface NoteMatch {
    note: ParsedNote;
    relation: 'direct';
}

const CODEBASE_DIR = '/Users/user/aladdin/obsidian/Codebase';

let _index: Map<string, ParsedNote[]> | null = null;

export async function buildNoteIndex(): Promise<Map<string, ParsedNote[]>> {
    if (_index !== null) return _index;

    const index = new Map<string, ParsedNote[]>();
    const glob = new Glob('**/*.md');

    for await (const relPath of glob.scan(CODEBASE_DIR)) {
        const fullPath = `${CODEBASE_DIR}/${relPath}`;
        const note = await parseNote(fullPath);
        if (!note) continue;

        const sourceFile = note.frontmatter.source_file;
        if (typeof sourceFile !== 'string' || !sourceFile) continue;

        const existing = index.get(sourceFile);
        if (existing) {
            existing.push(note);
        } else {
            index.set(sourceFile, [note]);
        }
    }

    _index = index;
    return _index;
}

function normalizeAgrabahPath(filePath: string): string {
    if (filePath.startsWith('agrabah/')) return filePath;
    return `agrabah/${filePath}`;
}

export async function findNotesForFile(agrabahFilePath: string): Promise<NoteMatch[]> {
    const index = await buildNoteIndex();
    const normalized = normalizeAgrabahPath(agrabahFilePath);
    const notes = index.get(normalized) ?? [];
    return notes.map(note => ({ note, relation: 'direct' as const }));
}

export async function findNoteByFqn(fqn: string): Promise<ParsedNote | null> {
    const index = await buildNoteIndex();
    for (const notes of index.values()) {
        for (const note of notes) {
            if (note.fqn === fqn) return note;
        }
    }
    return null;
}

export function getServerFromPath(filePath: string): string | null {
    const match = filePath.match(/src\/servers\/([^/]+)\//);
    return match ? match[1] : null;
}

function toPascalCase(snakeOrKebab: string): string {
    return snakeOrKebab
        .split(/[_-]/)
        .map(part => part.charAt(0).toUpperCase() + part.slice(1))
        .join('');
}

export function getManagerFromPath(filePath: string): string | null {
    const match = filePath.match(/src\/managers\/([^/]+?)(?:\.ts)?$/);
    if (!match) return null;
    return toPascalCase(match[1]);
}
