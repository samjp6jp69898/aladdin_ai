---
description: For tech-personnel assigned tickets only. Reads bug_analysis_tracker.md (shared with /analyze-bugs), claims one pending/rerun ticket (rerun first), analyzes, traces root cause (with mandatory method-call-graph evidence), fixes code + writes pure L0 unit tests in worktree (base = origin/dev), reviews via single solution-reviewer, then pushes branch and opens MR against dev with the assignee's git email as reviewer.
argument-hint: "[ticket_id]"
---

# /create-mr Pipeline (Claim One Tracker Entry + Analyze + Fix + Tests + MR)

You are the pipeline manager responsible for dispatching engineers. Your role is to claim ONE ticket from the tracker and sequentially dispatch sub agents to complete the bug analysis pipeline. **You do not read any Notion content or code yourself** — you only manage pipeline state and coordinate agents.

**Always use the specified prompt document to create the corresponding sub agent.**

## Parameters

`$ARGUMENTS` format: `/create-mr [ticket_id]`

- **ticket_id** (optional): e.g. `FAQ-1702`; if provided, claim this specific ticket. If omitted, claim the first available `pending` ticket from the tracker.

## Tracker File

**Path:** `/Users/user/.claude/projects/-Users-user-aladdin/memory/bug_analysis_tracker.md`

Shared with `/analyze-bugs`. Maintained by both `bun scripts/notion-bug-query.ts` (severity-driven) and `bun obsidian/scripts/notion-bug-query-v2.ts` (tech-assignee-driven). Schema:

```
| 單號 | Notion 連結 | 嚴重性 | 狀態 | 加入時間 | 完成時間 |
```

Where `狀態 ∈ {pending, rerun, in_progress, done, failed}`.

`/create-mr` 認 `pending` 與 `rerun` 狀態（`rerun` = AI分析「需要重跑」訊號，**優先於 pending 處理**）。`rerun` 與 `/analyze-bugs` 共享，靠 Step 0.1 的 atomic claim（`bug-lock.sh`）去重——誰先搶到鎖誰處理。

## Tech Users Reference

**Path:** `/Users/user/aladdin/obsidian/commands/create-mr/references/tech-users.csv`

Columns: `notion_user_name,notion_user_id,email,pushed_repos`. v2 query 已用此名單後篩，但 tracker 沒有 reviewer 欄位（與 v1 共用 schema），所以 `reviewer_email` 在 Step 0.5 透過 Notion 查當前指派 + 此 CSV 比對推導。

---

## State Variables

```
ticket_id = ""
notion_url = ""
page_id = ""                  # UUID format (8-4-4-4-12), extracted from Notion URL
reviewer_email = ""           # derived in Step 0.5 from Notion assignees ∩ tech-users.csv
assignee_check_passed = false
tracer_attempt_count = 0
fixer_attempt_count = 0
reviewer_attempt_count = 0
total_attempt_count = 0
review_result = ""            # PASSED / FAILED
pipeline_status = ""          # success / already_fixed / i18n_manual_handoff / needs_qa_clarification / failed
grounding_result = ""         # CONSISTENT / NEEDS_QA_CLARIFICATION
qa_question = ""              # grounder 或 tracer 給 QA 的詳細待確認問題
drive_link = ""
mr_links = []
affected_repos = []
tg_notify_result = ""         # tg-notify.sh 回傳的一行狀態（TG_SENT / TG_SKIP_* / TG_FAIL）
tg_chatid_sync_result = ""    # Step 0 tg-chatid-sync 彙總（自動對映 N / ASK 待處理 M / 確認訊息結果）
worktree_path = ""            # set to /Users/user/aladdin/worktrees/{ticket_id} after Step 4
```

---

## Execution Flow

### Step 0: Telegram chat_id 回填（pipeline 前置，best-effort 非阻斷）

在 claim 任何 ticket 之前，先用 `tg-chatid-sync` 流程把「有 DM 過 bot 但 CSV 缺 chat_id」的技術自動回填，讓 Step 7b.1 的 TG 通知不會因缺 chat_id 而 `TG_SKIP_NO_CHATID`。**本步驟一律 best-effort：任何錯誤只記 log、絕不中斷 pipeline；不 claim、不改 tracker。** 由 manager 自跑，**不派 sub agent**。

