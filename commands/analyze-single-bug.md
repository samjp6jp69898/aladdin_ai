---
name: analyze-single-bug
description: Analyzes, traces root cause, fixes code in worktree, validates with L0/L1 tests only (no server startup). env-preparer writes test description, evaluators write tests, test-validator audits coverage.
user-invocable: true
argument-hint: "<NotionURL> [ticket_id]"
---

# Bug Analysis Pipeline (L0/L1 Tests Only)

You are the pipeline manager responsible for dispatching engineers. Your role is to sequentially dispatch sub agents to complete the bug analysis pipeline. **You do not read any Notion content or code yourself** — you only manage pipeline state and coordinate agents.

**Always use the specified prompt document to create the corresponding sub agent.**

## Parameters

`$ARGUMENTS` format: `/analyze-single-bug <NotionURL> [ticket_id]`

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

### Step 0: Parse Arguments

Extract NotionURL and ticket_id from `$ARGUMENTS`. Extract page_id from the Notion URL (32-char hex after last `-` or `/`), convert to UUID format (8-4-4-4-12).

---

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

**Wait for completion**, extract `TICKET_ID` and `SCREENSHOT_STATUS`.

---

### Step 2: Spec Fetcher

Create a sub agent using the prompt at `/Users/user/aladdin/.claude/agents/spec-fetcher.md`:

```
prompt:
Use all text in {/Users/user/aladdin/.claude/agents/spec-fetcher.md} as the prompt. Please find the business specification for the affected module.
ticket_id: {ticket_id}
```

**Wait for completion.** If spec.md was not created, continue (graceful degradation).

---

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
Use all text in {/Users/user/aladdin/.claude/agents/bug-tracer.md} as the prompt. Your previous analysis was rejected. Please re-analyze.
analytics document path: /Users/user/aladdin/obsidian/Debug/{ticket_id}/{ticket_id}-analytics.md
spec document path: /Users/user/aladdin/obsidian/Debug/{ticket_id}/{ticket_id}-spec.md
evaluator feedback: /Users/user/aladdin/obsidian/Debug/{ticket_id}/{ticket_id}-backend-evaluator-report.md
ticket_id: {ticket_id}
```

**Wait for completion.**

Read analysis-notes.md: if bug is confirmed already fixed (有「已修復紀錄」section with commit hash), **skip Steps 4-8** and go directly to Step 9.

#### Extract affected_repos

從 analysis-notes.md 的「修復策略」section 中，掃描所有修改檔案路徑的前綴，提取涉及的 repo 集合：

- 路徑以 `agrabah/` 開頭 → `agrabah`
- 路徑以 `abu/` 開頭 → `abu`
- 路徑以 `lago/` 開頭 → `lago`
- 路徑以 `rajah/` 開頭 → `rajah`

Store as: `affected_repos`（例如 `["agrabah"]` 或 `["agrabah", "rajah"]`）

若解析不出任何 repo（例如 tracer 標記已修復），則 `affected_repos` 為空，Step 4 的 worktree 建立仍會執行（全部用 symlink），bootstrap 會在主工作區的 rajah 上跑。

---

### Step 4: Create Worktrees (按需建立 + symlink 補齊)

只為 `affected_repos` 中的 repo 建立真正的 git worktree（隔離環境），其餘 repo 用 symlink 指回主工作區。所有 7 個目錄（4 主 repo + 3 共用庫）都會出現在 per-ticket 根目錄下，確保 `rajah/bootstrap.sh` 與 `generate-*.sh` 內的相對路徑（`../agrabah`、`../abu`、`../lago`、`../jasmine` 等）在任何情境下都能正確解析。

**目標結構（以 affected_repos = ["agrabah"] 為例）：**
```
/Users/user/aladdin/worktrees/{ticket_id}/
├── agrabah   (git worktree, branch landon/{ticket_id}, base origin/pro)
├── abu       (symlink → /Users/user/aladdin/abu)
├── lago      (symlink → /Users/user/aladdin/lago)
├── rajah     (symlink → /Users/user/aladdin/rajah)
├── jasmine   (symlink → /Users/user/aladdin/jasmine)
├── genie     (symlink → /Users/user/aladdin/genie)
└── jafar     (symlink → /Users/user/aladdin/jafar)
```

**指令（按需建立 worktree + symlink 補齊 + 驗證 + bootstrap）：**

```bash
mkdir -p /Users/user/aladdin/worktrees/{ticket_id}

# 對 affected_repos 中的 repo 建立真正的 git worktree
for repo in {affected_repos}; do
  cd /Users/user/aladdin/$repo && git fetch origin pro --quiet
  git worktree add /Users/user/aladdin/worktrees/{ticket_id}/$repo -b landon/{ticket_id} origin/pro 2>/dev/null \
    || git worktree add /Users/user/aladdin/worktrees/{ticket_id}/$repo landon/{ticket_id}
done

