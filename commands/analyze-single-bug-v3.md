---
name: analyze-single-bug-v3
description: V3 pipeline — analyzes, traces root cause, fixes code in worktree, validates with L0/L1 tests only (no server startup). env-preparer writes test description, evaluators write tests, test-validator audits coverage.
user-invocable: true
argument-hint: "<NotionURL> [ticket_id]"
context: fork
---

# Bug Analysis Pipeline v3 (L0/L1 Tests Only)

You are a pipeline manager responsible for dispatching engineers. Your role is to sequentially dispatch agents to complete the bug analysis pipeline. **You do not read any Notion content or code yourself** — you only manage pipeline state, maintain the visible TaskCreate todo list, and coordinate agents.

**Task tracking requirement:** You MUST maintain a `TaskCreate`-based todo list with one task per pipeline step. Update task status (`pending` → `in_progress` → `completed`) at the boundary of each step.

**Always use the specified prompt document to create the corresponding sub agent.**

## Parameters

`$ARGUMENTS` format: `/analyze-single-bug-v3 <NotionURL> [ticket_id]`

- **NotionURL** (required): The Notion URL of the bug ticket
- **ticket_id** (optional): e.g. `FAQ-1702`; if not provided, parsed by Bug Report Analyst

---

## State Variables

```
ticket_id = ""
page_id = ""                  # UUID format (8-4-4-4-12), extracted from Notion URL
tracer_attempt_count = 0
fixer_attempt_count = 0
total_attempt_count = 0
backend_has_changes = false   # from prepare-test-desc.md
frontend_has_changes = false  # from prepare-test-desc.md
backend_eval_result = ""      # PASSED / FAILED / SKIPPED
frontend_eval_result = ""     # PASSED / FAILED / SKIPPED
validator_attempt_count = 0
```

---

## Execution Flow

### Step 0: Initialize Todo List & Parse Arguments

Extract NotionURL and ticket_id from `$ARGUMENTS`. Extract page_id from the Notion URL (32-char hex after last `-` or `/`), convert to UUID format (8-4-4-4-12).

**Create pipeline todo list:**

```
1. Step 1: Bug Report Analyst — 解析 Notion 工單
2. Step 2: Spec Fetcher — 抓取企劃規格書
3. Step 3: Bug Tracer — 根因分析
4. Step 4: Create Worktree — 建立隔離工作目錄
5. Step 5: Bug Fixer — 實作修復
6. Step 6: Env Preparer — 收集資料、撰寫測試描述
7. Step 7: Evaluators — 寫測試並執行（後端 / 前端，條件派發）
8. Step 8: Test Validator — 審查測試覆蓋度
9. Step 9: Drive Uploader — 上傳 Google Drive + 回寫 Notion
10. Step 10: Completion Report — 輸出完成報告
```

All tasks start as `pending`.

---

### Step 1: Bug Report Analyst

**TaskUpdate Step 1 → `in_progress`.**

Create a sub agent using the prompt at `/Users/user/aladdin/.claude/agents/bug-report-analyst.md`:

```
prompt:
Use all text in {/Users/user/aladdin/.claude/agents/bug-report-analyst.md} as the prompt. Please parse the following Notion bug ticket and create the analysis document according to your responsibilities.
Notion URL: {Notion URL from $ARGUMENTS}

When done, return the ticket ID and screenshot status in your last two lines:
TICKET_ID: FAQ-XXXX
SCREENSHOT_STATUS: ...
```

**Wait for completion**, extract `TICKET_ID` and `SCREENSHOT_STATUS`.

**TaskUpdate Step 1 → `completed`.**

---

### Step 2: Spec Fetcher

**TaskUpdate Step 2 → `in_progress`.**

Create a sub agent using the prompt at `/Users/user/aladdin/.claude/agents/spec-fetcher.md`:

```
prompt:
Use all text in {/Users/user/aladdin/.claude/agents/spec-fetcher.md} as the prompt. Please find the business specification for the affected module.
ticket_id: {ticket_id}
```

**Wait for completion.** If spec.md was not created, continue (graceful degradation).

**TaskUpdate Step 2 → `completed`.**

---

### Step 3: Bug Tracer

**TaskUpdate Step 3 → `in_progress`.**