紀律承襲 `tg-chatid-sync` skill：發現來源為新 bot 自己的 `getUpdates`（誰 DM 過新 bot），與 telegram channel / `access.json` 完全無關；只讀不確認 offset、冪等（`--list` 跳過已對映）、不覆蓋既有不同 chat_id。注意 getUpdates 只看近 ~24h 未確認更新，超時者需重發 DM 才會被發現。

1. **唯讀發現**：
   ```bash
   bash /Users/user/aladdin/scripts/tg-map-chatids.sh --list
   ```
   輸出 TSV（無表頭，tab 分隔）：`chat_id  source  tg_first_name  tg_username  confidence(HIGH|ASK)  candidate_email  candidate_name  alt_candidates`。指令失敗或無輸出 → 設 `tg_chatid_sync_result = "SKIPPED (--list 無輸出或失敗)"`，直接進 Step 0.1。

2. **逐行處理（不使用 AskUserQuestion）**：
   - `confidence == HIGH` → 自動寫入，再對 `SET_OK` 者發確認訊息（`first_name` 取自該行）：
     ```bash
     bash /Users/user/aladdin/scripts/tg-map-chatids.sh --set <candidate_email> <chat_id>
     bash /Users/user/aladdin/scripts/tg-notify.sh --email <candidate_email> --text "<tg_first_name> 連結成功"
     ```
   - `confidence == ASK`（候選 0 或 ≥2）→ **不問、不寫**，只記 log（`chat_id` / `tg_first_name` / `alt_candidates`），留待人工另跑 `/tg-chatid-sync`。

3. 彙總寫入 `tg_chatid_sync_result`，格式：`自動對映 N / ASK 待處理 M / 確認訊息 X SENT, Y FAIL`，於 Step 9 完成報告輸出。

無論結果如何，繼續 **Step 0.1**。

### Step 0.1: Claim Ticket From Tracker

1. **Read tracker file**:
   ```bash
   cat /Users/user/.claude/projects/-Users-user-aladdin/memory/bug_analysis_tracker.md
   ```
   If the file does not exist or contains no `pending` rows, output:
   ```
   No pending tickets to claim. Run: bun obsidian/scripts/notion-bug-query-v2.ts
   ```
   and exit.

2. **Pick target row**:
   - If `$ARGUMENTS` includes a ticket_id (e.g., `FAQ-1702`): find that row. Row must have `狀態 ∈ {pending, rerun}`. If neither (or not in tracker) → output `SKIPPED: {ticket_id} not claimable (狀態 must be pending/rerun)` and exit.
   - If `$ARGUMENTS` is empty: pick the first claimable row with `狀態 ∈ {pending, rerun}`, **`rerun` 優先於 `pending`**，同狀態內依 FAQ number descending (newest first)。`rerun` 與 `/analyze-bugs` 共享，下方 atomic claim 會去重。

3. **Extract** from the row: `ticket_id`, `notion_url`. Compute `page_id` from `notion_url` (32-char hex after last `-` or `/`, convert to UUID format 8-4-4-4-12). `reviewer_email` 在 Step 0.5 從 Notion 查得後填入。

4. **Atomic claim**:
   ```bash
   bash /Users/user/aladdin/scripts/bug-lock.sh claim {ticket_id}
   ```
   - Exit code 0 (`CLAIMED`) → proceed.
   - Exit code 1 (`LOCKED`) → another session owns this ticket. Output `SKIPPED: {ticket_id} already locked by another session` and exit.

5. **Mark tracker** `pending`/`rerun` → `in_progress` for this row (use Edit tool).

6. **On any failure after this point**, the lock MUST be released and the row MUST be set to `failed` before exiting. See "Pipeline Failure" at the bottom.

---

### Step 0.5: Assignee Re-verification（Tech 名單比對）

**Manager 自跑 curl Notion**：

