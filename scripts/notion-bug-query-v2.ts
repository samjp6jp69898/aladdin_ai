/**
 * Notion Bug List 查詢腳本 v2 — /create-mr / /create-mrs 用
 *
 * 篩選條件：
 *   狀態     = 仍有問題 OR 待處理
 *   AI分析   = 待分析 OR 需要重跑
 *   當前指派 = 至少一人在 tech-users.csv 名單中（程式端後篩）
 *
 * 寫入 tracker file：
 *   ~/.claude/projects/-Users-user-aladdin/memory/bug_analysis_tracker.md
 *   （與 /analyze-bugs 共用同一份 tracker；schema 保持一致 6 欄）
 *
 * 每次執行除了「合併新單」外，也會依 Notion 現狀「清理」tracker：
 *   tracker 中狀態仍為 pending、但該單在 Notion 已被改成非（仍有問題/待處理/處理中）者，
 *   視為已失效，從 tracker 移除（rerun / in_progress / done / failed 一律保留）。
 *
 * 用法：
 *   bun obsidian/scripts/notion-bug-query-v2.ts [選項]
 *
 * 選項：
 *   --limit      回傳筆數上限（預設：50）
 *   --json       以 JSON 格式輸出
 *
 * 範例：
 *   bun obsidian/scripts/notion-bug-query-v2.ts
 *   bun obsidian/scripts/notion-bug-query-v2.ts --limit 20
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const NOTION_TOKEN = '***REMOVED-NOTION-TOKEN***';
const DATA_SOURCE_ID = '21c87d78-618a-817f-ae71-000baa9ab11b';
const NOTION_API = 'https://api.notion.com/v1';
const MEMORY_DIR = join(homedir(), '.claude', 'projects', '-Users-user-aladdin', 'memory');
const TRACKER_PATH = join(MEMORY_DIR, 'bug_analysis_tracker.md');
const TECH_USERS_CSV = '/Users/user/aladdin/obsidian/commands/create-mr/references/tech-users.csv';

// ── 參數解析 ──

function parseArgs() {
    const args = process.argv.slice(2);
    const flags: Record<string, string> = {};
    for (let i = 0; i < args.length; i++) {
        if (args[i].startsWith('--') && i + 1 < args.length && !args[i + 1].startsWith('--')) {
            flags[args[i].slice(2)] = args[i + 1];
            i++;
        } else if (args[i].startsWith('--')) {
            flags[args[i].slice(2)] = 'true';
        }
    }
    return {
        limit: parseInt(flags['limit'] ?? '50', 10),
        json: flags['json'] === 'true',
    };
}

// ── tech-users.csv 載入 ──

interface TechUser {
    notion_user_id: string;
    notion_user_name: string;
    email: string;
}

function loadTechUsers(): TechUser[] {
    if (!existsSync(TECH_USERS_CSV)) {
        throw new Error(`tech-users.csv 不存在: ${TECH_USERS_CSV}`);
    }
    const lines = readFileSync(TECH_USERS_CSV, 'utf-8').split('\n').filter(l => l.trim());
    const [header, ...rows] = lines;
    const cols = header.split(',');
    const nameIdx = cols.indexOf('notion_user_name');
    const idIdx = cols.indexOf('notion_user_id');
    const emailIdx = cols.indexOf('email');
    if (nameIdx < 0 || idIdx < 0 || emailIdx < 0) {
        throw new Error(`tech-users.csv 缺少必要欄位 (notion_user_name / notion_user_id / email)`);
    }
    return rows.map(row => {
        const cells = row.split(',');
        return {
            notion_user_id: cells[idIdx].trim(),
            notion_user_name: cells[nameIdx].trim(),
            email: cells[emailIdx].trim(),
        };
    }).filter(u => u.notion_user_id);
}

// ── Notion API 呼叫 ──

// 「想要的狀態」單一事實來源：查詢新單與 tracker 清理判定都以此為準
const WANTED_STATUSES = ['仍有問題', '待處理', '處理中'];

function buildStatusOnlyFilter(): object {
    return {
        or: WANTED_STATUSES.map(s => ({ property: '狀態', select: { equals: s } })),
    };
}

function buildFilter(): object {
    return {
        and: [
            buildStatusOnlyFilter(),
            {
                or: [
                    { property: 'AI分析', select: { equals: '待分析' } },
                    { property: 'AI分析', select: { equals: '需要重跑' } },
                ],
            },
        ],
    };
}

async function queryDatabase(filter: object, limit: number) {
    const allResults: any[] = [];
    let startCursor: string | undefined;
    let hasMore = true;

    while (hasMore && allResults.length < limit) {
        const body: any = {
            filter,
            sorts: [{ property: '單號', direction: 'descending' }],
            page_size: Math.min(100, limit - allResults.length),
        };
        if (startCursor) {
            body.start_cursor = startCursor;
        }

        const res = await fetch(`${NOTION_API}/data_sources/${DATA_SOURCE_ID}/query`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${NOTION_TOKEN}`,
                'Notion-Version': '2025-09-03',
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
        });

        if (!res.ok) {
            const err = await res.text();
            throw new Error(`Notion API error ${res.status}: ${err}`);
        }

        const data = await res.json();
        allResults.push(...data.results);
        hasMore = data.has_more;
        startCursor = data.next_cursor;
    }

    return allResults.slice(0, limit);
}

/**
 * 抓取「目前仍處於想要狀態」的所有單號全集（不限 AI分析、不限 assignee）。
 * 用途：判定 tracker 中 pending 的單在 Notion 是否已被改成非想要狀態。
 * 注意：必須抓「全部」（不可受 --limit 影響），否則會把未抓到的單誤判為已離開狀態而誤刪。
 */
