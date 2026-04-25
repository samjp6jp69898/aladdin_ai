import { readFile, writeFile } from 'node:fs/promises';
import { collectCommits, type CommitInfo } from './lib/git-diff-collector.ts';
import { filterCommits, type FilterResult } from './lib/noise-filter.ts';
import { resolveRajahImpacts } from './lib/rajah-change-resolver.ts';
import { buildNoteIndex } from './lib/file-to-note-mapper.ts';
import { classifyChanges, deduplicateActions, type ChangeAction } from './lib/change-classifier.ts';
import { batchCheck, hasErrors } from './lib/note-integrity-checker.ts';
import { buildDailyReport, type DailyReportData } from './lib/daily-report-builder.ts';
import { $ } from 'bun';

const AGRABAH_REPO = '/Users/user/aladdin/agrabah';
const RAJAH_REPO = '/Users/user/aladdin/rajah';
const OBSIDIAN_ROOT = '/Users/user/aladdin/obsidian';
const SCRIPTS_DIR = `${OBSIDIAN_ROOT}/scripts/codebase-index`;
const NOISE_RULES_PATH = `${SCRIPTS_DIR}/noise-rules.json`;
const SYNC_STATE_PATH = `${SCRIPTS_DIR}/sync-state.json`;
const CODEBASE_ROOT = `${OBSIDIAN_ROOT}/Codebase`;

// ─── CLI args ───
const args = process.argv.slice(2);
function getArg(name: string): string | undefined {
    const arg = args.find(a => a.startsWith(`--${name}=`));
    return arg?.split('=').slice(1).join('=');
}
const dryRun = args.includes('--dry-run');
const finalizeOnly = args.includes('--finalize');
const since = getArg('since');
const until = getArg('until');
const commitArg = getArg('commits');
const specificCommits = commitArg?.split(',').filter(Boolean);

