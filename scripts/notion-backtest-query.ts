/**
 * Notion Bug List 回測查詢腳本
 *
 * 固定篩選：
 *   狀態 = 待上版 / 待測試 / 測試完成 / 已解決 / 已完成
 *   AI分析 = 分析成功 / 分析失敗
 *
 * 用法：
 *   bun scripts/notion-backtest-query.ts [選項]
 *
 * 選項：
 *   --limit      回傳筆數上限（預設：50）
 *   --json       以 JSON 格式輸出
 *
 * 範例：
 *   bun scripts/notion-backtest-query.ts
 *   bun scripts/notion-backtest-query.ts --limit 20
 *   bun scripts/notion-backtest-query.ts --json
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const NOTION_TOKEN = '***REMOVED-NOTION-TOKEN***';
const DATA_SOURCE_ID = '21c87d78-618a-817f-ae71-000baa9ab11b';
const NOTION_API = 'https://api.notion.com/v1';
const MEMORY_DIR = join(homedir(), '.claude', 'projects', '-Users-user-aladdin', 'memory');
const TRACKER_PATH = join(MEMORY_DIR, 'backtest_tracker.md');

// ── 固定篩選值 ──

const VALID_STATUSES = ['測試完成', '已解決', '已完成', "WON'T FIX"];
const VALID_AI_ANALYSIS = ['分析成功', '分析失敗'];

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

// ── Notion API 呼叫 ──

function buildFilter(): object {
    return {
        and: [
            // 狀態：待上版 / 待測試 / 測試完成 / 已解決 / 已完成
            {
                or: VALID_STATUSES.map(s => ({
                    property: '狀態',
                    select: { equals: s },
                })),
            },
            // AI分析：分析成功 / 分析失敗
            {
                or: VALID_AI_ANALYSIS.map(a => ({
                    property: 'AI分析',
                    select: { equals: a },
                })),
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

// ── 資料擷取 ──

function extractText(richText: any[]): string {
    if (!richText || richText.length === 0) return '';
    return richText.map((t: any) => t.plain_text).join('');
}

function extractPeople(people: any[]): string {
    if (!people || people.length === 0) return '';
    return people.map((p: any) => p.name ?? '').filter(Boolean).join(', ');
}

function extractMultiSelect(ms: any[]): string {
    if (!ms || ms.length === 0) return '';
    return ms.map((m: any) => m.name).join(', ');
}

interface BugItem {
    id: string;
    url: string;
    faqNumber: number;
    title: string;
    status: string;
    severity: string;
    aiAnalysis: string;
    environment: string;
    affectedModules: string;
    techOwner: string;
    createdTime: string;
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
        environment: props['環境']?.select?.name ?? '',
        affectedModules: extractMultiSelect(props['影響模塊']?.multi_select ?? []),
        techOwner: extractPeople(props['負責技術']?.people ?? []),
        createdTime: props['回報時間']?.created_time ?? '',
    };
}

// ── 輸出 ──

function printTable(items: BugItem[]) {
    if (items.length === 0) {
        console.log('\n  沒有符合條件的 bug 單。\n');
        return;
    }

    console.log(`\n  共 ${items.length} 筆\n`);
    console.log('  單號       | AI分析   | 狀態     | 嚴重性  | 負責技術');
    console.log('  -----------|----------|----------|---------|--------');
    for (const item of items) {
        const faq = `FAQ-${item.faqNumber}`.padEnd(10);
        const ai = item.aiAnalysis.padEnd(8);
        const status = item.status.padEnd(8);
        const severity = item.severity.padEnd(7);
        console.log(`  ${faq} | ${ai} | ${status} | ${severity} | ${item.techOwner}`);
    }
    console.log();
}

// ── Tracker 讀寫 ──

interface TrackerEntry {
    faqNumber: number;
    url: string;
    severity: string;
    aiAnalysis: string;
    bugStatus: string;
    status: 'pending' | 'in_progress' | 'done' | 'failed';
    addedAt: string;
    doneAt?: string;
}

function readTracker(): TrackerEntry[] {
    if (!existsSync(TRACKER_PATH)) return [];

    const content = readFileSync(TRACKER_PATH, 'utf-8');
    const lines = content.split('\n');
    const entries: TrackerEntry[] = [];

    for (const line of lines) {
        // 格式: | FAQ-1234 | url | P2較高 | 分析成功 | 已解決 | pending | 2026-03-28 | |
        const match = line.match(/^\| FAQ-(\d+) \| (.+?) \| (.+?) \| (.+?) \| (.+?) \| (.+?) \| (.+?) \| (.*?) \|$/);
        if (match) {
            entries.push({
                faqNumber: parseInt(match[1], 10),
                url: match[2].trim(),
                severity: match[3].trim(),
                aiAnalysis: match[4].trim(),
                bugStatus: match[5].trim(),
                status: match[6].trim() as TrackerEntry['status'],
                addedAt: match[7].trim(),
                doneAt: match[8].trim() || undefined,
            });
        }
    }
    return entries;
}

function writeTracker(entries: TrackerEntry[]) {
    const header = `---
name: 回測追蹤清單
description: 記錄從 Notion Bug List 查詢到的待回測 bug 及其處理狀態，跨 session 共享
type: project
---

## 回測追蹤

| 單號 | Notion 連結 | 嚴重性 | AI分析 | Bug狀態 | 回測狀態 | 加入時間 | 完成時間 |
|------|-------------|--------|--------|---------|----------|----------|----------|
`;

    const rows = entries.map(e =>
        `| FAQ-${e.faqNumber} | ${e.url} | ${e.severity} | ${e.aiAnalysis} | ${e.bugStatus} | ${e.status} | ${e.addedAt} | ${e.doneAt ?? ''} |`
    );

    writeFileSync(TRACKER_PATH, header + rows.join('\n') + '\n', 'utf-8');
}

function mergeToTracker(items: BugItem[]): { added: number; skipped: number } {
    const existing = readTracker();
    const existingFaqs = new Set(existing.map(e => e.faqNumber));
    const today = new Date().toISOString().slice(0, 10);

    let added = 0;
    let skipped = 0;

    for (const item of items) {
        if (existingFaqs.has(item.faqNumber)) {
            skipped++;
        } else {
            existing.push({
                faqNumber: item.faqNumber,
                url: item.url,
                severity: item.severity,
                aiAnalysis: item.aiAnalysis,
                bugStatus: item.status,
                status: 'pending',
                addedAt: today,
            });
            added++;
        }
    }

    // 按單號由新到舊排序
    existing.sort((a, b) => b.faqNumber - a.faqNumber);
    writeTracker(existing);

    return { added, skipped };
}

// ── 主程式 ──

async function main() {
    const args = parseArgs();

    console.log(`\n  查詢條件: 狀態=${VALID_STATUSES.join('/')} | AI分析=${VALID_AI_ANALYSIS.join('/')} | 上限=${args.limit}`);

    const filter = buildFilter();
    const results = await queryDatabase(filter, args.limit);
    const items = results.map(extractBugItem);

    if (args.json) {
        console.log(JSON.stringify(items, null, 2));
    } else {
        printTable(items);
    }

    // 寫入 tracker
    const { added, skipped } = mergeToTracker(items);
    console.log(`  Tracker 更新: 新增 ${added} 筆, 略過 ${skipped} 筆（已存在）`);
    console.log(`  檔案: ${TRACKER_PATH}\n`);
}

main().catch((err) => {
    console.error('Error:', err.message);
    process.exit(1);
});
