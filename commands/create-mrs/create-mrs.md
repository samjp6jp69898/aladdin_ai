---
description: Batch pipeline — Reads pending/rerun tickets from bug_analysis_tracker.md (populated by notion-bug-query-v2.ts), claims them one by one via bug-lock.sh, and dispatches each to /create-mr to run the full analyze + fix + MR pipeline. Target 10 completed tickets per session.
---

# /create-mrs Batch Pipeline (Claim + Dispatch /create-mr × 10)

Reads `pending`/`rerun` tasks from the shared bug tracker (rerun first, then newest FAQ first), and dispatches each one to `/create-mr` to run the full pipeline (claim → analyze → trace → fix → tests → review → push MR → Notion writeback).

## Parameters

**No parameters required.** Simply run `/create-mrs`.

The bug list to be processed is pre-imported into `bug_analysis_tracker.md` by `bun obsidian/scripts/notion-bug-query-v2.ts`. This command is only responsible for claiming `pending`/`rerun` tasks and dispatching them.

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
| `pending` | Not yet processed; available to claim。**也包含 Step 0.5 判定當前指派為非技術人員而還原的單**（非技術人員的單不是失敗，保留 pending 待 re-query 或指派變更後再領，不標 failed） |
| `rerun` | AI分析=需要重跑 訊號；`/create-mrs` 與 `/analyze-bugs` 皆可領，`/create-mrs` **優先於 pending** 處理，靠 atomic lock 去重 |
| `in_progress` | Claimed by a session and currently being processed |
| `done` | Pipeline completed (success / already_fixed / i18n_manual_handoff) |
| `failed` | Pipeline failed (exceeded retry limit / other error)。**注意：Step 0.5 當前指派非技術人員 → 還原 `pending`，不算 failed** |

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
2. If the file does not exist or has no `pending`/`rerun` rows, prompt the user to populate it first:
   ```
   bug_analysis_tracker.md has no claimable (pending/rerun) rows. Please run:
   bun obsidian/scripts/notion-bug-query-v2.ts
   ```
3. Parse all rows in the table.

### Step 2: Filter Claimable Tasks

Filter all rows with **status ∈ {`rerun`, `pending`}**（`rerun` = AI分析「需要重跑」訊號，與 `/analyze-bugs` 共享，靠 atomic lock 去重）。

Sort: **`rerun` first, then `pending`**; within each group by ticket number descending (newest first).

Take **up to 10 tickets** from the sorted list as the initial working list.

If no `rerun`/`pending` rows exist, report and stop:
```
No claimable tickets to process (all are in_progress/done/failed).
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

Use Edit tool to change the tracker row status `pending`/`rerun` → `in_progress`.

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
   - Filter all rows with **status ∈ {`rerun`, `pending`}** (excluding any ticket already in the working list)
   - Sort `rerun` first, then `pending`, each by FAQ number descending
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

1. **Reads from `bug_analysis_tracker.md` only**: Never queries Notion directly. To refresh the list, run `bun obsidian/scripts/notion-bug-query-v2.ts`. 與 `/analyze-bugs` 共用同一份 tracker（pending / rerun / in_progress / done / failed），`/create-mrs` 認 `pending` 與 `rerun`（rerun 與 /analyze-bugs 共享，靠 lock 去重）。
2. **Shared lock dir**: Uses `/tmp/bug-analysis-locks/` (same as `/analyze-bugs`). A ticket being analyzed by `/analyze-bugs` will be skipped by `/create-mrs` and vice versa — by design.
3. **Atomic claim**: `bash /Users/user/aladdin/scripts/bug-lock.sh claim FAQ-{ticket_id}` is backed by `mkdir`, OS-guaranteed atomic. Multiple parallel `/create-mrs` sessions will not double-claim.
4. **Serial processing**: One ticket at a time; wait for `/create-mr` to finish before claiming the next. Each `/create-mr` may take 20-40 minutes (tracer + fixer + reviewer + push + Drive).
5. **10 tickets per session**: Session targets exactly 10 completed tickets (done + failed). If initial candidates are locked by other sessions, the tracker is re-read for fresh refills.
6. **Tech personnel filter is at query stage**: `notion-bug-query-v2.ts` already filtered; this command and `/create-mr` only re-verify in Step 0.5 to catch assignee changes between query and execution.
7. **Tracker is the single source of truth**: Query script imports → batch reads → `/create-mr` writes back results. No direct Notion queries from this command.
