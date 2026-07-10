---
description: Batch pipeline — Query pending, unanalyzed bugs from Notion Bug List by severity, then dispatch each one to /analyze-single-bug (L0/L1 tests only, no Agent Teams).
---

# Bug Batch Analysis Workflow 

Reads `pending` and `rerun` tasks from the bug tracker (via `tracker.sh`), claims them (rerun first), and dispatches each one to `/analyze-single-bug` to run the full analysis pipeline (report → screenshot → worktree → trace fix → spec → evaluate → validate → upload).

## Parameters

**No parameters required.** Simply run `/analyze-bugs`.

The bug list to be analyzed is pre-imported into the tracker by a query script. This command is only responsible for claiming `pending` / `rerun` tasks and dispatching them for analysis.

---

## Tracker File

**Path**: `/Users/user/.claude/projects/-Users-user-aladdin/memory/bug_analysis_tracker.md`

This file is generated and maintained by the `bun scripts/notion-bug-query.ts` script, and records all Notion bug tickets pending analysis.

**All reads and writes must go through `bash /Users/user/aladdin/scripts/tracker.sh`（`next` / `row` / `set` / `counts` / `log-fail`）— the file is 166KB+; never `cat` it whole and never modify it with the Edit tool.**

### Tracker Format

```markdown
| 單號 | Notion 連結 | 嚴重性 | 狀態 | 加入時間 | 完成時間 |
|------|-------------|--------|------|----------|----------|
| FAQ-1841 | https://www.notion.so/... | P1重點 | pending | 2026-03-27 |  |
| FAQ-1807 | https://www.notion.so/... | P1重點 | in_progress | 2026-03-27 |  |
| FAQ-1722 | https://www.notion.so/... | P1重點 | done | 2026-03-27 | 20260327 1430 |
| FAQ-1690 | https://www.notion.so/... | P2較高 | rerun | 2026-04-22 |  |
```

> 完成時間欄是自由文字：**新寫入一律用 `date '+%Y-%m-%d %H%M'` 格式**（如 `2026-07-03 1530`）；歷史資料可能是 `YYYYMMDD HHMM` 舊格式，僅供欄位對照，勿模仿。

### Status Reference

| Status | Meaning |
|--------|---------|
| `pending` | Not yet processed; available to claim |
| `rerun` | Previously analyzed but flagged `需要重跑` in Notion AI分析; reset from `done`/`failed` by the query script. Semantically equivalent to `pending` but **processed first** within a batch |
| `in_progress` | Claimed by a session and currently being processed (prevents multiple sessions from grabbing the same ticket) |
| `done` | Analysis complete |
| `failed` | Analysis failed (exceeded retry limit or other error) |

---

## Execution Steps

### Step 0: Update Git Records

Before starting analysis, run `daily_bootstrap.sh` to ensure all repo git records and generated code are up to date:

```bash
sh /Users/user/aladdin/daily_bootstrap.sh
```

Wait for it to finish before proceeding to Step 1. If the script fails, report the error to the user but continue with subsequent steps (using existing code).

After bootstrap completes, ensure the worktrees directory exists:

```bash
mkdir -p /Users/user/aladdin/worktrees
```

### Step 1: Check Tracker

```bash
bash /Users/user/aladdin/scripts/tracker.sh counts
```

If the command errors (tracker file missing) or the counts show no `pending` and no `rerun`, prompt the user to run the query script first and stop:
```
Tracker is empty. Please run the query script to import bugs for analysis:
bun scripts/notion-bug-query.ts P2較高
```

### Step 2: Build Working List (Rerun First)

Collect **up to 5 tickets** by calling the picker repeatedly — each call returns the single best claimable row (`rerun` before `pending`; ticket number descending within each group), so the sort rules live in the script, not in you:

```bash
bash /Users/user/aladdin/scripts/tracker.sh next "{exclude_list}"
```

Start with an empty `{exclude_list}`; after each returned row, append its ticket id to `{exclude_list}`（逗號串、不含空格，如 `FAQ-3757,FAQ-3468`）and call again — until you have 5 tickets or it prints `NO_CLAIMABLE`.

If there are no `rerun` or `pending` bugs, report to the user and stop:
```
No pending/rerun bugs to process (all tasks are in_progress/done/failed).
To query new bugs, run: bun scripts/notion-bug-query.ts <severity>
```

### Step 3: Display Pending List

Show the filtered list to the user (rerun tickets marked explicitly):

```
## Pending Bug List

N tickets to analyze (up to 5; rerun first):

| # | 單號 | 嚴重性 | 來源 | Notion 連結 |
|---|------|--------|------|-------------|
| 1 | FAQ-1690 | P2較高 | rerun   | https://... |
| 2 | FAQ-1841 | P1重點 | pending | https://... |
| 3 | FAQ-1807 | P1重點 | pending | https://... |

Starting analysis one by one.
```

### Step 4: Claim and Analyze Each Ticket (Loop)

**Initialize completed counter to 0.**

For each bug in the pending list, execute in order:

#### 4a. Claim Task (Atomic Lock)

Use the Bash tool to run the lockfile claim:

```bash
bash scripts/bug-lock.sh claim FAQ-{ticket_id}
```

- **Exit code 0** (output `CLAIMED`) → claim successful, proceed to 4b
- **Exit code 1** (output `LOCKED`) → already claimed by another session — first append `FAQ-{ticket_id}` to `{exclude_list}`（被鎖的單必須排除：`bug-lock.sh` 的鎖沒有 TTL，殘留鎖情境下若不排除，refill 會反覆吐回同一張單、迴圈永遠無法終止）, then **skip this ticket and go to 4e to refill**