```bash
# 取得當前指派的所有 notion user id
ASSIGNEE_IDS=$(curl -s -H "Authorization: Bearer ***REMOVED-NOTION-TOKEN***" \
  -H "Notion-Version: 2022-06-28" \
  "https://api.notion.com/v1/pages/{page_id}" \
  | jq -r '.properties["當前指派"].people[].id')

# 與 tech-users.csv 的 notion_user_id 欄位比對
MATCHED_EMAIL=""
while IFS=, read -r name nid email repos tgid; do
  for aid in $ASSIGNEE_IDS; do
    if [ "$aid" = "$nid" ]; then
      MATCHED_EMAIL="$email"
      break 2
    fi
  done
done < <(tail -n +2 /Users/user/aladdin/obsidian/commands/create-mr/references/tech-users.csv)

if [ -z "$MATCHED_EMAIL" ]; then
  echo "SKIPPED: {ticket_id} 當前指派不在 tech-users.csv 名單中"
  # 釋放鎖 + 標記 tracker → failed（非技術人員的單,本流程不處理）
  exit 0
fi

reviewer_email="$MATCHED_EMAIL"
assignee_check_passed=true
```

未命中 tech 名單 → 釋放 lock,tracker 標記為 `failed`,直接結束指令（不留 Notion 留言、不更新 AI分析 欄位、不啟動任何 sub agent）。

命中 → 設 `assignee_check_passed = true`,記下 `reviewer_email`,繼續 Step 1。

---

### Step 1: Bug Report Analyst

Create a sub agent using the prompt at `/Users/user/aladdin/.claude/agents/bug-report-analyst.md`:

```
prompt:
Use all text in {/Users/user/aladdin/.claude/agents/bug-report-analyst.md} as the prompt. Please parse the following Notion bug ticket and create the analysis document according to your responsibilities.
Notion URL: {notion_url}

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

### Step 2.5: CQA Grounder（實證 grounding + 早停）

Create a sub agent using the prompt at `/Users/user/aladdin/.claude/agents/cqa-grounder.md`:

```
prompt:
Use all text in {/Users/user/aladdin/.claude/agents/cqa-grounder.md} as the prompt. Please ground the bug against CQA real data and judge ticket-vs-reality discrepancy.
ticket_id: {ticket_id}
analytics document path: /Users/user/aladdin/obsidian/Debug/{ticket_id}/{ticket_id}-analytics.md
spec document path: /Users/user/aladdin/obsidian/Debug/{ticket_id}/{ticket_id}-spec.md
```

**Wait for completion.** 從 grounder 回傳輸出的最後兩行抽 `GROUNDING_RESULT` 與 `QA_QUESTION`（grounder 亦會把這兩行附在 `{ticket_id}-grounding.md` 檔末作備援），存入 `grounding_result` / `qa_question`;`grounding.md` 為詳細佐證文件。

- 若 `grounding_result == NEEDS_QA_CLARIFICATION` → 設 `pipeline_status = needs_qa_clarification`,**跳過 Steps 3–7b**,直接進 Step 7c（manager Notion 寫回），再走 Step 7a 上傳 grounding 文件、Step 8 收尾。
- 否則續跑 Step 3,並在 tracer dispatch prompt 加一行:`grounding document path: /Users/user/aladdin/obsidian/Debug/{ticket_id}/{ticket_id}-grounding.md`。
- grounder 整個失敗 / 未產出 grounding.md → graceful degradation:當作 CONSISTENT,續跑 Step 3（不擋 pipeline）。

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

- 若 bug 確認已修復（有「已修復紀錄」section + commit hash） → 設 `pipeline_status = already_fixed`,從 analysis-notes.md「已修復紀錄」段抽取 commit hash 存為 `fixed_commit`（給 Step 7c Notion 留言用）,跳過 Steps 4-6,直接進 Step 7（**只跑 7a drive-uploader-mr,不跑 7b mr-pusher**)

#### Check TRACER_RESULT — NEEDS_QA_CLARIFICATION

若 tracer 最後一行輸出 `TRACER_RESULT: NEEDS_QA_CLARIFICATION`:
- 設 `pipeline_status = needs_qa_clarification`,從 analysis-notes 的 `qa_question` 段抽出存入 `qa_question`
- 跳過 Steps 4–7b,直接進 Step 7c → Step 7a → Step 8

#### Check primary_fix_paths — i18n Manual Handoff Detection

從 analysis-notes.md 解析 `primary_fix_paths` YAML block。若**所有** `file` 都符合 `localizations/.*\.json$` pattern：

- 設定 `pipeline_status = i18n_manual_handoff`
- 跳過 Steps 4-6（不建 worktree、不派 Fixer / Reviewer）
- 直接進 Step 7（**只跑 7a drive-uploader-mr,不跑 7b mr-pusher**),傳入 `pipeline_status: i18n_manual_handoff` 並附 primary_fix_paths 解析後的 i18n key 清單

若 primary_fix_paths 為混合（部分 i18n、部分 code）：保持正常流程,但在 Step 5 Bug Fixer dispatch prompt 中明示「i18n JSON 路徑禁止寫入,僅修 code 部分」,並要求 Fixer 把 i18n key 清單寫入 `{ticket_id}-i18n-keys-to-import.md`。

#### Extract affected_repos

從 analysis-notes.md 的「修復策略」section 中，掃描所有修改檔案路徑的前綴，提取涉及的 repo 集合：

- 路徑以 `agrabah/` 開頭 → `agrabah`
- 路徑以 `abu/` 開頭 → `abu`
- 路徑以 `lago/` 開頭 → `lago`
- 路徑以 `rajah/` 開頭 → `rajah`

Store as: `affected_repos`（例如 `["agrabah"]` 或 `["agrabah", "rajah"]`）

若解析不出任何 repo，則 `affected_repos` 為空，Step 4 的 worktree 建立仍會執行（全部用 symlink），bootstrap 會在主工作區的 rajah 上跑。

---

### Step 4: Create Worktrees (按需建立 + symlink 補齊)

只為 `affected_repos` 中的 repo 建立真正的 git worktree（隔離環境），其餘 repo 用 symlink 指回主工作區。所有 7 個目錄（4 主 repo + 3 共用庫）都會出現在 per-ticket 根目錄下，確保 `rajah/bootstrap.sh` 與 `generate-*.sh` 內的相對路徑（`../agrabah`、`../abu`、`../lago`、`../jasmine` 等）在任何情境下都能正確解析。

**目標結構（以 affected_repos = ["agrabah"] 為例）：**
```
/Users/user/aladdin/worktrees/{ticket_id}/
├── agrabah   (git worktree, branch mr/{ticket_id}, base origin/dev)
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
  git worktree remove /Users/user/aladdin/worktrees/{ticket_id}/$repo --force 2>/dev/null
  git branch -D mr/{ticket_id} 2>/dev/null
  git worktree add /Users/user/aladdin/worktrees/{ticket_id}/$repo -b mr/{ticket_id} origin/dev
  # 實體 worktree 沒有 node_modules（gitignored，不在 checkout 內）；symlink 主 repo 的，讓 bun 能解析 genie/* 等 workspace 依賴
  ln -sfn /Users/user/aladdin/$repo/node_modules /Users/user/aladdin/worktrees/{ticket_id}/$repo/node_modules
  # .gitignore 用 node_modules/（只比對目錄），symlink 不會被忽略；用 local exclude 讓它對 git 隱形，避免誤 commit
  grep -qxF 'node_modules' /Users/user/aladdin/$repo/.git/info/exclude 2>/dev/null \
    || echo 'node_modules' >> /Users/user/aladdin/$repo/.git/info/exclude
done

# 驗證
ALL_OK=1
for repo in {affected_repos}; do
  branch=$(git -C /Users/user/aladdin/worktrees/{ticket_id}/$repo branch --show-current 2>/dev/null)
  if [ "$branch" != "mr/{ticket_id}" ]; then
    echo "WORKTREE_ERROR: $repo branch=$branch (expected mr/{ticket_id})"
    ALL_OK=0
  fi
done
[ "$ALL_OK" = "1" ] || exit 1

# 不在 affected_repos 中的主 repo 用 symlink
for repo in agrabah abu lago rajah; do
  if [ ! -d "/Users/user/aladdin/worktrees/{ticket_id}/$repo" ]; then
    ln -sfn /Users/user/aladdin/$repo /Users/user/aladdin/worktrees/{ticket_id}/$repo
  fi
done

# 共用庫
for shared in jasmine genie jafar; do
  ln -sfn /Users/user/aladdin/$shared /Users/user/aladdin/worktrees/{ticket_id}/$shared
done

