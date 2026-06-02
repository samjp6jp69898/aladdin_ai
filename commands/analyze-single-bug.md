---
description: V6 pipeline — pre-check fast-path (73% 命中) → complexity routing → simple (fix-planner) 或 critical (bug-tracer + fixer-with-tests) → reviewer → drive-uploader. 不跑 spec-fetcher / env-preparer / evaluator / test-validator（V5/V5-Lite 已驗證可砍）。
argument-hint: "<NotionURL> [ticket_id] [--force-critical|--force-simple]"
---

# Bug Analysis Pipeline (V6 — pre-check + complexity routing)

You are the pipeline manager responsible for dispatching engineers. Your role is to sequentially dispatch sub agents to complete the bug analysis pipeline. **You do not read any Notion content or code yourself** — you only manage pipeline state and coordinate agents.

**Always use the specified prompt document to create the corresponding sub agent.**

## Parameters

`$ARGUMENTS` format: `/analyze-single-bug <NotionURL> [ticket_id] [--force-critical|--force-simple]`

- **NotionURL** (required): The Notion URL of the bug ticket
- **ticket_id** (optional): e.g. `FAQ-1702`; if not provided, parsed by Bug Report Analyst
- **--force-critical** / **--force-simple** (optional): override Step 3 complexity routing

---

## State Variables

```
ticket_id = ""
page_id = ""                  # UUID format (8-4-4-4-12), extracted from Notion URL
pre_check_verdict = ""        # "ALREADY_FIXED_HIGH" | "ALREADY_FIXED_MEDIUM" | "PRESS_ON"
pre_check_evidence = ""       # commit hash / repo / merge-base 結果 / 文字摘要
complexity = ""               # "simple" | "critical"
affected_repos = []           # parsed from analyst / fix-planner / tracer 輸出
pipeline_status = ""          # success | already_fixed | failed | i18n_manual_handoff | needs_qa_clarification
grounding_result = ""         # CONSISTENT | NEEDS_QA_CLARIFICATION
qa_question = ""              # grounder 或 tracer 給 QA 的詳細待確認問題
tracer_attempt_count = 0      # 僅 critical 路徑用
fixer_attempt_count = 0       # 僅 critical 路徑用
total_attempt_count = 0
```

---

## Execution Flow

### Step 0: Parse Arguments

Extract NotionURL, ticket_id, force-flag from `$ARGUMENTS`. Extract page_id from the Notion URL (32-char hex after last `-` or `/`), convert to UUID format (8-4-4-4-12).

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

### Step 2: Pre-Check (V6 核心 — fast-path 命中率 73%)

Dispatch a general-purpose sub-agent with the following inline prompt (no separate agent file needed):

```
prompt:
你是 V6 pipeline 的 pre-check sub-agent。判定 {ticket_id} 是否已在 origin/dev 修復、或需要 PRESS_ON 進入 fix 階段。

## 你的任務

對 5 個 repo（agrabah, abu, lago, rajah, genie）跑下列流程，最多 3 階段。

### Step 2a: Ticket-id grep（所有 repo 並行）

對每個 repo 在 /Users/user/aladdin/{repo}/ 下跑：
```bash
git -C /Users/user/aladdin/{repo} log --all --oneline -i -E \
  --grep='FAQ[-_ ]?{ticket_num}' \
  --grep='(^|[^0-9]){ticket_num}([^0-9]|$)'