After a successful claim, mark it in-progress via tracker.sh (never edit the tracker file directly):

```bash
bash /Users/user/aladdin/scripts/tracker.sh set FAQ-{ticket_id} in_progress
```

#### 4b. Dispatch Analysis

Use the `Skill` tool to invoke `analyze-single-bug`, passing in the Notion page URL and ticket number:

```
skill: "analyze-single-bug"
args: "{NotionURL} {ticket_id}"
```

**Wait for `/analyze-single-bug` to complete fully.**

Then check its completion report's `Pipeline status`:
- `needs_qa_clarification` → 這是「等 QA 釐清」的正常暫停，**不是失敗**：release the lock（`bash scripts/bug-lock.sh release FAQ-{ticket_id}`）, mark it via `bash /Users/user/aladdin/scripts/tracker.sh set FAQ-{ticket_id} needs_qa`, increment completed counter by 1（算處理完成，與 /create-mrs 的計法一致）, report `⏸ {ticket_id} 待 QA 釐清`, then go to **4e** — skip 4c/4d for this ticket.
- 其他狀態 → 照常走 4c（成功）或 4d（錯誤）。

#### 4c. Record Completion Status

1. Release the lockfile:
   ```bash
   bash scripts/bug-lock.sh release FAQ-{ticket_id}
   ```
2. Mark done with completion time via tracker.sh:
   ```bash
   bash /Users/user/aladdin/scripts/tracker.sh set FAQ-{ticket_id} done "$(date '+%Y-%m-%d %H%M')"
   ```
3. Increment completed counter by 1

Report progress to the user:
```
✓ {ticket_id} analysis complete ({completed}/{total})
```

#### 4d. Error Handling

If `/analyze-single-bug` encounters an error or fails:

1. Release the lockfile:
   ```bash
   bash scripts/bug-lock.sh release FAQ-{ticket_id}
   ```
2. Mark failed and log the reason via tracker.sh:
   ```bash
   bash /Users/user/aladdin/scripts/tracker.sh set FAQ-{ticket_id} failed "$(date '+%Y-%m-%d %H%M')"
   bash /Users/user/aladdin/scripts/tracker.sh log-fail FAQ-{ticket_id} "<failure reason>"
   ```
3. Increment completed counter by 1 (counts as processed)
4. Continue to the next ticket

#### 4e. Determine Whether to Continue (Refill Logic)

The goal is to ensure this session **actually completes 5 tickets** (done + failed), not merely iterates through 5 candidates.

Check the following conditions:

1. **Completion check**: If `completed counter >= 5` → proceed to **Step 5**
2. **List check**: If there are still unprocessed bugs in the current working list → return to **4a** for the next ticket
3. **Refill**: If the current working list is exhausted but `completed counter < 5`:
   - Call `bash /Users/user/aladdin/scripts/tracker.sh next "{exclude_list}"` again — `{exclude_list}` 是**同一個從 Step 2 一路沿用的變數**（Step 2 建列與 4a 的 LOCKED 跳過都 append 過；不要重新計算），因此含本場碰過的所有單號 — it always reads the freshest tracker state, so no snapshot re-read is needed
   - If it returns a row → append its ticket id to `{exclude_list}`, add it to the working list, and return to **4a** (repeat as needed, up to `5 - completed` tickets)
   - If it prints `NO_CLAIMABLE` → proceed to **Step 5** (all available work is exhausted)

**Important: After completing each ticket, automatically continue to the next — no need to wait for user instruction. The entire loop is fully automatic.**

### Step 5: Completion Report

```
## Batch Analysis Complete

- Total processed: {completed} tickets

| # | 單號 | Result |
|---|------|--------|
| 1 | FAQ-1841 | done |
| 2 | FAQ-1807 | done |
| 3 | FAQ-1722 | skipped (claimed by another session) |
```

After the report, remind the user:
```
提醒：已完成的 worktrees 可以手動清理：
git worktree list
git worktree remove /Users/user/aladdin/worktrees/{ticket_id}
```

---

## Notes

1. **No longer uses Notion search**: All pending bug lists are read from the tracker memory file; Notion is not queried directly.
2. **Atomic lock mechanism**: Use `bash scripts/bug-lock.sh claim FAQ-{ticket_id}` for atomic claiming (backed by `mkdir`, which the OS guarantees to be atomic). 8 parallel sessions will not claim the same ticket. Always `release` after completion or failure.
3. **Fully automatic loop**: After completing each ticket, automatically claim the next — no user input needed. Continues until the list is empty.
4. **Serial processing**: Only one ticket is processed at a time; wait for `/analyze-single-bug` to finish completely before processing the next.
5. **Maximum 5 tickets per run**: Each session targets exactly 5 completed tickets. If initial candidates are locked by other sessions, the tracker is re-read to refill with new `pending`/`rerun` tickets until 5 are completed or no available tickets remain.
6. **Tracker is the single source of truth**: The query script imports Notion data into the tracker; this command only reads from the tracker — and only via `tracker.sh` (no whole-file cat, no direct Edit).
7. **`rerun` priority**: Tickets flagged `AI分析 = 需要重跑` in Notion get status `rerun` in the tracker (reset from previous `done`/`failed` by the query script). They are always processed before regular `pending` tickets within a batch. Upon successful completion, their status becomes `done` just like any other ticket.
8. **Lock cleanup**: If a session crashes and leaves locks unreleased, manually run `bash scripts/bug-lock.sh cleanup` to clear all locks, or `bash scripts/bug-lock.sh release FAQ-{ticket_id}` to release a specific lock.