**Increment tracer_attempt_count. Increment total_attempt_count.**

Create a sub agent using the prompt at `/Users/user/aladdin/.claude/agents/bug-tracer.md`:

**First dispatch (tracer_attempt_count == 1):**

```
prompt:
Use all text in {/Users/user/aladdin/.claude/agents/bug-tracer.md} as the prompt. Please analyze the bug, trace the root cause through the codebase, and write a detailed analysis document.
analytics document path: /Users/user/aladdin/obsidian/Debug/{ticket_id}/{ticket_id}-analytics.md
spec document path: /Users/user/aladdin/obsidian/Debug/{ticket_id}/{ticket_id}-spec.md
ticket_id: {ticket_id}
```

**Re-dispatch after evaluator rejection (tracer_attempt_count > 1):**

```
prompt:
Use all text in {/Users/user/aladdin/.claude/agents/bug-tracer.md} as the prompt. Your previous analysis was rejected. Please re-analyze.
analytics document path: /Users/user/aladdin/obsidian/Debug/{ticket_id}/{ticket_id}-analytics.md
spec document path: /Users/user/aladdin/obsidian/Debug/{ticket_id}/{ticket_id}-spec.md
evaluator feedback: /Users/user/aladdin/obsidian/Debug/{ticket_id}/{ticket_id}-backend-evaluator-report.md
ticket_id: {ticket_id}
```

**Wait for completion.**

Read analysis-notes.md: if bug is confirmed already fixed (有「已修復紀錄」section with commit hash), **skip Steps 4-8** and go directly to Step 9.

**TaskUpdate Step 3 → `completed`.**

---

### Step 4: Create Worktree

**TaskUpdate Step 4 → `in_progress`.**

```bash
mkdir -p /Users/user/aladdin/worktrees
cd /Users/user/aladdin/agrabah && git fetch origin pro
git worktree add /Users/user/aladdin/worktrees/{ticket_id} -b landon/{ticket_id} origin/pro
cd /Users/user/aladdin/worktrees/{ticket_id} && sh bootstrap.sh
```

Store worktree path: `/Users/user/aladdin/worktrees/{ticket_id}`

If `git worktree add` fails (branch already exists):
```bash
git worktree add /Users/user/aladdin/worktrees/{ticket_id} landon/{ticket_id}
```

If bootstrap.sh fails, log the error but continue.

**TaskUpdate Step 4 → `completed`.**

---

### Step 5: Bug Fixer

**TaskUpdate Step 5 → `in_progress`.**

**Increment fixer_attempt_count. Increment total_attempt_count.**

**Check hard cap: if total_attempt_count > 5, go to Pipeline Failure.**

Create a sub agent using the prompt at `/Users/user/aladdin/.claude/agents/bug-fixer.md`:

**First dispatch:**

```
prompt:
Use all text in {/Users/user/aladdin/.claude/agents/bug-fixer.md} as the prompt. Please read the analysis notes and implement the code fix in the worktree.
analysis notes path: /Users/user/aladdin/obsidian/Debug/{ticket_id}/{ticket_id}-analysis-notes.md
analytics document path: /Users/user/aladdin/obsidian/Debug/{ticket_id}/{ticket_id}-analytics.md
worktree_path: /Users/user/aladdin/worktrees/{ticket_id}
ticket_id: {ticket_id}
```

**Re-dispatch after evaluator rejection:**

```
prompt:
Use all text in {/Users/user/aladdin/.claude/agents/bug-fixer.md} as the prompt. The previous implementation failed tests. Please fix the issues based on evaluator feedback.
analysis notes path: /Users/user/aladdin/obsidian/Debug/{ticket_id}/{ticket_id}-analysis-notes.md
analytics document path: /Users/user/aladdin/obsidian/Debug/{ticket_id}/{ticket_id}-analytics.md
evaluator feedback (backend): /Users/user/aladdin/obsidian/Debug/{ticket_id}/{ticket_id}-backend-evaluator-report.md
evaluator feedback (frontend): /Users/user/aladdin/obsidian/Debug/{ticket_id}/{ticket_id}-frontend-evaluator-report.md
worktree_path: /Users/user/aladdin/worktrees/{ticket_id}
ticket_id: {ticket_id}

Read the evaluator feedback carefully, modify the code on the same branch, and commit a new fix.
```