```
({ticket_num} = ticket id 去掉 FAQ- 前綴，例如 "1702")

### Step 2b: 對命中 commit 驗證

對每個命中 commit：
```bash
git -C /Users/user/aladdin/{repo} show {commit} --stat
git -C /Users/user/aladdin/{repo} merge-base --is-ancestor {commit} origin/dev; echo $?
git -C /Users/user/aladdin/{repo} branch -r --contains {commit} | head -10
```

判定（依嚴格度）：
- **ALREADY_FIXED HIGH**：commit message 帶 ticket id + merge-base exit 0（IN DEV）+ 修改檔與 ticket 描述對應 + 落地分支含 origin/dev / origin/pro（非 mr/exp-*、landon/*、exp/*、mr/FAQ-*）
- **ALREADY_FIXED MEDIUM**：commit 在 dev 但與 analytics.md 提案的 fix 路徑有語意差異（不同 enum / 不同檔等）
- **ALREADY_FIXED LOW**：commit 帶 ticket id 但 merge-base exit 非 0（只在 experiment / MR branch）
- **PRESS_ON**：5 repo 全部 0 命中，或所有命中都是 LOW

### Step 2c: Commit-message-fallback（僅當 Step 2a 全 5 repo 0 命中時跑）

實際 commit 可能不帶 ticket id（例如 `feat(agent): 換線規則調整`）。兜底策略：

1. 讀 ticket 報案日（從 analytics.md 或 stage1 ticket info）
2. 抓 ticket 報案日起 +30 天範圍內，5 個 repo 的版本 tag list：
   ```bash
   git -C /Users/user/aladdin/{repo} tag --sort=creatordate --merged origin/dev | awk -v from="{report_date}" '$0 >= from'
   ```
3. 從 analytics.md / spec.md / peer-review.md 抓 ticket 描述提到的關鍵檔案（例如 `inventory_manager.ts`、`Personal.vue`），對每個檔案跑：
   ```bash
   git -C /Users/user/aladdin/{repo} log --oneline {first_tag}..{last_tag} -- {path/to/file}
   ```
4. 對候選 commit 跑 `git show {commit} --stat` + diff inspection，驗證 diff 邏輯是否對應 ticket 描述的症狀
5. 若有匹配 commit 且在 origin/dev → 升級為 **ALREADY_FIXED MEDIUM**（commit-message-fallback 命中信心一律 MEDIUM，不給 HIGH）
6. 若找不到匹配 commit → 維持 **PRESS_ON**

### Step 3: 寫產出

寫到 /Users/user/aladdin/obsidian/Debug/{ticket_id}/{ticket_id}-pre-check.md：

```
# Pre-check — {ticket_id}

## VERDICT: ALREADY_FIXED HIGH / MEDIUM / LOW / PRESS_ON

## 證據
- Repo: ...
- Commit hash: ...
- Commit message: ...
- merge-base check: IN DEV / NOT IN DEV
- Refs containing: origin/dev / origin/pro / mr/exp-* ...
- 修改檔: ...
- 與 ticket 對應: YES / PARTIAL / NO

## 與 analytics 提案的差異（MEDIUM only）
...

## Commit-message-fallback（如有跑 Step 2c）
- 候選 tag range: ...
- 掃過的關鍵檔案: ...
- 命中候選 commit: ...
```

紀律：
- **禁止**：建 worktree、commit、push、修改 source code、跑 lint/test/build
- **允許**：read-only git（log / show / merge-base / branch -r / tag）+ Read + Bash + Write {ticket_id}-pre-check.md
- 預算：~3-5 分鐘 / 10-20 次工具呼叫

回最後三行：
PRE_CHECK_VERDICT: ALREADY_FIXED_HIGH / ALREADY_FIXED_MEDIUM / PRESS_ON
PRE_CHECK_COMMITS: {repo}:{hash} | {repo}:{hash}（命中 commit 清單，PRESS_ON 時為 NONE）
PRE_CHECK_AFFECTED_REPOS: [list]（從命中 commit 改的檔提取的 repo list，PRESS_ON 時為 []）
```

**Wait for completion.** 解析三個輸出：
- `pre_check_verdict`
- `pre_check_evidence`（從 pre-check.md 讀）
- `affected_repos`（若 pre-check 已抓到）

#### Pre-check Fast-Path 分流

| pre_check_verdict | 下一步 |
|---|---|
| `ALREADY_FIXED_HIGH` | **跳到 Step 7 Drive Uploader**，`pipeline_status = already_fixed` |
| `ALREADY_FIXED_MEDIUM` | 進 Step 3 complexity routing；後續 fix-planner / tracer 須再驗證 commit 是否真的對應 ticket |
| `PRESS_ON` | 進 Step 3 complexity routing |

---

### Step 2.5: CQA Grounder（實證 grounding + 早停）

**僅當 `pre_check_verdict != ALREADY_FIXED_HIGH` 時執行**（已修復的單不需 grounding）。

Create a sub agent using the prompt at `/Users/user/aladdin/.claude/agents/cqa-grounder.md`:

```
prompt:
Use all text in {/Users/user/aladdin/.claude/agents/cqa-grounder.md} as the prompt. Please ground the bug against CQA real data and judge ticket-vs-reality discrepancy.
ticket_id: {ticket_id}
analytics document path: /Users/user/aladdin/obsidian/Debug/{ticket_id}/{ticket_id}-analytics.md
spec document path: /Users/user/aladdin/obsidian/Debug/{ticket_id}/{ticket_id}-spec.md
```

