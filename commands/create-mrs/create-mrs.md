---
description: Use when running the MR pipeline in batch — loops /create-mr over claimable (pending/rerun) tickets from bug_analysis_tracker.md until 10 are completed, the tracker runs dry, or too many consecutive tickets are skipped (not-tech/locked).
---

# /create-mrs Batch（依序把可認領工單餵給 /create-mr，目標 10 張）

你是 batch 調度員。**自主聲明：全自動迴圈，處理完一張自動接下一張，不等使用者。** 不適用互動式流程 skill。

分工（v2，修正舊版 double-claim 矛盾）：**本指令不 claim 鎖、不改 tracker 狀態**——那些全部由 `/create-mr` 自己做。本指令只負責：挑單、逐張呼叫 `/create-mr`、記錄進度、善後殘局。

## Step 0：環境準備

```bash
sh /Users/user/aladdin/daily_bootstrap.sh    # 失敗回報但繼續
mkdir -p /Users/user/aladdin/worktrees
RUNLOG=/Users/user/aladdin/worktrees/.create-mrs-run-$(date '+%Y%m%d-%H%M').md
printf '# /create-mrs run log\n| ticket | result | time |\n|---|---|---|\n' > "$RUNLOG"
```

**Run-log 是本迴圈唯一的進度事實**（對話記憶會被壓縮）。每處理完一張立刻 append 一行。若你發現自己不確定「處理到第幾張」：
```bash
ls -t /Users/user/aladdin/worktrees/.create-mrs-run-*.md | head -1   # 找到本場 run log
```
讀它，而不是回憶。

## Step 1：迴圈（直到 completed ≥ 10、無單可領、或連續跳過過多）

`consecutive_skip`（本場連續 SKIPPED 計數，初始 0；每次進 Step 1.2 判定）。

每一輪：

1. **挑單**（`skip_list` = 本場已處理與已跳過的單，逗號串、**不含空格**，如 `FAQ-3757,FAQ-3468`）：
   ```bash
   bash /Users/user/aladdin/scripts/tracker.sh next "{skip_list}"
   ```
   `NO_CLAIMABLE` → 跳 Step 2（收工）。

2. **呼叫 /create-mr**：**每一張都重新**用 Skill tool 執行 `create-mr:create-mr`，args = `{ticket_id}`（不要憑記憶沿用上一張的流程文本——檔案與 Skill 才是事實來源）。
   - `/create-mr` 自己會 claim 鎖、標 in_progress、跑完整 pipeline、寫回終態並解鎖。
   - 若它輸出 `SKIPPED: already locked`（別的 session 在跑）或 `SKIPPED: 當前指派不在 tech 名單` → 把該單加入 `skip_list`，**不計入 completed**，`consecutive_skip += 1`。
     - `consecutive_skip ≥ 8` → 判定佇列剩餘可認領單多為非 tech 指派或已被鎖定，**不要問使用者**，直接跳 Step 2（收工，報告需註明「本場提前收工：連續 {consecutive_skip} 張跳過（非 tech 指派/已鎖定），研判佇列剩餘無更多可處理單」）。
     - 否則回到 1。
   - 若它產出實際 pipeline 結果（`done`/`failed`/`needs_qa`）→ `consecutive_skip = 0`，續 Step 1.3。

3. **善後檢查**（`/create-mr` 崩潰的安全網）：
   ```bash
   bash /Users/user/aladdin/scripts/tracker.sh row {ticket_id}
   ```
   狀態仍是 `in_progress` → 表示 pipeline 沒走到 Step 8：
   ```bash
   bash /Users/user/aladdin/scripts/bug-lock.sh release {ticket_id}
   bash /Users/user/aladdin/scripts/tracker.sh set {ticket_id} failed "$(date '+%Y-%m-%d %H%M')"
   bash /Users/user/aladdin/scripts/tracker.sh log-fail {ticket_id} "create-mrs 善後：/create-mr 中途崩潰未收尾"
   ```

4. **記錄**：append 到 run-log：`| {ticket_id} | {done|failed|needs_qa|skipped} | $(date '+%H%M') |`，completed +1（done/failed/needs_qa 都算處理完成；skipped 不算）。回到 1。

## Step 2：收工報告

```
## /create-mrs Batch Complete
- 本場處理：{completed} 張（目標 10）
{consecutive_skip 觸發收工時加一行：- 提前收工原因：連續 {consecutive_skip} 張跳過（非 tech 指派/已鎖定），研判佇列剩餘無更多可處理單}
{把 run-log 表格貼上（它本來就 ≤ 12 行）}
- Tracker 現況：{bash scripts/tracker.sh counts 的輸出}
提醒：完成的 worktrees 可手動清理（git worktree list → git worktree remove /Users/user/aladdin/worktrees/{ticket}）
```

## Notes

1. 單源紀律：只讀 tracker（經 `tracker.sh`），不直接查 Notion。要補新單先跑 `bun obsidian/scripts/notion-bug-query-v2.ts`。
2. 鎖目錄 `/tmp/bug-analysis-locks/` 與 `/analyze-bugs` 共用；`rerun` 單兩邊都可領，靠原子鎖去重，`/create-mr` 內部已處理。
3. 序列執行：一次一張，等 `/create-mr` 完全結束才進下一張（每張 20–40 分鐘）。
4. 舊版行為差異（2026-07-03 v2）：本指令**不再**預先 claim / 標 in_progress——舊做法會讓 `/create-mr` Step 0.1 看到「已被鎖、狀態不對」而自我 SKIP，屬邏輯矛盾，勿回退。
5. 連續跳過收工（2026-07-23）：pending 佇列可能長期堆積非 tech 指派的舊單（NOT_TECH 判定後會被還原回 `pending`，下一輪還會被挑到），若放任跑到 10 completed 會演變成大量空轉 claim/release。`consecutive_skip ≥ 8` 時**自行**停下收工回報，不要為此停下來問使用者——這是既定行為，非例外情況。
