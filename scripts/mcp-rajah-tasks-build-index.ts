#!/usr/bin/env bun
/**
 * mcp-rajah-tasks-build-index.ts — 掃 aladdin_mcps/rajah-inventory/*.json（不含自己），
 * 彙總每個檔案的任務數與各狀態計數，寫成 _index.json（main json）。
 *
 * 這支不碰任何 task 內容，純讀彙總；每次任一個 per-file json 被改過（不論是重跑
 * mcp-rajah-tasks-gen.ts、或 agent 手動 claim/set 某筆狀態）之後都該重跑一次讓 index 保持最新。
 *
 * 用法：bun aladdin_ai/scripts/mcp-rajah-tasks-build-index.ts
 */

import { readFileSync, readdirSync, writeFileSync } from 'fs';

const DIR = '/Users/user/aladdin/aladdin_mcps/rajah-inventory';
const INDEX_FILE = `${ DIR }/_index.json`;

const STATUSES = [ 'pending', 'in_progress', 'review', 'done', 'failed', 'needs_clarification' ] as const;

function main() {
    const files = readdirSync(DIR).filter((f) => f.endsWith('.json') && f !== '_index.json').sort();

    const entries = files.map((f) => {
        const data = JSON.parse(readFileSync(`${ DIR }/${ f }`, 'utf8'));
        const counts: Record<string, number> = Object.fromEntries(STATUSES.map((s) => [ s, 0 ]));
        for (const t of data.tasks) counts[ t.status ] = (counts[ t.status ] ?? 0) + 1;
        return {
            rajah_file: data.rajah_file,
            json_path: `aladdin_mcps/rajah-inventory/${ f }`,
            services: data.services,
            total_tasks: data.tasks.length,
            counts,
        };
    });

    const grandTotal: Record<string, number> = Object.fromEntries(STATUSES.map((s) => [ s, 0 ]));
    let totalTasks = 0;
    for (const e of entries) {
        totalTasks += e.total_tasks;
        for (const s of STATUSES) grandTotal[ s ] += e.counts[ s ];
    }

    writeFileSync(INDEX_FILE, JSON.stringify({
        generated_at: new Date().toISOString(),
        schema_version: 1,
        note: '每個 files[] 項目對應一個 rajah/services/*.rajah 檔案的完整任務清單（aladdin_mcps/rajah-inventory/<stem>.json）。要重跑：先跑 mcp-rajah-tasks-gen.ts（可用 --files= 限定範圍），再跑本腳本重建這份 index。',
        total_files: entries.length,
        total_tasks: totalTasks,
        counts: grandTotal,
        files: entries,
    }, null, 2) + '\n');

    console.log(`寫了 ${ INDEX_FILE }：${ entries.length } 個檔案、共 ${ totalTasks } 筆任務。`);
    console.log(STATUSES.map((s) => `${ s }=${ grandTotal[ s ] }`).join('  '));
}

main();