**Wait for completion.** 從 grounder 回傳輸出的最後兩行抽 `GROUNDING_RESULT` 與 `QA_QUESTION`（亦附在 `{ticket_id}-grounding.md` 檔末），存入 `grounding_result` / `qa_question`。

- 若 `grounding_result == NEEDS_QA_CLARIFICATION` → 設 `pipeline_status = needs_qa_clarification`，**跳過 Steps 3–6**，直接進 Step 7 Drive Uploader（傳 `pipeline_status = needs_qa_clarification` + `qa_question`），上傳 grounding 文件 + Notion 留言問 QA + AI分析=待釐清。
- 否則續跑 Step 3；Step 4a fix-planner 與 Step 4b tracer 的 dispatch prompt 各加一行：`grounding document path: /Users/user/aladdin/obsidian/Debug/{ticket_id}/{ticket_id}-grounding.md`。
- grounder 整個失敗 / 未產出 grounding.md → graceful degradation：當作 CONSISTENT，續跑 Step 3。

---

### Step 3: Complexity Routing

判定 `complexity`：

**Force-flag**：若 `$ARGUMENTS` 含 `--force-critical` → `complexity = critical`；含 `--force-simple` → `complexity = simple`。

**Heuristic（任一成立則 critical）**：
- `affected_repos` 含 agrabah **且** 至少另一 repo（跨 server）
- analyst 輸出 ticket 描述含「資料庫 / migration / schema / DB / RPC / cross-server / 跨服務 / transaction / 死鎖」關鍵字
- analyst 標 `severity = high`（從 bug-report-analyst 的輸出讀）
- pre_check 為 `ALREADY_FIXED_MEDIUM` 且有語意差異需要 deep verification

否則 `complexity = simple`（多數 ticket，包含純前端 / i18n / 單檔 / 簡單後端邏輯）。

---

### Step 4: 路徑分歧

#### Step 4a: Fix-planner（simple 路徑）

只跑 simple 或 ALREADY_FIXED_MEDIUM 路徑。Dispatch general-purpose sub-agent inline：

```
prompt:
你是 V6 pipeline 的 fix-planner sub-agent。為 {ticket_id} 提一份 fix 計畫（**不建 worktree、不 commit、純文字計畫**）。

## 你的任務

### Step 1: 讀背景
讀（如有）：
- /Users/user/aladdin/obsidian/Debug/{ticket_id}/{ticket_id}-analytics.md
- /Users/user/aladdin/obsidian/Debug/{ticket_id}/{ticket_id}-spec.md
- /Users/user/aladdin/obsidian/Debug/{ticket_id}/{ticket_id}-solution.md
- /Users/user/aladdin/obsidian/Debug/{ticket_id}/{ticket_id}-peer-review.md
- /Users/user/aladdin/obsidian/Debug/{ticket_id}/{ticket_id}-pre-check.md
- /Users/user/aladdin/obsidian/Debug/{ticket_id}/{ticket_id}-analysis.md（如有）

### Step 2: 對 ALREADY_FIXED_MEDIUM 做 deep verification（若 pre-check verdict = MEDIUM）
比對 pre-check 抓到的 commit diff 與 analytics 提案的 fix 路徑：
- 若 commit 實際修法（即使檔案 / enum 不同）能消除 ticket 描述的症狀 → 升級為「等效替代解 = 已修復」
- 若 commit 沒覆蓋全部 ticket 症狀 → partial fix，標 PRESS_ON 並提補丁計畫
- 若 commit 完全不對應 → 標 PRESS_ON 並提完整 fix 計畫

### Step 3: 提 fix 計畫（PRESS_ON / partial 路徑）
寫到 /Users/user/aladdin/obsidian/Debug/{ticket_id}/{ticket_id}-fix-plan.md：

```
# Fix Plan — {ticket_id}

## VERDICT
PRESS_ON / PARTIAL_FIX_NEEDED / ALREADY_FIXED_EQUIVALENT

## Affected Repos
[list]

## Fix Plan（按檔案）
### File 1: {repo}/{path/to/file}:{line range}
- 改動方向: ...
- 邏輯: ...

