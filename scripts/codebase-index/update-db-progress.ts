/**
 * DB Schema & ORM 文件化進度追蹤工具。
 *
 * Usage:
 *   bun run update-db-progress.ts show-next          # 顯示下一個待辦 package
 *   bun run update-db-progress.ts show-batch <batch>  # 顯示某 batch 全部 package 狀態
 *   bun run update-db-progress.ts show-stats          # 顯示整體進度統計
 *
 *   bun run update-db-progress.ts set-status <pkgId> <pending|in_progress|completed>
 *   bun run update-db-progress.ts set-orm <pkgId> <pending|in_progress|completed>
 *   bun run update-db-progress.ts set-schema <pkgId> <pending|in_progress|completed|skipped>
 *   bun run update-db-progress.ts mark-completed <pkgId>             # 同時標記 orm + schema + status
 *   bun run update-db-progress.ts mark-batch-completed <batch>       # 標記整個 batch completed
 *
 *   bun run update-db-progress.ts mark-script-run <scriptName>
 *   bun run update-db-progress.ts add-notes-count <count>            # 累加已產出筆記數
 *
 * Examples:
 *   bun run update-db-progress.ts show-next
 *   bun run update-db-progress.ts set-status DB-01 in_progress
 *   bun run update-db-progress.ts set-orm DB-01 completed
 *   bun run update-db-progress.ts mark-completed DB-01
 *   bun run update-db-progress.ts mark-batch-completed batch_1
 *   bun run update-db-progress.ts mark-script-run build-backlinks.ts
 *   bun run update-db-progress.ts add-notes-count 102
 */

import { readFile, writeFile } from 'node:fs/promises';

const PROGRESS_PATH = new URL('./db-schema-progress.json', import.meta.url).pathname;

interface Package {
    id: string;
    db_name: string;
    orm_loc: number;
    orm_classes: number;
    status: string;
    orm_status: string;
    schema_status: string;
    started_at?: string;
    completed_at?: string;
    [key: string]: any;
}

interface Batch {
    status: string;
    theme: string;
    packages: Package[];
    started_at?: string;
    completed_at?: string;
}

interface ProgressData {
    last_updated: string | null;
    completed: string[];
    batches: Record<string, Batch>;
    scripts_last_run: Record<string, string | null>;
    notes_produced: number;
    [key: string]: any;
}

async function load(): Promise<ProgressData> {
    return JSON.parse(await readFile(PROGRESS_PATH, 'utf-8'));
}

async function save(data: ProgressData): Promise<void> {
    data.last_updated = new Date().toISOString();
    await writeFile(PROGRESS_PATH, JSON.stringify(data, null, 2) + '\n');
}

function findPackage(data: ProgressData, pkgId: string): { batch: Batch; batchKey: string; pkg: Package } | null {
    for (const [batchKey, batch] of Object.entries(data.batches)) {
        const pkg = batch.packages.find((p) => p.id === pkgId);
        if (pkg) return { batch, batchKey, pkg };
    }
    return null;
}

function showNext(data: ProgressData): void {
    for (const [batchKey, batch] of Object.entries(data.batches)) {
        if (batch.status === 'completed') continue;
        for (const pkg of batch.packages) {
            if (pkg.status !== 'completed') {
                console.log(`Next: ${pkg.id} — ${pkg.db_name} (${pkg.status})`);
                console.log(`  Batch: ${batchKey} (${batch.theme})`);
                console.log(`  ORM: ${pkg.orm_classes} classes, ${pkg.orm_loc} LOC → ${pkg.orm_status}`);
                console.log(`  Schema: ${pkg.schema_status}`);
                console.log(`  database_types: ${pkg.database_types_file}`);
                if (pkg.migration_dir) console.log(`  migration_dir: ${pkg.migration_dir}`);
                if (pkg.note) console.log(`  note: ${pkg.note}`);

                // 也列出同 batch 剩餘的 pending
                const remaining = batch.packages.filter((p) => p.status !== 'completed');
                if (remaining.length > 1) {
                    console.log(`\n  Same batch remaining (${remaining.length}):`);
                    for (const r of remaining) {
                        console.log(`    - ${r.id}: ${r.db_name} (orm=${r.orm_status}, schema=${r.schema_status})`);
                    }
                }
                return;
            }
        }
    }
    console.log('All DB schema packages completed!');
}

function showBatch(data: ProgressData, batchKey: string): void {
    const batch = data.batches[batchKey];
    if (!batch) {
        console.error(`Batch not found: ${batchKey}`);
        console.error(`Available: ${Object.keys(data.batches).join(', ')}`);
        process.exit(1);
    }
    console.log(`${batchKey}: ${batch.theme}`);
    console.log(`Status: ${batch.status}`);
    console.log(`Packages: ${batch.packages.length}\n`);

    const done = batch.packages.filter((p) => p.status === 'completed').length;
    console.log(`Progress: ${done}/${batch.packages.length}\n`);

    for (const pkg of batch.packages) {
        const flag = pkg.status === 'completed' ? '✓' : pkg.status === 'in_progress' ? '▶' : '○';
        console.log(`  ${flag} ${pkg.id}: ${pkg.db_name} (${pkg.orm_classes} cls, ${pkg.orm_loc} LOC)`);
        console.log(`      orm=${pkg.orm_status}  schema=${pkg.schema_status}`);
    }
}

