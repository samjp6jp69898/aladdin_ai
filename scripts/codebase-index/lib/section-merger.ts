/**
 * Reduce a unit to comparison form: drop all markup, quotes, brackets,
 * whitespace and punctuation, keeping only letters/digits (incl. CJK), then
 * lowercase. Used only for matching, never for output — this makes
 * cosmetically reworded bullets (`code` vs 「code」, spacing, full/half-width
 * punctuation) compare equal.
 */
export function normalizeKey(text: string): string {
    return text
        .replace(/`([^`]+)`/g, '$1')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/[^\p{L}\p{N}]/gu, '')
        .toLowerCase();
}

/**
 * True when two normalized bullet keys denote the same bullet: identical, or
 * (for long-enough keys) one fully contains the other — i.e. one side just
 * appended detail to the other. The length floor stops a short generic bullet
 * from spuriously matching inside an unrelated long one.
 */
function keysMatch(a: string, b: string): boolean {
    if (!a || !b) return a === b;
    if (a === b) return true;
    if (Math.min(a.length, b.length) < 12) return false;
    return a.includes(b) || b.includes(a);
}

/**
 * Bullet-level set union with source-priority on conflict.
 * Order: note's bullets first (keeps note order); source-only appended.
 * On a match: if the note bullet strictly extends the source bullet, the note
 * version wins (it has source's content plus more); otherwise source's exact
 * text wins (preserves colleague edits / detail the note lacks).
 */
export function mergeBullets(sourceBullets: string[], noteBullets: string[]): string[] {
    const sourceKeys = sourceBullets.map(normalizeKey);
    const consumed = new Set<number>();
    const merged: string[] = [];

    for (const nb of noteBullets) {
        const nk = normalizeKey(nb);
        let matchIdx = -1;
        for (let i = 0; i < sourceBullets.length; i++) {
            if (consumed.has(i)) continue;
            if (keysMatch(nk, sourceKeys[i])) { matchIdx = i; break; }
        }
        if (matchIdx === -1) {
            merged.push(nb);
        } else {
            consumed.add(matchIdx);
            const sk = sourceKeys[matchIdx];
            // note ⊋ source → note extended it → note wins; else keep source.
            if (nk !== sk && nk.includes(sk)) merged.push(nb);
            else merged.push(sourceBullets[matchIdx]);
        }
    }
    for (let i = 0; i < sourceBullets.length; i++) {
        if (!consumed.has(i)) merged.push(sourceBullets[i]);
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
