/**
 * Notion Bug List 查詢腳本 v2 — /create-mr / /create-mrs 用
 *
 * 篩選條件：
 *   狀態     = 仍有問題 OR 待處理
 *   AI分析   = 待分析
 *   當前指派 = 至少一人在 tech-users.csv 名單中（程式端後篩）
 *
 * 寫入 tracker file：
 *   ~/.claude/projects/-Users-user-aladdin/memory/bug_analysis_tracker.md
 *   （與 /analyze-bugs 共用同一份 tracker；schema 保持一致 6 欄）
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

function buildFilter(): object {
    return {
        and: [
            {
                or: [
                    { property: '狀態', select: { equals: '仍有問題' } },
                    { property: '狀態', select: { equals: '待處理' } },
                ],
            },
            { property: 'AI分析', select: { equals: '待分析' } },
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

function mergeToTracker(items: BugItem[]): { added: number; skipped: number } {
    const existing = readTracker();
    const existingByFaq = new Map(existing.map(e => [e.faqNumber, e]));
    const today = new Date().toISOString().slice(0, 10);

    let added = 0;
    let skipped = 0;

    for (const item of items) {
        const entry = existingByFaq.get(item.faqNumber);

        if (entry) {
            // 既存：不覆寫狀態，避免把 in_progress / done / failed 拉回
            skipped++;
        } else {
            existing.push({
                faqNumber: item.faqNumber,
                url: item.url,
                severity: item.severity,
                status: 'pending',
                addedAt: today,
            });
            added++;
        }
    }

    existing.sort((a, b) => b.faqNumber - a.faqNumber);
    writeTracker(existing);

    return { added, skipped };
}

// ── 主程式 ──

async function main() {
    const args = parseArgs();

    console.log(`\n  查詢條件: 狀態=仍有問題,待處理 | AI分析=待分析 | 當前指派∈ tech-users.csv | 上限=${args.limit}`);

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

    const { added, skipped } = mergeToTracker(items);
    console.log(`  Tracker 更新: 新增 ${added} 筆 (pending), 略過 ${skipped} 筆（已存在）`);
    console.log(`  檔案: ${TRACKER_PATH}\n`);
}

main().catch((err) => {
    console.error('Error:', err.message);
    process.exit(1);
});