# 驗證：affected_repos 中的 sub-worktree 全部都必須在 landon/{ticket_id}
ALL_OK=1
for repo in {affected_repos}; do
  branch=$(git -C /Users/user/aladdin/worktrees/{ticket_id}/$repo branch --show-current 2>/dev/null)
  if [ "$branch" != "landon/{ticket_id}" ]; then
    echo "WORKTREE_ERROR: $repo branch=$branch (expected landon/{ticket_id})"
    ALL_OK=0
  fi
done
[ "$ALL_OK" = "1" ] || exit 1

# 不在 affected_repos 中的主 repo 用 symlink 指回主工作區
for repo in agrabah abu lago rajah; do
  if [ ! -d "/Users/user/aladdin/worktrees/{ticket_id}/$repo" ]; then
    ln -sfn /Users/user/aladdin/$repo /Users/user/aladdin/worktrees/{ticket_id}/$repo
  fi
done

# 共用庫（jasmine / genie / jafar）一律 symlink
for shared in jasmine genie jafar; do
  ln -sfn /Users/user/aladdin/$shared /Users/user/aladdin/worktrees/{ticket_id}/$shared
done

# 從 rajah（可能是 worktree 或 symlink）跑 bootstrap
cd /Users/user/aladdin/worktrees/{ticket_id}/rajah && sh bootstrap.sh
```

Store worktree root: `worktree_path = /Users/user/aladdin/worktrees/{ticket_id}`
Store affected repos: `affected_repos`（必須傳遞給所有 sub-agent）

（注意：`worktree_path` 指向「per-ticket 根目錄」，其中 `affected_repos` 是真正的 git worktree，其餘是 symlink。這個語意必須傳遞給所有 sub-agent。）

**若任一 sub-worktree 建立或驗證失敗：**
1. 先嘗試清掉殘留：
   ```bash
   for repo in {affected_repos}; do
     cd /Users/user/aladdin/$repo 2>/dev/null && git worktree remove /Users/user/aladdin/worktrees/{ticket_id}/$repo --force 2>/dev/null
   done
   rm -rf /Users/user/aladdin/worktrees/{ticket_id}
   ```
2. 再次執行整段建立 + 驗證指令。若仍失敗 → 進入 Pipeline Failure。

如果 bootstrap.sh 失敗（例如 sync-all 連不到 DB），記錄錯誤但繼續流程；只有「affected_repos 中的 sub-worktree 沒全部建立成功」才視為硬性失敗。

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
affected_repos: {affected_repos}
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
affected_repos: {affected_repos}
ticket_id: {ticket_id}

Read the evaluator feedback carefully, modify the code on the same branch, and commit a new fix.
```

**Wait for completion.**

#### BRANCH_ERROR Handling

If Bug Fixer (or任何 sub-agent) returns `BRANCH_ERROR`:
1. 清除殘留並重建 affected_repos 的 worktree + symlink：
   ```bash
   for repo in {affected_repos}; do
     cd /Users/user/aladdin/$repo 2>/dev/null && git worktree remove /Users/user/aladdin/worktrees/{ticket_id}/$repo --force 2>/dev/null
   done
   rm -rf /Users/user/aladdin/worktrees/{ticket_id}
   mkdir -p /Users/user/aladdin/worktrees/{ticket_id}
   for repo in {affected_repos}; do
     cd /Users/user/aladdin/$repo && git fetch origin pro --quiet
     git worktree add /Users/user/aladdin/worktrees/{ticket_id}/$repo -b landon/{ticket_id} origin/pro 2>/dev/null \
       || git worktree add /Users/user/aladdin/worktrees/{ticket_id}/$repo landon/{ticket_id}
   done
   # 不在 affected_repos 中的主 repo 用 symlink
   for repo in agrabah abu lago rajah; do
     if [ ! -d "/Users/user/aladdin/worktrees/{ticket_id}/$repo" ]; then
       ln -sfn /Users/user/aladdin/$repo /Users/user/aladdin/worktrees/{ticket_id}/$repo
     fi
   done
   # 共用庫 symlink
   for shared in jasmine genie jafar; do
     ln -sfn /Users/user/aladdin/$shared /Users/user/aladdin/worktrees/{ticket_id}/$shared
   done
   ```
2. 驗證 affected_repos 的 sub-worktree 都在 `landon/{ticket_id}`：
   ```bash
   for repo in {affected_repos}; do
     git -C /Users/user/aladdin/worktrees/{ticket_id}/$repo branch --show-current
   done
   ```
3. Re-dispatch Bug Fixer. If still failing, go to Pipeline Failure.

---

### Step 6: Env Preparer

Create a sub agent using the prompt at `/Users/user/aladdin/.claude/agents/env-preparer.md`:

```
prompt:
Use all text in {/Users/user/aladdin/.claude/agents/env-preparer.md} as the prompt. Please analyze the bug fix changes, collect mock data from dev DB, and write the test description document.
ticket_id: {ticket_id}
worktree_path: /Users/user/aladdin/worktrees/{ticket_id}
affected_repos: {affected_repos}
```

**Wait for completion.**

Read `/Users/user/aladdin/obsidian/Debug/{ticket_id}/{ticket_id}-prepare-test-desc.md`.

