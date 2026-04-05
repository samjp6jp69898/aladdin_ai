---
name: back-testing-batch
description: Batch back-testing from the back-testing tracker — dispatches each ticket to /back-testing, with a lock to prevent race conditions.
user-invocable: true
---

# Bug Batch Back-Testing Workflow

Reads `pending` tasks from the back-testing tracker in memory, claims them, and dispatches each one to `/back-testing` to run the back-testing pipeline.

## Parameters

**No parameters required.** Simply run `/back-testing-batch`.

The bug list to be back-tested is pre-imported into the tracker by a query script. This skill is only responsible for claiming `pending` tasks and dispatching them for back-testing.

---

## Tracker File

**Path**: `/Users/user/.claude/projects/-Users-user-aladdin/memory/backtest_tracker.md`

This file is generated and maintained by the `bun scripts/notion-backtest-query.ts` script, and records all bug tickets pending back-testing.

### Tracker Format

```markdown
| 單號 | Notion 連結 | 嚴重性 | AI分析 | Bug狀態 | 回測狀態 | 回測結論 | 加入時間 | 完成時間 |
|------|-------------|--------|--------|---------|----------|----------|----------|----------|
| FAQ-1841 | https://www.notion.so/... | P1重點 | 分析成功 | 已解決 | pending |  | 2026-03-28 |  |
| FAQ-1807 | https://www.notion.so/... | P1重點 | 分析失敗 | 待測試 | in_progress |  | 2026-03-28 |  |
| FAQ-1722 | https://www.notion.so/... | P2較高 | 分析成功 | 已完成 | done | ✅ 分析正確 | 2026-03-28 | 20260328 1430 |
```

### Status Reference

| Status | Meaning |
|--------|---------|
| `pending` | Not yet processed; available to claim |
| `in_progress` | Claimed by a session and currently being processed (prevents multiple sessions from grabbing the same ticket) |
| `done` | Back-testing complete |
| `failed` | Back-testing failed (exceeded retry limit or other error) |

---

## Execution Steps

### Step 0: Update Git Records

Before starting back-testing, run `daily_bootstrap.sh` to ensure all repo git records are up to date:

```bash
sh /Users/user/aladdin/daily_bootstrap.sh
```

Wait for it to finish before proceeding to Step 1. If the script fails, report the error to the user but continue with subsequent steps (using existing git records).

### Step 1: Read Tracker

1. Read the tracker file `/Users/user/.claude/projects/-Users-user-aladdin/memory/backtest_tracker.md`
2. If the file does not exist or is empty (no data rows), prompt the user to run the query script first:
   ```
   Tracker is empty. Please run the query script to import bugs for back-testing:
   bun scripts/notion-backtest-query.ts
   ```
3. Parse all rows in the table

### Step 2: Filter Pending Tasks

Filter all bugs with **back-testing status = `pending`** from the tracker, sorted by ticket number descending (newest first), **up to 10 tickets**.

If there are no `pending` bugs, report to the user and stop:
```
No pending back-testing tasks (all tasks are in_progress/done/failed).
To query new bugs, run: bun scripts/notion-backtest-query.ts
```

### Step 3: Display Pending List

Show the filtered list to the user:

```
## Pending Back-Testing List

N tickets to back-test (up to 10):

| # | 單號 | 嚴重性 | AI分析 | Bug狀態 | Notion 連結 |
|---|------|--------|--------|---------|-------------|
| 1 | FAQ-1841 | P1重點 | 分析成功 | 已解決 | https://... |
| 2 | FAQ-1807 | P1重點 | 分析失敗 | 待測試 | https://... |

Starting back-testing one by one.
```

### Step 4: Claim and Back-Test Each Ticket (Loop)

**Initialize completed counter to 0.**

For each bug in the pending list, execute in order:

#### 4a. Claim Task (Atomic Lock)

Use the Bash tool to run the lockfile claim:

```bash
bash scripts/backtest-lock.sh claim FAQ-{ticket_id}
```

- **Exit code 0** (output `CLAIMED`) → claim successful, proceed to validation below
- **Exit code 1** (output `LOCKED`) → already claimed by another session, **skip this ticket**, move to the next