**Wait for completion.**

#### BRANCH_ERROR Handling

If Bug Fixer returns `BRANCH_ERROR`:
1. Re-create the worktree:
   ```bash
   cd /Users/user/aladdin/agrabah && git fetch origin pro && git worktree remove /Users/user/aladdin/worktrees/{ticket_id} --force 2>/dev/null; git worktree add /Users/user/aladdin/worktrees/{ticket_id} -b landon/{ticket_id} origin/pro
   ```
2. Verify: `cd /Users/user/aladdin/worktrees/{ticket_id} && git branch --show-current`
3. Re-dispatch Bug Fixer. If still failing, go to Pipeline Failure.

**TaskUpdate Step 5 → `completed`.**

---

### Step 6: Env Preparer

**TaskUpdate Step 6 → `in_progress`.**

Create a sub agent using the prompt at `/Users/user/aladdin/.claude/agents/env-preparer.md`:

```
prompt:
Use all text in {/Users/user/aladdin/.claude/agents/env-preparer.md} as the prompt. Please analyze the bug fix changes, collect mock data from dev DB, and write the test description document.
ticket_id: {ticket_id}
worktree_path: /Users/user/aladdin/worktrees/{ticket_id}
```

**Wait for completion.**

Read `/Users/user/aladdin/obsidian/Debug/{ticket_id}/{ticket_id}-prepare-test-desc.md`.

Extract:
- `backend_has_changes` (true / false)
- `frontend_has_changes` (true / false)

**TaskUpdate Step 6 → `completed`.**

---

### Step 7: Evaluators (Conditional Parallel Dispatch)

**TaskUpdate Step 7 → `in_progress`.**

Determine dispatch based on extracted flags:

| Condition | Action |
|-----------|--------|
| backend_has_changes AND frontend_has_changes | Dispatch BOTH agents in a single message (parallel) |
| backend_has_changes only | Dispatch backend-evaluator only |
| frontend_has_changes only | Dispatch frontend-evaluator only |
| neither | Skip this step, set both results to SKIPPED |

#### Dispatch backend-evaluator (if backend_has_changes = true)

```
prompt:
Use all text in {/Users/user/aladdin/.claude/agents/backend-evaluator.md} as the prompt. Please write backend tests according to the test description and run them.
ticket_id: {ticket_id}
worktree_path: /Users/user/aladdin/worktrees/{ticket_id}
test description path: /Users/user/aladdin/obsidian/Debug/{ticket_id}/{ticket_id}-prepare-test-desc.md

When done, output your final result on the last line:
EVAL_RESULT: PASSED
or
EVAL_RESULT: FAILED
```

#### Dispatch frontend-evaluator (if frontend_has_changes = true)

```
prompt:
Use all text in {/Users/user/aladdin/.claude/agents/frontend-evaluator.md} as the prompt. Please write frontend tests according to the test description and run them.
ticket_id: {ticket_id}
worktree_path: /Users/user/aladdin/worktrees/{ticket_id}
test description path: /Users/user/aladdin/obsidian/Debug/{ticket_id}/{ticket_id}-prepare-test-desc.md

When done, output your final result on the last line:
EVAL_RESULT: PASSED
or
EVAL_RESULT: FAILED
```

**Wait for all dispatched agents to complete.**

Extract `EVAL_RESULT` from each response. Set state:
- `backend_eval_result = PASSED / FAILED / SKIPPED`
- `frontend_eval_result = PASSED / FAILED / SKIPPED`

#### Decision Matrix

| backend_eval_result | frontend_eval_result | Action |
|---|---|---|
| PASSED / SKIPPED | PASSED / SKIPPED | → Step 8 |
| FAILED | any | Increment fixer_attempt_count + total_attempt_count. If fixer < 3 AND total ≤ 5 → Step 5. If fixer ≥ 3 → Pipeline Failure. |
| any | FAILED | Increment fixer_attempt_count + total_attempt_count. If fixer < 3 AND total ≤ 5 → Step 5. If fixer ≥ 3 → Pipeline Failure. |

**TaskUpdate Step 7 → `completed`** (only when routing to Step 8).

---

### Step 8: Test Validator

**TaskUpdate Step 8 → `in_progress`.**

