---
name: analyze-single-bug
description: Full pipeline for processing a Notion bug ticket — analyzes, fixes code in worktree, tests, validates, and uploads results.
user-invocable: true
argument-hint: "<NotionURL> [ticket_id]"
context: fork
---

# Bug Analysis Pipeline v2

You are a pipeline manager responsible for dispatching engineers. Your role is to sequentially dispatch agents to complete the bug analysis pipeline. **You do not read any Notion content or code yourself** — you only manage pipeline state and coordinate agents.

Always use the specified prompt document to create the corresponding sub agent. Never read the prompt yourself and handle tasks that should be delegated to sub agents.

## Parameters

`$ARGUMENTS` format: `/analyze-single-bug <NotionURL> [ticket_id]`

- **NotionURL** (required): The Notion URL of the bug ticket
- **ticket_id** (optional): e.g. `FAQ-1702`; if not provided, parsed by Bug Report Analyst

---

## Execution Flow

### Step 0: Parse Arguments

Extract NotionURL and ticket_id from `$ARGUMENTS`.

### Step 1: Bug Report Analyst

Create a sub agent using the prompt at `/Users/user/aladdin/.claude/agents/bug-report-analyst.md`:

```
prompt:
Use all text in {/Users/user/aladdin/.claude/agents/bug-report-analyst.md} as the prompt. Please parse the following Notion bug ticket and create the analysis document according to your responsibilities.
Notion URL: {Notion URL from $ARGUMENTS}

When done, return the ticket ID on the last line in this format:
TICKET_ID: FAQ-XXXX
```

**Wait for completion**, extract `TICKET_ID: FAQ-XXXX`. In all subsequent steps, use the actual ticket ID.

### Step 1.5: Download Bug Screenshot (Main Flow)

This step is **executed by the main flow itself**, not by a sub agent.

1. Read `/Users/user/aladdin/debug/{ticket_id}/{ticket_id}-analytics.md`
2. Extract all image URLs from the "Supporting Document Links" section
3. If image URLs found, download each:
   ```bash
   curl -sL -o "/Users/user/aladdin/debug/{ticket_id}/screenshot_1.png" "full_image_url"
   ```
4. Read each image, append description to analytics document under `## Screenshot Analysis`
5. If no images or download fails, skip and proceed.

### Step 1.7: Create Worktree

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

### Step 2: Bug Fixer

**Initialize fixer_attempt_count = 0.**

Create a sub agent using the prompt at `/Users/user/aladdin/.claude/agents/bug-trace-fixer.md`:

```
prompt:
Use all text in {/Users/user/aladdin/.claude/agents/bug-trace-fixer.md} as the prompt. Please read the bug analysis document, trace through the code, fix the bug in the worktree, and write the analysis notes.
analytics document path: /Users/user/aladdin/debug/{ticket_id}/{ticket_id}-analytics.md
worktree_path: /Users/user/aladdin/worktrees/{ticket_id}
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

Read analysis-notes.md and check for "已修復紀錄" section. If the bug is confirmed already fixed (with commit hash), **skip Steps 3-5** and go directly to Step 6.

---

### Step 3: Spec Fetcher

Create a sub agent using the prompt at `/Users/user/aladdin/.claude/agents/spec-fetcher.md`:

```
prompt:
Use all text in {/Users/user/aladdin/.claude/agents/spec-fetcher.md} as the prompt. Please find the business specification for the affected module.
ticket_id: {ticket_id}
```

**Wait for completion.** If spec.md was not created, the pipeline continues (graceful degradation).

---

### Step 4: Evaluator

Create a sub agent using the prompt at `/Users/user/aladdin/.claude/agents/evaluator.md`:

```
prompt:
Use all text in {/Users/user/aladdin/.claude/agents/evaluator.md} as the prompt. Please review the Bug Fixer's solution, write tests, and execute them.
ticket_id: {ticket_id}
worktree_path: /Users/user/aladdin/worktrees/{ticket_id}
```

**Wait for completion.**

#### BRANCH_ERROR Handling
If the Evaluator returns a message containing `BRANCH_ERROR`, follow the same worktree recovery procedure as in Step 2, then re-dispatch the Evaluator.

Read `/Users/user/aladdin/debug/{ticket_id}/{ticket_id}-evaluator-report.md`.

#### If `✅ 通過` → Proceed to Step 5.

#### If `❌ 未通過`

Increment fixer_attempt_count.

**If fixer_attempt_count < 3:** Re-launch Bug Fixer with feedback:

```
prompt:
Use all text in {/Users/user/aladdin/.claude/agents/bug-trace-fixer.md} as the prompt. The previous solution failed review. Please re-read all documents and propose a new fix.
analytics document: /Users/user/aladdin/debug/{ticket_id}/{ticket_id}-analytics.md
evaluator feedback: /Users/user/aladdin/debug/{ticket_id}/{ticket_id}-evaluator-report.md
worktree_path: /Users/user/aladdin/worktrees/{ticket_id}

Read the evaluator feedback carefully, modify the code on the same branch, and commit a new fix.
```

Wait for completion, then **return to Step 4**.

**If fixer_attempt_count reaches 3:** Report failure and end pipeline (skip Steps 5-6).

```
{ticket_id} 經過 3 次修復嘗試仍未通過 Evaluator 審核。需要人工介入。
Worktree 保留在：/Users/user/aladdin/worktrees/{ticket_id}
文件位於：/Users/user/aladdin/debug/{ticket_id}/
```

---

### Step 5: Test Validator

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
If the Test Validator returns a message containing `BRANCH_ERROR`, follow the same worktree recovery procedure as in Step 2, then re-dispatch the Test Validator.

Read `/Users/user/aladdin/debug/{ticket_id}/{ticket_id}-validation-report.md`.

#### If `✅ 通過` → Proceed to Step 6.

#### If `❌ 未通過`

Increment validator_attempt_count.

**If validator_attempt_count < 2:** Re-launch Evaluator with feedback:

```
prompt:
Use all text in {/Users/user/aladdin/.claude/agents/evaluator.md} as the prompt. The tests failed validation. Please supplement the tests based on the feedback.
ticket_id: {ticket_id}
worktree_path: /Users/user/aladdin/worktrees/{ticket_id}
validation feedback: /Users/user/aladdin/debug/{ticket_id}/{ticket_id}-validation-report.md

Read the validation feedback and add/modify test cases to address the gaps.
```

Wait for completion, then **return to Step 5**.

**If validator_attempt_count reaches 2:** Report failure, preserve worktree, end pipeline.

---

### Step 6: Drive Uploader

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

### Step 7: Completion Report

```
## {ticket_id} Analysis Complete

- Bug Fixer attempts: {fixer_attempt_count + 1}
- Evaluator: passed
- Test Validator: passed (attempt {validator_attempt_count + 1})
- Google Drive: {share link}
- Notion comment: completed / failed
- Worktree: /Users/user/aladdin/worktrees/{ticket_id} (branch: landon/{ticket_id})

Documents at: /Users/user/aladdin/debug/{ticket_id}/
```
