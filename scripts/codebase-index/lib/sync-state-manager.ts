import { readFile, writeFile } from 'node:fs/promises';

const SYNC_STATE_PATH = '/Users/user/aladdin/aladdin_ai/scripts/codebase-index/sync-state.json';
const GC_MAX_AGE_DAYS = 30;

export interface SyncState {
    schema_version: number;
    agrabah_last_sync_commit: string | null;
    rajah_last_sync_commit: string | null;
    last_sync_date: string | null;
    processed_commits: {
        agrabah: Record<string, string>;
        rajah: Record<string, string>;
    };
    sync_history: Array<{
        date: string;
        agrabah_commits: number;
        rajah_commits: number;
        actions: number;
        report: string;
    }>;
}

export async function loadSyncState(): Promise<SyncState> {
    let raw: any;
    try {
        raw = JSON.parse(await readFile(SYNC_STATE_PATH, 'utf-8'));
    } catch {
        raw = {};
    }

    if (!raw.schema_version || raw.schema_version < 2) {
        raw.schema_version = 2;
        raw.processed_commits = raw.processed_commits ?? { agrabah: {}, rajah: {} };
    }
    raw.sync_history = raw.sync_history ?? [];
    raw.last_sync_date = raw.last_sync_date ?? null;

    return raw as SyncState;
}

export async function saveSyncState(state: SyncState): Promise<void> {
    await writeFile(SYNC_STATE_PATH, JSON.stringify(state, null, 2));
}

export function filterNewCommits(
    collectedHashes: string[],
    processedCommits: Record<string, string>,
): { newHashes: string[]; skippedCount: number } {
    const newHashes = collectedHashes.filter(h => !(h in processedCommits));
    return { newHashes, skippedCount: collectedHashes.length - newHashes.length };
}

export function markCommitsProcessed(
    state: SyncState,
    repo: 'agrabah' | 'rajah',
    hashes: string[],
    dateStr: string,
): void {
    for (const hash of hashes) {
        state.processed_commits[repo][hash] = dateStr;
    }
}

export function gcProcessedCommits(state: SyncState): number {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - GC_MAX_AGE_DAYS);
    let removed = 0;

    for (const repo of ['agrabah', 'rajah'] as const) {
        const commits = state.processed_commits[repo];
        for (const [hash, dateStr] of Object.entries(commits)) {
            if (new Date(dateStr) < cutoff) {
                delete commits[hash];
                removed++;
            }
        }
    }

    return removed;
}
