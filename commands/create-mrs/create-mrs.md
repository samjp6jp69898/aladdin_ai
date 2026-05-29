---
description: Batch pipeline — Reads pending tickets from bug_analysis_tracker.md (populated by notion-bug-query-v2.ts), claims them one by one via bug-lock.sh, and dispatches each to /create-mr to run the full analyze + fix + MR pipeline. Target 10 completed tickets per session.
---

# /create-mrs Batch Pipeline (Claim + Dispatch /create-mr × 10)

Reads `pending` tasks from the shared bug tracker, claims them (newest FAQ first), and dispatches each one to `/create-mr` to run the full pipeline (claim → analyze → trace → fix → tests → review → push MR → Notion writeback).

## Parameters

**No parameters required.** Simply run `/create-mrs`.

The bug list to be processed is pre-imported into `bug_analysis_tracker.md` by `bun obsidian/scripts/notion-bug-query-v2.ts`. This command is only responsible for claiming `pending` tasks and dispatching them.

---

## Tracker File

**Path**: `/Users/user/.claude/projects/-Users-user-aladdin/memory/bug_analysis_tracker.md`

Shared with `/analyze-bugs`. Maintained by both `bun scripts/notion-bug-query.ts` (severity-driven) and `bun obsidian/scripts/notion-bug-query-v2.ts` (tech-assignee-driven). Schema:

```
| 單號 | Notion 連結 | 嚴重性 | 狀態 | 加入時間 | 完成時間 |
```

### Status Reference

| Status | Meaning |
|--------|---------|
| `pending` | Not yet processed; available to claim |
| `rerun` | AI分析=需要重跑 訊號（由 v1 import）；`/create-mrs` 略過此狀態,由 `/analyze-bugs` 處理 |
| `in_progress` | Claimed by a session and currently being processed |
| `done` | Pipeline completed (success / already_fixed / i18n_manual_handoff) |
| `failed` | Pipeline failed (exceeded retry limit / Step 0.5 assignee check failed / other error) |

---

## Execution Steps

### Step 0: Update Git Records

Before starting, run `daily_bootstrap.sh` to ensure all repo git records and generated code are up to date:

```bash
sh /Users/user/aladdin/daily_bootstrap.sh
```

Wait for it to finish. If it fails, report the error but continue.

Ensure worktrees directory exists:

```bash
mkdir -p /Users/user/aladdin/worktrees
```

### Step 1: Read Tracker

1. Read the tracker file `/Users/user/.claude/projects/-Users-user-aladdin/memory/bug_analysis_tracker.md`
2. If the file does not exist or has no `pending` rows, prompt the user to populate it first:
   ```
   bug_analysis_tracker.md has no pending rows. Please run:
   bun obsidian/scripts/notion-bug-query-v2.ts
   ```
3. Parse all rows in the table.

### Step 2: Filter Pending Tasks

Filter all rows with **status = `pending`**（**略過 `rerun` 狀態**——那是 `/analyze-bugs` 的訊號）。

Sort by ticket number descending (newest first).

Take **up to 10 tickets** from the sorted list as the initial working list.

If no `pending` rows exist, report and stop:
```
No pending tickets to process (all are rerun/in_progress/done/failed).
To query new tickets, run: bun obsidian/scripts/notion-bug-query-v2.ts
```

### Step 3: Display Pending List

```
## /create-mrs Pending List

N tickets to process (up to 10):

| # | 單號 | 嚴重性 | Notion 連結 |
|---|------|--------|-------------|
| 1 | FAQ-3198 | P3一般 | https://www.notion.so/... |
| 2 | FAQ-3197 | P3一般 | https://www.notion.so/... |
...

Starting MR pipeline one by one. Reviewer 由 /create-mr Step 0.5 從 Notion 當前指派 + tech-users.csv 自動推導。
```

### Step 4: Claim and Dispatch /create-mr (Loop)

**Initialize completed counter to 0.**

For each ticket in the working list:

#### 4a. Claim Task (Atomic Lock)

```bash
bash /Users/user/aladdin/scripts/bug-lock.sh claim FAQ-{ticket_id}
```

- **Exit code 0** (`CLAIMED`) → proceed to 4b
- **Exit code 1** (`LOCKED`) → already claimed by another session, **skip and go to 4e to refill**

Use Edit tool to change the tracker row status `pending → in_progress`.

#### 4b. Dispatch /create-mr

Use the `SlashCommand` tool to call `/create-mr` with the ticket ID:

