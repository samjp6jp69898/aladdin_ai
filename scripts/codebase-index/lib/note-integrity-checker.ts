import matter from 'gray-matter';
import { readFile } from 'node:fs/promises';

export interface IntegrityIssue {
    notePath: string;
    severity: 'error' | 'warning';
    issue: string;
}

export async function checkNoteIntegrity(notePath: string, originalContent?: string): Promise<IntegrityIssue[]> {
    const issues: IntegrityIssue[] = [];

    // Read file
    let raw: string;
    try {
        raw = await readFile(notePath, 'utf-8');
    } catch (err) {
        issues.push({
            notePath,
            severity: 'error',
            issue: `Cannot read file: ${err instanceof Error ? err.message : String(err)}`,
        });
        return issues;
    }

    // Check 1: frontmatter YAML parseable
    let parsed: ReturnType<typeof matter>;
    try {
        parsed = matter(raw);
    } catch (err) {
        issues.push({
            notePath,
            severity: 'error',
            issue: `Frontmatter YAML parse error: ${err instanceof Error ? err.message : String(err)}`,
        });
        // Can't continue further checks without parsed frontmatter
        return issues;
    }

    const { data } = parsed;

    // Check 2: fqn field exists and non-empty
    if (!data.fqn || (typeof data.fqn === 'string' && data.fqn.trim() === '')) {
        issues.push({
            notePath,
            severity: 'error',
            issue: 'Missing or empty frontmatter field: fqn',
        });
    }

    // Check 3: type field exists and non-empty
    if (!data.type || (typeof data.type === 'string' && data.type.trim() === '')) {
        issues.push({
            notePath,
            severity: 'error',
            issue: 'Missing or empty frontmatter field: type',
        });
    }

    // Check 4: source_file field exists
    if (!('source_file' in data)) {
        issues.push({
            notePath,
            severity: 'warning',
            issue: 'Missing frontmatter field: source_file',
        });
    }

    // Check 5: AUTO-GENERATED marker pairing
    const autoGenOpenCount = (raw.match(/<!-- AUTO-GENERATED, DO NOT EDIT -->/g) ?? []).length;
    const autoGenCloseCount = (raw.match(/<!-- END AUTO-GENERATED -->/g) ?? []).length;
    if (autoGenOpenCount !== autoGenCloseCount) {
        issues.push({
            notePath,
            severity: 'error',
            issue: `AUTO-GENERATED marker mismatch: ${autoGenOpenCount} opening vs ${autoGenCloseCount} closing tags`,
        });
    }

    // Check 6: Phase 3/4 placeholder residue
    if (/<!-- Phase [34] will fill this -->/.test(raw)) {
        issues.push({
            notePath,
            severity: 'warning',
            issue: 'Phase 3/4 placeholder found: <!-- Phase [34] will fill this -->',
        });
    }

    // Checks that require originalContent
    if (originalContent !== undefined) {
        // Check 7: Content size change
        const newLen = raw.length;
        const origLen = originalContent.length;
        if (origLen > 100) {
            const ratio = newLen / origLen;
            if (ratio > 3.0 || ratio < 0.3) {
                issues.push({
                    notePath,
                    severity: 'warning',
                    issue: `Abnormal content size change: new/original ratio = ${ratio.toFixed(2)} (new: ${newLen} chars, original: ${origLen} chars)`,
                });
            }
        }

        // Check 8: TBD count increase
        const countTBD = (text: string) => (text.match(/\[TBD/g) ?? []).length;
        const newTBD = countTBD(raw);
        const origTBD = countTBD(originalContent);
        if (newTBD > origTBD) {
            issues.push({
                notePath,
                severity: 'warning',
                issue: `[TBD count increased: ${origTBD} → ${newTBD}`,
            });
        }
    }

    return issues;
}

export async function batchCheck(notePaths: string[], originals?: Map<string, string>): Promise<IntegrityIssue[]> {
    const allIssues: IntegrityIssue[] = [];
    for (const notePath of notePaths) {
        const originalContent = originals?.get(notePath);
        const issues = await checkNoteIntegrity(notePath, originalContent);
        allIssues.push(...issues);
    }
    return allIssues;
}

export function hasErrors(issues: IntegrityIssue[]): boolean {
    return issues.some(i => i.severity === 'error');
}