### File 2: ...
...

## Predicted Impact
- 解決的症狀: ...
- 潛在 regression: ...

## Reviewer 給的線索（給 Step 5 reviewer 用）
- 方向是否對齊 ticket 描述？
- 漏修風險點？
```

## 紀律約束

- **禁止**：建 worktree、commit、push、修改 source code、跑 lint/test/build
- **允許**：Read + Bash（read-only git）+ Write {ticket_id}-fix-plan.md
- 預算：~5-8 分鐘 / 20-30 次工具呼叫

回最後三行：
FIX_PLANNER_VERDICT: PRESS_ON / PARTIAL_FIX_NEEDED / ALREADY_FIXED_EQUIVALENT
FIX_PLANNER_AFFECTED_REPOS: [list]
FIX_PLANNER_FILES_COUNT: {n}（fix-plan.md 內提到要改幾個檔）
```

**Wait for completion.** 解析輸出。

**分流**：
- `FIX_PLANNER_VERDICT = ALREADY_FIXED_EQUIVALENT` → 跳到 Step 7，`pipeline_status = already_fixed`
- `FIX_PLANNER_VERDICT = PRESS_ON / PARTIAL_FIX_NEEDED` → 進 Step 6 reviewer（**不建 worktree、不 commit**；fix-plan 為純文字交付）

#### Step 4b: Bug Tracer（critical 路徑）

只跑 critical 路徑。**Increment tracer_attempt_count + total_attempt_count.**

Create a sub agent using the prompt at `/Users/user/aladdin/.claude/agents/bug-tracer.md`:

```
prompt:
Use all text in {/Users/user/aladdin/.claude/agents/bug-tracer.md} as the prompt. Please analyze the bug, trace the root cause through the codebase, and write a detailed analysis document.
analytics document path: /Users/user/aladdin/obsidian/Debug/{ticket_id}/{ticket_id}-analytics.md
spec document path: /Users/user/aladdin/obsidian/Debug/{ticket_id}/{ticket_id}-spec.md
ticket_id: {ticket_id}

⚠️ V6 紀律：§A 候選表必須對所有命中 commit 跑 `git merge-base --is-ancestor {commit} origin/dev`，merge-base exit 非 0 的 commit 一律不得當成「已修復」根據。pre-check.md 已給出嚴格的 commit list 作為參考。
```

**Wait for completion.**

Read analysis-notes.md：
- 若 tracer 標記「已修復」且 merge-base 已驗 → 跳 Step 7，`pipeline_status = already_fixed`
- 若 tracer 標記「已修復」但無 merge-base 驗證 → 視同 PRESS_ON，繼續 Step 5
- **若 tracer 最後一行輸出 `TRACER_RESULT: NEEDS_QA_CLARIFICATION`** → 設 `pipeline_status = needs_qa_clarification`，從 analysis-notes 的 `qa_question` 段抽出存入 `qa_question`，**跳過 Steps 5–6**，直接進 Step 7（傳 `pipeline_status = needs_qa_clarification` + `qa_question`）
- 其他情況 → 繼續 Step 5

#### Extract affected_repos & i18n Detection

從 analysis-notes.md 的「修復策略」section 提取 `affected_repos` 與檢測 i18n manual handoff：

- 路徑前綴 → repo（agrabah/, abu/, lago/, rajah/）
- 若**所有** primary_fix_paths 都是 `localizations/.*\.json$` → 設 `pipeline_status = i18n_manual_handoff`，跳 Step 7
- 混合情況：保持流程，Step 5 prompt 明示「i18n JSON 路徑禁止寫入，僅修 code 部分」

---

### Step 5: Worktrees + Bug-Fixer-with-Tests（critical 路徑 only）

只在 `complexity = critical` 且 fix 計畫非 already_fixed_equivalent 時跑。Simple 路徑跳過直接到 Step 6。

#### Step 5a: Create Worktrees

只為 `affected_repos` 中的 repo 建立真正的 git worktree，其餘 repo 用 symlink。