**After a successful claim, immediately re-read the tracker file and confirm the ticket's back-testing status is still `pending`**:
- If status has changed to `done` / `failed` → another session has already completed it; immediately release the lock and skip:
  ```bash
  bash scripts/backtest-lock.sh release FAQ-{ticket_id}
  ```
- If status is still `pending` → continue, use the Edit tool to change back-testing status to `in_progress`, then proceed to 4b

#### 4b. Dispatch Back-Testing

Use the `Agent` tool (`subagent_type: general-purpose`) to run back-testing, passing in the full back-testing flow and Notion URL. **Do not use the Skill tool** — it transfers control back to the user and breaks the batch loop.

Agent prompt template (replace `{NotionURL}` with the actual URL):

```
Please execute the Bug Analysis Back-Testing pipeline for this Notion URL: {NotionURL}

Execute the following complete flow:

## Important Constraints
- Do not modify any properties on the bug ticket, except changing AI分析 to "回測完成" at the end
- Use the Bash tool to run `bash /Users/user/aladdin/scripts/notion.sh` to read Notion pages

## Step 1: Read the Notion Bug Ticket
Use notion.sh to read page properties, blocks, and comments:
- bash /Users/user/aladdin/scripts/notion.sh fetch "{NotionURL}"
- bash /Users/user/aladdin/scripts/notion.sh fetch-blocks "{NotionURL}"
- bash /Users/user/aladdin/scripts/notion.sh comments "{page_id}"

Extract: ticket ID, title, severity, status, assigned engineer (git author), version, affected modules, affected side.
If a person field has no name, use notion.sh get-user to query the actual name. Never display only a user ID.

## Step 2: Find the Git Commit
Determine which repo to search based on affected side (frontend=lago, backend=agrabah, admin=abu).
Search order: grep commit message by FAQ ticket ID → author + time range → keyword.
Search multiple repos. After finding, use git show to confirm the diff.

Repo paths:
- /Users/user/aladdin/agrabah (backend)
- /Users/user/aladdin/abu (admin frontend)
- /Users/user/aladdin/lago (app frontend)
- /Users/user/aladdin/genie (shared utilities)
- /Users/user/aladdin/rajah (Protobuf)

## Step 3: Reverse Verification (strictly follow this order)
3a. First independently analyze the commit and answer: issue nature, ownership, root cause, changed files and direction.
3b. Only after completing 3a, read /Users/user/aladdin/debug/FAQ-XXXX/FAQ-XXXX-solution.md.
3c. Six-dimension comparison: issue nature determination, ownership, root cause module, root cause specific logic, changed files, change direction.
    Mark each ✅/❌/⚠️.
3d. If conclusion is "analysis incorrect" or "partially correct", select one failure mode code:
    wrong-side / not-a-bug / wrong-root-cause / incomplete / over-engineered

Overall conclusion criteria:
- Analysis correct: at least 5 of 6 ✅ (issue nature + ownership must both be ✅)
- Partially correct: issue nature ✅ + ownership ✅, but root cause or change direction has deviations
- Analysis incorrect: issue nature ❌ or ownership ❌ or root cause module ❌
- No prior analysis: no documents for this ticket found in debug/

## Step 4: Produce Obsidian Back-Testing Note
Path: /Users/user/aladdin/obsidian/backTesting/FAQ-XXXX-brief-description.md

Format:
# FAQ-XXXX Brief Description
**Ticket ID**: FAQ-XXXX ｜ **Severity**: PX ｜ **Status**: ✅/❌/⚠️

## Affected Modules
Use [[bidirectional links]] for specific file names / component names / manager names (no broad categories)

## Issue Description
## Root Cause
## Fix
(commit hash, author, what was changed)

## Structured Comparison
| Dimension | Match | Notes |
|-----------|-------|-------|
| Issue nature determination | | |
| Ownership | | |
| Root cause module | | |
| Root cause specific logic | | |
| Changed files | | |
| Change direction | | |

## Back-Testing Result
(one-sentence conclusion)

## Failure Mode (only for analysis incorrect / partially correct)
## Analysis Lesson (only when analysis failed)

Finally update the Notion AI分析 attribute:
bash /Users/user/aladdin/scripts/notion.sh update-prop "{page_id}" "AI分析" select "回測完成"

## Step 5: Report Result
Report format:
- Conclusion: ✅ Analysis correct / ✅ Partially correct / ❌ Analysis incorrect / ⚠️ Unable to compare
- Fix Commit: hash by author
- Comparison Summary: Issue nature X | Ownership X | Root cause module X | Root cause logic X | Files X | Direction X
- Failure Mode: code (if applicable)
- Note location: path
```