# bootstrap：rajah 為 shared symlink，generated 與分支無關。
# 注意：bootstrap 中 rajah 驅動的 generate-all.sh 會以「物理路徑」把 src/generated 寫進主 repo，不是 worktree；
# 故 bootstrap 在此的作用是「刷新主 repo 的 generated code」，worktree 再由下面的 sync 迴圈鏡像。
cd /Users/user/aladdin/worktrees/{ticket_id}/rajah && sh bootstrap.sh

# bootstrap 後，把 worktree 缺的 gitignored 衍生產物（主要是 src/generated）從剛刷新的主 repo 補進 worktree。
# 已由 worktree 內 generate 步驟產生者（configurations、entries 等）會被 [ ! -e ] 跳過，只補真正缺的。
for repo in {affected_repos}; do
  cd /Users/user/aladdin/$repo
  git status --ignored --porcelain 2>/dev/null | grep '^!!' \
    | grep -vE 'node_modules|\.DS_Store|\.env|\.vscode' | sed 's/^!! //' | while read f; do
    f="${f%/}"
    dst="/Users/user/aladdin/worktrees/{ticket_id}/$repo/$f"
    if [ ! -e "$dst" ]; then
      mkdir -p "$(dirname "$dst")"
      cp -R "/Users/user/aladdin/$repo/$f" "$dst"
    fi
  done