function showStats(data: ProgressData): void {
    let totalPkg = 0;
    let donePkg = 0;
    let totalClasses = 0;
    let doneClasses = 0;

    for (const batch of Object.values(data.batches)) {
        for (const pkg of batch.packages) {
            totalPkg++;
            totalClasses += pkg.orm_classes;
            if (pkg.status === 'completed') {
                donePkg++;
                doneClasses += pkg.orm_classes;
            }
        }
    }

    console.log('=== DB Schema Documentation Progress ===');
    console.log(`Packages: ${donePkg}/${totalPkg} (${((donePkg / totalPkg) * 100).toFixed(1)}%)`);
    console.log(`ORM classes: ${doneClasses}/${totalClasses}`);
    console.log(`Notes produced: ${data.notes_produced}`);
    console.log(`Already done: ${data.completed.join(', ')}`);
    console.log('');

    for (const [batchKey, batch] of Object.entries(data.batches)) {
        const d = batch.packages.filter((p) => p.status === 'completed').length;
        const t = batch.packages.length;
        const bar = '█'.repeat(Math.round((d / t) * 20)) + '░'.repeat(20 - Math.round((d / t) * 20));
        console.log(`  ${batchKey} [${bar}] ${d}/${t}  ${batch.status}`);
    }
}

async function main() {
    const [cmd, ...args] = process.argv.slice(2);
    const data = await load();

    switch (cmd) {
        case 'show-next': {
            showNext(data);
            return; // read-only, no save
        }

        case 'show-batch': {
            showBatch(data, args[0]);
            return;
        }

        case 'show-stats': {
            showStats(data);
            return;
        }

        case 'set-status': {
            const [pkgId, status] = args;
            const found = findPackage(data, pkgId);
            if (!found) throw new Error(`Package not found: ${pkgId}`);
            found.pkg.status = status;
            if (status === 'in_progress' && !found.pkg.started_at) {
                found.pkg.started_at = new Date().toISOString();
                if (found.batch.status === 'pending') {
                    found.batch.status = 'in_progress';
                    found.batch.started_at = new Date().toISOString();
                }
            }
            if (status === 'completed' && !found.pkg.completed_at) {
                found.pkg.completed_at = new Date().toISOString();
            }
            console.log(`Set ${pkgId}.status = ${status}`);
            break;
        }

        case 'set-orm': {
            const [pkgId, status] = args;
            const found = findPackage(data, pkgId);
            if (!found) throw new Error(`Package not found: ${pkgId}`);
            found.pkg.orm_status = status;
            console.log(`Set ${pkgId}.orm_status = ${status}`);
            break;
        }

        case 'set-schema': {
            const [pkgId, status] = args;
            const found = findPackage(data, pkgId);
            if (!found) throw new Error(`Package not found: ${pkgId}`);
            found.pkg.schema_status = status;
            console.log(`Set ${pkgId}.schema_status = ${status}`);
            break;
        }

        case 'mark-completed': {
            const [pkgId] = args;
            const found = findPackage(data, pkgId);
            if (!found) throw new Error(`Package not found: ${pkgId}`);
            found.pkg.status = 'completed';
            found.pkg.orm_status = 'completed';
            if (found.pkg.schema_status !== 'skipped') {
                found.pkg.schema_status = 'completed';
            }
            if (!found.pkg.completed_at) found.pkg.completed_at = new Date().toISOString();
            if (!data.completed.includes(found.pkg.db_name)) {
                data.completed.push(found.pkg.db_name);
            }
            console.log(`Marked ${pkgId} (${found.pkg.db_name}) completed`);

            // check if batch is fully done
            const allDone = found.batch.packages.every((p) => p.status === 'completed');
            if (allDone) {
                found.batch.status = 'completed';
                found.batch.completed_at = new Date().toISOString();
                console.log(`  → ${found.batchKey} is now fully completed!`);
            }
            break;
        }

        case 'mark-batch-completed': {
            const [batchKey] = args;
            const batch = data.batches[batchKey];
            if (!batch) throw new Error(`Batch not found: ${batchKey}`);
            batch.status = 'completed';
            if (!batch.completed_at) batch.completed_at = new Date().toISOString();
            for (const pkg of batch.packages) {
                if (pkg.status !== 'completed') {
                    pkg.status = 'completed';
                    pkg.orm_status = 'completed';
                    if (pkg.schema_status !== 'skipped') pkg.schema_status = 'completed';
                    if (!pkg.completed_at) pkg.completed_at = new Date().toISOString();
                    if (!data.completed.includes(pkg.db_name)) data.completed.push(pkg.db_name);
                }
            }
            console.log(`Marked ${batchKey} and all its packages completed`);
            break;
        }

        case 'mark-script-run': {
            const [scriptName] = args;
            data.scripts_last_run[scriptName] = new Date().toISOString();
            console.log(`Marked ${scriptName} run at ${data.scripts_last_run[scriptName]}`);
            break;
        }

        case 'add-notes-count': {
            const count = parseInt(args[0], 10);
            if (isNaN(count)) throw new Error('count must be a number');
            data.notes_produced += count;
            console.log(`notes_produced: ${data.notes_produced} (+${count})`);
            break;
        }

        default: {
            console.error(`Unknown command: ${cmd}`);
            console.error('Commands: show-next, show-batch, show-stats, set-status, set-orm, set-schema, mark-completed, mark-batch-completed, mark-script-run, add-notes-count');
            process.exit(1);
        }
    }

    await save(data);
}

await main();
