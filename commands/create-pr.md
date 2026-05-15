---
description: For 洋蔥 assigned tickets only. Analyzes, traces root cause (with mandatory method-call-graph evidence), fixes code + writes pure L0 unit tests in worktree (base = origin/dev), reviews via single solution-reviewer, then pushes branch and opens PR against dev. Skips ticket if not assigned to 洋蔥.
argument-hint: "<NotionURL> [ticket_id]"
---

# /create-pr Pipeline (Analyze + Fix + Tests + PR)

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
assignee_check_passed = false
tracer_attempt_count = 0
fixer_attempt_count = 0
reviewer_attempt_count = 0
total_attempt_count = 0
review_result = ""            # PASSED / FAILED
pipeline_status = ""          # success / already_fixed / i18n_manual_handoff / failed
drive_link = ""
pr_links = []
affected_repos = []
worktree_path = ""            # set to /Users/user/aladdin/worktrees/{ticket_id} after Step 4
```

---

## Execution Flow

### Step 0: Parse Arguments

Extract NotionURL and ticket_id from `$ARGUMENTS`. Extract page_id from the Notion URL (32-char hex after last `-` or `/`), convert to UUID format (8-4-4-4-12).

---

### Step 0.5: Assignee Pre-check（洋蔥過濾）

**Manager 自跑 curl Notion,不派 sub agent**：

```bash
ASSIGNEES=$(curl -s -H "Authorization: Bearer ***REMOVED-NOTION-TOKEN***" \
  -H "Notion-Version: 2022-06-28" \
  "https://api.notion.com/v1/pages/{page_id}" \
  | jq -r '.properties["當前指派"].people[].name')

if ! echo "$ASSIGNEES" | grep -q "洋蔥"; then
  echo "SKIPPED: ticket {ticket_id} not assigned to 洋蔥 (assignees: $ASSIGNEES)"
  exit 0
fi

assignee_check_passed=true
```

未命中「洋蔥」→ 直接結束指令,**不留 Notion 留言、不更新 AI分析 欄位、不啟動任何 sub agent**（避免污染他人單據）。

命中「洋蔥」→ 設 `assignee_check_passed = true`,繼續 Step 1。

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

### Step 3: Bug Tracer (with method-call-graph)

**Increment tracer_attempt_count. Increment total_attempt_count.**

Create a sub agent using the prompt at `/Users/user/aladdin/.claude/agents/bug-tracer-with-callgraph.md`:

**First dispatch (tracer_attempt_count == 1):**

```
prompt:
Use all text in {/Users/user/aladdin/.claude/agents/bug-tracer-with-callgraph.md} as the prompt. Please analyze the bug, trace the root cause through the codebase, and write a detailed analysis document.
analytics document path: /Users/user/aladdin/obsidian/Debug/{ticket_id}/{ticket_id}-analytics.md
spec document path: /Users/user/aladdin/obsidian/Debug/{ticket_id}/{ticket_id}-spec.md
ticket_id: {ticket_id}
```

**Re-dispatch after reviewer rejection (tracer_attempt_count > 1):**

```
prompt:
Use all text in {/Users/user/aladdin/.claude/agents/bug-tracer-with-callgraph.md} as the prompt. Your previous analysis was rejected. Please re-analyze.
analytics document path: /Users/user/aladdin/obsidian/Debug/{ticket_id}/{ticket_id}-analytics.md
spec document path: /Users/user/aladdin/obsidian/Debug/{ticket_id}/{ticket_id}-spec.md
reviewer feedback: /Users/user/aladdin/obsidian/Debug/{ticket_id}/{ticket_id}-reviewer-report.md
ticket_id: {ticket_id}
```

**Wait for completion.**

Read analysis-notes.md：

- 若 bug 確認已修復（有「已修復紀錄」section + commit hash） → 設 `pipeline_status = already_fixed`,從 analysis-notes.md「已修復紀錄」段抽取 commit hash 存為 `fixed_commit`（給 Step 7c Notion 留言用）,跳過 Steps 4-6,直接進 Step 7（**只跑 7a drive-uploader-pr,不跑 7b pr-pusher**)

#### Check primary_fix_paths — i18n Manual Handoff Detection

從 analysis-notes.md 解析 `primary_fix_paths` YAML block。若**所有** `file` 都符合 `localizations/.*\.json$` pattern：

- 設定 `pipeline_status = i18n_manual_handoff`
- 跳過 Steps 4-6（不建 worktree、不派 Fixer / Reviewer）
- 直接進 Step 7（**只跑 7a drive-uploader-pr,不跑 7b pr-pusher**),傳入 `pipeline_status: i18n_manual_handoff` 並附 primary_fix_paths 解析後的 i18n key 清單

若 primary_fix_paths 為混合（部分 i18n、部分 code）：保持正常流程,但在 Step 5 Bug Fixer dispatch prompt 中明示「i18n JSON 路徑禁止寫入,僅修 code 部分」,並要求 Fixer 把 i18n key 清單寫入 `{ticket_id}-i18n-keys-to-import.md`。

#### Extract affected_repos

從 analysis-notes.md 的「修復策略」section 中，掃描所有修改檔案路徑的前綴，提取涉及的 repo 集合：

- 路徑以 `agrabah/` 開頭 → `agrabah`
- 路徑以 `abu/` 開頭 → `abu`
- 路徑以 `lago/` 開頭 → `lago`
- 路徑以 `rajah/` 開頭 → `rajah`

Store as: `affected_repos`（例如 `["agrabah"]` 或 `["agrabah", "rajah"]`）

若解析不出任何 repo（tracer 分析完整但修復策略未涉及任何 code repo — 例如純文件修改或框架層說明），則 `affected_repos` 為空，Step 4 的 worktree 建立仍會執行（全部用 symlink），bootstrap 會在主工作區的 rajah 上跑。

---

### Step 4: Create Worktrees (按需建立 + symlink 補齊)

只為 `affected_repos` 中的 repo 建立真正的 git worktree（隔離環境），其餘 repo 用 symlink 指回主工作區。所有 7 個目錄（4 主 repo + 3 共用庫）都會出現在 per-ticket 根目錄下，確保 `rajah/bootstrap.sh` 與 `generate-*.sh` 內的相對路徑（`../agrabah`、`../abu`、`../lago`、`../jasmine` 等）在任何情境下都能正確解析。

**目標結構（以 affected_repos = ["agrabah"] 為例）：**
```
/Users/user/aladdin/worktrees/{ticket_id}/
├── agrabah   (git worktree, branch landon/{ticket_id}, base origin/dev)
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
  cd /Users/user/aladdin/$repo && git fetch origin dev --quiet
  git worktree add /Users/user/aladdin/worktrees/{ticket_id}/$repo -b landon/{ticket_id} origin/dev 2>/dev/null \
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

