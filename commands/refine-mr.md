---
description: 掃描指定工單在各子專案的 MR review 留言，依未解決的技術建議改進程式碼，跑 lint + 相關單測後直接 push 新 commit 到既有 mr/FAQ-* 分支（不開新 MR）。
argument-hint: "<ticket_id>"
---

# /refine-mr Pipeline（依 MR review 留言改進並推回既有分支）

技術人員在 `/create-mr` 開出的 MR 上留下 review 留言後，本指令掃描這些留言、依未解決的技術建議改進程式碼，並把新 commit **直接 push 到既有的 `mr/{ticket_id}` 分支**，不重發新 MR。

You are the pipeline manager. 你只管理 pipeline 狀態與派工，**不自己讀 MR 留言、不自己改 code**。所有留言解讀、程式碼修改、測試與推送都由 sub agent 完成。

**Always use the specified prompt document to create the corresponding sub agent.**

## Parameters

`$ARGUMENTS` format: `/refine-mr <ticket_id>`

- **ticket_id**（必填）：例如 `FAQ-1702`。對應的 MR 分支為 `mr/{ticket_id}`。

本指令為純 GitLab 端作業，**不讀寫 Notion**。

---

## State Variables

```
ticket_id = ""
glab_user = ""                # 自動化帳號 username（用於辨識 bot 留言）
mr_targets = []               # [{repo, iid, web_url}]，掃描後填入有 MR 的 repo
worktree_path = ""            # /Users/user/aladdin/worktrees/{ticket_id}

# 每個 repo 各自一組
per_repo[repo] = {
  fixer_attempt_count = 0,
  refine_status = "",         # committed / no_actionable / fixer_failed / eval_failed / push_failed / pushed
  commit_hashes = [],
  evaluator_result = "",      # PASSED / FAILED
  report_path = "",
  mr_note_status = "",
}
```

---

## Execution Flow

### Step 0: Parse Arguments + glab 認證檢查

1. 從 `$ARGUMENTS` 取出 `ticket_id`。格式不符 `FAQ-\d+` → 輸出錯誤並結束。
2. 確認 `glab` 已對 `gitlab.the777.pro` 認證：

```bash
glab auth status 2>&1 | grep -q "gitlab.the777.pro" || echo "GLAB_NOT_AUTHED"
```

若出現 `GLAB_NOT_AUTHED` → 輸出下列訊息並結束：

```
glab 未對 gitlab.the777.pro 認證，請先執行：
  glab auth login --hostname gitlab.the777.pro
```

3. 取得自動化帳號 username（辨識 bot 留言用）：

```bash
glab_user=$(glab api user | jq -r '.username')
```

---

### Step 1: 掃描四個主 repo 找 MR

對 `agrabah` / `abu` / `lago` / `rajah` 逐一查是否有 `mr/{ticket_id}` 的 open MR：

```bash
for repo in agrabah abu lago rajah; do
  cd /Users/user/aladdin/$repo
  glab mr list --source-branch "mr/{ticket_id}" --output json 2>/dev/null \
    | jq -c --arg repo "$repo" '.[] | {repo: $repo, iid: .iid, web_url: .web_url}'
done
```

每一行 JSON 物件代表一個命中的 MR，收集到 `mr_targets`。

- **`mr_targets` 為空**（四個 repo 都沒有 `mr/{ticket_id}` 的 open MR）→ 輸出下列訊息並結束，不建 worktree、不派任何 agent：

  ```
  找不到 {ticket_id} 的 open MR（已掃描 agrabah / abu / lago / rajah）。
  可能原因：MR 尚未建立、已被 merge、或分支名不是 mr/{ticket_id}。
  ```

- `mr_targets` 非空 → 記下涉及的 repo 集合，繼續 Step 2。

---

### Step 2: 為有 MR 的 repo 建立 worktree（base = origin/mr/{ticket_id}）

只為 `mr_targets` 中的 repo 建立真正的 git worktree，**base 是既有的 `origin/mr/{ticket_id}` 分支**（沿用既有 MR 分支，不是 `origin/dev`）；其餘主 repo 與共用庫用 symlink 補齊，確保 `bootstrap.sh` / `generate-*` 內的相對路徑可解析。