```bash
mkdir -p /Users/user/aladdin/worktrees/{ticket_id}

for repo in {affected_repos}; do
  cd /Users/user/aladdin/$repo && git fetch origin dev --quiet
  git worktree add /Users/user/aladdin/worktrees/{ticket_id}/$repo -b landon/{ticket_id} origin/dev 2>/dev/null \
    || git worktree add /Users/user/aladdin/worktrees/{ticket_id}/$repo landon/{ticket_id}
done

# 驗證 affected_repos 全部在 landon/{ticket_id}
ALL_OK=1
for repo in {affected_repos}; do
  branch=$(git -C /Users/user/aladdin/worktrees/{ticket_id}/$repo branch --show-current 2>/dev/null)
  [ "$branch" = "landon/{ticket_id}" ] || { echo "WORKTREE_ERROR: $repo branch=$branch"; ALL_OK=0; }
done
[ "$ALL_OK" = "1" ] || exit 1

# 不在 affected_repos 的主 repo 用 symlink
for repo in agrabah abu lago rajah; do
  [ -d "/Users/user/aladdin/worktrees/{ticket_id}/$repo" ] || ln -sfn /Users/user/aladdin/$repo /Users/user/aladdin/worktrees/{ticket_id}/$repo
done

# 共用庫 symlink
for shared in jasmine genie jafar; do
  ln -sfn /Users/user/aladdin/$shared /Users/user/aladdin/worktrees/{ticket_id}/$shared
done

cd /Users/user/aladdin/worktrees/{ticket_id}/rajah && sh bootstrap.sh
```

若 worktree 建立失敗：清殘留 → 重試 1 次 → 仍失敗 → Pipeline Failure。
bootstrap.sh 失敗（例如 sync-all 連不到 DB）→ 記錄錯誤但繼續。

#### Step 5b: Bug-Fixer-with-Tests

**Increment fixer_attempt_count + total_attempt_count.**
**Hard cap**: if total_attempt_count > 3, go to Pipeline Failure.

Create a sub agent using the prompt at `/Users/user/aladdin/.claude/agents/bug-fixer-with-tests.md`:

```
prompt:
Use all text in {/Users/user/aladdin/.claude/agents/bug-fixer-with-tests.md} as the prompt. Please implement the code fix in the worktree AND write L0 unit tests in the same commit.
analysis notes path: /Users/user/aladdin/obsidian/Debug/{ticket_id}/{ticket_id}-analysis-notes.md
analytics document path: /Users/user/aladdin/obsidian/Debug/{ticket_id}/{ticket_id}-analytics.md
worktree_path: /Users/user/aladdin/worktrees/{ticket_id}
affected_repos: {affected_repos}
ticket_id: {ticket_id}

⚠️ V6 紀律：fix + L0 tests 必須在同一個 commit；測試一律 L0 / L1 純單元測試（不啟 server、不開 DB、不打 network）。
```

**Wait for completion.**

#### BRANCH_ERROR Handling

若 Bug Fixer 返回 `BRANCH_ERROR`：清除殘留 worktree → 重建 → Re-dispatch（最多 1 次）。仍失敗 → Pipeline Failure。

---

### Step 6: Reviewer

#### Simple 路徑：1× reviewer self-pass

Dispatch general-purpose sub-agent inline：

```
prompt:
你是 V6 pipeline 的 reviewer sub-agent (single)。review {ticket_id} 的 fix 計畫（simple 路徑，**沒有實際 commit**，純文字計畫）。

## 你的任務

### Step 1: 讀
- /Users/user/aladdin/obsidian/Debug/{ticket_id}/{ticket_id}-fix-plan.md
- /Users/user/aladdin/obsidian/Debug/{ticket_id}/{ticket_id}-pre-check.md
- /Users/user/aladdin/obsidian/Debug/{ticket_id}/{ticket_id}-analytics.md（如有）

### Step 2: 評估
- 方向對齊 ticket 描述？（驗 fix-plan 的 file:line 確實能消除症狀）
- 漏修風險？（檢查是否有未提到的配套檔案、跨層影響、caller 契約改動）
- fix-plan 標 ALREADY_FIXED_EQUIVALENT 的 deep verification 是否站得住？

### Step 3: 寫產出
寫到 /Users/user/aladdin/obsidian/Debug/{ticket_id}/{ticket_id}-review.md：

```
# Review — {ticket_id}

## VERDICT: PASS / WEAK_PASS / FAIL

## 方向對齊
...

## 漏修風險
...

## 給下棒（人類開發者）的建議
...
```

紀律：
- **禁止**：建 worktree、commit、修改 source code
- **允許**：Read + Bash（read-only git）+ Write {ticket_id}-review.md

回最後一行：
REVIEW_VERDICT: PASS / WEAK_PASS / FAIL
```

