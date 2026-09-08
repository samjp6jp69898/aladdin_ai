/**
 * 回測統計計算腳本（給 /back-testing-stats 用）
 *
 * 讀 backtest_tracker.md，做「表格解析 + 計數 + 除法 + 累積序列」這類純確定性計算，
 * 輸出一份 JSON 給呼叫端（slash command）直接拿去排版/畫圖，不需要模型自己手算。
 *
 * 用法：
 *   bun scripts/back-testing-stats-compute.ts [tracker路徑]
 *   （tracker 路徑預設 /Users/user/.claude/projects/-Users-user-aladdin/memory/backtest_tracker.md）
 *
 * 輸出：純 JSON 印到 stdout。
 */

import { readFileSync, readdirSync } from 'fs';

const TRACKER_PATH =
  process.argv[2] || '/Users/user/.claude/projects/-Users-user-aladdin/memory/backtest_tracker.md';
const BACKTESTING_NOTES_DIR = '/Users/user/aladdin/obsidian/backTesting';

const SEVERITIES = ['P1重點', 'P2較高', 'P3一般', 'P4較低'];

type Row = {
  ticket: string;
  severity: string;
  status: string; // 回測狀態: done / pending / in_progress / failed
  conclusion: string | null; // 回測結論，非 done 時為 null
  completedAt: string | null; // 完成時間 "YYYYMMDD HHMM"
};

function parseTracker(text: string): Row[] {
  const rows: Row[] = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('| FAQ-') && !line.match(/^\|\s*[A-Za-z]+-\d+\s*\|/)) continue;
    // 拆表格列：去頭尾空 cell（開頭/結尾的 | 造成）
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    // 固定前綴：單號, Notion連結, 嚴重性, AI分析, Bug狀態, 回測狀態
    if (cells.length < 6) continue;
    const [ticket, , severity, , , status, ...rest] = cells;
    let conclusion: string | null = null;
    let completedAt: string | null = null;
    if (status === 'done') {
      // done 列多一格「回測結論」：rest = [回測結論, 加入時間, 完成時間]
      conclusion = rest[0] || null;
      completedAt = rest[2] || null;
    } else {
      // pending/in_progress/failed：rest = [加入時間, 完成時間(通常空)]
      completedAt = rest[1] || null;
    }
    rows.push({ ticket, severity, status, conclusion, completedAt });
  }
  return rows;
}

