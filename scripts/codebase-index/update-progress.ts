/**
 * 進度追蹤更新工具。
 *
 * Usage:
 *   bun run update-progress.ts set-part-status <batch> <part> <status>
 *   bun run update-progress.ts set-package-phase <batch> <part> <packageId> <phase_1|phase_2> <pending|in_progress|completed>
 *   bun run update-progress.ts mark-package-completed <batch> <part> <packageId>
 *   bun run update-progress.ts mark-script-run <scriptName>
 *
 * Example:
 *   bun run update-progress.ts set-part-status batch_1 part_a in_progress
 *   bun run update-progress.ts set-package-phase batch_1 part_a M2-S1a phase_1 completed
 *   bun run update-progress.ts mark-package-completed batch_1 part_a M2-S1a
 *   bun run update-progress.ts mark-script-run build-backlinks.ts
 */

import { readFile, writeFile } from 'node:fs/promises';

const PROGRESS_PATH = '/Users/user/aladdin/obsidian/scripts/codebase-index/scan-progress.json';

async function load(): Promise<any> {
    return JSON.parse(await readFile(PROGRESS_PATH, 'utf-8'));
}

async function save(data: any): Promise<void> {
    data.last_updated = new Date().toISOString();
    await writeFile(PROGRESS_PATH, JSON.stringify(data, null, 2) + '\n');
}

async function main() {
    const [cmd, ...args] = process.argv.slice(2);
    const data = await load();

    if (cmd === 'set-part-status') {
        const [batch, part, status] = args;
        const p = data.milestone_2.batches[batch].parts[part];
        if (!p) throw new Error(`part not found: ${batch}/${part}`);
        p.status = status;
        if (status === 'in_progress' && !p.started_at) p.started_at = new Date().toISOString();
        if (status === 'completed' && !p.completed_at) p.completed_at = new Date().toISOString();
        console.log(`Set ${batch}/${part}.status = ${status}`);
    } else if (cmd === 'set-package-phase') {
        const [batch, part, pkgId, phaseKey, status] = args;
        const pkgs = data.milestone_2.batches[batch].parts[part].packages;
        const pkg = pkgs.find((p: any) => p.id === pkgId);
        if (!pkg) throw new Error(`package not found: ${pkgId}`);
        pkg[`${phaseKey}_status`] = status;
        console.log(`Set ${pkgId}.${phaseKey}_status = ${status}`);
    } else if (cmd === 'mark-package-completed') {
        const [batch, part, pkgId] = args;
        const pkgs = data.milestone_2.batches[batch].parts[part].packages;
        const pkg = pkgs.find((p: any) => p.id === pkgId);
        if (!pkg) throw new Error(`package not found: ${pkgId}`);
        pkg.phase_1_status = 'completed';
        pkg.phase_2_status = 'completed';
        if (!data.completed_packages.find((c: any) => c.id === pkgId)) {
            data.completed_packages.push({
                id: pkgId,
                scope: pkg.scope,
                completed_at: new Date().toISOString().split('T')[0],
            });
        }
        console.log(`Marked ${pkgId} completed`);
    } else if (cmd === 'mark-script-run') {
        const [scriptName] = args;
        data.scripts_last_run[scriptName] = new Date().toISOString();
        console.log(`Marked ${scriptName} run at ${data.scripts_last_run[scriptName]}`);
    } else if (cmd === 'show-next-part') {
        // 找最早 pending 的 part
        for (const [batchKey, batch] of Object.entries<any>(data.milestone_2.batches)) {
            if (batch.status === 'completed') continue;
            for (const [partKey, part] of Object.entries<any>(batch.parts ?? {})) {
                if (part.status !== 'completed') {
                    console.log(`Next: ${batchKey}/${partKey} (${part.status})`);
                    console.log(`Packages: ${part.packages.length}`);
                    for (const pkg of part.packages) {
                        console.log(`  - ${pkg.id}: ${pkg.scope} (P1=${pkg.phase_1_status}, P2=${pkg.phase_2_status})`);
                    }
                    return;
                }
            }
        }
        console.log('All batches completed!');
        return;
    } else {
        console.error('Unknown command:', cmd);
        console.error('Usage: see file header');
        process.exit(1);
    }

    await save(data);
}

await main();