### Step 5: Bug Fixer With Tests

**Increment fixer_attempt_count. Increment total_attempt_count.**

**Check hard cap: if total_attempt_count > 5, go to Pipeline Failure.**

Create a sub agent using the prompt at `/Users/user/aladdin/.claude/agents/bug-fixer-with-tests.md`:

**First dispatch:**

```
prompt:
Use all text in {/Users/user/aladdin/.claude/agents/bug-fixer-with-tests.md} as the prompt. Please read the analysis notes and implement the code fix in the worktree.
analysis notes path: /Users/user/aladdin/obsidian/Debug/{ticket_id}/{ticket_id}-analysis-notes.md
analytics document path: /Users/user/aladdin/obsidian/Debug/{ticket_id}/{ticket_id}-analytics.md
worktree_path: /Users/user/aladdin/worktrees/{ticket_id}
affected_repos: {affected_repos}
ticket_id: {ticket_id}
```

**Re-dispatch after reviewer rejection:**

```
prompt:
Use all text in {/Users/user/aladdin/.claude/agents/bug-fixer-with-tests.md} as the prompt. The previous implementation failed tests. Please fix the issues based on reviewer feedback.
analysis notes path: /Users/user/aladdin/obsidian/Debug/{ticket_id}/{ticket_id}-analysis-notes.md
analytics document path: /Users/user/aladdin/obsidian/Debug/{ticket_id}/{ticket_id}-analytics.md
reviewer feedback: /Users/user/aladdin/obsidian/Debug/{ticket_id}/{ticket_id}-reviewer-report.md
worktree_path: /Users/user/aladdin/worktrees/{ticket_id}
affected_repos: {affected_repos}
ticket_id: {ticket_id}

Read the reviewer feedback carefully, modify the code on the same branch, and commit a new fix.
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
     cd /Users/user/aladdin/$repo && git fetch origin dev --quiet
     git worktree add /Users/user/aladdin/worktrees/{ticket_id}/$repo -b landon/{ticket_id} origin/dev 2>/dev/null \
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

### Step 6: Solution Reviewer

**Increment reviewer_attempt_count.**

Create a sub agent using the prompt at `/Users/user/aladdin/.claude/agents/solution-reviewer.md`：

```
prompt:
Use all text in {/Users/user/aladdin/.claude/agents/solution-reviewer.md} as the prompt. Please verify the fix and tests across 5 dimensions and produce the reviewer report.
ticket_id: {ticket_id}
worktree_path: /Users/user/aladdin/worktrees/{ticket_id}
affected_repos: {affected_repos}
analysis_notes: /Users/user/aladdin/obsidian/Debug/{ticket_id}/{ticket_id}-analysis-notes.md