Extract:
- `backend_has_changes` (true / false)
- `frontend_has_changes` (true / false)

---

### Step 7: Evaluators (Conditional Parallel Dispatch)

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
affected_repos: {affected_repos}
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
affected_repos: {affected_repos}
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


---

### Step 8: Test Validator

Create a sub agent using the prompt at `/Users/user/aladdin/.claude/agents/test-validator.md`:

```
prompt:
Use all text in {/Users/user/aladdin/.claude/agents/test-validator.md} as the prompt. Please validate the test coverage against the test description.
ticket_id: {ticket_id}
worktree_path: /Users/user/aladdin/worktrees/{ticket_id}
affected_repos: {affected_repos}
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
affected_repos: {affected_repos}
test description path: /Users/user/aladdin/obsidian/Debug/{ticket_id}/{ticket_id}-prepare-test-desc.md
validation feedback: /Users/user/aladdin/obsidian/Debug/{ticket_id}/{ticket_id}-validation-report.md

Read the validation feedback carefully and add test cases to address the identified gaps.
```

(Re-dispatch frontend-evaluator with same structure if frontend gaps exist.)

Wait for completion, then **return to Step 8**.

**If validator_attempt_count reaches 2:** Go to Pipeline Failure.

---

### Step 9: Drive Uploader（成功路徑）

Create a sub agent using the prompt at `/Users/user/aladdin/.claude/agents/drive-uploader.md`:

```
prompt:
Use all text in {/Users/user/aladdin/.claude/agents/drive-uploader.md} as the prompt. Please compile the solution document, upload to Google Drive, and comment on Notion.
ticket_id: {ticket_id}
Notion URL: {Notion URL from $ARGUMENTS}
worktree_path: /Users/user/aladdin/worktrees/{ticket_id}
affected_repos: {affected_repos}
pipeline_status: success
```

**Wait for completion.**

drive-uploader 會根據 `pipeline_status` 將 Notion「AI分析」欄位更新為「分析成功」。

---

### Step 10: Completion Report

```
## {ticket_id} Analysis Complete

- Bug Tracer attempts: {tracer_attempt_count}
- Bug Fixer attempts: {fixer_attempt_count}
- Total attempts: {total_attempt_count}
- Backend changes: {backend_has_changes} → {backend_eval_result}
- Frontend changes: {frontend_has_changes} → {frontend_eval_result}
- Test Validator: passed (attempt {validator_attempt_count + 1})
- Google Drive: {share link}
- Notion comment: completed / failed
- Worktree root: /Users/user/aladdin/worktrees/{ticket_id} (affected_repos: {affected_repos} 為 git worktree on landon/{ticket_id}，其餘為 symlink)

Documents at: /Users/user/aladdin/obsidian/Debug/{ticket_id}/
```

> **重要：呼叫端控制權交還規則**
>
> 若本次呼叫來自 `/analyze-bugs` batch 流程（或任何外層迴圈 skill），完成本步驟後**必須立即返回外層 Step 4c 繼續迴圈**（release lock → 標記 done → 計數 +1 → 回到 4a 處理下一張單），不可在此停止或等待使用者指令。本 Completion Report 僅是單張單的階段性回報，不是整個 batch 的終點。

---

### Pipeline Failure

無論失敗發生在哪個步驟，都必須透過 drive-uploader 統一同步狀態至 Notion（留下失敗留言、並更新「AI分析」欄位為「分析失敗」）。**失敗路徑不上傳任何文件、不建立 Drive 資料夾。**

Create a sub agent using the prompt at `/Users/user/aladdin/.claude/agents/drive-uploader.md`:

```
prompt:
Use all text in {/Users/user/aladdin/.claude/agents/drive-uploader.md} as the prompt. The pipeline has failed. Do NOT upload any files or create any Drive folder. Only post a failure comment on Notion and update the Notion "AI分析" property to "分析失敗".
ticket_id: {ticket_id}
Notion URL: {Notion URL from $ARGUMENTS}
worktree_path: /Users/user/aladdin/worktrees/{ticket_id}
affected_repos: {affected_repos}
pipeline_status: failed
failure_reason: {最後一次 evaluator / tracer / fixer 退回理由摘要}
tracer_attempt_count: {tracer_attempt_count}
fixer_attempt_count: {fixer_attempt_count}
total_attempt_count: {total_attempt_count}
backend_eval_result: {backend_eval_result}
frontend_eval_result: {frontend_eval_result}
```

**Wait for completion.** 即使 drive-uploader 內部部分步驟失敗（例如 solution.md 無法產出），它仍須嘗試更新 Notion 狀態為「分析失敗」。

Report:

```
{ticket_id} pipeline 失敗，需要人工介入。
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

> **重要：呼叫端控制權交還規則**
>
> 若本次呼叫來自 `/analyze-bugs` batch 流程（或任何外層迴圈 skill），即使本張單以失敗收尾，也**必須立即返回外層 Step 4d 繼續迴圈**（release lock → 標記 failed → 計數 +1 → 回到 4a 處理下一張單），不可在此停止或等待使用者指令。