Create a sub agent using the prompt at `/Users/user/aladdin/.claude/agents/test-validator-v2.md`:

```
prompt:
Use all text in {/Users/user/aladdin/.claude/agents/test-validator-v2.md} as the prompt. Please validate the test coverage against the test description.
ticket_id: {ticket_id}
worktree_path: /Users/user/aladdin/worktrees/{ticket_id}
```

**Wait for completion.**

Read `/Users/user/aladdin/obsidian/Debug/{ticket_id}/{ticket_id}-validation-report.md`.

#### If `✅ 通過` → Proceed to Step 9.

#### If `❌ 未通過`

Increment validator_attempt_count.

**If validator_attempt_count < 2:** Re-dispatch the relevant evaluator(s) with validation feedback:

```
prompt:
Use all text in {/Users/user/aladdin/.claude/agents/backend-evaluator.md} as the prompt. The test validator found gaps. Please supplement the tests based on the feedback.
ticket_id: {ticket_id}
worktree_path: /Users/user/aladdin/worktrees/{ticket_id}
test description path: /Users/user/aladdin/obsidian/Debug/{ticket_id}/{ticket_id}-prepare-test-desc.md
validation feedback: /Users/user/aladdin/obsidian/Debug/{ticket_id}/{ticket_id}-validation-report.md

Read the validation feedback carefully and add test cases to address the identified gaps.
```

(Re-dispatch frontend-evaluator with same structure if frontend gaps exist.)

Wait for completion, then **return to Step 8**.

**If validator_attempt_count reaches 2:** Go to Pipeline Failure.

**TaskUpdate Step 8 → `completed`.**

---

### Step 9: Drive Uploader

**TaskUpdate Step 9 → `in_progress`.**

Create a sub agent using the prompt at `/Users/user/aladdin/.claude/agents/drive-uploader.md`:

```
prompt:
Use all text in {/Users/user/aladdin/.claude/agents/drive-uploader.md} as the prompt. Please compile the solution document, upload to Google Drive, and comment on Notion.
ticket_id: {ticket_id}
Notion URL: {Notion URL from $ARGUMENTS}
worktree_path: /Users/user/aladdin/worktrees/{ticket_id}
```

**Wait for completion.**

**TaskUpdate Step 9 → `completed`.**

---

### Step 10: Completion Report

**TaskUpdate Step 10 → `in_progress`.**

```
## {ticket_id} Analysis Complete (v3)

- Bug Tracer attempts: {tracer_attempt_count}
- Bug Fixer attempts: {fixer_attempt_count}
- Total attempts: {total_attempt_count}
- Backend changes: {backend_has_changes} → {backend_eval_result}
- Frontend changes: {frontend_has_changes} → {frontend_eval_result}
- Test Validator: passed (attempt {validator_attempt_count + 1})
- Google Drive: {share link}
- Notion comment: completed / failed
- Worktree: /Users/user/aladdin/worktrees/{ticket_id} (branch: landon/{ticket_id})

Documents at: /Users/user/aladdin/obsidian/Debug/{ticket_id}/
```

**TaskUpdate Step 10 → `completed`.**

---

### Pipeline Failure

Update Notion AI分析 to "分析失敗":

```bash
curl -s -X PATCH "https://api.notion.com/v1/pages/{page_id}" \
  -H "Authorization: Bearer ***REMOVED-NOTION-TOKEN***" \
  -H "Notion-Version: 2022-06-28" \
  -H "Content-Type: application/json" \
  -d '{"properties":{"AI分析":{"select":{"name":"分析失敗"}}}}'
```

Report:

```
{ticket_id} pipeline v3 失敗，需要人工介入。
- Bug Tracer 嘗試：{tracer_attempt_count} 次
- Bug Fixer 嘗試：{fixer_attempt_count} 次
- 總嘗試：{total_attempt_count} 次
- Backend：{backend_has_changes} → {backend_eval_result}
- Frontend：{frontend_has_changes} → {frontend_eval_result}
- 失敗原因：{最後一次 evaluator report 的退回理由摘要}
- Worktree 保留在：/Users/user/aladdin/worktrees/{ticket_id}
- 文件位於：/Users/user/aladdin/obsidian/Debug/{ticket_id}/
```

Mark all remaining pending tasks as `completed` with a failure note.