When done, output your final result on the last line:
REVIEW_RESULT: PASSED
or
REVIEW_RESULT: FAILED
```

**Wait for completion.**

Read `/Users/user/aladdin/obsidian/Debug/{ticket_id}/{ticket_id}-reviewer-report.md`,extract `REVIEW_RESULT`。

#### Decision Matrix

| review_result | Action |
|---|---|
| PASSED | Set `pipeline_status = success`,proceed to Step 7 |
| FAILED | If `fixer_attempt_count < 3` AND `total_attempt_count ≤ 5` → return to Step 5（re-dispatch bug-fixer-with-tests with reviewer feedback；Step 5 entry 會負責 increment counts,本表不重複加）. If `fixer_attempt_count ≥ 3` OR `total_attempt_count > 5` → Pipeline Failure. |

---

### Step 7a: Drive Uploader PR

Create a sub agent using the prompt at `/Users/user/aladdin/.claude/agents/drive-uploader-pr.md`：

```
prompt:
Use all text in {/Users/user/aladdin/.claude/agents/drive-uploader-pr.md} as the prompt. Please compile the solution document, upload to Google Drive, and return the Drive link.
ticket_id: {ticket_id}
Notion URL: {Notion URL from $ARGUMENTS}
worktree_path: /Users/user/aladdin/worktrees/{ticket_id}
affected_repos: {affected_repos}
pipeline_status: {pipeline_status}
i18n_keys: {若 pipeline_status == i18n_manual_handoff,傳入 key 清單,否則 N/A}
```

**Wait for completion.** 從輸出最後一行抽 `DRIVE_LINK: <url>`,存到 `drive_link`。

failed 路徑 → drive-uploader-pr 會回傳 `DRIVE_LINK: N/A`。

### Step 7b: PR Pusher（僅 pipeline_status == success）

**只有 `pipeline_status == success` 才執行本步驟。** already_fixed / i18n_manual_handoff / failed 路徑：完成 Step 7a 後**跳過本步驟**,直接進 Step 7c 由 manager 自處 Notion。

從 `/Users/user/aladdin/obsidian/Debug/{ticket_id}/{ticket_id}-analytics.md` 的「Bug 描述 / 標題」段抽取一句話 `bug_summary`（≤ 60 字,用於 PR title）。若該段超過 60 字,取第一句並改寫為動詞開頭簡潔描述。範例：「修復商城兌換點數時餘額顯示舊值的問題」。

Create a sub agent using the prompt at `/Users/user/aladdin/.claude/agents/pr-pusher.md`：

```
prompt:
Use all text in {/Users/user/aladdin/.claude/agents/pr-pusher.md} as the prompt. Please push the worktree branch to origin, create a PR against dev, post a Notion comment with the Drive + PR links, and update the AI分析 field to 分析成功.
ticket_id: {ticket_id}
page_id: {page_id}
worktree_path: /Users/user/aladdin/worktrees/{ticket_id}
affected_repos: {affected_repos}
drive_link: {drive_link}
bug_summary: {bug_summary}
solution_md_path: /Users/user/aladdin/obsidian/Debug/{ticket_id}/{ticket_id}-solution.md
```

**Wait for completion.** 抽 `PR_LINKS: [...]` 存到 `pr_links`,並從報告確認 `NOTION_AI_FIELD: ok`。

### Step 7c: Manager Notion Writeback（非 success 路徑）

僅在 `pipeline_status ∈ {already_fixed, i18n_manual_handoff, failed}` 執行。

**Manager 直接 curl Notion**,不派 sub agent。

#### already_fixed

```bash
curl -s -X POST "https://api.notion.com/v1/comments" \
  -H "Authorization: Bearer ***REMOVED-NOTION-TOKEN***" \
  -H "Notion-Version: 2022-06-28" \
  -H "Content-Type: application/json" \
  -d "{
    \"parent\": {\"page_id\": \"{page_id}\"},
    \"rich_text\": [
      {\"type\": \"text\", \"text\": {\"content\": \"AI 分析完成。Tracer 確認此 bug 已於 commit {fixed_commit} 修復,無需再發 PR。\\n分析報告：\"}},
      {\"type\": \"text\", \"text\": {\"content\": \"{drive_link}\", \"link\": {\"url\": \"{drive_link}\"}}}
    ]
  }"

curl -s -X PATCH "https://api.notion.com/v1/pages/{page_id}" \
  -H "Authorization: Bearer ***REMOVED-NOTION-TOKEN***" \
  -H "Notion-Version: 2022-06-28" \
  -H "Content-Type: application/json" \
  -d '{"properties": {"AI分析": {"select": {"name": "分析成功"}}}}'
