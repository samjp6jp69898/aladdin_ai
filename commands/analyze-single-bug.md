---
name: analyze-single-bug
description: Full pipeline for processing a Notion bug ticket — analyzes, traces root cause, fixes code in worktree, tests, validates, and uploads results.
user-invocable: true
argument-hint: "<NotionURL> [ticket_id]"
context: fork
---

# Bug Analysis Pipeline v3

You are a pipeline manager responsible for dispatching engineers. Your role is to sequentially dispatch agents to complete the bug analysis pipeline. **You do not read any Notion content or code yourself** — you only manage pipeline state and coordinate agents.

Always use the specified prompt document to create the corresponding sub agent. Never read the prompt yourself and handle tasks that should be delegated to sub agents.

## Parameters

`$ARGUMENTS` format: `/analyze-single-bug <NotionURL> [ticket_id]`

- **NotionURL** (required): The Notion URL of the bug ticket
- **ticket_id** (optional): e.g. `FAQ-1702`; if not provided, parsed by Bug Report Analyst

---

## State Variables

```
ticket_id = ""
page_id = ""              # UUID format (8-4-4-4-12), extracted from Notion URL
tracer_attempt_count = 0  # How many times Bug Tracer has analyzed
fixer_attempt_count = 0   # How many times Bug Fixer has attempted (resets when Tracer re-analyzes)
total_attempt_count = 0   # Tracer + Fixer total attempts (hard cap)
```

---

## Execution Flow

### Step 0: Parse Arguments

Extract NotionURL and ticket_id from `$ARGUMENTS`.

Also extract page_id from the Notion URL (the 32-char hex after the last `-` or `/`), convert to UUID format (8-4-4-4-12). Store this for use in Notion API calls throughout the pipeline (especially failure paths).

### Step 1: Bug Report Analyst

Create a sub agent using the prompt at `/Users/user/aladdin/.claude/agents/bug-report-analyst.md`:

```
prompt:
Use all text in {/Users/user/aladdin/.claude/agents/bug-report-analyst.md} as the prompt. Please parse the following Notion bug ticket and create the analysis document according to your responsibilities.
Notion URL: {Notion URL from $ARGUMENTS}

When done, return the ticket ID and screenshot status in your last two lines:
TICKET_ID: FAQ-XXXX
SCREENSHOT_STATUS: ...
```

**Wait for completion**, extract `TICKET_ID: FAQ-XXXX` and `SCREENSHOT_STATUS`. In all subsequent steps, use the actual ticket ID. Log the screenshot status for the completion report — if screenshots partially or fully failed, note it but continue the pipeline.

### Step 2: Spec Fetcher

Create a sub agent using the prompt at `/Users/user/aladdin/.claude/agents/spec-fetcher.md`:

```
prompt:
Use all text in {/Users/user/aladdin/.claude/agents/spec-fetcher.md} as the prompt. Please find the business specification for the affected module.
ticket_id: {ticket_id}
```

**Wait for completion.** If spec.md was not created, the pipeline continues (graceful degradation).

### Step 3: Bug Tracer

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
Use all text in {/Users/user/aladdin/.claude/agents/bug-tracer.md} as the prompt. Your previous analysis was rejected by the Evaluator. Please re-analyze the bug with the evaluator's feedback.
analytics document path: /Users/user/aladdin/obsidian/Debug/{ticket_id}/{ticket_id}-analytics.md
spec document path: /Users/user/aladdin/obsidian/Debug/{ticket_id}/{ticket_id}-spec.md
evaluator feedback: /Users/user/aladdin/obsidian/Debug/{ticket_id}/{ticket_id}-evaluator-report.md
ticket_id: {ticket_id}

The evaluator determined your previous root cause analysis was incorrect. Read the evaluator feedback carefully and re-analyze from scratch.
```

**Wait for completion.**

Read analysis-notes.md and check for "已修復紀錄" section. If the bug is confirmed already fixed (with commit hash), **skip Steps 4-7** and go directly to Step 8.

---

### Step 4: Create Worktree

```bash
mkdir -p /Users/user/aladdin/worktrees
git worktree add /Users/user/aladdin/worktrees/{ticket_id} -b landon/{ticket_id} main
cd /Users/user/aladdin/worktrees/{ticket_id} && sh bootstrap.sh
```

Store the worktree path: `/Users/user/aladdin/worktrees/{ticket_id}`

If `git worktree add` fails (branch already exists), try:
```bash
git worktree add /Users/user/aladdin/worktrees/{ticket_id} landon/{ticket_id}
```

If bootstrap.sh fails, log the error but continue.

---

### Step 5: Bug Fixer

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

**Re-dispatch after evaluator rejection (implementation error):**

```
prompt:
Use all text in {/Users/user/aladdin/.claude/agents/bug-fixer.md} as the prompt. The previous implementation failed review. Please fix the issues based on evaluator feedback.
analysis notes path: /Users/user/aladdin/obsidian/Debug/{ticket_id}/{ticket_id}-analysis-notes.md
analytics document path: /Users/user/aladdin/obsidian/Debug/{ticket_id}/{ticket_id}-analytics.md
evaluator feedback: /Users/user/aladdin/obsidian/Debug/{ticket_id}/{ticket_id}-evaluator-report.md
worktree_path: /Users/user/aladdin/worktrees/{ticket_id}
ticket_id: {ticket_id}

