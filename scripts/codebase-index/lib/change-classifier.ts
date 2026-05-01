import type { CommitInfo, FileChange } from './git-diff-collector.ts';
import { getDiffContent } from './git-diff-collector.ts';
import { findNotesForFile, type NoteMatch } from './file-to-note-mapper.ts';
import { filterFilesByScope } from './noise-filter.ts';

const AGRABAH_REPO = '/Users/user/aladdin/agrabah';

// ──────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────

interface RajahImpact {
    rajahFile: string;
    affectedFqns: string[];
    changeType: 'signature' | 'model' | 'enum' | 'new_method' | 'deleted_method';
    commitHash: string;
    diffSummary: string;
}

export type ActionType =
    | 'new_file'            // 新增 .ts 檔 → 需建立新筆記
    | 'update_existing'     // 修改 .ts 檔 → 更新已有筆記
    | 'delete_file'         // 刪除 .ts 檔 → 標記筆記 deprecated
    | 'rename_file'         // rename .ts 檔 → 筆記改名 + 連結更新
    | 'rajah_signature'     // rajah 簽章變更 → 更新筆記 input/output
    | 'rajah_new_method'    // rajah 新增 method → 需建立新筆記
    | 'rajah_delete_method' // rajah 刪除 method → 標記筆記 deprecated
    | 'uncovered';          // 無法對應到任何筆記

export interface ChangeAction {
    type: ActionType;
    commit: CommitInfo;
    file: FileChange;
    affectedNotes: NoteMatch[];
    rajahImpact?: RajahImpact;
    newMethodHints?: string[];
    summary: string;
}

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

function buildFileSummary(type: ActionType, file: FileChange, notes: NoteMatch[]): string {
    const noteCount = notes.length;
    const notePart = noteCount > 0
        ? ` → ${noteCount} note(s): ${notes.map(n => n.note.fqn).join(', ')}`
        : ' → no matching notes';

    switch (type) {
        case 'new_file':
            return `New file ${file.path}${notePart}`;
        case 'update_existing':
            return `Modified ${file.path} (+${file.additions}/-${file.deletions})${notePart}`;
        case 'delete_file':
            return `Deleted ${file.path}${notePart}`;
        case 'rename_file':
            return `Renamed ${file.oldPath ?? '?'} → ${file.path}${notePart}`;
        case 'uncovered':
            return `Modified ${file.path} (+${file.additions}/-${file.deletions}) — no note coverage`;
        default:
            return `${type}: ${file.path}${notePart}`;
    }
}

function buildRajahSummary(type: ActionType, impact: RajahImpact): string {
    const fqns = impact.affectedFqns.join(', ');
    switch (type) {
        case 'rajah_new_method':
            return `New rajah method(s) in ${impact.rajahFile}: ${fqns} [${impact.diffSummary}]`;
        case 'rajah_delete_method':
            return `Deleted rajah method(s) in ${impact.rajahFile}: ${fqns} [${impact.diffSummary}]`;
        case 'rajah_signature':
            return `Rajah signature/model/enum change in ${impact.rajahFile}: ${fqns} [${impact.diffSummary}]`;
        default:
            return `Rajah change in ${impact.rajahFile}: ${fqns}`;
    }
}

// Build a synthetic FileChange to represent a rajah impact for the action
function buildRajahFileChange(impact: RajahImpact): FileChange {
    return {
        status: 'M',
        path: impact.rajahFile,
        additions: 0,
        deletions: 0,
    };
}

// ──────────────────────────────────────────────
// New method detection from diff
// ──────────────────────────────────────────────

