import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { $ } from 'bun';
import matter from 'gray-matter';
import { extractJsdocAbove } from './lib/jsdoc-extractor.ts';
import { parseJsdoc, type ParsedJsdoc } from './lib/jsdoc-parser.ts';
import { parseNote } from './lib/note-section-parser.ts';
import { mergeBullets, mergeDescription } from './lib/section-merger.ts';
import { renderJsdoc } from './lib/jsdoc-renderer.ts';

const AGRABAH_REPO = '/Users/user/aladdin/agrabah';
const OBSIDIAN_ROOT = '/Users/user/aladdin/obsidian';
const SCRIPTS_DIR = `${OBSIDIAN_ROOT}/scripts/codebase-index`;
const PENDING_ACTIONS_PATH = `${SCRIPTS_DIR}/pending-actions.json`;
const REPORT_PATH = `${SCRIPTS_DIR}/writeback-report.json`;

export interface WritebackAction {
    noteAbsPath: string;
    sourceAbsPath: string;
    declarationLine: number;
}

export interface WritebackOptions {
    dryRun?: boolean;
}

export interface WritebackReport {
    timestamp: string;
    summary: {
        actions_total: number;
        files_modified: number;
        actions_unchanged: number;
        actions_skipped: number;
    };
    modified: Array<{ source: string; method: string; note: string }>;
    unchanged: Array<{ source: string; note: string }>;
    skipped: Array<{ note: string; reason: string }>;
}

const ABORT_SKIP_RATIO = 0.30;

function mergeParsed(source: ParsedJsdoc, note: ParsedJsdoc): ParsedJsdoc {
    return {
        description: { sentences: mergeDescription(source.description.sentences, note.description.sentences) },
        scenarios: { bullets: mergeBullets(source.scenarios.bullets, note.scenarios.bullets) },
        rules: { bullets: mergeBullets(source.rules.bullets, note.rules.bullets) },
        notes: { bullets: mergeBullets(source.notes.bullets, note.notes.bullets) },
        tags: { raw: source.tags.raw },
    };
}

function detectIndent(sourceText: string, jsdocStartLine: number): string {
    const lines = sourceText.split('\n');
    const line = lines[jsdocStartLine - 1] ?? '';
    const m = line.match(/^(\s*)/);
    return m ? m[1] : '';
}

async function isFileDirty(filePath: string): Promise<boolean> {
    try {
        const out = await $`git diff --quiet -- ${filePath}`.cwd(AGRABAH_REPO).quiet().nothrow();
        return out.exitCode !== 0;
    } catch {
        return false;
    }
}

export async function runWriteback(
    actions: WritebackAction[],
    opts: WritebackOptions = {},
): Promise<WritebackReport> {
    const report: WritebackReport = {
        timestamp: new Date().toISOString(),
        summary: { actions_total: actions.length, files_modified: 0, actions_unchanged: 0, actions_skipped: 0 },
        modified: [],
        unchanged: [],
        skipped: [],
    };

    for (const action of actions) {
        const noteContent = await readFile(action.noteAbsPath, 'utf-8');
        const noteMatter = matter(noteContent);

        if (noteMatter.data.human_edited === true) {
            report.skipped.push({ note: action.noteAbsPath, reason: 'note.human_edited = true' });
            continue;
        }

        const isInRepo = action.sourceAbsPath.startsWith(AGRABAH_REPO);
        if (isInRepo && (await isFileDirty(action.sourceAbsPath))) {
            report.skipped.push({ note: action.noteAbsPath, reason: 'source file has uncommitted changes' });
            continue;
        }

        const sourceText = await readFile(action.sourceAbsPath, 'utf-8');
        const block = extractJsdocAbove(sourceText, action.declarationLine);
        if (!block) {
            report.skipped.push({ note: action.noteAbsPath, reason: 'no JSDoc block found above declaration' });
            continue;
        }

        const indent = detectIndent(sourceText, block.startLine);

        const sourceParsed = parseJsdoc(block.text);
        const noteParsed = parseNote(noteContent);
        const merged = mergeParsed(sourceParsed, noteParsed);
        const rendered = renderJsdoc(merged, indent);

        if (rendered === block.text) {
            report.unchanged.push({ source: action.sourceAbsPath, note: action.noteAbsPath });
            report.summary.actions_unchanged++;
            continue;
        }

        if (!opts.dryRun) {
            const lines = sourceText.split('\n');
            const newLines = [
                ...lines.slice(0, block.startLine - 1),
                rendered,
                ...lines.slice(block.endLine),
            ];
            await writeFile(action.sourceAbsPath, newLines.join('\n'), 'utf-8');
        }

        report.modified.push({
            source: action.sourceAbsPath,
            method: `(line ${action.declarationLine})`,
            note: action.noteAbsPath,
        });
        report.summary.files_modified++;
    }

    report.summary.actions_skipped = report.skipped.length;

    if (actions.length > 0 && report.summary.actions_skipped / actions.length > ABORT_SKIP_RATIO) {
        console.error(`Stage 4 warning: skip ratio ${report.summary.actions_skipped}/${actions.length} > ${ABORT_SKIP_RATIO}`);
    }

    return report;
}

interface PendingAction {
    status?: string;
    type: string;
    filePath?: string;
    affectedNotes?: Array<{ path: string; type?: string }>;
}

export async function loadProcessedActions(): Promise<WritebackAction[]> {
    const raw = await readFile(PENDING_ACTIONS_PATH, 'utf-8');
    const data = JSON.parse(raw) as { actions: PendingAction[] };
    const result: WritebackAction[] = [];

    for (const action of data.actions) {
        const status = action.status ?? 'pending';
        if (status !== 'processed') continue;
        if (!action.affectedNotes || action.affectedNotes.length === 0) continue;

        for (const note of action.affectedNotes) {
            if (note.type !== 'rpc-method' && note.type !== 'service') continue;
            const noteAbsPath = note.path.startsWith('/') ? note.path : resolve(OBSIDIAN_ROOT, note.path);
            const noteContent = await readFile(noteAbsPath, 'utf-8');
            const fm = matter(noteContent).data;
            if (!fm.source_file || !fm.source_line) continue;
            const sourceRel = (fm.source_file as string).replace(/^agrabah\//, '');
            const sourceAbsPath = resolve(AGRABAH_REPO, sourceRel);
            result.push({
                noteAbsPath,
                sourceAbsPath,
                declarationLine: fm.source_line as number,
            });
        }
    }
    return result;
}

if (import.meta.path === Bun.main) {
    const args = process.argv.slice(2);
    const dryRun = args.includes('--dry-run');
    const actions = await loadProcessedActions();
    console.log(`Stage 4: writeback-jsdoc (${dryRun ? 'DRY RUN' : 'LIVE'})`);
    console.log(`  Actions to process: ${actions.length}`);

    const report = await runWriteback(actions, { dryRun });

    await writeFile(REPORT_PATH, JSON.stringify(report, null, 2));
    console.log(`\n  ✓ ${report.summary.files_modified} files modified`);
    console.log(`  − ${report.summary.actions_unchanged} unchanged`);
    console.log(`  ⊘ ${report.summary.actions_skipped} skipped (see ${REPORT_PATH})`);
    if (report.summary.files_modified > 0 && !dryRun) {
        console.log(`\nPlease review:`);
        console.log(`  cd ${AGRABAH_REPO} && git diff`);
    }
}