#### Critical 路徑：2× parallel reviewer

並行派 2 個 general-purpose sub-agent，inline prompt 與 simple 版本相同但替換：
- 讀的文件多 `analysis-notes.md` 與 fixer 的實際 commit diff
- 輸出 `{ticket_id}-review-A.md` / `{ticket_id}-review-B.md`
- 每個 reviewer 獨立給 VERDICT

**Wait for both.** Merge：
- 任一 reviewer FAIL → 整體 FAIL
- 兩個都 PASS → 整體 PASS
- 其他組合（含 WEAK_PASS）→ 整體 WEAK_PASS

`review_verdict = PASS / WEAK_PASS / FAIL`

**Critical 路徑 FAIL 退回邏輯**：fixer_attempt_count < 2 且 total < 3 → 回 Step 5b（re-dispatch fixer 帶 reviewer feedback）；否則 → Pipeline Failure。
**Simple 路徑**：FAIL 不退回 Step 4a（避免無限迴圈），直接走 Pipeline Failure 並要求人工介入。

---

### Step 7: Drive Uploader

Create a sub agent using the prompt at `/Users/user/aladdin/.claude/agents/drive-uploader.md`:

```
prompt:
Use all text in {/Users/user/aladdin/.claude/agents/drive-uploader.md} as the prompt. Please compile the solution document, upload to Google Drive, and comment on Notion.
ticket_id: {ticket_id}
Notion URL: {Notion URL from $ARGUMENTS}
worktree_path: {worktree_path or N/A if no worktree built}
affected_repos: {affected_repos}
pipeline_status: success / already_fixed / i18n_manual_handoff / needs_qa_clarification
pre_check_verdict: {pre_check_verdict}
complexity: {complexity}
qa_question: {qa_question；非 needs_qa_clarification 時填 N/A}
grounding_doc: /Users/user/aladdin/obsidian/Debug/{ticket_id}/{ticket_id}-grounding.md
```

**pipeline_status 對應**：
- `success` — critical 路徑跑完且 reviewer PASS / WEAK_PASS，已有 commit + L0 tests
- `already_fixed` — pre-check HIGH fast-path 命中、或 fix-planner / tracer 標 ALREADY_FIXED_EQUIVALENT
- `i18n_manual_handoff` — tracer 標 primary_fix_paths 全為 i18n JSON（critical 路徑 only；simple 路徑由 fix-planner 處理）
- `needs_qa_clarification` — grounder 或 tracer 發現 ticket 與 CQA 實況有不可裁定的出入，暫停問 QA（drive-uploader 設 AI分析=待釐清 + 留言 qa_question + 上傳 grounding 文件）

對 `i18n_manual_handoff` 額外傳入 `i18n_keys` 清單（從 analysis-notes.md 解析）。

**Wait for completion.** drive-uploader 會根據 pipeline_status 更新 Notion「AI分析」欄位為「分析成功」。

---

### Step 8: Completion Report

```
## {ticket_id} Analysis Complete (V6 pipeline)

- Pre-check verdict: {pre_check_verdict}
- Complexity: {complexity}
- Path taken: {simple | critical | fast-path}
- Bug Tracer attempts: {tracer_attempt_count} (critical only)
- Bug Fixer attempts: {fixer_attempt_count} (critical only)
- Total attempts: {total_attempt_count}
- Reviewer verdict: {review_verdict}
- Pipeline status: {pipeline_status}
- Google Drive: {share link}
- Notion comment: completed / failed
- Worktree root: /Users/user/aladdin/worktrees/{ticket_id} (critical only) or N/A
- Documents: /Users/user/aladdin/obsidian/Debug/{ticket_id}/
```

> **重要：呼叫端控制權交還規則**
>
> 若本次呼叫來自 `/analyze-bugs` batch 流程（或任何外層迴圈 skill），完成本步驟後**必須立即返回外層 Step 4c 繼續迴圈**（release lock → 標記 done → 計數 +1 → 回到 4a 處理下一張單），不可在此停止或等待使用者指令。本 Completion Report 僅是單張單的階段性回報，不是整個 batch 的終點。

---

### Pipeline Failure