Read the evaluator feedback carefully, modify the code on the same branch, and commit a new fix.
```

**Wait for completion.**

#### BRANCH_ERROR Handling
If the Bug Fixer returns a message containing `BRANCH_ERROR`:
1. Log the error
2. Attempt to re-create the worktree:
   ```bash
   git worktree remove /Users/user/aladdin/worktrees/{ticket_id} --force 2>/dev/null; git worktree add /Users/user/aladdin/worktrees/{ticket_id} -b landon/{ticket_id} main
   ```
   If the branch already exists: `git worktree add /Users/user/aladdin/worktrees/{ticket_id} landon/{ticket_id}`
3. Verify: `cd /Users/user/aladdin/worktrees/{ticket_id} && git branch --show-current`
4. If verified, re-dispatch Bug Fixer. If still failing, report error and end pipeline.

---

### Step 6: Evaluator

Create a sub agent using the prompt at `/Users/user/aladdin/.claude/agents/evaluator.md`:

```
prompt:
Use all text in {/Users/user/aladdin/.claude/agents/evaluator.md} as the prompt. Please review the Bug Fixer's solution, write tests, and execute them.
ticket_id: {ticket_id}
worktree_path: /Users/user/aladdin/worktrees/{ticket_id}
```

**Wait for completion.**

#### BRANCH_ERROR Handling
If the Evaluator returns a message containing `BRANCH_ERROR`, follow the same worktree recovery procedure as in Step 5, then re-dispatch the Evaluator.

Read `/Users/user/aladdin/obsidian/Debug/{ticket_id}/{ticket_id}-evaluator-report.md`.

#### If `✅ 通過` → Proceed to Step 7.

#### If `❌ 未通過`

Read the `退回類型` field from the evaluator report.

**If `退回類型: 實作錯誤`:**

Increment fixer_attempt_count and total_attempt_count.

- **If fixer_attempt_count < 3 AND total_attempt_count <= 5:** Return to Step 5 (re-dispatch Bug Fixer with feedback).
- **If fixer_attempt_count >= 3:** Fixer has failed 3 times on this analysis. Reset fixer_attempt_count = 0. Go to Step 3 to re-dispatch Bug Tracer for re-analysis.

**If `退回類型: 分析錯誤`:**

Reset fixer_attempt_count = 0.

- **If tracer_attempt_count < 2 AND total_attempt_count <= 5:** Return to Step 3 (re-dispatch Bug Tracer with feedback).
- **If tracer_attempt_count >= 2:** Go to Pipeline Failure.

---

### Step 7: Test Validator

**Initialize validator_attempt_count = 0.**

Create a sub agent using the prompt at `/Users/user/aladdin/.claude/agents/test-validator.md`:

```
prompt:
Use all text in {/Users/user/aladdin/.claude/agents/test-validator.md} as the prompt. Please validate the test quality and coverage.
ticket_id: {ticket_id}
worktree_path: /Users/user/aladdin/worktrees/{ticket_id}
```

**Wait for completion.**

#### BRANCH_ERROR Handling
If the Test Validator returns a message containing `BRANCH_ERROR`, follow the same worktree recovery procedure as in Step 5, then re-dispatch the Test Validator.

Read `/Users/user/aladdin/obsidian/Debug/{ticket_id}/{ticket_id}-validation-report.md`.

#### If `✅ 通過` → Proceed to Step 8.

#### If `❌ 未通過`

Increment validator_attempt_count.

**If validator_attempt_count < 2:** Re-launch Evaluator with feedback:

```
prompt:
Use all text in {/Users/user/aladdin/.claude/agents/evaluator.md} as the prompt. The tests failed validation. Please supplement the tests based on the feedback.
ticket_id: {ticket_id}
worktree_path: /Users/user/aladdin/worktrees/{ticket_id}
validation feedback: /Users/user/aladdin/obsidian/Debug/{ticket_id}/{ticket_id}-validation-report.md

Read the validation feedback and add/modify test cases to address the gaps.
```

Wait for completion, then **return to Step 7**.

**If validator_attempt_count reaches 2:** Go to Pipeline Failure.

---

### Step 8: Drive Uploader

Create a sub agent using the prompt at `/Users/user/aladdin/.claude/agents/drive-uploader.md`:

```
prompt:
Use all text in {/Users/user/aladdin/.claude/agents/drive-uploader.md} as the prompt. Please compile the solution document, upload to Google Drive, and comment on Notion.
ticket_id: {ticket_id}
Notion URL: {Notion URL from $ARGUMENTS}
worktree_path: /Users/user/aladdin/worktrees/{ticket_id}
```

**Wait for completion.**

---

### Step 9: Completion Report

```
## {ticket_id} Analysis Complete

- Bug Tracer attempts: {tracer_attempt_count}
- Bug Fixer attempts: {fixer_attempt_count}
- Total attempts: {total_attempt_count}
- Evaluator: passed
- Test Validator: passed (attempt {validator_attempt_count + 1})
- Google Drive: {share link}
- Notion comment: completed / failed
- Worktree: /Users/user/aladdin/worktrees/{ticket_id} (branch: landon/{ticket_id})

Documents at: /Users/user/aladdin/obsidian/Debug/{ticket_id}/
```

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
{ticket_id} pipeline 失敗，需要人工介入。
- Bug Tracer 嘗試：{tracer_attempt_count} 次
- Bug Fixer 嘗試：{fixer_attempt_count} 次
- 總嘗試：{total_attempt_count} 次
- 失敗原因：{最後一次 evaluator report 的退回理由摘要}
- Worktree 保留在：/Users/user/aladdin/worktrees/{ticket_id}
- 文件位於：/Users/user/aladdin/obsidian/Debug/{ticket_id}/
```