```

#### i18n_manual_handoff

```bash
curl -s -X POST "https://api.notion.com/v1/comments" \
  -H "Authorization: Bearer ***REMOVED-NOTION-TOKEN***" \
  -H "Notion-Version: 2022-06-28" \
  -H "Content-Type: application/json" \
  -d "{
    \"parent\": {\"page_id\": \"{page_id}\"},
    \"rich_text\": [
      {\"type\": \"text\", \"text\": {\"content\": \"AI 分析完成。主因為 i18n 翻譯缺失/錯誤,依專案規範 AI 不主動修 localizations JSON。\\n請開發者參考 i18n keys 清單從 Google Sheets 匯入：\\n\"}},
      {\"type\": \"text\", \"text\": {\"content\": \"{drive_link}\", \"link\": {\"url\": \"{drive_link}\"}}}
    ]
  }"

curl -s -X PATCH "https://api.notion.com/v1/pages/{page_id}" \
  -H "Authorization: Bearer ***REMOVED-NOTION-TOKEN***" \
  -H "Notion-Version: 2022-06-28" \
  -H "Content-Type: application/json" \
  -d '{"properties": {"AI分析": {"select": {"name": "分析成功"}}}}'
```

#### failed

**`{failure_reason}` 由 manager 在進入 Step 7c 前準備**：從最後一次 reviewer/tracer/fixer 退回報告抽 5-10 行摘要,字面替換進下方 curl payload。`{review_result}` 由 Step 6 結果直接代入；若 reviewer 未跑（tracer 階段就失敗）則填 `N/A`。

```bash
curl -s -X POST "https://api.notion.com/v1/comments" \
  -H "Authorization: Bearer ***REMOVED-NOTION-TOKEN***" \
  -H "Notion-Version: 2022-06-28" \
  -H "Content-Type: application/json" \
  -d "{
    \"parent\": {\"page_id\": \"{page_id}\"},
    \"rich_text\": [
      {\"type\": \"text\", \"text\": {\"content\": \"AI 分析失敗,需人工介入。\\n失敗原因：{failure_reason}\\nTracer 嘗試：{tracer_attempt_count} 次,Fixer 嘗試：{fixer_attempt_count} 次（總 {total_attempt_count}）\\nReviewer 結果：{review_result}\"}}
    ]
  }"

curl -s -X PATCH "https://api.notion.com/v1/pages/{page_id}" \
  -H "Authorization: Bearer ***REMOVED-NOTION-TOKEN***" \
  -H "Notion-Version: 2022-06-28" \
  -H "Content-Type: application/json" \
  -d '{"properties": {"AI分析": {"select": {"name": "分析失敗"}}}}'
```

---

### Step 8: Completion Report

```
## {ticket_id} /create-pr Pipeline Complete

- Assignee check: PASSED (洋蔥 在當前指派)
- Pipeline status: {pipeline_status}
- Bug Tracer (with call-graph) attempts: {tracer_attempt_count}
- Bug Fixer (with tests) attempts: {fixer_attempt_count}
- Solution Reviewer: {review_result} at attempt {reviewer_attempt_count}
- Total attempts: {total_attempt_count}
- Google Drive: {drive_link}
- PR(s):
{對每個 affected_repo 列一行 "- {repo}: {pr_url}",若 pipeline_status != success 則整段顯示 "(N/A - {pipeline_status})"}
- Notion comment: completed
- Notion AI分析: {分析成功 / 分析失敗}
- Worktree root: /Users/user/aladdin/worktrees/{ticket_id} (affected_repos: {affected_repos} 為 git worktree on landon/{ticket_id}，其餘為 symlink)

Documents at: /Users/user/aladdin/obsidian/Debug/{ticket_id}/
```

> **注意**：本指令為單張單 pipeline,完成後直接結束,不需要返回任何外層迴圈（與 /analyze-single-bug 的 batch flow 不相關）。

---

### Pipeline Failure

任何步驟失敗（tracer / fixer / reviewer / drive-uploader-pr）超過重試上限,設定 `pipeline_status = failed`,跳過 Step 7b（pr-pusher）,進 Step 7c 由 manager 直接 curl Notion 留失敗訊息 + 「AI分析」=「分析失敗」。

**失敗路徑不上傳 Drive 文件、不開 PR、不留成功留言。**

完成 Step 7c 後輸出：

```
{ticket_id} pipeline 失敗,需要人工介入。
- Bug Tracer 嘗試：{tracer_attempt_count} 次
- Bug Fixer 嘗試：{fixer_attempt_count} 次
- 總嘗試：{total_attempt_count} 次
- Reviewer 結果：{review_result}
- 失敗原因：{最後一次 reviewer / tracer / fixer 退回理由摘要}
- Worktree 保留在：/Users/user/aladdin/worktrees/{ticket_id}
- 文件位於：/Users/user/aladdin/obsidian/Debug/{ticket_id}/
```
