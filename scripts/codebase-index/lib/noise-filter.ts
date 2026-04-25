import type { CommitInfo, FileChange } from './git-diff-collector.ts';
import { getDiffContent } from './git-diff-collector.ts';

export interface FilterResult {
    kept: CommitInfo[];
    skipped: Array<{ commit: CommitInfo; reason: string }>;
    mixedSignal: Array<{ commit: CommitInfo; note: string }>;
}

interface NoiseRules {
    skip_commit_message_patterns: string[];
    skip_file_patterns: string[];
    low_signal_keywords: string[];
    low_signal_diff_patterns: string[];
}

// Lazy cache: rules loaded once per process
let cachedRules: NoiseRules | null = null;
let cachedRulesPath: string | null = null;

async function loadRules(rulesPath: string): Promise<NoiseRules> {
    if (cachedRules !== null && cachedRulesPath === rulesPath) {
        return cachedRules;
    }
    const file = Bun.file(rulesPath);
    const text = await file.text();
    cachedRules = JSON.parse(text) as NoiseRules;
    cachedRulesPath = rulesPath;
    return cachedRules;
}

function compilePatterns(patterns: string[]): RegExp[] {
    return patterns.map(p => new RegExp(p, 'i'));
}

function matchesAny(value: string, regexes: RegExp[]): boolean {
    return regexes.some(re => re.test(value));
}

/** Check whether value contains any of the given plain-string keywords (case-insensitive). */
function containsKeyword(value: string, keywords: string[]): boolean {
    const lower = value.toLowerCase();
    return keywords.some(k => lower.includes(k.toLowerCase()));
}

/**
 * Filter only files under service / manager / logic directories.
 */
export function filterFilesByScope(files: FileChange[]): FileChange[] {
    const scopePattern = /(?:src\/servers\/[^/]+\/services\/|src\/managers\/|src\/servers\/[^/]+\/logic\/)/;
    return files.filter(f => scopePattern.test(f.path));
}

export async function filterCommits(
    commits: CommitInfo[],
    repoPath: string,
    rulesPath: string
): Promise<FilterResult> {
    const rules = await loadRules(rulesPath);

    const commitMsgRegexes = compilePatterns(rules.skip_commit_message_patterns);
    const filePathRegexes = compilePatterns(rules.skip_file_patterns);
    // low_signal_keywords are plain string fragments (may contain regex meta chars), use substring match
    const lowSignalKeywords = rules.low_signal_keywords;
    const lowSignalDiffRegexes = compilePatterns(rules.low_signal_diff_patterns);

    const kept: CommitInfo[] = [];
    const skipped: Array<{ commit: CommitInfo; reason: string }> = [];
    const mixedSignal: Array<{ commit: CommitInfo; note: string }> = [];

    for (const commit of commits) {
        // Layer 1: commit message match → skip entire commit
        if (matchesAny(commit.message, commitMsgRegexes)) {
            skipped.push({ commit, reason: 'commit_message_match' });
            continue;
        }

        // Layer 2: remove noise files from file list
        const filteredFiles = commit.files.filter(f => !matchesAny(f.path, filePathRegexes));

        if (filteredFiles.length === 0 && commit.files.length > 0) {
            // All files were noise
            skipped.push({ commit, reason: 'all_files_noise' });
            continue;
        }

        // Layer 3: low signal keyword check in commit message
        if (containsKeyword(commit.message, lowSignalKeywords)) {
            // Enter low signal channel: check diff content of up to 5 files
            const filesToCheck = filteredFiles.slice(0, 5);
            let hasSubstance = false;

            for (const file of filesToCheck) {
                const diff = await getDiffContent(repoPath, commit.hash, file.path);
                if (!diff) continue;

                // Examine each +/- line in the diff
                const diffLines = diff.split('\n').filter(line => line.startsWith('+') || line.startsWith('-'));

                // Skip unified diff header lines like +++ and ---
                const contentLines = diffLines.filter(line => !line.startsWith('+++') && !line.startsWith('---'));

                if (contentLines.length === 0) continue;

                const allNoise = contentLines.every(line => matchesAny(line, lowSignalDiffRegexes));
                if (!allNoise) {
                    hasSubstance = true;
                    break;
                }
            }

            if (!hasSubstance) {
                skipped.push({ commit, reason: 'low_signal_no_substance' });
                continue;
            }

            // Has substance but message is low signal → mixed signal
            const updatedCommit: CommitInfo = { ...commit, files: filteredFiles };
            mixedSignal.push({
                commit: updatedCommit,
                note: `low_signal_keyword in message but diff contains substantive changes`,
            });
            kept.push(updatedCommit);
            continue;
        }

        // Passed all filters
        kept.push({ ...commit, files: filteredFiles });
    }

    return { kept, skipped, mixedSignal };
}
