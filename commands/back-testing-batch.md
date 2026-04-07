---
name: back-testing-batch
description: Batch back-testing pipeline — reads pending tickets from tracker, dispatches three-stage agents in parallel batches (N=3 per stage).
user-invocable: true
---

# Batch Back-Testing Pipeline

You are a batch pipeline manager. Your responsibility is to read pending tickets from the tracker and process them through three sequential stages, dispatching N agents in parallel per stage. You do NOT read Notion pages, search git repos, or write back-testing notes yourself — those are delegated to specialized agents.

## Parameters

`$ARGUMENTS` format: `/back-testing-batch [N]`

- **N** (optional): Concurrent agents per batch. Default `3`.

Examples:
- `/back-testing-batch` → 3 agents per batch
- `/back-testing-batch 5` → 5 agents per batch

---

## Execution Flow

### Step 0: Update Git Records

```bash
sh /Users/user/aladdin/daily_bootstrap.sh
```

Wait for completion. If the script fails, report the error but continue using existing git records.

---

### Step 1: Read Tracker & Filter Pending

1. Read the tracker: `/Users/user/.claude/projects/-Users-user-aladdin/memory/backtest_tracker.md`
2. If the file does not exist or has no data rows, prompt the user:
   ```
   Tracker is empty. Please run the query script first:
   bun scripts/notion-backtest-query.ts
   ```
3. Filter all rows with **回測狀態 = `pending`**, sort by ticket number descending (newest first), **max 10 tickets**
4. If no pending tickets:
   ```
   No pending back-testing tasks (all tasks are in_progress/done/failed).
   To import new tickets, run: bun scripts/notion-backtest-query.ts
   ```
   Stop.

---

### Step 2: Display Pending List & Claim Locks

Display the filtered list:

```
## Pending Back-Testing Tickets

{N} tickets to process (max 10):

| # | 單號 | 嚴重性 | AI分析 | Bug狀態 | Notion 連結 |
|---|------|--------|--------|---------|-------------|
| 1 | FAQ-XXXX | P1重點 | 分析成功 | 已解決 | https://... |
```

Then claim locks for each ticket:

```bash
bash /Users/user/aladdin/scripts/backtest-lock.sh claim FAQ-{ticket_id}
```

- **CLAIMED** → add to `PROCESSING_LIST`; re-read tracker and confirm status is still `pending`
  - Still pending: use Edit tool to change 回測狀態 to `in_progress`
  - Changed (done/failed): release lock immediately and skip
    ```bash
    bash /Users/user/aladdin/scripts/backtest-lock.sh release FAQ-{ticket_id}
    ```
- **LOCKED** → skip (another session has it)

Build `PROCESSING_LIST` from all successfully claimed tickets.

If `PROCESSING_LIST` is empty, report and stop.

---

### Step 3: Stage 1 Batch — Ticket Info Collection

Create staging directories for all tickets in `PROCESSING_LIST`:

```bash
mkdir -p /Users/user/aladdin/debug/backtest-staging/{ticket_id}
```

Process `PROCESSING_LIST` in batches of N. For each batch:

1. **Dispatch N agents simultaneously in a single message** — serial dispatch is forbidden.

   Agent prompt template for each ticket:

   ```
   Read all text in /Users/user/aladdin/obsidian/agents/backtest-ticket-collector.md as your instructions.

   Parameters:
   - NotionURL: {url from tracker}
   - git_author: none
   - staging_dir: /Users/user/aladdin/debug/backtest-staging/{ticket_id}
   ```

2. Wait for ALL agents in the batch to complete.

3. For each ticket: verify `/Users/user/aladdin/debug/backtest-staging/{ticket_id}/stage1-ticket-info.md` exists.
   - Missing → **Stage 1 failure** for that ticket

4. Report batch progress:
   ```
   Stage 1 batch {n}/{total_batches}: {success} succeeded, {fail} failed
   ```

After all Stage 1 batches complete:
- For each failed ticket: release lock, update tracker to `failed`, remove from `PROCESSING_LIST`

  ```bash
  bash /Users/user/aladdin/scripts/backtest-lock.sh release FAQ-{ticket_id}
  ```

If `PROCESSING_LIST` is now empty, skip to Step 6.

---

### Step 4: Stage 2 Batch — Commit Search & Independent Analysis

Process remaining `PROCESSING_LIST` in batches of N. For each batch:

1. **Dispatch N agents simultaneously in a single message**.

   Agent prompt template for each ticket:

   ```
   Read all text in /Users/user/aladdin/obsidian/agents/backtest-commit-analyzer.md as your instructions.

   Parameters:
   - staging_dir: /Users/user/aladdin/debug/backtest-staging/{ticket_id}
   ```