```bash
mkdir -p /Users/user/aladdin/worktrees/{ticket_id}

# 對 mr_targets 中的 repo 建立 worktree，base = origin/mr/{ticket_id}
for repo in {mr_target_repos}; do
  cd /Users/user/aladdin/$repo && git fetch origin "mr/{ticket_id}" --quiet
  git worktree remove /Users/user/aladdin/worktrees/{ticket_id}/$repo --force 2>/dev/null
  git branch -D "mr/{ticket_id}" 2>/dev/null
  git worktree add /Users/user/aladdin/worktrees/{ticket_id}/$repo -b "mr/{ticket_id}" "origin/mr/{ticket_id}"
done

# 驗證：mr_targets 中的 sub-worktree 都必須在 mr/{ticket_id}
ALL_OK=1
for repo in {mr_target_repos}; do
  branch=$(git -C /Users/user/aladdin/worktrees/{ticket_id}/$repo branch --show-current 2>/dev/null)
  if [ "$branch" != "mr/{ticket_id}" ]; then
    echo "WORKTREE_ERROR: $repo branch=$branch (expected mr/{ticket_id})"
    ALL_OK=0
  fi
done
[ "$ALL_OK" = "1" ] || exit 1

# 不在 mr_targets 中的主 repo 用 symlink 指回主工作區
for repo in agrabah abu lago rajah; do
  if [ ! -d "/Users/user/aladdin/worktrees/{ticket_id}/$repo" ]; then
    ln -sfn /Users/user/aladdin/$repo /Users/user/aladdin/worktrees/{ticket_id}/$repo
  fi
done

# 共用庫一律 symlink
for shared in jasmine genie jafar; do
  ln -sfn /Users/user/aladdin/$shared /Users/user/aladdin/worktrees/{ticket_id}/$shared
done

# 從 rajah 跑 bootstrap，確保 generated code 一致
cd /Users/user/aladdin/worktrees/{ticket_id}/rajah && sh bootstrap.sh
```

Store: `worktree_path = /Users/user/aladdin/worktrees/{ticket_id}`

**若任一 sub-worktree 建立或驗證失敗：** 先清殘留（`git worktree remove --force` + `rm -rf`），重跑一次整段。仍失敗 → 進 Pipeline Failure。

bootstrap.sh 失敗（例如 sync-all 連不到 DB）只記錄、不中止；只有 worktree 沒全部建成才算硬性失敗。

---

### Step 3-5: 逐 repo 處理（對 `mr_targets` 中每個 repo 依序執行）

對 `mr_targets` 中的每一個 `{repo, iid, web_url}`，依序跑 Step 3 → 4 → 5。各 repo 互相獨立。

#### Step 3: Dispatch mr-feedback-fixer

**Increment `per_repo[repo].fixer_attempt_count`。**

Create a sub agent using the prompt at `/Users/user/aladdin/.claude/agents/mr-feedback-fixer.md`：

**首次派工：**

```
prompt:
Use all text in {/Users/user/aladdin/.claude/agents/mr-feedback-fixer.md} as the prompt. Please read the MR review comments, address the actionable ones, run lint, and commit on the existing branch.
ticket_id: {ticket_id}
repo: {repo}
mr_iid: {iid}
mr_web_url: {web_url}
worktree_path: /Users/user/aladdin/worktrees/{ticket_id}
glab_user: {glab_user}
report_path: /Users/user/aladdin/worktrees/{ticket_id}/{repo}-refine-report.md
```

**evaluator 退回後重派（fixer_attempt_count > 1）：** 在 prompt 末尾追加：

```
This is a re-dispatch. The evaluator rejected the previous commit.
evaluator feedback: /Users/user/aladdin/worktrees/{ticket_id}/{repo}-eval-report.md
Read the evaluator feedback, fix the failing tests / issues on the same branch, and commit again.
```

**Wait for completion.** 從輸出最後一行抽 `FIXER_RESULT`：

| FIXER_RESULT | 處理 |
|---|---|
| `COMMITTED` | 抽 commit hash，設 `refine_status = committed`，進 Step 4 |
| `NO_ACTIONABLE_COMMENTS` | 設 `refine_status = no_actionable`，**跳過 Step 4、5**，此 repo 完成（不 push、不發 MR 訊息） |
| `BRANCH_ERROR` | 依下方 BRANCH_ERROR Handling 重建 worktree 後重派一次；仍失敗 → `refine_status = fixer_failed` |
| `FIXER_FAILED` | 設 `refine_status = fixer_failed`，跳過 Step 4、5 |

#### Step 4: Dispatch mr-feedback-evaluator（僅 refine_status == committed）

Create a sub agent using the prompt at `/Users/user/aladdin/.claude/agents/mr-feedback-evaluator.md`：