```
command: "/create-mr {ticket_id}"
```

`/create-mr` will:
- Re-read the tracker to get the row (NotionURL, reviewer_email)
- Re-verify Step 0.5 assignee against tech-users.csv
- Run tracer → fixer → reviewer → drive-uploader → mr-pusher (with reviewer)
- Update tracker row status to `done` / `failed` and release the lock

**Wait for `/create-mr` to complete fully.**

Note: `/create-mr` itself also manages the lock and tracker row. After `/create-mr` returns, the lock should already be released and the tracker row should already be set to `done` / `failed`. Steps 4c is mainly a safety net.

#### 4c. Safety-Net: Confirm Lock Released & Tracker Updated

Re-read tracker. The row for `{ticket_id}` should be `done` or `failed`. If it is still `in_progress` (e.g., /create-mr crashed before Step 8):
1. Force-release the lock: `bash /Users/user/aladdin/scripts/bug-lock.sh release FAQ-{ticket_id}`
2. Edit the tracker row to `failed` with the current completion time

Increment completed counter by 1.

Report progress:
```
✓ FAQ-{ticket_id} /create-mr done ({completed}/{total target=10})
```

#### 4d. Error Handling

If `/create-mr` crashes or returns an error (not the normal failed-pipeline path):
1. Force-release the lock
2. Set tracker row to `failed`
3. Increment completed counter (counts as processed)
4. Continue to the next ticket

#### 4e. Refill Logic

The goal is for this session to actually **complete 10 tickets** (done + failed), not just iterate over 10 candidates.

Check:
1. **Completion check**: If `completed counter >= 10` → proceed to **Step 5**
2. **List check**: If the current working list still has unprocessed tickets → return to **4a**
3. **Refill**: If the working list is exhausted but `completed counter < 10`:
   - Re-read the tracker for a fresh snapshot
   - Filter all rows with **status = `pending`** (excluding any ticket already in the working list)
   - Sort by FAQ number descending
   - If new tickets exist → add up to `10 - completed` and return to **4a**
   - If no new tickets exist → proceed to **Step 5** (work exhausted)

**Important: After completing each ticket, automatically continue to the next — do not wait for user instruction. The entire loop is fully automatic.**

### Step 5: Completion Report

```
## /create-mrs Batch Complete

- Total processed: {completed} tickets (target: 10)

| # | 單號 | Reviewer | Result | MR Link |
|---|------|----------|--------|---------|
| 1 | FAQ-3198 | pkh_hiro@photons.com.tw | done | https://gitlab.the777.pro/.../-/merge_requests/123 |
| 2 | FAQ-3197 | pkh_farus@photons.com.tw | failed | (N/A) |
...

Remaining pending tickets in tracker: {N}
```

Remind the user:
```
提醒：已完成的 worktrees 可以手動清理：
git worktree list
git worktree remove /Users/user/aladdin/worktrees/{ticket_id}
```

---

## Notes

1. **Reads from `bug_analysis_tracker.md` only**: Never queries Notion directly. To refresh the list, run `bun obsidian/scripts/notion-bug-query-v2.ts`. 與 `/analyze-bugs` 共用同一份 tracker（pending / rerun / in_progress / done / failed），但 `/create-mrs` 僅認 `pending`。
2. **Shared lock dir**: Uses `/tmp/bug-analysis-locks/` (same as `/analyze-bugs`). A ticket being analyzed by `/analyze-bugs` will be skipped by `/create-mrs` and vice versa — by design.
3. **Atomic claim**: `bash /Users/user/aladdin/scripts/bug-lock.sh claim FAQ-{ticket_id}` is backed by `mkdir`, OS-guaranteed atomic. Multiple parallel `/create-mrs` sessions will not double-claim.
4. **Serial processing**: One ticket at a time; wait for `/create-mr` to finish before claiming the next. Each `/create-mr` may take 20-40 minutes (tracer + fixer + reviewer + push + Drive).
5. **10 tickets per session**: Session targets exactly 10 completed tickets (done + failed). If initial candidates are locked by other sessions, the tracker is re-read for fresh refills.
6. **Tech personnel filter is at query stage**: `notion-bug-query-v2.ts` already filtered; this command and `/create-mr` only re-verify in Step 0.5 to catch assignee changes between query and execution.
7. **Tracker is the single source of truth**: Query script imports → batch reads → `/create-mr` writes back results. No direct Notion queries from this command.