/** 對「✅ 部分正確」的 ticket，讀對應筆記的 Failure Mode 區塊分 A（等效替代）/ B（不完整） */
function classifyPartial(ticket: string): 'A' | 'B' {
  let files: string[];
  try {
    files = readdirSync(BACKTESTING_NOTES_DIR).filter((f) => f.startsWith(`${ticket}-`) && f.endsWith('.md'));
  } catch {
    return 'B';
  }
  if (files.length === 0) return 'B';
  let content: string;
  try {
    content = readFileSync(`${BACKTESTING_NOTES_DIR}/${files[0]}`, 'utf8');
  } catch {
    return 'B';
  }
  const section = content.match(/## Failure Mode\n([\s\S]*?)(\n## |\n?$)/);
  if (!section) return 'B';
  return section[1].includes('alternative-path') ? 'A' : 'B';
}

type Bucket = {
  total: number;
  done: number;
  correct: number;
  partial: number;
  partial_A: number;
  partial_B: number;
  wrong: number;
  unable: number;
  no_fix: number;
  effective: number;
  strict_rate: number | null;
  full_rate: number | null;
  total_rate: number | null;
};

function emptyBucket(): Bucket {
  return {
    total: 0,
    done: 0,
    correct: 0,
    partial: 0,
    partial_A: 0,
    partial_B: 0,
    wrong: 0,
    unable: 0,
    no_fix: 0,
    effective: 0,
    strict_rate: null,
    full_rate: null,
    total_rate: null,
  };
}

function pct(n: number, d: number): number | null {
  return d > 0 ? Math.round((n / d) * 1000) / 10 : null;
}

function finalizeRates(b: Bucket) {
  b.effective = b.done - b.no_fix;
  b.strict_rate = pct(b.correct, b.effective);
  b.full_rate = pct(b.correct + b.partial_A, b.effective);
  b.total_rate = pct(b.correct + b.partial, b.effective);
}

function main() {
  const text = readFileSync(TRACKER_PATH, 'utf8');
  const rows = parseTracker(text);
  if (rows.length === 0) {
    console.log(JSON.stringify({ error: 'EMPTY_TRACKER' }));
    process.exit(0);
  }

  const overall = emptyBucket();
  overall.total = rows.length;
  const bySeverity: Record<string, Bucket> = {};
  for (const s of SEVERITIES) bySeverity[s] = emptyBucket();

  let failedCount = 0;
  let inProgressCount = 0;

  // 累積序列用：只收 done 且有 completedAt 的列，先排序
  const doneWithDate: (Row & { partialKind?: 'A' | 'B' })[] = [];

  for (const row of rows) {
    const bucket = bySeverity[row.severity];
    if (bucket) bucket.total++;

    if (row.status === 'failed') {
      failedCount++;
      continue;
    }
    if (row.status !== 'done') {
      inProgressCount++;
      continue;
    }

    overall.done++;
    if (bucket) bucket.done++;

    let partialKind: 'A' | 'B' | undefined;
    switch (row.conclusion) {
      case '✅ 分析正確':
        overall.correct++;
        if (bucket) bucket.correct++;
        break;
      case '✅ 部分正確': {
        partialKind = classifyPartial(row.ticket);
        overall.partial++;
        if (bucket) bucket.partial++;
        if (partialKind === 'A') {
          overall.partial_A++;
          if (bucket) bucket.partial_A++;
        } else {
          overall.partial_B++;
          if (bucket) bucket.partial_B++;
        }
        break;
      }
      case '❌ 分析錯誤':
        overall.wrong++;
        if (bucket) bucket.wrong++;
        break;
      case '⚠️ 無法比對':
        overall.unable++;
        if (bucket) bucket.unable++;
        break;
      case '➖ 不需修復':
        overall.no_fix++;
        if (bucket) bucket.no_fix++;
        break;
    }

    if (row.completedAt) doneWithDate.push({ ...row, partialKind });
  }

  finalizeRates(overall);
  for (const s of SEVERITIES) finalizeRates(bySeverity[s]);

  // 累積序列：依完成時間排序（"YYYYMMDD HHMM" 字串排序即為時間排序）
  doneWithDate.sort((a, b) => (a.completedAt! < b.completedAt! ? -1 : a.completedAt! > b.completedAt! ? 1 : 0));

  let cCorrect = 0;
  let cPartialA = 0;
  let cPartial = 0;
  const cumulative = doneWithDate
    .filter((r) => r.conclusion !== '➖ 不需修復') // 累積序列的分母排除不需修復，比照整體有效樣本口徑
    .map((r, i) => {
      if (r.conclusion === '✅ 分析正確') cCorrect++;
      if (r.conclusion === '✅ 部分正確') {
        cPartial++;
        if (r.partialKind === 'A') cPartialA++;
      }
      const doneSoFar = i + 1;
      return {
        ticket: r.ticket,
        index: doneSoFar,
        correct: cCorrect,
        partial_A: cPartialA,
        partial: cPartial,
        done_so_far: doneSoFar,
        strict_rate: pct(cCorrect, doneSoFar),
        full_rate: pct(cCorrect + cPartialA, doneSoFar),
        total_rate: pct(cCorrect + cPartial, doneSoFar),
      };
    });

  console.log(
    JSON.stringify(
      {
        total: overall.total,
        done: overall.done,
        failed: failedCount,
        in_progress: inProgressCount,
        overall,
        bySeverity,
        cumulative,
      },
      null,
      2,
    ),
  );
}

main();