**Wait for the Agent to complete fully before continuing.**

#### 4c. Record Completion Status

1. Release the lockfile:
   ```bash
   bash scripts/backtest-lock.sh release FAQ-{ticket_id}
   ```
2. Use the Edit tool to change the tracker back-testing status from `in_progress` to `done`, fill in the completion time (format `YYYYMMDD HHMM`, 24-hour, e.g. `20260328 1430`), **and fill in the "回測結論" column with the comparison result**
3. Increment completed counter by 1

**Back-testing conclusion column values** (extracted from the `/back-testing` result):

| Back-Testing Result | Criteria |
|---------------------|----------|
| `✅ 分析正確` | Previous analysis root cause matches actual fix |
| `✅ 部分正確` | Root cause direction correct but fix approach differs |
| `❌ 分析錯誤` | Root cause wrong, or pointed to unrelated logic |
| `⚠️ 無法比對` | No prior analysis / fix commit not found / non-bug closed directly |

Report progress to the user:
```
✓ FAQ-{ticket_id} back-testing complete ({completed}/{total}) — {back-testing result}
```

#### 4d. Error Handling

If the Agent encounters an error or fails:

1. Release the lockfile:
   ```bash
   bash scripts/backtest-lock.sh release FAQ-{ticket_id}
   ```
2. Change the ticket back-testing status to `failed`
3. Increment completed counter by 1 (counts as processed)
4. Continue to the next ticket

#### 4e. Determine Whether to Continue

- If there are still unprocessed bugs in the list → return to **4a** to automatically claim the next ticket
- If all are processed → proceed to **Step 5**

**Important: After completing each ticket, automatically continue to the next — no user input needed. The entire loop is fully automatic until the list is empty.**

### Step 5: Completion Report

```
## Batch Back-Testing Complete

- Total processed: {completed} tickets

| # | 單號 | Result | Back-Testing Result |
|---|------|--------|---------------------|
| 1 | FAQ-1841 | done | ✅ 分析正確 |
| 2 | FAQ-1807 | done | ❌ 分析錯誤 |
| 3 | FAQ-1722 | skipped | — |
```

---

## Notes

1. **No longer uses Notion search**: All pending back-testing lists are read from the tracker memory file; Notion is not queried directly.
2. **Atomic lock mechanism**: Use `bash scripts/backtest-lock.sh claim FAQ-{ticket_id}` for atomic claiming (backed by `mkdir`, which the OS guarantees to be atomic). Multiple parallel sessions will not claim the same ticket. Always `release` after completion or failure.
3. **Fully automatic loop**: After completing each ticket, automatically claim the next — no user input needed. Continues until the list is empty.
4. **Serial processing**: Only one ticket is processed at a time; wait for the Agent to finish completely before processing the next.
5. **Maximum 10 tickets per run**: Prevents any single execution from running too long.
6. **Tracker is the single source of truth**: The query script imports Notion data into the tracker; this skill only reads from the tracker.
7. **Lock cleanup**: If a session crashes and leaves locks unreleased, manually run `bash scripts/backtest-lock.sh cleanup` to clear all locks, or `bash scripts/backtest-lock.sh release FAQ-{ticket_id}` to release a specific lock.
8. **Independent from `/analyze-bugs`**: Back-testing uses its own separate tracker (`backtest_tracker.md`) and separate lock directory (`/tmp/backtest-locks`), completely isolated from the analysis pipeline.