const RPC_METHOD_PATTERN = /^\+\s+async\s+method(\w+)\s*\(/;
const CLASS_METHOD_PATTERN = /^\+\s+(?:public\s+)?(?:static\s+)?async\s+(\w+)\s*\(/;

function isMethodCovered(methodName: string, existingNoteFqns: Set<string>): boolean {
    const stripped = methodName.startsWith('method') ? methodName.slice(6) : methodName;
    return [...existingNoteFqns].some(fqn =>
        fqn.endsWith(`.${methodName}`) ||
        fqn.endsWith(`.${stripped}`) ||
        fqn.endsWith(`.method${methodName}`)
    );
}

async function detectNewMethodsFromDiff(
    commitHash: string,
    filePath: string,
    existingNoteFqns: Set<string>,
): Promise<string[]> {
    const diff = await getDiffContent(AGRABAH_REPO, commitHash, filePath);
    if (!diff) return [];

    const addedLines = new Set<string>();
    const removedLines = new Set<string>();

    for (const line of diff.split('\n')) {
        if (line.startsWith('+') && !line.startsWith('+++')) {
            addedLines.add(line);
        } else if (line.startsWith('-') && !line.startsWith('---')) {
            removedLines.add(line);
        }
    }

    const newMethods: string[] = [];

    for (const line of addedLines) {
        const rpcMatch = line.match(RPC_METHOD_PATTERN);
        if (rpcMatch) {
            const methodName = rpcMatch[1];
            if (!methodName || /^(constructor|init|super)$/.test(methodName)) continue;

            const wasSignatureChange = [...removedLines].some(
                rl => rl.match(new RegExp(`async\\s+method${methodName}\\s*\\(`))
            );
            if (wasSignatureChange) continue;

            if (!isMethodCovered(`method${methodName}`, existingNoteFqns)) {
                newMethods.push(`method${methodName}`);
            }
            continue;
        }

        const classMatch = line.match(CLASS_METHOD_PATTERN);
        if (classMatch) {
            const methodName = classMatch[1];
            if (!methodName || /^(constructor|init|super)$/.test(methodName)) continue;
            if (methodName.startsWith('method')) continue;

            const wasSignatureChange = [...removedLines].some(
                rl => rl.match(new RegExp(`async\\s+${methodName}\\s*\\(`))
            );
            if (wasSignatureChange) continue;

            if (!isMethodCovered(methodName, existingNoteFqns)) {
                newMethods.push(methodName);
            }
        }
    }

    return [...new Set(newMethods)];
}

// ──────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────

export async function classifyChanges(
    commits: CommitInfo[],
    rajahImpacts: RajahImpact[]
): Promise<ChangeAction[]> {
    const actions: ChangeAction[] = [];

    // ── Part 1: Classify file changes from commits ──────────────────
    for (const commit of commits) {
        const scopedFiles = filterFilesByScope(commit.files);

        for (const file of scopedFiles) {
            const notes = await findNotesForFile(file.path);
            const hasNotes = notes.length > 0;

            let type: ActionType;

            switch (file.status) {
                case 'A':
                    // Added: if we somehow already have a note, treat as update_existing (edge case)
                    type = hasNotes ? 'update_existing' : 'new_file';
                    break;
                case 'M':
                    type = hasNotes ? 'update_existing' : 'uncovered';
                    break;
                case 'D':
                    type = 'delete_file';
                    break;
                case 'R':
                    type = 'rename_file';
                    break;
                default:
                    type = 'uncovered';
            }

            let newMethodHints: string[] | undefined;
            if (type === 'update_existing' && file.path.endsWith('.ts')) {
                const existingFqns = new Set(notes.map(n => n.note.fqn));
                const detected = await detectNewMethodsFromDiff(commit.hash, file.path, existingFqns);
                if (detected.length > 0) {
                    newMethodHints = detected;
                }
            }

            actions.push({
                type,
                commit,
                file,
                affectedNotes: notes,
                newMethodHints,
                summary: buildFileSummary(type, file, notes),
            });
        }
    }

    // ── Part 2: Classify rajah impacts ──────────────────────────────
    // Build a commit lookup map for quick access
    const commitByHash = new Map<string, CommitInfo>();
    for (const commit of commits) {
        commitByHash.set(commit.hash, commit);
    }

    for (const impact of rajahImpacts) {
        // Find the commit this impact belongs to
        const commit = commitByHash.get(impact.commitHash);
        if (!commit) continue;

        let type: ActionType;

        switch (impact.changeType) {
            case 'new_method':
                type = 'rajah_new_method';
                break;
            case 'deleted_method':
                type = 'rajah_delete_method';
                break;
            case 'signature':
            case 'model':
            case 'enum':
                type = 'rajah_signature';
                break;
            default:
                type = 'rajah_signature';
        }

        // Find notes for each affected FQN by looking up via the rajah file path
        // (We use the rajah file as the file reference; note lookup may not match, so we try FQN-based approach)
        const affectedNotes: NoteMatch[] = [];
        for (const fqn of impact.affectedFqns) {
            // Try to find notes that have this FQN
            // Since findNotesForFile looks up by source_file, we attempt with the rajah file path
            // prefixed with the expected agrabah service path pattern
            const serverMatch = impact.rajahFile.match(/services\/([^/]+)\.rajah$/);
            if (serverMatch) {
                const serverName = serverMatch[1];
                // Attempt to find notes via likely service path
                const guessedPath = `src/servers/${serverName}/services/`;
                const candidates = await findNotesForFile(guessedPath);
                // Filter to only those whose FQN matches one of the affected FQNs
                const matching = candidates.filter(nm =>
                    impact.affectedFqns.some(afqn => nm.note.fqn === afqn || nm.note.fqn?.startsWith(afqn))
                );
                affectedNotes.push(...matching);
            }
        }

        const syntheticFile = buildRajahFileChange(impact);

        actions.push({
            type,
            commit,
            file: syntheticFile,
            affectedNotes,
            rajahImpact: impact,
            summary: buildRajahSummary(type, impact),
        });
    }

    return actions;
}

export function deduplicateActions(actions: ChangeAction[]): ChangeAction[] {
    const seen = new Set<string>();
    const result: ChangeAction[] = [];

    for (const action of actions) {
        let key: string;

        if (action.affectedNotes.length > 0) {
            // Key = sorted note FQNs + action type
            const fqns = action.affectedNotes
                .map(n => n.note.fqn)
                .sort()
                .join('|');
            key = `${action.type}::notes::${fqns}`;
        } else {
            // No notes — use file path + type
            key = `${action.type}::file::${action.file.path}`;
        }

        if (!seen.has(key)) {
            seen.add(key);
            result.push(action);
        }
    }

    return result;
}