async function fetchWantedFaqSet(): Promise<Set<number>> {
    const pages = await queryDatabase(buildStatusOnlyFilter(), Number.MAX_SAFE_INTEGER);
    const set = new Set<number>();
    for (const page of pages) {
        const n = page.properties?.['單號']?.unique_id?.number;
        if (typeof n === 'number') set.add(n);
    }
    return set;
}

// ── 資料擷取 ──

function extractText(richText: any[]): string {
    if (!richText || richText.length === 0) return '';
    return richText.map((t: any) => t.plain_text).join('');
}

interface NotionPerson {
    id: string;
    name: string;
}

function extractPeopleDetailed(people: any[]): NotionPerson[] {
    if (!people || people.length === 0) return [];
    return people.map((p: any) => ({ id: p.id ?? '', name: p.name ?? '' })).filter(p => p.id);
}

interface BugItem {
    id: string;
    url: string;
    faqNumber: number;
    title: string;
    status: string;
    severity: string;
    aiAnalysis: string;
    assignees: NotionPerson[];
    matchedTechUser?: TechUser;
}

function extractBugItem(page: any): BugItem {
    const props = page.properties;
    return {
        id: page.id,
        url: page.url ?? `https://www.notion.so/${page.id.replace(/-/g, '')}`,
        faqNumber: props['單號']?.unique_id?.number ?? 0,
        title: extractText(props['問題摘要']?.title ?? []),
        status: props['狀態']?.select?.name ?? '',
        severity: props['嚴重性']?.select?.name ?? '',
        aiAnalysis: props['AI分析']?.select?.name ?? '',
        assignees: extractPeopleDetailed(props['當前指派']?.people ?? []),
    };
}

// ── Tech 名單後篩 ──

function filterByTechAssignee(items: BugItem[], techUsers: TechUser[]): BugItem[] {
    const techById = new Map(techUsers.map(u => [u.notion_user_id, u]));
    const matched: BugItem[] = [];
    for (const item of items) {
        const hit = item.assignees.find(a => techById.has(a.id));
        if (hit) {
            item.matchedTechUser = techById.get(hit.id);
            matched.push(item);
        }
    }
    return matched;
}

// ── 輸出 ──

function printTable(items: BugItem[]) {
    if (items.length === 0) {
        console.log('\n  沒有符合條件的 bug 單。\n');
        return;
    }
    console.log(`\n  共 ${items.length} 筆（命中 tech-users.csv 名單）\n`);
    for (const item of items) {
        const tech = item.matchedTechUser;
        console.log(
            `  FAQ-${item.faqNumber}  |  ${item.severity}  |  ${item.status}  |  指派→${tech?.notion_user_name} <${tech?.email}>`
        );
        console.log(`    ${item.url}`);
    }
    console.log();
}

// ── Tracker 讀寫（與 v1 / /analyze-bugs 共用 schema，6 欄）──

interface TrackerEntry {
    faqNumber: number;
    url: string;
    severity: string;
    status: 'pending' | 'rerun' | 'in_progress' | 'done' | 'failed';
    addedAt: string;
    doneAt?: string;
}

function readTracker(): TrackerEntry[] {
    if (!existsSync(TRACKER_PATH)) return [];

    const content = readFileSync(TRACKER_PATH, 'utf-8');
    const lines = content.split('\n');
    const entries: TrackerEntry[] = [];

    for (const line of lines) {
        // 格式: | FAQ-1234 | url | P2較高 | pending | 2026-03-27 | |
        const match = line.match(/^\| FAQ-(\d+) \| (.+?) \| (.+?) \| (.+?) \| (.+?) \| (.*?) \|$/);
        if (match) {
            entries.push({
                faqNumber: parseInt(match[1], 10),
                url: match[2].trim(),
                severity: match[3].trim(),
                status: match[4].trim() as TrackerEntry['status'],
                addedAt: match[5].trim(),
                doneAt: match[6].trim() || undefined,
            });
        }
    }
    return entries;
}

function writeTracker(entries: TrackerEntry[]) {
    const header = `---
name: Bug 分析追蹤清單
description: 記錄從 Notion Bug List 查詢到的待分析 bug 及其處理狀態，跨 session 共享
type: project
---

## Bug 分析追蹤

| 單號 | Notion 連結 | 嚴重性 | 狀態 | 加入時間 | 完成時間 |
|------|-------------|--------|------|----------|----------|
`;

    const rows = entries.map(e =>
        `| FAQ-${e.faqNumber} | ${e.url} | ${e.severity} | ${e.status} | ${e.addedAt} | ${e.doneAt ?? ''} |`
    );

    writeFileSync(TRACKER_PATH, header + rows.join('\n') + '\n', 'utf-8');
}

