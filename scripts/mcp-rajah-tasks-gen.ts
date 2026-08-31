#!/usr/bin/env bun
/**
 * mcp-rajah-tasks-gen.ts — 把全 rajah 表面（101 檔、2398 支真實 method）拆成「一個 rajah 檔案
 * 對應一個 JSON」的任務清單，寫進 aladdin_mcps/rajah-inventory/<rajah檔案 stem>.json，
 * 再由 mcp-rajah-tasks-build-index.ts 彙總成 _index.json（main json）。
 *
 * 拆分單位是 rajah 檔案，不是 server / service：
 * - 一個 rajah 檔案常含多個 service（如 game_back_office.rajah 有 14 個），全部收進同一個 json，
 *   保證這個 json 對某個 rajah 檔案而言「數量齊全」，實作 agent 打開一個 json 就能對應回唯一
 *   一個 rajah 檔案，不會漏看同檔其他 service。
 * - 大多數 method 目前都還沒決定要掛在哪個 MCP server 底下，用 service 分檔反而會製造出
 *   249 個檔案、大多數 server 欄位是 null 的破碎狀態。
 *
 * 冪等 + 不遺失既有進度：
 * - 若 aladdin_mcps/tool-gap-tasks.json（舊的、只涵蓋 3 個 service 的落差清單）裡已經有對應
 *   （用 service+method+rajah_ref 三者比對，不是用 id 比對，因為新舊 id 命名規則不同）的紀錄，
 *   直接把該筆的 status/server/notes/claimed_by/claimed_at/category 原樣搬過來，不會被重置成
 *   pending。舊檔本身不動、不刪，仍是目前 3 個 service pipeline（mcp-tasks.sh）的權威來源；
 *   這支腳本只是把它「投影」進更完整的全表面清單裡，兩邊要同步得靠人工或未來另外寫的腳本。
 * - 若某個 method 目前已經有任一 MCP tool 呼叫到它（用跟 mcp-rajah-inventory-scan.ts 相同的
 *   call-pattern 掃描），且舊檔沒有紀錄，狀態自動判定為 done，並附註是自動偵測、未經人工確認
 *   tool 是否真的對應這支 method（可能只是巧合呼叫到同名 method）。
 * - 已存在的 <rajah檔案>.json 會被整批覆寫重算（重新掃 rajah 源碼 + 舊 tasks.json + coverage），
 *   不是增量 merge——來源都是唯讀的，重算不會遺失資訊，除非有 agent 手動編輯過某個 per-file json
 *   加了内容（那種情況重跑本腳本會蓋掉，先跟人確認）。
 *
 * 用法：
 *   bun aladdin_ai/scripts/mcp-rajah-tasks-gen.ts                 # 全部 101 個檔案
 *   bun aladdin_ai/scripts/mcp-rajah-tasks-gen.ts --files=a.rajah,b.rajah   # 只處理指定檔案（給分批 agent 用）
 */

import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from 'fs';

const RAJAH_DIR = '/Users/user/aladdin/rajah/services';
const MCPS_DIR = '/Users/user/aladdin/aladdin_mcps';
const OUT_DIR = `${ MCPS_DIR }/rajah-inventory`;
const LEGACY_TASKS_FILE = `${ MCPS_DIR }/tool-gap-tasks.json`;

type Method = { name: string; line: number; isPlaceholder: boolean };
type ServiceBlock = { file: string; service: string; methods: Method[] };

function toCamelCase(s: string): string {
    return s.charAt(0).toLowerCase() + s.slice(1);
}

