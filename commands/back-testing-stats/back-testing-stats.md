---
name: back-testing-stats
description: Read backtest_tracker.md and display overall accuracy stats, per-severity breakdown, and generate an HTML cumulative trend chart.
user-invocable: true
---

# Back-Testing Statistics Report

Reads the back-testing tracker and produces:
1. An overall snapshot in the conversation
2. A per-severity breakdown table
3. An HTML cumulative trend chart opened in the browser

## Parameters

**No parameters required.** Simply run `/back-testing-stats`.

---

## Execution Flow

### Step 1: Read Tracker

Read the tracker file:
```
/Users/user/.claude/projects/-Users-user-aladdin/memory/backtest_tracker.md
```

If the file does not exist or has no data rows, report and stop:
```
Tracker is empty. Please run the query script first:
bun scripts/notion-backtest-query.ts
```

Parse all rows. Columns used:
- `單號` — ticket ID
- `嚴重性` — severity (P1重點 / P2較高 / P3一般 / P4較低)
- `回測狀態` — status (pending / in_progress / done / failed)
- `回測結論` — conclusion (see values below)
- `完成時間` — completion timestamp (YYYYMMDD HHMM), for trend ordering

Conclusion values:
- `✅ 分析正確`
- `✅ 部分正確`
- `❌ 分析錯誤`
- `⚠️ 無法比對`
- `➖ 不需修復`

---

### Step 2: Calculate Statistics

#### Overall counts

- `total` = all rows
- `done` = rows where 回測狀態 = `done`
- `failed` = rows where 回測狀態 = `failed`
- `in_progress` = rows where 回測狀態 = `in_progress` or `pending`

From `done` rows:
- `correct` = count of `✅ 分析正確`
- `partial` = count of `✅ 部分正確`
- `wrong` = count of `❌ 分析錯誤`
- `unable` = count of `⚠️ 無法比對`
- `no_fix` = count of `➖ 不需修復`

Rates (denominator = `done` total **excluding `no_fix`**):
- `effective` = done - no_fix (有效樣本數，排除不需修復)
- **完全成功率** = correct / effective
- **部分成功率** = partial / effective
- **總成功率** = (correct + partial) / effective

#### Per-severity counts

For each severity (P1重點 / P2較高 / P3一般 / P4較低), compute the same breakdown and three rates from `done` rows only (excluding `no_fix` from denominator).

---

### Step 3: Display in Conversation

Output the following two blocks:

**Block 1: Overall Snapshot**

```
## 回測統計報告

回測總計：{total} tickets
├─ done:         {done} ({done/total %})
├─ failed:       {failed} ({failed/total %})
└─ 未完成:        {in_progress} ({in_progress/total %})

回測結論分布（已完成 {done} 張）：
✅ 分析正確    {correct} ({correct/effective %})
✅ 部分正確    {partial} ({partial/effective %})
❌ 分析錯誤    {wrong}   ({wrong/effective %})
⚠️ 無法比對    {unable}  ({unable/effective %})
➖ 不需修復    {no_fix}  (不計入正確率)

有效樣本數：{effective}（排除 {no_fix} 張不需修復）
完全成功率：{correct/effective %}
部分成功率：{partial/done %}
總成功率　：{(correct+partial)/done %}
```

**Block 2: Per-Severity Breakdown**

```
         總數  正確  部分  錯誤  無法比對  不需修復  完全率  部分率  總成功率
P1重點     18    10     3     4      1   55.6%  16.7%   72.2%
P2較高     15     8     3     3      1   53.3%  20.0%   73.3%
P3一般      9     4     2     2      1   44.4%  22.2%   66.7%
P4較低      0     —     —     —      —      —      —       —
```

Rows with 0 done tickets show `—` for all rate columns.

---

### Step 4: Generate HTML Trend Chart

#### 4a. Build cumulative series

Take all `done` rows with a valid `完成時間`. Sort ascending by `完成時間`.

For each ticket in order, compute running totals at that point:
- cumulative `correct`, `partial`, `done_so_far`
- **累積總成功率** = (correct + partial) / done_so_far × 100
- **累積完全成功率** = correct / done_so_far × 100
- **累積部分成功率** = partial / done_so_far × 100

X-axis labels: ticket index (1, 2, 3 … N) with ticket ID as tooltip label.

#### 4b. Write HTML file

Compute current timestamp for filename: `YYYYMMDD-HHmm`.

Ensure directory exists:
```
/Users/user/aladdin/obsidian/skills/back-testing-stats/temp/
```

Write to:
```
/Users/user/aladdin/obsidian/skills/back-testing-stats/temp/back-testing-stats-{YYYYMMDD-HHmm}.html
```

HTML structure:
- Standalone single file, no external assets except Chart.js CDN
- `<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>`
- **HTML 必須包含完整的統計摘要，不能只有圖表。** 頁面由上而下依序包含：

#### Section 1: 總覽卡片
- 兩張卡片並排 (CSS grid 2-column)：
  - 左卡：**總成功率** (大字) + 已完成 / 總數
  - 右卡：**完全成功率** (大字) + 部分成功率
- 下方以 progress bar 顯示結論分布（分析正確 / 部分正確 / 分析錯誤 / 無法比對 / 不需修復）含數量與百分比

#### Section 2: 各嚴重性等級成功率表格
- HTML `<table>` 呈現 Step 3 Block 2 的完整內容
- 欄位：嚴重性 | 總數 | 正確 | 部分 | 錯誤 | 無法比對 | 不需修復 | 完全率 | 部分率 | 總成功率
- 嚴重性使用顏色標籤 (P1 紅 / P2 橙 / P3 黃 / P4 藍)

#### Section 3: 累積趨勢圖表
- Three lines on the same chart:
  - 總成功率 (blue)
  - 完全成功率 (green)
  - 部分成功率 (orange)
- Chart title: `累積成功率趨勢`
- Y-axis: 0–100%, label `成功率 (%)`
- X-axis: ticket index, label `完成順序`
- Legend displayed
- Tooltip shows: ticket ID, 總成功率, 完全成功率, 部分成功率

All chart data is embedded inline as a JSON literal in a `<script>` tag — no external data files.

**視覺風格：** 使用圓角卡片 (border-radius 12px)、淺灰底色 (#f5f5f5)、白色容器、box-shadow、system font stack。整體排版乾淨俐落。

#### 4c. Open in browser

```bash
open /Users/user/aladdin/obsidian/skills/back-testing-stats/temp/back-testing-stats-{YYYYMMDD-HHmm}.html
```

---

### Step 5:

```
圖表已在瀏覽器開啟：
back-testing-stats-{YYYYMMDD-HHmm}.html
```

---

## Notes

1. **Rates are always based on `done` count** — pending/failed/in_progress tickets are excluded from all accuracy calculations
2. **Tickets with empty `完成時間`** are excluded from the trend chart but still counted in the snapshot
3. **Three-line chart**: 總成功率 / 完全成功率 / 部分成功率 are plotted as separate cumulative lines
4. **Temp directory is ephemeral**: always created fresh, deleted after user confirms viewing
5. **Does not modify the tracker** or any Notion properties