function applyMerge(existing: TrackerEntry[], items: BugItem[]): { added: number; addedRerun: number; reset: number; skipped: number } {
    const existingByFaq = new Map(existing.map(e => [e.faqNumber, e]));
    const today = new Date().toISOString().slice(0, 10);

    let added = 0;
    let addedRerun = 0;
    let reset = 0;
    let skipped = 0;

    for (const item of items) {
        const isRerun = item.aiAnalysis === '需要重跑';
        const entry = existingByFaq.get(item.faqNumber);

        if (entry) {
            if (isRerun) {
                // 重送分析：一律把既有紀錄拉回處理佇列，不論原本是 done/failed/pending
                entry.status = 'rerun';
                entry.severity = item.severity;
                entry.url = item.url;
                entry.addedAt = today;
                entry.doneAt = undefined;
                reset++;
            } else {
                // 待分析 + 已存在：維持既有狀態，不覆寫（避免把做到一半或 done 的單拉回）
                skipped++;
            }
        } else {
            existing.push({
                faqNumber: item.faqNumber,
                url: item.url,
                severity: item.severity,
                status: isRerun ? 'rerun' : 'pending',
                addedAt: today,
            });
            if (isRerun) {
                addedRerun++;
            } else {
                added++;
            }
        }
    }

    return { added, addedRerun, reset, skipped };
}

/**
 * 清理：tracker 中狀態仍為 pending、但 Notion 現狀已不在 WANTED_STATUSES 的單，從 tracker 移除。
 * 僅針對 pending（rerun / in_progress / done / failed 一律保留，避免動到處理中或已完成的紀錄）。
 * `existing` 會被就地過濾。
 */
function applyCleanup(existing: TrackerEntry[], wantedFaqSet: Set<number>): TrackerEntry[] {
    const removed: TrackerEntry[] = [];
    for (let i = existing.length - 1; i >= 0; i--) {
        const e = existing[i];
        if (e.status === 'pending' && !wantedFaqSet.has(e.faqNumber)) {
            removed.push(e);
            existing.splice(i, 1);
        }
    }
    return removed;
}

// ── 主程式 ──

async function main() {
    const args = parseArgs();

    console.log(`\n  查詢條件: 狀態=仍有問題,待處理,處理中 | AI分析=待分析,需要重跑 | 當前指派∈ tech-users.csv | 上限=${args.limit}`);

    const techUsers = loadTechUsers();
    console.log(`  Tech 名單載入: ${techUsers.length} 人`);

    const filter = buildFilter();
    const results = await queryDatabase(filter, args.limit);
    const rawItems = results.map(extractBugItem);

    console.log(`  Notion 回傳 ${rawItems.length} 筆（未過濾 assignee）`);

    const items = filterByTechAssignee(rawItems, techUsers);

    if (args.json) {
        console.log(JSON.stringify(items, null, 2));
    } else {
        printTable(items);
    }

    // 讀一次 tracker，先合併新單，再依 Notion 現狀清理失效的 pending，最後寫回一次
    const existing = readTracker();
    const { added, addedRerun, reset, skipped } = applyMerge(existing, items);

    // 抓 Notion 目前仍處於想要狀態的單號全集（不限 AI分析 / assignee）作為清理依據
    const wantedFaqSet = await fetchWantedFaqSet();
    console.log(`  Notion 現處於 ${WANTED_STATUSES.join('/')} 的單號全集: ${wantedFaqSet.size} 筆`);

    let removed: TrackerEntry[] = [];
    if (wantedFaqSet.size === 0) {
        // 防呆：全集為空多半是查詢異常，若據此清理會一次誤刪所有 pending，故跳過
        console.log('  ⚠ 想要狀態全集為空，略過 pending 清理（避免誤刪）');
    } else {
        removed = applyCleanup(existing, wantedFaqSet);
    }

    existing.sort((a, b) => b.faqNumber - a.faqNumber);
    writeTracker(existing);

    console.log(`  Tracker 更新: 新增 ${added} 筆 (pending), 新增 ${addedRerun} 筆 (rerun), 重置 ${reset} 筆 (→rerun), 略過 ${skipped} 筆（已存在）`);
    console.log(`  Tracker 清理: 移除 ${removed.length} 筆（pending 但 Notion 狀態已非 ${WANTED_STATUSES.join('/')}）`);
    if (removed.length > 0) {
        const list = removed.sort((a, b) => b.faqNumber - a.faqNumber).map(e => `FAQ-${e.faqNumber}`).join(', ');
        console.log(`    ${list}`);
    }
    console.log(`  檔案: ${TRACKER_PATH}\n`);
}

main().catch((err) => {
    console.error('Error:', err.message);
    process.exit(1);
});