2. Wait for ALL agents in the batch to complete.

3. For each ticket: verify `/Users/user/aladdin/debug/backtest-staging/{ticket_id}/stage2-actual-fix.md` exists.
   - Missing → **Stage 2 failure** (distinguish from NOT_FOUND status)
   - File exists with `NOT_FOUND` status → **keep in `PROCESSING_LIST`** (will produce ⚠️ in Stage 3)

4. Report batch progress:
   ```
   Stage 2 batch {n}/{total_batches}: {success} succeeded, {fail} failed
   ```

After all Stage 2 batches complete:
- For each **failed** ticket (file missing): release lock, update tracker to `failed`, remove from `PROCESSING_LIST`
- Keep NOT_FOUND tickets in `PROCESSING_LIST`

If `PROCESSING_LIST` is now empty, skip to Step 6.

---

### Step 5: Stage 3 Batch — Comparison & Note Writing

Process remaining `PROCESSING_LIST` in batches of N. For each batch:

1. **Dispatch N agents simultaneously in a single message**.

   Agent prompt template for each ticket:

   ```
   Read all text in /Users/user/aladdin/obsidian/agents/backtest-comparator.md as your instructions.

   Parameters:
   - staging_dir: /Users/user/aladdin/debug/backtest-staging/{ticket_id}
   - ticket_id: {ticket_id}
   ```

2. Wait for ALL agents in the batch to complete.

3. For each completed ticket:
   - Read `/Users/user/aladdin/debug/backtest-staging/{ticket_id}/stage3-comparison.md`
   - Extract the conclusion line
   - Release lock:
     ```bash
     bash /Users/user/aladdin/scripts/backtest-lock.sh release FAQ-{ticket_id}
     ```
   - Update tracker: status → `done`, 完成時間 → `YYYYMMDD HHMM` (24-hour, Asia/Taipei), 回測結論 → mapped value

4. For each failed ticket (stage3-comparison.md missing):
   - Release lock
   - Update tracker: status → `failed`

5. Report batch progress:
   ```
   Stage 3 batch {n}/{total_batches}: {success} succeeded, {fail} failed
   ```

**Conclusion mapping (Stage 3 → tracker 回測結論):**

| Stage 3 Conclusion | Tracker 回測結論 |
|--------------------|-----------------|
| ✅ 分析正確 | ✅ 分析正確 |
| ✅ 部分正確 | ✅ 部分正確 |
| ❌ 分析錯誤 | ❌ 分析錯誤 |
| ⚠️ 無法比對 | ⚠️ 無法比對 |

---

### Step 6: Completion Report

```
## Batch Back-Testing Complete

Total processed: {total} tickets

| # | 單號 | Stage 1 | Stage 2 | Stage 3 | 回測結論 |
|---|------|---------|---------|---------|----------|
| 1 | FAQ-XXXX | ✓ | ✓ | ✓ | ✅ 分析正確 |
| 2 | FAQ-YYYY | ✓ | ✓ | ✓ | ⚠️ 無法比對 |
| 3 | FAQ-ZZZZ | ✓ | ✗ | — | failed |
```

---

## Error Handling

| Scenario | Action |
|----------|--------|
| Stage 1 failure (file missing) | Release lock → tracker `failed` → skip ticket from Stage 2 and 3 |
| Stage 2 failure (file missing) | Release lock → tracker `failed` → skip ticket from Stage 3 |
| Stage 2 NOT_FOUND (file exists, status NOT_FOUND) | Keep in list → continue to Stage 3 (will produce ⚠️) |
| Stage 3 failure (file missing) | Release lock → tracker `failed` |
| Any unexpected error | Always release lock before aborting |

**Lock lifecycle**: claim before Stage 1 → hold through all stages → release after Stage 3 (or on any failure).

---

## Notes

1. **Parallel dispatch is mandatory**: Each batch MUST call multiple Agent tools simultaneously in a single message. Serial dispatch is forbidden.
2. **Stage gate**: ALL tickets must complete Stage N before ANY ticket starts Stage N+1.
3. **Tracker is the single source of truth**: Only read pending tickets from the tracker; never query Notion directly.
4. **Do not use the Skill tool**: It transfers control to the user and breaks the pipeline.
5. **Do not read Notion/git/code**: Delegate all such work to the three specialized agents.
6. **Max 10 tickets per run**: Prevents any single execution from running too long.
7. **Tracker updates are immediate**: Update each ticket's status as soon as its stage completes — do not batch-update at the end.
8. **Lock cleanup**: If a session crashes and leaves locks unreleased, manually run `bash /Users/user/aladdin/scripts/backtest-lock.sh cleanup` to clear all locks.
