/**
 * Notion Bug List 查詢腳本
 *
 * 固定篩選：狀態=待處理,仍有問題,處理中 AI分析=待分析,需要重跑
 *
 * 寫入 tracker 的規則：
 *   - AI分析=待分析：新單以 `pending` 加入；已存在於 tracker 則略過（不覆寫現有狀態）
 *   - AI分析=需要重跑：若 tracker 已有紀錄（通常 status=done/failed），重設為 `rerun`
 *     並更新加入時間、清空完成時間；若尚未有紀錄則以 `rerun` 新增。`rerun` 為
 *     `pending` 的優先子型別，/analyze-bugs-v3 會先處理。
 *
 * 用法：
 *   bun scripts/notion-bug-query.ts <嚴重性> [選項]
 *
 * 嚴重性（必填，支援逗號分隔多值）：
 *   P1重點 | P2較高 | P3一般 | P4較低
 *
 * 選項：
 *   --limit      回傳筆數上限（預設：20）
 *   --json       以 JSON 格式輸出
 *
 * 範例：
 *   bun scripts/notion-bug-query.ts P2較高
 *   bun scripts/notion-bug-query.ts P1重點
 *   bun scripts/notion-bug-query.ts "P1重點,P2較高"
 *   bun scripts/notion-bug-query.ts P2較高 --limit 5
 *   bun scripts/notion-bug-query.ts P1重點 --json
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// token 單一來源：環境變數 > /Users/user/aladdin/.env（bun 從專案根執行時會自動載入 .env）
const NOTION_TOKEN = (() => {
  let t = process.env.ALD_NOTION_TOKEN ?? '';
  if (!t) {
    try {
      const env = require('fs').readFileSync('/Users/user/aladdin/.env', 'utf8');
      t = env.match(/^ALD_NOTION_TOKEN=(.+)$/m)?.[1]?.trim().replace(/^["']|["']$/g, '') ?? '';
    } catch {}
  }
  if (!t.startsWith('ntn_')) {
    console.error('ERROR: ALD_NOTION_TOKEN 未設定——請在 /Users/user/aladdin/.env 加 ALD_NOTION_TOKEN=ntn_xxx');
    process.exit(1);
  }
  return t;
})();
const DATA_SOURCE_ID = '21c87d78-618a-817f-ae71-000baa9ab11b';
const NOTION_API = 'https://api.notion.com/v1';
const MEMORY_DIR = join(homedir(), '.claude', 'projects', '-Users-user-aladdin', 'memory');
const TRACKER_PATH = join(MEMORY_DIR, 'bug_analysis_tracker.md');

// ── 參數解析 ──

const VALID_SEVERITIES = ['P1重點', 'P2較高', 'P3一般', 'P4較低'];

function parseArgs() {
    const args = process.argv.slice(2);

    // 第一個非 -- 開頭的參數為 severity
    const positional = args.filter(a => !a.startsWith('--'));
    const severity = positional[0];

    if (!severity) {
        console.error('錯誤：請提供嚴重性參數\n');
        console.error('用法：bun scripts/notion-bug-query.ts <嚴重性>');
        console.error('可選值：P1重點 | P2較高 | P3一般 | P4較低（支援逗號分隔多值）');
        console.error('\n範例：bun scripts/notion-bug-query.ts P2較高');
        console.error('      bun scripts/notion-bug-query.ts "P1重點,P2較高"');
        process.exit(1);
    }

    const severityValues = severity.split(',').map(s => s.trim());
    const invalid = severityValues.filter(v => !VALID_SEVERITIES.includes(v));
    if (invalid.length > 0) {
        console.error(`錯誤：無效的嚴重性值 "${invalid.join(', ')}"`);
        console.error(`可選值：${VALID_SEVERITIES.join(' | ')}`);
        process.exit(1);
    }

    // 解析 -- 選項
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
        severity,
        limit: parseInt(flags['limit'] ?? '20', 10),
        json: flags['json'] === 'true',
    };
}

// ── Notion API 呼叫 ──

interface NotionFilter {
    property: string;
    select: { equals: string };
}

interface NotionOrGroup {
    or: NotionFilter[];
}

function buildFilter(severity: string): object {
    const conditions: (NotionFilter | NotionOrGroup)[] = [];

    // 狀態固定篩選多值
    const statusValues = ['待處理', '仍有問題', '處理中'];
    conditions.push({
        or: statusValues.map(v => ({ property: '狀態', select: { equals: v } })),
    });
    // AI分析 固定：待分析（新單）或 需要重跑（重送分析）
    const aiAnalysisValues = ['待分析', '需要重跑'];
    conditions.push({
        or: aiAnalysisValues.map(v => ({ property: 'AI分析', select: { equals: v } })),
    });

    // 嚴重性支援逗號分隔多值
    const severityValues = severity.split(',').map(s => s.trim());
    if (severityValues.length === 1) {
        conditions.push({ property: '嚴重性', select: { equals: severityValues[0] } });
    } else {
        conditions.push({
            or: severityValues.map(v => ({ property: '嚴重性', select: { equals: v } })),
        });
    }

    return { and: conditions };
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
    affectedPorts: string;
    affectedModules: string;
    affectedMerchants: string;
    reportType: string;
    reporter: string;
    assignee: string;
    techOwner: string;
    createdTime: string;
    lastEditedTime: string;
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
        affectedPorts: extractMultiSelect(props['影響端口']?.multi_select ?? []),
        affectedModules: extractMultiSelect(props['影響模塊']?.multi_select ?? []),
        affectedMerchants: extractMultiSelect(props['影響商戶']?.multi_select ?? []),
        reportType: props['回報類型']?.select?.name ?? '',
        reporter: props['回報人員']?.select?.name ?? '',
        assignee: extractPeople(props['當前指派']?.people ?? []),
        techOwner: extractPeople(props['負責技術']?.people ?? []),
        createdTime: props['回報時間']?.created_time ?? '',
        lastEditedTime: props['最後編輯時間']?.last_edited_time ?? '',
    };
}

// ── 輸出 ──

function printTable(items: BugItem[]) {
    if (items.length === 0) {
        console.log('\n  沒有符合條件的 bug 單。\n');
        return;
    }

    console.log(`\n  共 ${items.length} 筆\n`);
    for (const item of items) {
        const rerunMark = item.aiAnalysis === '需要重跑' ? ' [需要重跑]' : '';
        console.log(`  FAQ-${item.faqNumber}${rerunMark}  |  ${item.url}`);
    }
    console.log();
}

// ── Tracker 讀寫 ──

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

function mergeToTracker(items: BugItem[]): {
    added: number;
    addedRerun: number;
    reset: number;
    skipped: number;
} {
    const existing = readTracker();
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
            // 全新單
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

    // 按單號由新到舊排序
    existing.sort((a, b) => b.faqNumber - a.faqNumber);
    writeTracker(existing);

    return { added, addedRerun, reset, skipped };
}

// ── 主程式 ──

async function main() {
    const args = parseArgs();

    console.log(`\n  查詢條件: 狀態=待處理,仍有問題,處理中 | AI分析=待分析,需要重跑 | 嚴重性=${args.severity} | 上限=${args.limit}`);

    const filter = buildFilter(args.severity);
    const results = await queryDatabase(filter, args.limit);
    const items = results.map(extractBugItem);

    if (args.json) {
        console.log(JSON.stringify(items, null, 2));
    } else {
        printTable(items);
    }

    // 寫入 tracker
    const { added, addedRerun, reset, skipped } = mergeToTracker(items);
    console.log(
        `  Tracker 更新: 新增 ${added} 筆 (pending), 新增 ${addedRerun} 筆 (rerun), `
        + `重置 ${reset} 筆 (既有→rerun), 略過 ${skipped} 筆（已存在且未標記重跑）`
    );
    console.log(`  檔案: ${TRACKER_PATH}\n`);
}

main().catch((err) => {
    console.error('Error:', err.message);
    process.exit(1);
});