done
```

Store: `worktree_path = /Users/user/aladdin/worktrees/{ticket_id}`, `affected_repos`。

**任一 sub-worktree 建立或驗證失敗** → 清掉殘留後重試一次,仍失敗則進入 Pipeline Failure。

> node_modules 與 generated 皆 gitignored，不會污染後續 commit；generated 一致性由「bootstrap 刷新主 repo + 上面的 sync 迴圈鏡像到 worktree（只補 worktree 缺的、已生成者不動）」共同保證。

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

> **單一 turn 自足原則：** 本環境沒有 SendMessage，無法喚醒已讓出的 sub agent。bug-fixer-with-tests 與 solution-reviewer 端已改為「只 lint 改動檔、前景跑完」；若任一 agent 仍中途讓出（把長指令丟背景等通知、沒有正常完成），manager 不要枯等，視為該次嘗試未完成、重派接手 worktree 既有變更（計入 total_attempt_count cap）。

#### BRANCH_ERROR Handling

若 Bug Fixer（或任何 sub-agent）回傳 `BRANCH_ERROR`:
1. 清除殘留並重建 affected_repos 的 worktree + symlink（同 Step 4 全段）
2. 驗證 affected_repos 的 sub-worktree 都在 `mr/{ticket_id}`
3. Re-dispatch Bug Fixer。仍失敗 → Pipeline Failure。

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

**Wait for completion.** 讀 `/Users/user/aladdin/obsidian/Debug/{ticket_id}/{ticket_id}-reviewer-report.md`,抽 `REVIEW_RESULT`。

#### Decision Matrix

| review_result | Action |
|---|---|
| PASSED | Set `pipeline_status = success`,proceed to Step 7 |
| FAILED | If `fixer_attempt_count < 3` AND `total_attempt_count ≤ 5` → return to Step 5. If `fixer_attempt_count ≥ 3` OR `total_attempt_count > 5` → Pipeline Failure. |

---

### Step 7a: Drive Uploader MR

Create a sub agent using the prompt at `/Users/user/aladdin/.claude/agents/drive-uploader-mr.md`：

```
prompt:
Use all text in {/Users/user/aladdin/.claude/agents/drive-uploader-mr.md} as the prompt. Please compile the solution document, upload to Google Drive, and return the Drive link.
ticket_id: {ticket_id}
Notion URL: {notion_url}
worktree_path: /Users/user/aladdin/worktrees/{ticket_id}
affected_repos: {affected_repos}
pipeline_status: {pipeline_status}
i18n_keys: {若 pipeline_status == i18n_manual_handoff,傳入 key 清單,否則 N/A}
```

**Wait for completion.** 從輸出最後一行抽 `DRIVE_LINK: <url>`,存到 `drive_link`。

failed 路徑 → drive-uploader-mr 會回傳 `DRIVE_LINK: N/A`。

needs_qa_clarification 路徑:比照 already_fixed / i18n —— 只跑本步驟（7a）上傳 grounding/analysis 文件,**不跑 7b mr-pusher**。

### Step 7b: MR Pusher（僅 pipeline_status == success）

**只有 `pipeline_status == success` 才執行本步驟。** already_fixed / i18n_manual_handoff / failed 路徑：完成 Step 7a 後**跳過本步驟**,直接進 Step 7c 由 manager 自處 Notion。

從 `/Users/user/aladdin/obsidian/Debug/{ticket_id}/{ticket_id}-analytics.md` 的「Bug 描述 / 標題」段抽取一句話 `bug_summary`（≤ 60 字,用於 MR title）。

Create a sub agent using the prompt at `/Users/user/aladdin/.claude/agents/mr-pusher.md`：

```
prompt:
Use all text in {/Users/user/aladdin/.claude/agents/mr-pusher.md} as the prompt. Please push the worktree branch to origin, create an MR against dev with the assignee as reviewer, post a Notion comment with the Drive + MR links, and update the AI分析 field to 分析成功.
ticket_id: {ticket_id}
page_id: {page_id}
worktree_path: /Users/user/aladdin/worktrees/{ticket_id}
affected_repos: {affected_repos}
drive_link: {drive_link}
bug_summary: {bug_summary}
solution_md_path: /Users/user/aladdin/obsidian/Debug/{ticket_id}/{ticket_id}-solution.md
reviewer_email: {reviewer_email}
```

**Wait for completion.** 抽 `MR_LINKS: [...]` 存到 `mr_links`,並從報告確認 `NOTION_AI_FIELD: ok`。

#### Step 7b.1: TG 通知技術（success）

成功開出 MR 後，向該技術發私訊（永不阻斷流程，僅記 log）：

> **路徑紀律：`tg-notify.sh` 固定位於根目錄 scripts —— `/Users/user/aladdin/scripts/tg-notify.sh`。呼叫前必須先以 `ls` 確認該檔存在；若一時找不到，務必實際檢查 `/Users/user/aladdin/scripts/` 目錄，嚴禁僅憑記憶或前一階段的舊判斷斷定「腳本不存在」就略過通知（該檔可能在 pipeline 執行期間才被加入根目錄 scripts）。**

```bash
TG_SH=/Users/user/aladdin/scripts/tg-notify.sh   # 固定根目錄 scripts；呼叫前先確認
ls "$TG_SH" >/dev/null 2>&1 || { echo "TG_FAIL: 根目錄 scripts 查無 tg-notify.sh（請實際檢查 /Users/user/aladdin/scripts/，勿憑記憶斷定）"; }
TG_MSG="✅ [已開 MR] {ticket_id}
AI 已完成修復並開出 MR，待你 review：
{對每個 affected repo 一行：'{repo}: {mr_url}'}
分析文件：{drive_link}
Notion：{notion_url}"
bash "$TG_SH" --email "{reviewer_email}" --text "$TG_MSG"
```

把輸出（`TG_SENT` / `TG_SKIP_NOT_TECH` / `TG_SKIP_NO_CHATID` / `TG_FAIL`）存入 `tg_notify_result`。

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

#### needs_qa_clarification

```bash
curl -s -X POST "https://api.notion.com/v1/comments" \
  -H "Authorization: Bearer ***REMOVED-NOTION-TOKEN***" \
  -H "Notion-Version: 2022-06-28" \
  -H "Content-Type: application/json" \
  -d "{
    \"parent\": {\"page_id\": \"{page_id}\"},
    \"rich_text\": [
      {\"type\": \"text\", \"text\": {\"content\": \"AI 在實證 grounding 階段發現 bug 單描述與 CQA 實際狀況/數據可能有出入,需 QA 確認後才繼續分析:\\n{qa_question}\\n(完整佐證見分析文件)\\n\"}},
      {\"type\": \"text\", \"text\": {\"content\": \"{drive_link}\", \"link\": {\"url\": \"{drive_link}\"}}}
    ]
  }"

curl -s -X PATCH "https://api.notion.com/v1/pages/{page_id}" \
  -H "Authorization: Bearer ***REMOVED-NOTION-TOKEN***" \
  -H "Notion-Version: 2022-06-28" \
  -H "Content-Type: application/json" \
  -d '{"properties": {"AI分析": {"select": {"name": "待釐清"}}}}'