```
prompt:
Use all text in {/Users/user/aladdin/.claude/agents/mr-feedback-evaluator.md} as the prompt. Please run the related unit tests for the fixer's changes and produce the evaluation report.
ticket_id: {ticket_id}
repo: {repo}
worktree_path: /Users/user/aladdin/worktrees/{ticket_id}
report_path: /Users/user/aladdin/worktrees/{ticket_id}/{repo}-eval-report.md

When done, output your final result on the last line:
EVAL_RESULT: PASSED
or
EVAL_RESULT: FAILED
```

**Wait for completion.** 抽 `EVAL_RESULT`：

| EVAL_RESULT | 處理 |
|---|---|
| `PASSED` | 進 Step 5 |
| `FAILED` | 若 `fixer_attempt_count < 3` → 回 Step 3 重派 fixer（帶 eval feedback）。若 `fixer_attempt_count >= 3` → 設 `refine_status = eval_failed`，跳過 Step 5 |

#### Step 5: Dispatch mr-feedback-pusher（僅 evaluator PASSED）

Create a sub agent using the prompt at `/Users/user/aladdin/.claude/agents/mr-feedback-pusher.md`：

```
prompt:
Use all text in {/Users/user/aladdin/.claude/agents/mr-feedback-pusher.md} as the prompt. Please push the new commits to the existing MR branch and post a summary note on the MR.
ticket_id: {ticket_id}
repo: {repo}
mr_iid: {iid}
mr_web_url: {web_url}
worktree_path: /Users/user/aladdin/worktrees/{ticket_id}
report_path: /Users/user/aladdin/worktrees/{ticket_id}/{repo}-refine-report.md

When done, output your final result on the last line:
PUSH_RESULT: PUSHED
or
PUSH_RESULT: PUSH_FAILED
```

**Wait for completion.** 抽 `PUSH_RESULT`：`PUSHED` → `refine_status = pushed`；`PUSH_FAILED` → `refine_status = push_failed`。

---

### Step 6: Completion Report

```
## {ticket_id} /refine-mr Pipeline Complete

- glab 認證：PASSED
- 掃描到的 MR：
{對每個 mr_targets 列一行 "- {repo}: MR !{iid} {web_url}"}

逐 repo 結果：
{對每個處理過的 repo 列出}
- {repo}:
  - 狀態：{refine_status}
  - Fixer 嘗試：{fixer_attempt_count} 次
  - Evaluator：{evaluator_result}
  - 新 commit：{commit_hashes，若無則 N/A}
  - MR 留言：{mr_note_status，若無則 N/A}
  - 報告：{report_path}

Worktree root: /Users/user/aladdin/worktrees/{ticket_id}
```

`refine_status` 對應的人類可讀說明：

| refine_status | 說明 |
|---|---|
| `pushed` | 已依留言改進並 push 新 commit、已在 MR 留總結訊息 |
| `no_actionable` | MR 上無未解決的可採納技術留言，未做任何變更 |
| `fixer_failed` | fixer 無法完成修改，需人工介入 |
| `eval_failed` | 相關單測連續未通過達上限，未 push，需人工介入 |
| `push_failed` | 改完且測試通過，但 push 失敗（多半是 remote 已被他人更新），需人工介入 |

---

### BRANCH_ERROR Handling

任一 sub-agent 回 `BRANCH_ERROR` 時，重建該 repo 的 worktree：

```bash
cd /Users/user/aladdin/{repo} && git fetch origin "mr/{ticket_id}" --quiet
git worktree remove /Users/user/aladdin/worktrees/{ticket_id}/{repo} --force 2>/dev/null
git branch -D "mr/{ticket_id}" 2>/dev/null
git worktree add /Users/user/aladdin/worktrees/{ticket_id}/{repo} -b "mr/{ticket_id}" "origin/mr/{ticket_id}"
```

驗證 branch 為 `mr/{ticket_id}` 後重派一次。仍失敗 → 該 repo 標記 `fixer_failed`。

---

### Pipeline Failure

Step 2 worktree 建立重試後仍失敗 → 輸出失敗摘要並結束：

```
{ticket_id} /refine-mr 失敗：worktree 無法建立，需人工介入。
- 掃描到的 MR：{mr_targets}
```

個別 repo 的 `fixer_failed` / `eval_failed` / `push_failed` 不中止整個 pipeline；其他 repo 照常處理，最終在 Step 6 報告中標示。
