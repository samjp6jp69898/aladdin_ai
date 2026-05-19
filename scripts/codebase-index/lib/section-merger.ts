/**
 * Normalize a unit for key comparison: strip backticks/bold, unify full/half-width
 * parens, collapse whitespace, lowercase. Used only for matching, never for output.
 */
export function normalizeKey(text: string): string {
    return text
        .replace(/`([^`]+)`/g, '$1')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/[（(]/g, '(').replace(/[)）]/g, ')')
        .replace(/\s+/g, ' ')
        .replace(/[。、，；,.;\s]+$/u, '')
        .trim()
        .toLowerCase();
}

/**
 * Bullet-level set union with source-priority on conflict.
 * Order: note's bullets first (keeps note order); source-only appended.
 * When a normalized key matches, source's exact text wins (preserves colleague edits).
 */
export function mergeBullets(sourceBullets: string[], noteBullets: string[]): string[] {
    const sourceByKey = new Map<string, string>();
    for (const u of sourceBullets) sourceByKey.set(normalizeKey(u), u);
    const noteKeys = new Set(noteBullets.map(normalizeKey));

    const merged: string[] = [];
    for (const u of noteBullets) {
        const key = normalizeKey(u);
        if (sourceByKey.has(key)) {
            merged.push(sourceByKey.get(key)!);
        } else {
            merged.push(u);
        }
    }
    for (const u of sourceBullets) {
        if (!noteKeys.has(normalizeKey(u))) {
            merged.push(u);
        }
    }
    return merged;
}

/**
 * Description merge: treat as single unit. If every source sentence (normalized) is
 * present in note text → use note (note has improvements and contains everything source has).
 * Otherwise → use source (source has content note is missing — likely colleague's edits).
 *
 * This is the core defense against the trackEvent regression: when source has a sentence
 * not in note, we keep source.
 */
export function mergeDescription(sourceSentences: string[], noteSentences: string[]): string[] {
    if (sourceSentences.length === 0) return noteSentences;
    if (noteSentences.length === 0) return sourceSentences;

    const noteText = noteSentences.map(normalizeKey).join(' ');
    const allInNote = sourceSentences.every(s => noteText.includes(normalizeKey(s)));
    return allInNote ? noteSentences : sourceSentences;
}
