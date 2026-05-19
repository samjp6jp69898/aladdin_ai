export interface JsdocBlock {
    startLine: number; // 1-based, line of `/**`
    endLine: number;   // 1-based, line of `*/`
    text: string;      // full block including `/**` and `*/`, lines joined by '\n'
}

/**
 * Find the `/** ... *\/` JSDoc block immediately above `declarationLine`.
 * Skips blank lines between the JSDoc and the declaration.
 * Returns null if no JSDoc is found (e.g. previous line is code).
 */
export function extractJsdocAbove(source: string, declarationLine: number): JsdocBlock | null {
    const lines = source.split('\n');
    if (declarationLine < 2 || declarationLine > lines.length) {
        return null;
    }

    let i = declarationLine - 2; // convert 1-based to 0-based, look at line above

    // Skip blank lines (but not single-line // comments — those mean no JSDoc)
    while (i >= 0 && lines[i].trim() === '') {
        i--;
    }
    if (i < 0) return null;

    // Expect `*/` at line i
    if (!lines[i].trimEnd().endsWith('*/')) {
        return null;
    }
    const endLine0 = i;

    // Scan up for `/**`
    while (i >= 0 && !lines[i].trimStart().startsWith('/**')) {
        i--;
    }
    if (i < 0) return null;
    const startLine0 = i;

    return {
        startLine: startLine0 + 1,
        endLine: endLine0 + 1,
        text: lines.slice(startLine0, endLine0 + 1).join('\n'),
    };
}
