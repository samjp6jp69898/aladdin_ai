#!/usr/bin/env bun
/**
 * mcp-tool-gap-scan.ts — 掃描 rajah service 定義，比對 obsidian/mcps/<server>/src/tools/*.ts
 * 現有工具的 header 註解（`rajah: Service.Method`），把「rajah 有定義、但目前沒有對應
 * MCP tool」的 method 寫成任務，累加進 obsidian/mcps/tool-gap-tasks.json。
 *
 * 這支腳本只做「有 vs 沒有」的機械式落差列舉，**不做**命名/分類判斷（那是
 * tool-naming-convention.md / method-category-checklist.md 的事，由 generate agent
 * 依 SOP 第 1 步重新查證，不可信任本腳本算出的 candidate_id 直接拿去命名）。
 *
 * 用法：
 *   bun obsidian/scripts/mcp-tool-gap-scan.ts                # 用預設 SCOPE 掃描，合併寫回 tasks.json
 *   bun obsidian/scripts/mcp-tool-gap-scan.ts --dry-run       # 只印會新增幾筆，不寫檔
 *
 * 冪等：已存在 tasks.json 裡的 id 不會被覆寫狀態；只會新增本次掃描到的新 candidate（狀態
 * 一律 "pending"）。若某個既有 pending/failed 任務這次發現已經被實作覆蓋，會印出提醒，
 * 但不自動改狀態——留給人或 mcp-tasks.sh 決定。
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';

const RAJAH_DIR = '/Users/user/aladdin/rajah/services';
const MCPS_DIR = '/Users/user/aladdin/obsidian/mcps';
const TASKS_FILE = `${ MCPS_DIR }/tool-gap-tasks.json`;

// 掃描範圍：目前鎖定 aladdin-admin / aladdin-platform 兩個 server 已在服務的核心
// service（見 2026-08-24 落差分析對話）。要擴大範圍（例如 MessageBoardPlatform）
// 只需要在這裡加一筆，不需要改下面的邏輯。
const SCOPE: { server: string; serverShort: string; rajahFile: string; service: string }[] = [
    { server: 'aladdin-admin', serverShort: 'aladdin_admin', rajahFile: 'game_back_office.rajah', service: 'GameVendorAdmin' },
    { server: 'aladdin-admin', serverShort: 'aladdin_admin', rajahFile: 'admin.rajah', service: 'PlatformManagement' },
    { server: 'aladdin-platform', serverShort: 'aladdin_platform', rajahFile: 'game_back_office.rajah', service: 'GameVendorPlatform' },
];

type RajahMethod = { service: string; method: string; line: number; excludedPlaceholder: boolean; suspectPlaceholderTypo: boolean };

function toSnakeCase(s: string): string {
    return s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2').toLowerCase();
}

/** 抓出檔案裡所有同名 service 區塊（rajah 允許同名 service 分散多處重開），逐區塊解析 method。 */
function extractMethods(rajahFile: string, serviceName: string): RajahMethod[] {
    const path = `${ RAJAH_DIR }/${ rajahFile }`;
    const text = readFileSync(path, 'utf8');
    const lines = text.split('\n');
    const results: RajahMethod[] = [];

    for (let i = 0; i < lines.length; i++) {
        const m = lines[ i ].match(new RegExp(`^service\\s+${ serviceName }\\s*\\{`));
        if (!m) continue;

        // 找對應的收尾 `}`（只算最外層大括號深度，method 內部沒有巢狀大括號可忽略）
        let depth = 1;
        let j = i + 1;
        for (; j < lines.length && depth > 0; j++) {
            const opens = (lines[ j ].match(/\{/g) || []).length;
            const closes = (lines[ j ].match(/\}/g) || []).length;
            depth += opens - closes;
        }
        const blockLines = lines.slice(i + 1, j - 1);

        for (let k = 0; k < blockLines.length; k++) {
            const mm = blockLines[ k ].match(/^\s*method\s+(\w+)\s*\(/);
            if (!mm) continue;
            const methodName = mm[ 1 ];
            results.push({
                service: serviceName,
                method: methodName,
                line: i + 1 + k + 1, // 1-indexed，對應原始檔案行號
                excludedPlaceholder: /^Placeholder[A-Z]/.test(methodName), // 規則 0：精確大小寫比對
                suspectPlaceholderTypo: /^placeholder/i.test(methodName) && !/^Placeholder[A-Z]/.test(methodName),
            });
        }
    }
    return results;
}

function toCamelCase(s: string): string {
    return s.charAt(0).toLowerCase() + s.slice(1);
}

/**
 * 掃現有 tool 檔「實際呼叫」的 RPC（`remote.<group>.<serviceCamel>.<Method>(` 呼叫點），
 * 而不是只看 header 註解——header 只寫這支 tool 對外的「身分」method（見
 * tool-naming-convention.md：Get 讀現值 + 另一支寫入時，header 只掛寫入那支的身分，
 * 但程式碼裡仍真的呼叫了 Get）。用實際呼叫點判斷「已覆蓋」才不會把這種內部 helper
 * 呼叫誤判成落差、重複產生任務。
 */
function scanCoveredMethods(server: string, serviceName: string): Set<string> {
    const toolsDir = `${ MCPS_DIR }/${ server }/src/tools`;
    const covered = new Set<string>();
    if (!existsSync(toolsDir)) return covered;

    const serviceCamel = toCamelCase(serviceName);
    const callPattern = new RegExp(`\\.${ serviceCamel }\\.([A-Za-z]+)\\(`, 'g');

    const glob = new Bun.Glob('*.ts');
    for (const file of glob.scanSync({ cwd: toolsDir })) {
        const content = readFileSync(`${ toolsDir }/${ file }`, 'utf8');
        for (const mm of content.matchAll(callPattern)) {
            covered.add(mm[ 1 ]);
        }
    }
    return covered;
}

type Task = {
    id: string;
    server: string;
    service: string;
    method: string;
    rajah_ref: string;
    status: 'pending' | 'in_progress' | 'review' | 'done' | 'failed' | 'needs_clarification';
    category: string | null;
    claimed_by: string | null;
    claimed_at: string | null;
    updated_at: string | null;
    notes: string;
};

function loadTasksFile(): { generated_at: string; scope: typeof SCOPE; tasks: Task[] } {
    if (!existsSync(TASKS_FILE)) {
        return { generated_at: new Date().toISOString(), scope: SCOPE, tasks: [] };
    }
    return JSON.parse(readFileSync(TASKS_FILE, 'utf8'));
}

function main() {
    const dryRun = process.argv.includes('--dry-run');
    const store = loadTasksFile();
    const existingIds = new Set(store.tasks.map((t) => t.id));

    let added = 0;
    let excludedPlaceholderCount = 0;
    const typoWarnings: string[] = [];
    const staleWarnings: string[] = [];

    for (const scope of SCOPE) {
        const methods = extractMethods(scope.rajahFile, scope.service);
        const covered = scanCoveredMethods(scope.server, scope.service);

        for (const m of methods) {
            if (m.excludedPlaceholder) { excludedPlaceholderCount++; continue; }
            if (m.suspectPlaceholderTypo) {
                typoWarnings.push(`${ scope.service }.${ m.method}（${scope.rajahFile}:${m.line}）—— 名字像 placeholder 但大小寫不符規則 0 的精確比對，未自動排除，generate agent 撿到這筆時要先查是否真的有 Service override`);
            }

            const candidateId = `${ scope.serverShort }_${ toSnakeCase(scope.service) }_${ toSnakeCase(m.method) }`;
            const isCovered = covered.has(m.method);

            if (isCovered) {
                const existing = store.tasks.find((t) => t.id === candidateId);
                if (existing && existing.status !== 'done') {
                    staleWarnings.push(`${ candidateId }：目前狀態是 ${ existing.status }，但已在 ${ scope.server }/src/tools/*.ts 找到對應 header——確認是否該手動 set 成 done`);
                }
                continue;
            }

            if (existingIds.has(candidateId)) continue; // 已經在 tasks.json 裡（任何狀態），不重複加

            store.tasks.push({
                id: candidateId,
                server: scope.server,
                service: scope.service,
                method: m.method,
                rajah_ref: `rajah/services/${ scope.rajahFile }:${ m.line }`,
                status: 'pending',
                category: null,
                claimed_by: null,
                claimed_at: null,
                updated_at: null,
                notes: '',
            });
            existingIds.add(candidateId);
            added++;
        }
    }

    console.log(`新增 ${ added } 筆 pending task；排除 Placeholder（規則 0）${ excludedPlaceholderCount } 支。`);
    if (typoWarnings.length) console.log(`\n疑似 placeholder 大小寫拼錯（未自動排除，需人工/agent 複查）：\n- ${ typoWarnings.join('\n- ') }`);
    if (staleWarnings.length) console.log(`\n可能過期的既有任務（已被實作覆蓋但狀態未更新）：\n- ${ staleWarnings.join('\n- ') }`);

    if (dryRun) { console.log('\n--dry-run：未寫檔。'); return; }

    store.generated_at = new Date().toISOString();
    writeFileSync(TASKS_FILE, JSON.stringify(store, null, 2) + '\n');
    console.log(`已寫回 ${ TASKS_FILE }`);
}

main();