// ─── Main ───
async function main() {
    console.log('=== Incremental Codebase Sync ===');
    console.log(`Mode: ${dryRun ? 'DRY RUN' : finalizeOnly ? 'FINALIZE ONLY' : 'LIVE'}`);

    const syncState = JSON.parse(await readFile(SYNC_STATE_PATH, 'utf-8'));
    const effectiveSince = since ?? syncState.last_sync_date ?? '2026-04-21 20:00';
    const effectiveUntil = until ?? new Date().toISOString();
    const today = new Date().toISOString().split('T')[0];

    console.log(`Range: ${effectiveSince} → ${effectiveUntil}`);

    if (finalizeOnly) {
        await runFinalize(today, effectiveSince, effectiveUntil);
        return;
    }

    // ─── Stage 1: Collect git diffs ───
    console.log('\n--- Stage 1: Collecting git diffs ---');

    const agrabahCommits = await collectCommits({
        repoPath: AGRABAH_REPO,
        since: effectiveSince,
        until: effectiveUntil,
        commits: specificCommits,
    });
    console.log(`agrabah: ${agrabahCommits.length} commits`);

    const rajahCommits = await collectCommits({
        repoPath: RAJAH_REPO,
        since: effectiveSince,
        until: effectiveUntil,
    });
    console.log(`rajah: ${rajahCommits.length} commits`);

    // ─── Filter noise ───
    console.log('\n--- Filtering noise ---');
    const agrabahFiltered = await filterCommits(agrabahCommits, AGRABAH_REPO, NOISE_RULES_PATH);
    const rajahFiltered = await filterCommits(rajahCommits, RAJAH_REPO, NOISE_RULES_PATH);

    console.log(`agrabah: kept=${agrabahFiltered.kept.length}, skipped=${agrabahFiltered.skipped.length}, mixed=${agrabahFiltered.mixedSignal.length}`);
    console.log(`rajah: kept=${rajahFiltered.kept.length}, skipped=${rajahFiltered.skipped.length}`);

    // ─── Resolve rajah impacts ───
    console.log('\n--- Resolving rajah impacts ---');
    const rajahImpacts = await resolveRajahImpacts(rajahFiltered.kept, RAJAH_REPO, AGRABAH_REPO);
    console.log(`rajah impacts: ${rajahImpacts.length}`);

    // ─── Build note index ───
    console.log('\n--- Building note index ---');
    const noteIndex = await buildNoteIndex();
    console.log(`Note index: ${noteIndex.size} source files mapped`);

    // ─── Classify changes ───
    console.log('\n--- Classifying changes ---');
    const rawActions = await classifyChanges(agrabahFiltered.kept, rajahImpacts);
    const actions = deduplicateActions(rawActions);
    console.log(`Actions: ${actions.length} (deduplicated from ${rawActions.length})`);

    const byType = new Map<string, number>();
    for (const a of actions) {
        byType.set(a.type, (byType.get(a.type) ?? 0) + 1);
    }
    for (const [type, count] of byType) {
        console.log(`  ${type}: ${count}`);
    }

    if (dryRun) {
        console.log('\n=== DRY RUN — Actions that would be taken ===\n');
        for (const action of actions) {
            console.log(`[${action.type}] ${action.summary}`);
            if (action.affectedNotes.length > 0) {
                for (const n of action.affectedNotes) {
                    console.log(`  → ${n.note.fqn} (${n.note.path})`);
                }
            }
        }

        const reportData = buildReportData(
            today, effectiveSince, effectiveUntil,
            agrabahCommits.length, rajahCommits.length,
            agrabahFiltered, actions, [], 0
        );
        const reportPath = await buildDailyReport(reportData);
        console.log(`\nDry-run report: ${reportPath}`);
        return;
    }

    // ─── LIVE MODE: output action list for agent dispatch ───
    console.log('\n--- Stage 2: Action list for agent dispatch ---');
    const actionListPath = `${SCRIPTS_DIR}/pending-actions.json`;

    const serializableActions = actions.map(a => ({
        type: a.type,
        commitHash: a.commit.hash,
        commitMessage: a.commit.message,
        filePath: a.file.path,
        fileStatus: a.file.status,
        oldPath: a.file.oldPath,
        additions: a.file.additions,
        deletions: a.file.deletions,
        affectedNotes: a.affectedNotes.map(n => ({
            fqn: n.note.fqn,
            path: n.note.path,
            type: n.note.type,
        })),
        rajahImpact: a.rajahImpact ? {
            rajahFile: a.rajahImpact.rajahFile,
            affectedFqns: a.rajahImpact.affectedFqns,
            changeType: a.rajahImpact.changeType,
            diffSummary: a.rajahImpact.diffSummary,
        } : undefined,
        summary: a.summary,
    }));

    await writeFile(actionListPath, JSON.stringify(serializableActions, null, 2));
    console.log(`Action list written to: ${actionListPath}`);

    const agentRequired = actions.filter(a =>
        ['new_file', 'update_existing', 'rajah_new_method', 'rajah_signature'].includes(a.type)
    ).length;
    console.log(`Actions requiring agent dispatch: ${agentRequired}`);
    console.log(`Actions auto-handled (delete/rename/uncovered): ${actions.length - agentRequired}`);

    // Save partial sync metadata for --finalize
    const partialMeta = {
        today,
        effectiveSince,
        effectiveUntil,
        agrabahCommitCount: agrabahCommits.length,
        rajahCommitCount: rajahCommits.length,
        filterResult: {
            kept: agrabahFiltered.kept.map(c => ({ hash: c.hash, message: c.message, author: c.author })),
            skipped: agrabahFiltered.skipped.map(s => ({ commit: { hash: s.commit.hash, message: s.commit.message }, reason: s.reason })),
            mixedSignal: agrabahFiltered.mixedSignal.map(m => ({ commit: { hash: m.commit.hash, message: m.commit.message }, note: m.note })),
        },
        actionSummary: serializableActions,
    };
    await writeFile(`${SCRIPTS_DIR}/sync-partial-meta.json`, JSON.stringify(partialMeta, null, 2));

    console.log('\n=== Stage 1 complete. Dispatch agents for Stage 2, then run --finalize ===');
}