無論失敗發生在哪個步驟，都必須透過 drive-uploader 統一同步狀態至 Notion（留下失敗留言、並更新「AI分析」欄位為「分析失敗」）。**失敗路徑不上傳任何文件、不建立 Drive 資料夾。**

**needs_qa_clarification 不是 failed**：它是「等 QA 釐清」的正常暫停，走 Step 7（drive-uploader 設 AI分析=待釐清 + 留言 qa_question + 上傳 grounding 文件），不留失敗留言、不標分析失敗。

Create a sub agent using the prompt at `/Users/user/aladdin/.claude/agents/drive-uploader.md`:

```
prompt:
Use all text in {/Users/user/aladdin/.claude/agents/drive-uploader.md} as the prompt. The pipeline has failed. Do NOT upload any files or create any Drive folder. Only post a failure comment on Notion and update the Notion "AI分析" property to "分析失敗".
ticket_id: {ticket_id}
Notion URL: {Notion URL from $ARGUMENTS}
worktree_path: /Users/user/aladdin/worktrees/{ticket_id} or N/A
affected_repos: {affected_repos}
pipeline_status: failed
failure_reason: {最後一次 reviewer / tracer / fixer 退回理由摘要}
pre_check_verdict: {pre_check_verdict}
complexity: {complexity}
tracer_attempt_count: {tracer_attempt_count}
fixer_attempt_count: {fixer_attempt_count}
total_attempt_count: {total_attempt_count}
```

**Wait for completion.** 即使 drive-uploader 內部部分步驟失敗，它仍須嘗試更新 Notion 狀態為「分析失敗」。

Report:

```
{ticket_id} pipeline 失敗，需要人工介入。
- Pre-check: {pre_check_verdict}
- Complexity: {complexity}
- Tracer 嘗試：{tracer_attempt_count} 次
- Fixer 嘗試：{fixer_attempt_count} 次
- 總嘗試：{total_attempt_count} 次
- Reviewer verdict: {review_verdict}
- 失敗原因：{最後一次 reviewer / fixer / tracer 退回理由摘要}
- Worktree: /Users/user/aladdin/worktrees/{ticket_id} (critical only)
- 文件：/Users/user/aladdin/obsidian/Debug/{ticket_id}/
```

Mark all remaining pending tasks as `completed` with a failure note.

> **重要：呼叫端控制權交還規則**
>
> 若本次呼叫來自 `/analyze-bugs` batch 流程（或任何外層迴圈 skill），即使本張單以失敗收尾，也**必須立即返回外層 Step 4d 繼續迴圈**（release lock → 標記 failed → 計數 +1 → 回到 4a 處理下一張單），不可在此停止或等待使用者指令。

---

## V6 設計依據

| 環節 | 設計依據 |
|---|---|
| pre-check + commit-message-fallback | V6-Light 100 張驗證：73% fast-path 命中率、3% 退步全部是「commit message 不帶 ticket id」邊界 |
| 砍 spec-fetcher | V5/V5-Lite 6 ticket 證實 spec 內容可由 fix-planner / tracer 階段直接讀，不需獨立 agent |
| 砍 env-preparer + evaluator + test-validator | V5 SUMMARY 證實合併進 bug-fixer-with-tests 後 100% 寫測試率 + pass-rate，且省 ~50% 時間 |
| Simple 路徑 fix-planner（不 commit） | V6-Light 100 張驗證：21% 進步多數來自跳過 5 角度 analyzer 直接以 ground truth 為基準 |
| Critical 路徑保留 bug-tracer + fixer-with-tests | FAQ-1982 silent regression 證明複雜後端 bug 仍需 5 角度 + 實際 commit + L0 tests |
| 1× / 2× reviewer 分流 | V5/V5-Lite 證實 FAQ-1982 上 4 個 reviewer 抓不重疊漏修點，critical 需 2× redundancy；simple 不需要 |
| force-flag override | Complexity heuristic 必然會誤判邊界 case，提供人工 override |

## 已知限制與 caveat

- **commit-message-fallback 仍可能漏判**：tag-range 找候選 + diff inspection 是必要兜底，但仍依賴關鍵檔名能從 analytics 抽出
- **Simple 路徑無實際 fix commit**：交付人類開發者實作；想自動 fix 需手動加 `--force-critical`
- **2× reviewer 並行對 critical bug 才划算**：simple 用 1× 省成本

備份：原 V5 版本見 `analyze-single-bug.md.v5-backup`。
