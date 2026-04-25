import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';

export interface DailyReportData {
    date: string;                    // YYYY-MM-DD
    agrabahCommitRange: { since: string; until: string; total: number };
    rajahCommitRange: { since: string; until: string; total: number };
    filterResult: {
        kept: Array<{ hash: string; message: string; author: string }>;
        skipped: Array<{ commit: { hash: string; message: string }; reason: string }>;
        mixedSignal: Array<{ commit: { hash: string; message: string }; note: string }>;
    };
    actions: Array<{
        type: string;
        file: { path: string };
        affectedNotes: Array<{ note: { fqn: string } }>;
        summary: string;
    }>;
    integrityIssues: Array<{ notePath: string; severity: string; issue: string }>;
    brokenLinksCount: number;
    newNotesCreated: string[];
    notesUpdated: string[];
    notesDeprecated: string[];
    rejectedUpdates: Array<{ note: string; reason: string }>;
    agentDispatches: number;
}

const REPORT_BASE_DIR = '/Users/user/aladdin/obsidian/Codebase/_index/daily-sync-reports';

function shortHash(hash: string): string {
    return hash.slice(0, 7);
}

function escapeCell(value: string): string {
    return value.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

export async function buildDailyReport(data: DailyReportData): Promise<string> {
    const reportDir = REPORT_BASE_DIR;
    await mkdir(reportDir, { recursive: true });

    const reportPath = join(reportDir, `${data.date}.md`);
    const generatedAt = new Date().toISOString();

    const sections: string[] = [];

    // 1. Title
    sections.push(`# Daily Sync Report — ${data.date}`);
    sections.push('');
    sections.push(`Generated: ${generatedAt}`);
    sections.push('');

    // 2. Summary table
    const summaryRows = [
        ['agrabah commits scanned', String(data.agrabahCommitRange.total)],
        ['rajah commits scanned', String(data.rajahCommitRange.total)],
        ['commits kept', String(data.filterResult.kept.length)],
        ['commits skipped', String(data.filterResult.skipped.length)],
        ['commits mixed signal', String(data.filterResult.mixedSignal.length)],
        ['actions taken', String(data.actions.length)],
        ['integrity issues', String(data.integrityIssues.length)],
        ['broken links', String(data.brokenLinksCount)],
        ['notes created', String(data.newNotesCreated.length)],
        ['notes updated', String(data.notesUpdated.length)],
        ['notes deprecated', String(data.notesDeprecated.length)],
        ['rejected updates', String(data.rejectedUpdates.length)],
        ['agent dispatches', String(data.agentDispatches)],
    ];

    sections.push('## Summary');
    sections.push('');
    sections.push('| Metric | Value |');
    sections.push('|--------|-------|');
    for (const [metric, value] of summaryRows) {
        sections.push(`| ${escapeCell(metric)} | ${escapeCell(value)} |`);
    }
    sections.push('');

    // 3. Commits Processed
    if (data.filterResult.kept.length > 0) {
        sections.push('## Commits Processed');
        sections.push('');
        sections.push('| Hash | Message | Author |');
        sections.push('|------|---------|--------|');
        for (const commit of data.filterResult.kept) {
            sections.push(
                `| ${escapeCell(shortHash(commit.hash))} | ${escapeCell(commit.message)} | ${escapeCell(commit.author)} |`
            );
        }
        sections.push('');
    }

    // 4. Skipped Commits
    if (data.filterResult.skipped.length > 0) {
        sections.push('## Skipped Commits');
        sections.push('');
        sections.push('| Hash | Message | Reason |');
        sections.push('|------|---------|--------|');
        for (const item of data.filterResult.skipped) {
            sections.push(
                `| ${escapeCell(shortHash(item.commit.hash))} | ${escapeCell(item.commit.message)} | ${escapeCell(item.reason)} |`
            );
        }
        sections.push('');
    }

    // 5. Actions Taken
    if (data.actions.length > 0) {
        sections.push('## Actions Taken');
        sections.push('');
        sections.push('| Type | File | Notes Affected | Summary |');
        sections.push('|------|------|---------------|---------|');
        for (const action of data.actions) {
            const notesAffected = action.affectedNotes.map(n => n.note.fqn).join(', ');
            sections.push(
                `| ${escapeCell(action.type)} | ${escapeCell(action.file.path)} | ${escapeCell(notesAffected)} | ${escapeCell(action.summary)} |`
            );
        }
        sections.push('');
    }

    // 6. Integrity Issues
    if (data.integrityIssues.length > 0) {
        sections.push('## Integrity Issues');
        sections.push('');
        sections.push('| Note | Severity | Issue |');
        sections.push('|------|----------|-------|');
        for (const issue of data.integrityIssues) {
            sections.push(
                `| ${escapeCell(issue.notePath)} | ${escapeCell(issue.severity)} | ${escapeCell(issue.issue)} |`
            );
        }
        sections.push('');
    }

    // 7. Rejected Updates
    if (data.rejectedUpdates.length > 0) {
        sections.push('## Rejected Updates');
        sections.push('');
        for (const item of data.rejectedUpdates) {
            sections.push(`- **${escapeCell(item.note)}**: ${escapeCell(item.reason)}`);
        }
        sections.push('');
    }

    const content = sections.join('\n');
    await writeFile(reportPath, content, 'utf-8');

    return reportPath;
}