async function runFinalize(today: string, since: string, until: string) {
    console.log('\n--- Stage 3: Running idempotent scripts ---');

    const scripts = [
        'build-backlinks.ts',
        'build-overview-aggregates.ts',
        'generate-call-chain.ts',
        'generate-cross-server-rpc-graph.ts',
        'generate-indexes.ts',
        'check-orphan-notes.ts',
    ];

    for (const script of scripts) {
        console.log(`Running ${script}...`);
        try {
            await $`bun run ${script}`.cwd(SCRIPTS_DIR);
        } catch (e) {
            console.error(`  WARNING: ${script} failed:`, e);
        }
    }

    // ─── Stage 4: Integrity check ───
    console.log('\n--- Stage 4: Integrity check ---');

    // Load partial metadata
    let partialMeta: any;
    try {
        partialMeta = JSON.parse(await readFile(`${SCRIPTS_DIR}/sync-partial-meta.json`, 'utf-8'));
    } catch {
        console.error('No sync-partial-meta.json found. Run sync-from-git.ts without --finalize first.');
        process.exit(1);
    }

    const modifiedNotePaths: string[] = [];
    for (const action of partialMeta.actionSummary) {
        for (const note of action.affectedNotes) {
            if (!modifiedNotePaths.includes(note.path)) {
                modifiedNotePaths.push(note.path);
            }
        }
    }

    const integrityIssues = await batchCheck(modifiedNotePaths);
    const errors = integrityIssues.filter(i => i.severity === 'error');
    const warnings = integrityIssues.filter(i => i.severity === 'warning');
    console.log(`Integrity: ${errors.length} errors, ${warnings.length} warnings`);

    if (errors.length > 0) {
        console.log('\nErrors:');
        for (const e of errors) {
            console.log(`  [ERROR] ${e.notePath}: ${e.issue}`);
        }
    }

    // Read broken links count
    let brokenLinksCount = 0;
    try {
        const brokenReport = await readFile(`${CODEBASE_ROOT}/_index/broken-links-report.md`, 'utf-8');
        const match = brokenReport.match(/Total broken: (\d+)/);
        brokenLinksCount = match ? parseInt(match[1]) : 0;
    } catch { /* file might not exist */ }
    console.log(`Broken links: ${brokenLinksCount}`);

    // Build report
    const reportData = buildReportData(
        today, since, until,
        partialMeta.agrabahCommitCount,
        partialMeta.rajahCommitCount,
        partialMeta.filterResult,
        partialMeta.actionSummary.map((a: any) => ({
            type: a.type,
            file: { path: a.filePath },
            affectedNotes: a.affectedNotes.map((n: any) => ({ note: { fqn: n.fqn } })),
            summary: a.summary,
        })),
        integrityIssues,
        brokenLinksCount,
    );
    const reportPath = await buildDailyReport(reportData);
    console.log(`Daily report: ${reportPath}`);

    // Update sync state
    const syncState = JSON.parse(await readFile(SYNC_STATE_PATH, 'utf-8'));
    syncState.last_sync_date = until;
    syncState.sync_history.push({
        date: today,
        agrabah_commits: partialMeta.agrabahCommitCount,
        rajah_commits: partialMeta.rajahCommitCount,
        actions: partialMeta.actionSummary.length,
        report: reportPath,
    });
    await writeFile(SYNC_STATE_PATH, JSON.stringify(syncState, null, 2));

    console.log('\n=== Sync finalized ===');
}

function buildReportData(
    date: string,
    since: string,
    until: string,
    agrabahTotal: number,
    rajahTotal: number,
    filterResult: any,
    actions: any[],
    integrityIssues: any[],
    brokenLinksCount: number,
): DailyReportData {
    return {
        date,
        agrabahCommitRange: { since, until, total: agrabahTotal },
        rajahCommitRange: { since, until, total: rajahTotal },
        filterResult,
        actions,
        integrityIssues,
        brokenLinksCount,
        newNotesCreated: actions.filter((a: any) => a.type === 'new_file').map((a: any) => a.file?.path ?? a.filePath ?? ''),
        notesUpdated: [...new Set(actions.flatMap((a: any) => (a.affectedNotes ?? []).map((n: any) => n.note?.fqn ?? n.fqn ?? '')))],
        notesDeprecated: actions.filter((a: any) => a.type === 'delete_file').map((a: any) => a.file?.path ?? a.filePath ?? ''),
        rejectedUpdates: integrityIssues.filter((i: any) => i.severity === 'error').map((i: any) => ({ note: i.notePath, reason: i.issue })),
        agentDispatches: actions.filter((a: any) =>
            ['new_file', 'update_existing', 'rajah_new_method', 'rajah_signature'].includes(a.type)
        ).length,
    };
}

await main();
