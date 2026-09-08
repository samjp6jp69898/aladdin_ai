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

### Step 1-2: Compute Statistics（腳本化，確定性計算）

表格解析、計數、除法、累積序列這類確定性計算一律交給腳本，manager 不手算：

```bash
bun /Users/user/aladdin/aladdin_ai/scripts/back-testing-stats-compute.ts
```

若輸出是 `{"error": "EMPTY_TRACKER"}`，報告並停止：
```
Tracker is empty. Please run the query script first:
bun scripts/notion-backtest-query.ts
```

腳本輸出一份 JSON（見腳本檔頭註解），已算好：
- `total` / `done` / `failed` / `in_progress`
- `overall`：`correct` / `partial` / `partial_A` / `partial_B` / `wrong` / `unable` / `no_fix` / `effective` / `strict_rate`（嚴格正確率）/ `full_rate`（完全成功率，含等效，**主要指標**）/ `total_rate`（總成功率）
- `bySeverity`：`P1重點` / `P2較高` / `P3一般` / `P4較低` 各自同上欄位
- `cumulative`：依完成時間排序、逐張累加後的 `strict_rate` / `full_rate` / `total_rate` 序列（Step 4 畫圖直接用）

`partial_A`（等效替代解法）/ `partial_B`（不完整）的判定，是腳本讀 `/Users/user/aladdin/obsidian/backTesting/{單號}-*.md` 的 `## Failure Mode` 區塊是否含 `alternative-path` 分出來的——腳本已做好，不需要重讀筆記或重新分類。

Step 3、4 的所有數字直接引用這份 JSON，不重新計算、不重新解析 tracker 表格。

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
   ├─ A 等效替代  {partial_A}
   └─ B 不完整    {partial_B}
❌ 分析錯誤    {wrong}   ({wrong/effective %})
⚠️ 無法比對    {unable}  ({unable/effective %})
➖ 不需修復    {no_fix}  (不計入正確率)

有效樣本數：{effective}（排除 {no_fix} 張不需修復）
嚴格正確率　　　：{correct/effective %}（僅完全照 commit 對齊）
完全成功率(含等效)：{(correct+partial_A)/effective %}（**主要指標**，partial_A 視為正確）
總成功率　　　　：{(correct+partial)/effective %}（含部分正確 B 不完整）
```

**Block 2: Per-Severity Breakdown**

```
         總數  正確  部分A  部分B  錯誤  無法比對  不需修復  嚴格率  含等效率  總成功率
P1重點     18    10     2      1     4      1          55.6%   66.7%    72.2%
P2較高     15     8     2      1     3      1          53.3%   66.7%    73.3%
P3一般      9     4     1      1     2      1          44.4%   55.6%    66.7%
P4較低      0     —     —      —     —      —      —       —       —        —
```

Rows with 0 done tickets show `—` for all rate columns.

---

### Step 4: Generate HTML Trend Chart

#### 4a. Cumulative series

直接用 Step 1-2 腳本輸出的 `cumulative` 陣列（已按完成時間排序、已算好每個時間點的 `strict_rate`/`full_rate`/`total_rate`），不重新計算。

X-axis labels: ticket index（`index` 欄位）with ticket ID（`ticket` 欄位）as tooltip label.

#### 4b. Write HTML file

Compute current timestamp for filename: `YYYYMMDD-HHmm`.

Ensure directory exists:
```
/Users/user/aladdin/aladdin_ai/skills/back-testing-stats/temp/
```

Write to:
```
/Users/user/aladdin/aladdin_ai/skills/back-testing-stats/temp/back-testing-stats-{YYYYMMDD-HHmm}.html
```

HTML structure:
- Standalone single file, no external assets except Chart.js CDN
- `<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>`
- **HTML 必須包含完整的統計摘要，不能只有圖表。** 頁面由上而下依序包含：

#### Section 1: 總覽卡片
- 三張卡片並排 (CSS grid 3-column)：
  - 左卡：**完全成功率(含等效)** (大字，**主要指標**) + 已完成 / 有效樣本
  - 中卡：**嚴格正確率** (大字) + 僅完全對齊 commit 的張數
  - 右卡：**總成功率** (大字) + 含部分正確 B 不完整
- 下方以 progress bar 顯示結論分布（分析正確 / 部分正確A / 部分正確B / 分析錯誤 / 無法比對 / 不需修復）含數量與百分比
- 部分正確 A（等效替代）使用淺綠色 (#81c784) — 視覺上接近「正確」綠色，表示計入完全成功率
- 部分正確 B（不完整）使用橙色 (#ffb74d) — 表示僅計入總成功率

#### Section 2: 各嚴重性等級成功率表格
- HTML `<table>` 呈現 Step 3 Block 2 的完整內容
- 欄位：嚴重性 | 總數 | 正確 | 部分A | 部分B | 錯誤 | 無法比對 | 不需修復 | 嚴格率 | 含等效率 | 總成功率
- 嚴重性使用顏色標籤 (P1 紅 / P2 橙 / P3 黃 / P4 藍)
- 「含等效率」欄位加粗顯示（主要指標）

#### Section 3: 累積趨勢圖表
- Three lines on the same chart:
  - 嚴格正確率 (gray, dashed) — 僅完全對齊 commit
  - **完全成功率(含等效)** (green, solid, thicker) — 主要指標
  - 總成功率 (blue, solid) — 含部分正確 B
- Chart title: `累積成功率趨勢`
- Y-axis: 0–100%, label `成功率 (%)`
- X-axis: ticket index, label `完成順序`
- Legend displayed
- Tooltip shows: ticket ID, 嚴格正確率, 含等效率, 總成功率

All chart data is embedded inline as a JSON literal in a `<script>` tag — no external data files.

**視覺風格：** 使用圓角卡片 (border-radius 12px)、淺灰底色 (#f5f5f5)、白色容器、box-shadow、system font stack。整體排版乾淨俐落。

#### 4c. Open in browser

```bash
open /Users/user/aladdin/aladdin_ai/skills/back-testing-stats/temp/back-testing-stats-{YYYYMMDD-HHmm}.html
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
3. **Three-line chart**: 嚴格正確率 / 完全成功率(含等效) / 總成功率 are plotted as separate cumulative lines; A/B breakdown is shown in the table instead
4. **「完全成功率(含等效)」是主要對外指標** — partial_A（等效替代解法）等同正確：AI 已找對根因，僅實作風格與開發者偏好不同，工程價值等同。partial_B（不完整）才是真正的部分修復。
5. **Temp directory is ephemeral**: always created fresh, deleted after user confirms viewing
6. **Does not modify the tracker** or any Notion properties
