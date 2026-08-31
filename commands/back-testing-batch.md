---
name: back-testing-batch
description: Sequential back-testing pipeline — reads pending tickets from tracker, processes one ticket at a time through three stages before moving to the next.
user-invocable: true
---

# Sequential Back-Testing Pipeline

You are a back-testing pipeline manager. Your responsibility is to read pending tickets from the tracker and process them **one at a time** through three sequential stages. Each ticket must complete all stages (or fail) before the next ticket is claimed. You do NOT read Notion pages, search git repos, or write back-testing notes yourself — those are delegated to specialized agents.

## Parameters

`$ARGUMENTS` format: `/back-testing-batch [max]`

- **max** (optional): Maximum number of tickets to process this run. Default `10`.

Examples:
- `/back-testing-batch` → process up to 10 tickets sequentially
- `/back-testing-batch 5` → process up to 5 tickets sequentially

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
3. **清除誤匯資料**：掃描 tracker 中所有 **Bug狀態 = `待上版`** 的行（不限回測狀態），用 Edit 工具直接從 tracker 刪除這些行。刪除後列出被移除的票號。
4. Filter all rows with **回測狀態 = `pending`**, sort by ticket number descending (newest first), **max {max} tickets**
5. If no pending tickets:
   ```
   No pending back-testing tasks (all tasks are in_progress/done/failed).
   To import new tickets, run: bun scripts/notion-backtest-query.ts
   ```
   Stop.

---

### Step 2: Display Pending List

Display the filtered list (for informational purposes only — locks are NOT claimed here):

```
## Pending Back-Testing Tickets

{count} tickets to process (max {max}):

| # | 單號 | 嚴重性 | AI分析 | Bug狀態 | Notion 連結 |
|---|------|--------|--------|---------|-------------|
| 1 | FAQ-XXXX | P1重點 | 分析成功 | 已解決 | https://... |

🗑️ Removed (待上版 — 誤匯資料): FAQ-AAAA, FAQ-BBBB
```

---

### Step 3: Sequential Processing Loop

For each ticket in the pending list, **one at a time**:

#### 3a. Claim Lock

```bash
bash /Users/user/aladdin/scripts/backtest-lock.sh claim FAQ-{ticket_id}
```

- **CLAIMED** → re-read tracker and confirm status is still `pending`
  - Still pending: use Edit tool to change 回測狀態 to `in_progress`
  - Changed (done/failed): release lock immediately and skip to next ticket
    ```bash
    bash /Users/user/aladdin/scripts/backtest-lock.sh release FAQ-{ticket_id}
    ```
- **LOCKED** → skip to next ticket (another session has it)

#### 3b. Stage 1 — Ticket Info Collection

Create staging directory:

```bash
mkdir -p /Users/user/aladdin/obsidian/Debug/backtest-staging/{ticket_id}
```

Dispatch ONE agent:

```
Read all text in /Users/user/aladdin/aladdin_ai/agents/backtest-ticket-collector.md as your instructions.

Parameters:
- NotionURL: {url from tracker}
- git_author: none
- staging_dir: /Users/user/aladdin/obsidian/Debug/backtest-staging/{ticket_id}
```

Wait for completion. Verify `/Users/user/aladdin/obsidian/Debug/backtest-staging/{ticket_id}/stage1-ticket-info.md` exists.
- Missing → **Stage 1 failure** → release lock, update tracker to `failed`, report, skip to next ticket

#### 3c. Stage 2 — Commit Search & Independent Analysis

Dispatch ONE agent:

```
Read all text in /Users/user/aladdin/aladdin_ai/agents/backtest-commit-analyzer.md as your instructions.

Parameters:
- staging_dir: /Users/user/aladdin/obsidian/Debug/backtest-staging/{ticket_id}
```

Wait for completion. Verify `/Users/user/aladdin/obsidian/Debug/backtest-staging/{ticket_id}/stage2-actual-fix.md` exists.
- Missing → **Stage 2 failure** → release lock, update tracker to `failed`, report, skip to next ticket
- File exists with `NOT_FOUND` status → **continue to Stage 3** (will produce ⚠️)

#### 3d. Stage 3 — Comparison & Note Writing

Dispatch ONE agent:

```
Read all text in /Users/user/aladdin/aladdin_ai/agents/backtest-comparator.md as your instructions.

Parameters:
- staging_dir: /Users/user/aladdin/obsidian/Debug/backtest-staging/{ticket_id}
- ticket_id: {ticket_id}
```

Wait for completion.

- **Success** (stage3-comparison.md exists):
  - Read `/Users/user/aladdin/obsidian/Debug/backtest-staging/{ticket_id}/stage3-comparison.md`
  - Extract the conclusion line
  - Release lock:
    ```bash
    bash /Users/user/aladdin/scripts/backtest-lock.sh release FAQ-{ticket_id}
    ```
  - Update tracker: status → `done`, 完成時間 → `YYYYMMDD HHMM` (24-hour, Asia/Taipei), 回測結論 → mapped value

- **Failure** (stage3-comparison.md missing):
  - Release lock
  - Update tracker: status → `failed`

#### 3e. Report Progress

After each ticket completes (success or failure):

```
Ticket {current}/{total}: FAQ-{ticket_id} → {result}
```

Then proceed to the next ticket in the pending list (back to Step 3a).

**Conclusion mapping (Stage 3 → tracker 回測結論):**

| Stage 3 Conclusion | Tracker 回測結論 |
|--------------------|-----------------|
| ✅ 分析正確 | ✅ 分析正確 |
| ✅ 部分正確（A — 等效替代） | ✅ 部分正確 |
| ✅ 部分正確（B — 不完整） | ✅ 部分正確 |
| ✅ 部分正確 | ✅ 部分正確 |
| ❌ 分析錯誤 | ❌ 分析錯誤 |
| ⚠️ 無法比對 | ⚠️ 無法比對 |
| ➖ 不需修復 | ➖ 不需修復 |

---

### Step 4: Completion Report

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
| Bug狀態 = 待上版 | 視為誤匯資料，直接從 tracker 刪除該行 |
| Stage 1 failure (file missing) | Release lock → tracker `failed` → skip to next ticket |
| Stage 2 failure (file missing) | Release lock → tracker `failed` → skip to next ticket |
| Stage 2 NOT_FOUND (file exists, status NOT_FOUND) | Continue to Stage 3 (will produce ⚠️) |
| Stage 3 failure (file missing) | Release lock → tracker `failed` → skip to next ticket |
| Any unexpected error | Always release lock before moving on |

**Lock lifecycle**: claim immediately before Stage 1 → hold through all 3 stages → release after Stage 3 (or on any failure). Only ONE ticket is locked at a time.

---

## Notes

1. **One ticket at a time**: Claim, process all 3 stages, release — then move to the next ticket. Never hold locks on multiple tickets simultaneously.
2. **Tracker is the single source of truth**: Only read pending tickets from the tracker; never query Notion directly.
3. **Do not use the Skill tool**: It transfers control to the user and breaks the pipeline.
4. **Do not read Notion/git/code**: Delegate all such work to the three specialized agents.
5. **Max tickets per run**: Configurable via argument, default 10. Prevents any single execution from running too long.
6. **Tracker updates are immediate**: Update each ticket's status as soon as its stage completes — do not batch-update at the end.
7. **Lock cleanup**: If a session crashes and leaves locks unreleased, manually run `bash /Users/user/aladdin/scripts/backtest-lock.sh cleanup` to clear all locks.