function extractAllServiceBlocks(file: string): ServiceBlock[] {
    const text = readFileSync(`${ RAJAH_DIR }/${ file }`, 'utf8');
    const lines = text.split('\n');
    const blocks: ServiceBlock[] = [];

    for (let i = 0; i < lines.length; i++) {
        const m = lines[ i ].match(/^service\s+(\w+)\s*\{/);
        if (!m) continue;
        const serviceName = m[ 1 ];

        let depth = 1;
        let j = i + 1;
        for (; j < lines.length && depth > 0; j++) {
            const opens = (lines[ j ].match(/\{/g) || []).length;
            const closes = (lines[ j ].match(/\}/g) || []).length;
            depth += opens - closes;
        }
        const blockLines = lines.slice(i + 1, j - 1);

        const methods: Method[] = [];
        for (let k = 0; k < blockLines.length; k++) {
            const mm = blockLines[ k ].match(/^\s*method\s+(\w+)\s*\(/);
            if (!mm) continue;
            methods.push({
                name: mm[ 1 ],
                line: i + 1 + k + 1,
                isPlaceholder: /^Placeholder[A-Z]/.test(mm[ 1 ]),
            });
        }
        blocks.push({ file, service: serviceName, methods });
        i = j - 1;
    }
    return blocks;
}

/** serviceCamel -> { methodName -> Set<server> }，跟 inventory scan 同款 call-pattern，但這裡多存 server 明細。 */
function scanCoverage(): Map<string, Map<string, Set<string>>> {
    const coverage = new Map<string, Map<string, Set<string>>>();
    const serverDirs = readdirSync(MCPS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);

    for (const server of serverDirs) {
        const toolsDir = `${ MCPS_DIR }/${ server }/src/tools`;
        let files: string[];
        try { files = readdirSync(toolsDir).filter((f) => f.endsWith('.ts')); } catch { continue; }

        for (const f of files) {
            const content = readFileSync(`${ toolsDir }/${ f }`, 'utf8');
            for (const mm of content.matchAll(/\.([a-z][A-Za-z0-9]*)\.([A-Z][A-Za-z0-9]*)\(/g)) {
                const camel = mm[ 1 ];
                const method = mm[ 2 ];
                if (!coverage.has(camel)) coverage.set(camel, new Map());
                const byMethod = coverage.get(camel)!;
                if (!byMethod.has(method)) byMethod.set(method, new Set());
                byMethod.get(method)!.add(server);
            }
        }
    }
    return coverage;
}

type Task = {
    id: string;
    service: string;
    method: string;
    rajah_ref: string;
    server: string | null;
    mcp_tool_id: string | null;
    status: 'pending' | 'in_progress' | 'review' | 'done' | 'failed' | 'needs_clarification';
    category: string | null;
    claimed_by: string | null;
    claimed_at: string | null;
    updated_at: string | null;
    notes: string;
    legacy_task_id: string | null;
};

function loadLegacyTasks(): Map<string, any> {
    const map = new Map<string, any>();
    if (!existsSync(LEGACY_TASKS_FILE)) return map;
    const store = JSON.parse(readFileSync(LEGACY_TASKS_FILE, 'utf8'));
    for (const t of store.tasks) {
        map.set(`${ t.service }::${ t.method }::${ t.rajah_ref }`, t);
    }
    return map;
}

function main() {
    const filesArg = process.argv.find((a) => a.startsWith('--files='));
    const files = filesArg
        ? filesArg.slice('--files='.length).split(',').map((s) => s.trim()).filter(Boolean)
        : readdirSync(RAJAH_DIR).filter((f) => f.endsWith('.rajah')).sort();

    mkdirSync(OUT_DIR, { recursive: true });
    const legacy = loadLegacyTasks();
    const coverage = scanCoverage();

    let totalTasks = 0;
    let totalDone = 0;
    let totalMigrated = 0;
    const writtenFiles: string[] = [];

    for (const file of files) {
        const stem = file.replace(/\.rajah$/, '');
        const blocks = extractAllServiceBlocks(file);
        const tasks: Task[] = [];

        for (const block of blocks) {
            for (const m of block.methods) {
                if (m.isPlaceholder) continue;
                const rajah_ref = `rajah/services/${ file }:${ m.line }`;
                const legacyKey = `${ block.service }::${ m.name }::${ rajah_ref }`;
                const legacyTask = legacy.get(legacyKey);
                const id = `${ stem }__${ block.service }__${ m.name }`;

                if (legacyTask) {
                    tasks.push({
                        id,
                        service: block.service,
                        method: m.name,
                        rajah_ref,
                        server: legacyTask.server ?? null,
                        mcp_tool_id: legacyTask.status === 'done' ? legacyTask.id : null,
                        status: legacyTask.status,
                        category: legacyTask.category ?? null,
                        claimed_by: legacyTask.claimed_by ?? null,
                        claimed_at: legacyTask.claimed_at ?? null,
                        updated_at: legacyTask.updated_at ?? null,
                        notes: legacyTask.notes ?? '',
                        legacy_task_id: legacyTask.id,
                    });
                    totalMigrated++;
                    if (legacyTask.status === 'done') totalDone++;
                    continue;
                }

                const camel = toCamelCase(block.service);
                const servers = coverage.get(camel)?.get(m.name);
                const isCovered = !!servers && servers.size > 0;
                if (isCovered) totalDone++;

                tasks.push({
                    id,
                    service: block.service,
                    method: m.name,
                    rajah_ref,
                    server: isCovered ? [ ...servers! ].sort().join(',') : null,
                    mcp_tool_id: null,
                    status: isCovered ? 'done' : 'pending',
                    category: null,
                    claimed_by: null,
                    claimed_at: null,
                    updated_at: null,
                    notes: isCovered
                        ? '自動偵測：已有 MCP tool 呼叫到同名 method（call-pattern 掃描），未經人工確認是否真的是刻意設計覆蓋，之後領這筆的人請先查對應 tool 檔案再動作。'
                        : '',
                    legacy_task_id: null,
                });
                totalTasks++;
            }
        }

        const outPath = `${ OUT_DIR }/${ stem }.json`;
        writeFileSync(outPath, JSON.stringify({
            rajah_file: `rajah/services/${ file }`,
            generated_at: new Date().toISOString(),
            services: [ ...new Set(blocks.map((b) => b.service)) ],
            tasks,
        }, null, 2) + '\n');
        writtenFiles.push(outPath);
    }

    console.log(`寫了 ${ writtenFiles.length } 個 json（${ OUT_DIR }/），共 ${ totalTasks + totalMigrated } 筆任務（其中 ${ totalMigrated } 筆從舊 tool-gap-tasks.json 搬過來、保留原狀態；${ totalDone } 筆狀態為 done）。`);
}

main();