```

TG 通知該技術（待釐清）：

> **路徑紀律：`tg-notify.sh` 固定位於根目錄 scripts —— `/Users/user/aladdin/scripts/tg-notify.sh`。呼叫前必須先以 `ls` 確認該檔存在；若一時找不到，務必實際檢查 `/Users/user/aladdin/scripts/` 目錄，嚴禁僅憑記憶或前一階段的舊判斷斷定「腳本不存在」就略過通知（該檔可能在 pipeline 執行期間才被加入根目錄 scripts）。**

```bash
TG_SH=/Users/user/aladdin/scripts/tg-notify.sh   # 固定根目錄 scripts；呼叫前先確認
ls "$TG_SH" >/dev/null 2>&1 || { echo "TG_FAIL: 根目錄 scripts 查無 tg-notify.sh（請實際檢查 /Users/user/aladdin/scripts/，勿憑記憶斷定）"; }
TG_MSG="🟡 [待釐清] {ticket_id}
AI 在實證 grounding 階段發現 bug 單與 CQA 實況可能有出入，需你確認：
{qa_question}
分析文件：{drive_link}
Notion：{notion_url}"
bash "$TG_SH" --email "{reviewer_email}" --text "$TG_MSG"
```

把輸出存入 `tg_notify_result`。（`already_fixed` / `i18n_manual_handoff` / `failed` 分支不發 TG。）

---

### Step 8: Release Lock & Update Tracker

**This step MUST run on every exit path** (success / already_fixed / i18n_manual_handoff / failed / skipped).

1. Release lock:
   ```bash
   bash /Users/user/aladdin/scripts/bug-lock.sh release {ticket_id}
   ```
2. Edit tracker row for `{ticket_id}`:
   - `pipeline_status ∈ {success, already_fixed, i18n_manual_handoff}` → `狀態` = `done`, 完成時間 = `YYYY-MM-DD HHMM`
   - `pipeline_status == failed` 或 Step 0.5 SKIPPED → `狀態` = `failed`, 完成時間 = now
   - `pipeline_status == needs_qa_clarification` → `狀態` = `needs_qa`, 完成時間 = now

---

### Step 9: Completion Report

```
## {ticket_id} /create-mr Pipeline Complete

- Assignee check: PASSED (matched {reviewer_email})
- Pipeline status: {pipeline_status}
- Bug Tracer (with call-graph) attempts: {tracer_attempt_count}
- Bug Fixer (with tests) attempts: {fixer_attempt_count}
- Solution Reviewer: {review_result} at attempt {reviewer_attempt_count}
- Total attempts: {total_attempt_count}
- Google Drive: {drive_link}
- MR(s):
{對每個 affected_repo 列一行 "- {repo}: {mr_url}",若 pipeline_status != success 則整段顯示 "(N/A - {pipeline_status})"}
- Notion comment: completed
- Notion AI分析: {分析成功 / 分析失敗}
- TG 通知: {tg_notify_result}（success / 待釐清 才會送，其餘為 N/A）
- TG chat_id 同步 (Step 0): {tg_chatid_sync_result}
- Reviewer: {reviewer_email}
- Worktree root: /Users/user/aladdin/worktrees/{ticket_id}

Documents at: /Users/user/aladdin/obsidian/Debug/{ticket_id}/
```

---

### Pipeline Failure

任何步驟失敗（tracer / fixer / reviewer / drive-uploader-mr）超過重試上限,設定 `pipeline_status = failed`,跳過 Step 7b（mr-pusher）,進 Step 7c 由 manager 直接 curl Notion 留失敗訊息 + 「AI分析」=「分析失敗」,然後**仍要執行 Step 8 釋放鎖並把 tracker 標為 `failed`**。

**失敗路徑不上傳 Drive 文件、不開 PR、不留成功留言。**

**needs_qa_clarification 不是 failed**:不留失敗留言、不標分析失敗;它是「等 QA 釐清」的正常暫停,走 Step 7c 的 needs_qa_clarification 分支（`AI分析` = `待釐清` + 留言詳述待確認問題）+ Step 7a 上傳 grounding 文件 + tracker 標 `needs_qa`。
