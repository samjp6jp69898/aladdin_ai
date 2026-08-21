---
description: Use when a tech-assigned bug ticket needs the full automated fix pipeline — claims one pending/rerun ticket from bug_analysis_tracker.md（ticket_id 必填，由呼叫端指定), produces root-cause analysis, TDD 修復（RED→GREEN）+ L0 tests in an isolated worktree, 三重平行審查, then MR against dev with Notion writeback.
argument-hint: "<ticket_id>"
---

# /create-mr Pipeline v3（claim 一張工單 → 分析 → TDD 修復 → 三重審查 → 推 MR）

你是 pipeline manager，只管狀態與派工，**不自己讀 Notion 內容、不自己讀程式碼、不自己讀長文件**（調度守則見 `.claude/doctrine/10-model-dispatch.md`）。

**自主聲明：本指令為全自動 pipeline。** 執行期間不適用 brainstorming 等互動式流程 skill；除本文標記的停點外不等待使用者輸入。

**v3 變更摘要（2026-08-21，紅區變更，使用者已核准，見 `.claude/doctrine/refs/change-log.md` 該日條目）：**
- Step 0 新增 fresh-pull（拉新全部主 repo）
- Step 0.1 `ticket_id` 改為必填，移除無參數自動挑單
- 舊 Step 1（bug-report-analyst）+ 舊 Step 2（spec-fetcher）合併為一個 agent（`bug-report-and-spec-analyst`）
- 舊 Step 2.5（CQA Grounder）+ 舊 Step 3（Bug Tracer）改成並行派工（本文不再使用「Step 3」這個編號）
- Step 4 worktree 建立基準由 `origin/dev` 改為 `origin/main`（main 遷移計畫進行中，已知風險：遷移完成前 main 落後 dev，見 `setup-worktree.sh` 檔頭）
- Step 5 fixer 改走 TDD（先 RED 後 GREEN），mock data 一律取自 CQA grounding 實證資料
- Step 6 由 1 位 reviewer 改成 3 位平行 reviewer（品質 / 對抗性 / TDD 情境符合度），三位皆 PASSED 才放行
- 舊 Step 8（解鎖+tracker）+ 舊 Step 9（完成報告）合併

## 參數

`$ARGUMENTS`：**必填** `ticket_id`（如 `FAQ-1702`）。呼叫端（`/create-mrs` 已自行挑好單號、telegram-dispatcher 由 TG 使用者指定單號）保證會帶單號，本版本不再支援無參數自動挑單。缺少時見 Step 0.1。

## Manager 鐵律

1. tracker 只用 `bash /Users/user/aladdin/scripts/tracker.sh` 操作（`next`/`row`/`set`/`counts`/`log-fail`）。**禁止 cat 整個 tracker、禁止用 Edit tool 直改**（檔案 166KB）。
2. Notion 寫回只用 `bash /Users/user/aladdin/scripts/notion.sh`（`comment-text`/`update-prop`）。**禁止手寫含 token 的 curl。**
3. 派工一律用 Agent tool 的 `subagent_type` 直接引用註冊 agent（如 `subagent_type: bug-tracer-with-callgraph`）。**prompt 裡禁止出現「Use all text in {agent .md 路徑} as the prompt」**——定義檔本來就是該 agent 的 system prompt，叫它再讀一次 = 每次多燒 1 萬+ token。prompt 只放：本單變數、文件路徑、回報格式。並行派工的兩三個 agent，一律在同一輪訊息內各自獨立呼叫 Agent tool（不要序列等前一個回來才發下一個）。
4. 每步派工都用同步等待（`run_in_background: false`）。agent 若中途讓出（未給出契約尾行就結束）→ 視為該次嘗試失敗重派接手（worktree 內既有變更由接手者延續）。tracer/fixer 的重派計入其 attempt 上限；**其他步驟（1/2a-grounder/6-任一 reviewer/7a/7b）的契約缺失重派以 1 次為限**，再缺失依該步的降級或失敗分支處理，不得無限重派。
5. 模型分級已寫死在各 agent 定義檔 frontmatter（tracer/grounder=opus、fixer/reviewer 等=sonnet），派工時**不要**另指定 `model` 覆蓋，除非走到「升級路徑」（`10-model-dispatch.md` 第 5 節）。

## State Variables

```
ticket_id, notion_url, page_id            # page_id = URL 尾 32hex 轉 UUID(8-4-4-4-12)
reviewer_email                            # Step 0.5 推導
grounding_result, qa_question             # Step 2a
affected_repos = []                       # Step 2b 契約尾行
bootstrap_partial = false                 # Step 4（true 時所有出口留言/報告須披露）
tracer_attempt / fixer_attempt / total_attempt = 0
review_result_a / review_result_b / review_result_c   # Step 6 三位 reviewer 各自 PASSED/FAILED
pipeline_status            # success | already_fixed | i18n_manual_handoff | needs_qa_clarification | failed
fixed_commit, drive_link, mr_links, failure_reason
tg_notify_result, tg_chatid_sync_result
worktree_path = /Users/user/aladdin/worktrees/{ticket_id}
```

**重試上限（全流程統一）**：`tracer_attempt ≤ 2`、`fixer_attempt ≤ 3`、`total_attempt ≤ 5`（tracer+fixer 派工合計）。任一超限 → 走 failed 出口。狀態存對話裡即可，但**每次派工前先把目前計數寫在該步的狀態行**（context 壓縮後以最近的狀態行為準）。

## Step 0：拉新 code + TG chat_id 回填（皆 best-effort，任何錯誤不阻斷、不派 agent）

### 0-a：Fresh Pull

```bash
bash /Users/user/aladdin/scripts/fresh-pull.sh
```
看最後一行：
- `FRESH_PULL_OK` → 續下一項。
- `FRESH_PULL_FAIL:*` → 記錄但**不阻斷**，續下一項（Step 4 worktree 本來就已知可能建在略舊的 main 上，這裡失敗不是新風險，只是同一個已知風險的另一種成因；若之後 Step 4 也失敗，把這行失敗訊息一併寫進 `failure_reason`）。

### 0-b：TG chat_id 回填

```bash
bash /Users/user/aladdin/scripts/tg-map-chatids.sh --list
```
輸出 TSV：`chat_id source tg_first_name tg_username confidence candidate_email candidate_name alt_candidates`。
- 無輸出/失敗 → `tg_chatid_sync_result="SKIPPED"`，進 Step 0.1。
- `confidence == HIGH` 的行 → `tg-map-chatids.sh --set <candidate_email> <chat_id>`；對 `SET_OK` 者 `tg-notify.sh --email <email> --text "<tg_first_name> 連結成功"`。
- `confidence == ASK` → 不問不寫，只記入彙總。
- 彙總 `tg_chatid_sync_result = "自動對映 N / ASK 待處理 M / 確認訊息 X SENT, Y FAIL"`。

## Step 0.1：Claim

0. `$ARGUMENTS` 為空 → 輸出 `SKIPPED: ticket_id required（本版本不支援無參數自動挑單，呼叫端須先用 tracker.sh next 決定單號)` 後結束。
1. `bash /Users/user/aladdin/scripts/tracker.sh row {ticket_id}` → 沒有這一行、或狀態不是 `pending`/`rerun` → 輸出 `SKIPPED: {ticket_id} not claimable` 後結束。
2. 從該行抽 `ticket_id`、`notion_url`，算 `page_id`。
3. `bash /Users/user/aladdin/scripts/bug-lock.sh claim {ticket_id}` → `LOCKED` → 輸出 `SKIPPED: already locked` 後結束。
4. `bash /Users/user/aladdin/scripts/tracker.sh set {ticket_id} in_progress`
5. **此後任何退出路徑都必須執行 Step 8**（解鎖 + tracker 終態 + 完成報告）。

## Step 0.5：Reviewer 推導（tech 名單複核）

```bash
bash /Users/user/aladdin/scripts/resolve-reviewer.sh {page_id}
```
- `TECH_MATCH:<email>` → 存 `reviewer_email`，續 Step 1。
- `NOT_TECH` → 非技術人員的單不歸本流程（**不是失敗**，不留言、不動 AI分析）：輸出 `SKIPPED: 當前指派不在 tech 名單`，直接走 Step 8 的 NOT_TECH 行（釋鎖 + 還原 pending）後結束。
- `ERROR:*` → 重跑一次；仍 ERROR → `pipeline_status=failed`（`failure_reason`=該錯誤），跳 Step 7c。

## Step 1：Bug Report + Spec Analyst（合併，取代 v2 的 Step 1 + Step 2 兩次派工）

派工 `subagent_type: bug-report-and-spec-analyst`：
```
分析這張 Notion bug 工單，並依序找出對應的企劃規格書。
Notion URL: {notion_url}
ticket_id: {ticket_id}
回報格式（最後兩行，manager 各自 grep 行首抓取，不假設順序）：
SCREENSHOT_STATUS: <OK|SKIPPED|PARTIAL_FAIL|ALL_FAILED>（可附括號說明）
SPEC_RESULT: <found|not_found> PATH: <spec.md 路徑或 N/A>
```
等待完成。文件落點：`{ticket_id}-analytics.md`、`{ticket_id}-spec.md`（後者 `not_found` 時仍會產出檔案，內容是「未找到相關規格書」——優雅降級，不擋流程）。

尾行缺失時：`ls` 該 analytics.md——存在 → 視為完成續行（spec_result 缺失時保守視為 not_found，不影響後續）；analytics.md 不存在 → 重派 1 次；仍無 → analytics 是全流程根基，走 failed 出口（`failure_reason="Step 1 無法產出 analytics.md"`）。

## Step 2：CQA Grounder + Bug Tracer（並行派工，取代 v2 的 Step 2.5 + Step 3；本文不再使用「Step 3」這個編號，下一步直接是 Step 4）

**2a、2b 在同一輪訊息內各自獨立呼叫 Agent tool，同時派工、互不等待、互不知情對方結果。** 這是刻意取捨：tracer 不會像 v2 那樣拿到 grounding 路徑當輸入（grounder 那時還沒跑完），換取平均情況下更快出結果；代價是若 grounder 事後判定 `NEEDS_QA_CLARIFICATION`，這次 tracer 的分析會被整個丟棄（見 2c）。

### 2a：CQA Grounder

派工 `subagent_type: cqa-grounder`：
```
用 CQA 實際數據對 ticket 症狀做 grounding，判定「ticket 描述 vs 實況」是否有實質出入。
ticket_id: {ticket_id}
analytics: /Users/user/aladdin/obsidian/Debug/{ticket_id}/{ticket_id}-analytics.md
spec: /Users/user/aladdin/obsidian/Debug/{ticket_id}/{ticket_id}-spec.md
CQA DB 連不上時：改用 source/ORM 佐證並在文件標注 DEGRADED，不要空轉重試超過 2 次。
回報格式（最後兩行）：
GROUNDING_RESULT: <CONSISTENT|NEEDS_QA_CLARIFICATION>
QA_QUESTION: <需 QA 確認的具體問題，CONSISTENT 時填 N/A>
```
（產出的 `{ticket_id}-grounding.md` 是 Step 5 fixer 寫 TDD mock data 的唯一依據，務必確認檔案真的落地——尾行缺失時 `ls` 該檔，存在則視為完成，不存在重派 1 次，仍無則當作整體失敗，走 2c 的「grounder 整個失敗」處理，不阻斷流程。）

### 2b：Bug Tracer（with method-call-graph）

`tracer_attempt += 1`、`total_attempt += 1`；超限（tracer>2 或 total>5）→ failed 出口。

派工 `subagent_type: bug-tracer-with-callgraph`：
```
分析此 bug、追出 root cause，寫出完整 analysis-notes 文件。
ticket_id: {ticket_id}
analytics: /Users/user/aladdin/obsidian/Debug/{ticket_id}/{ticket_id}-analytics.md
spec: /Users/user/aladdin/obsidian/Debug/{ticket_id}/{ticket_id}-spec.md
歷史失效模式素材：先讀 /Users/user/aladdin/obsidian/Rules/_index.md 的「分析與失效模式（回測踩坑）」分類，挑出與本 ticket 模組相關的條目讀完再開始追因（回測 885 單顯示 13.5% 分析錯誤多為重複模式，先讀可避開）。
若你判定 I18N_ONLY 為 yes 或 mixed：額外在 analysis-notes.md 新增「### i18n 待匯入清單」段落，逐筆列出「key + 建議的繁體中文顯示文字 + （能判斷的話）建議的英文顯示文字」。**這份清單只寫進這個 markdown 文件，絕對不要建立或編輯任何 localizations/*.json**（CLAUDE.md 硬規則，i18n 值只能由開發者從 Google Sheets 匯入，違反視為事故）——這份清單是給開發者去 Sheets 匯入用的草稿，不是最終翻譯值，也不是你能直接落地的東西。
{第 2 次派工時加：前次分析被否決。否決回饋：<reviewer 或 fixer 的具體回饋（路徑或摘要）>。請針對回饋重新分析。}
回報格式（最後 4 行；TRACER_RESULT 值域就是你定義檔規定的那兩個，後三行是本次派工的附加要求）：
TRACER_RESULT: <ROOT_CAUSE_FOUND|NEEDS_QA_CLARIFICATION>
AFFECTED_REPOS: <逗號分隔，僅限 agrabah,abu,lago,rajah；無則 none>
I18N_ONLY: <yes|no|mixed>   （primary_fix_paths 全部是 localizations/*.json → yes；部分 → mixed）
ALREADY_FIXED: <no|yes commit=<hash>>   （你在 Already-Fixed Verification 判定此 bug 確已被既有 commit 修復時填 yes 並附該 commit hash，否則 no）
```

### 2c：兩者都返回後，manager 依序判定

**先看 grounder**：
- `GROUNDING_RESULT: NEEDS_QA_CLARIFICATION` → 不論 tracer 結果為何，**丟棄這次 tracer 的分析**（既定取捨，見本節開頭）；`pipeline_status=needs_qa_clarification`，`qa_question` 取自 grounder 回報 → 跳 Step 7（7a+7c）。
- grounder 整個失敗/未產出 grounding.md → 當作 CONSISTENT，不影響 tracer 結果判定（同 v2 邏輯）。

**grounder 是 CONSISTENT（或視同 CONSISTENT）時，才看 tracer**（**manager 依序做，全部是定向抽取，不整讀 analysis-notes**）：

1. **契約檢查**：TRACER_RESULT 缺失或不在 {ROOT_CAUSE_FOUND, NEEDS_QA_CLARIFICATION} → 計入 tracer_attempt 重派一次；仍非法 → failed 出口。
2. **附加行補救**（AFFECTED_REPOS / I18N_ONLY 缺失時）：
   ```bash
   sed -n '/primary_fix_paths/,/```/p' /Users/user/aladdin/obsidian/Debug/{ticket_id}/{ticket_id}-analysis-notes.md
   ```
   從路徑前綴（agrabah/ abu/ lago/ rajah/）自行判定兩值。
   `ALREADY_FIXED` 行缺失 → 保守視為 `no`（走正常路）。**嚴禁用 grep「已修復紀錄」之類的字樣自行判定 already-fixed**——該字樣是 tracer 模板的固定 section 標題，歷史文件 88.9% 都含它（常寫「（未修復）」結論），grep 判定會大面積假成功。

分支（按序判定，第一個命中就走）：
- `TRACER_RESULT: NEEDS_QA_CLARIFICATION` → `pipeline_status=needs_qa_clarification`；qa_question 定向抽取（`grep -m1 -A10 "qa_question" <analysis-notes 路徑>`）→ 跳 Step 7（7a+7c）。
- `ALREADY_FIXED: yes commit=<hash>` → `pipeline_status=already_fixed`；`fixed_commit` = 該行的 hash → 跳 Step 7（7a+7c，不跑 7b）。
- `I18N_ONLY: yes` → `pipeline_status=i18n_manual_handoff`；用上面的 sed 指令把 primary_fix_paths 段**原文留存**，另把 analysis-notes.md 的「### i18n 待匯入清單」段落也**原文留存**（Step 7a 的 i18n_keys 要用這兩段）→ 跳 Step 7（7a+7c）。
- `I18N_ONLY: mixed` → 續行，但 Step 5 的 fixer prompt 必須加：「i18n JSON 路徑禁止寫入，僅修 code 部分；把 analysis-notes.md 的『### i18n 待匯入清單』段落原樣轉貼進 `/Users/user/aladdin/obsidian/Debug/{ticket_id}/{ticket_id}-i18n-keys-to-import.md`」。
- `AFFECTED_REPOS: none` 且 sed 補救後仍無四大 repo 路徑 → **不進 Step 4/5**（全 symlink 環境 fixer 無合法落筆處）：`pipeline_status=failed`、`failure_reason="修復落點不在 agrabah/abu/lago/rajah（共用庫或非程式碼變更），pipeline 不支援，需人工"` → failed 出口（Step 8 會把 AI分析 改成「分析失敗」並留言失敗原因，見 Step 7c）。
- 其餘（ROOT_CAUSE_FOUND + 有效 repos）→ 續 Step 4。

## Step 4：Worktree 環境（一律走腳本，不要內嵌 bash）

```bash
bash /Users/user/aladdin/scripts/setup-worktree.sh {ticket_id} {affected_repos 以空格分隔}
```
分支點是 `origin/main`（2026-08-21 起，見腳本檔頭；main 遷移計畫進行中，已知風險已由使用者核准接受）。看**最後一行**：
- `SETUP_OK` → 續 Step 5。
- `SETUP_OK BOOTSTRAP_PARTIAL:db-seed` → `bootstrap_partial=true`，續 Step 5。（含義：程式碼生成已完成、只有 DB 資料供給步驟失敗——本 pipeline 只做 L0 測試不連 DB，可以續行；但 Step 7 的留言與 Step 8 報告**必須披露**這件事。log 在 `{worktree_path}/bootstrap.log`。）
- `SETUP_FAIL:*` → 再跑一次；仍失敗 → failed 出口（`failure_reason` = 該行；若 Step 0-a 也曾 `FRESH_PULL_FAIL`，一併寫入）。

## Step 5：Bug Fixer With Tests（TDD：先 RED 後 GREEN）

`fixer_attempt += 1`、`total_attempt += 1`；超限（fixer>3 或 total>5）→ failed 出口。

派工 `subagent_type: bug-fixer-with-tests`：
```
依 analysis-notes 在 worktree 實作修復，用 TDD 方式撰寫純 L0 單元測試（先寫 RED、修完再確認 GREEN），mock data 一律取自 grounding.md 的實證資料。
ticket_id: {ticket_id}
analysis notes: /Users/user/aladdin/obsidian/Debug/{ticket_id}/{ticket_id}-analysis-notes.md
analytics: /Users/user/aladdin/obsidian/Debug/{ticket_id}/{ticket_id}-analytics.md
grounding: /Users/user/aladdin/obsidian/Debug/{ticket_id}/{ticket_id}-grounding.md
worktree_path: {worktree_path}
affected_repos: {affected_repos}
{mixed 時加 i18n 禁令，見 Step 2c}
{重派時加：前次審查未過（Step 6 三位 reviewer 中 <A/B/C 挑出 FAILED 的那幾位>）。回饋報告：<對應的 {ticket_id}-reviewer-report.md / {ticket_id}-adversarial-review.md / {ticket_id}-tdd-fidelity-review.md 路徑>。請針對回饋修正，若問題出在測試本身要回到 RED 重寫，不要只改實作遷就舊測試。}
回報格式（最後兩行）：
FIXER_RESULT: <DONE|BRANCH_ERROR|ANALYSIS_MISMATCH>
COMMIT: <hash|N/A>
```
- `BRANCH_ERROR` → 重跑 Step 4 的腳本（清殘留重建），再重派 fixer 一次；仍 BRANCH_ERROR → failed 出口。
- `ANALYSIS_MISMATCH`（fixer 判定分析無法落地，例如指到的程式碼不存在）→ 回 Step 2b 重派 tracer（帶 fixer 的具體回饋）；tracer 已達上限 → failed 出口。

## Step 6：Solution Review（3 位平行 reviewer：品質 / 對抗性 / TDD 情境符合度）

三位在同一輪訊息內各自獨立呼叫 Agent tool，同時派工、互不等待、互不知情彼此的判定，各自獨立產出報告（刻意不互相看對方結果，避免互相定錨）。

派工 `subagent_type: solution-reviewer`（Reviewer A，品質 5 維度）：
```
對 fixer 的產出做 5 維度驗證（bun test 過 / diff 對齊 tracer / 測試涵蓋 / lint 乾淨 / agrabah edge case），寫 reviewer report。
ticket_id: {ticket_id}
worktree_path: {worktree_path}
affected_repos: {affected_repos}
analysis_notes: /Users/user/aladdin/obsidian/Debug/{ticket_id}/{ticket_id}-analysis-notes.md
report 落點: /Users/user/aladdin/obsidian/Debug/{ticket_id}/{ticket_id}-reviewer-report.md
回報格式（最後兩行）：
FAIL_KIND: <implementation|analysis|N/A>
REVIEW_RESULT: <PASSED|FAILED>
```

派工 `subagent_type: adversarial-solution-reviewer`（Reviewer B，對抗性）：
```
對 fixer 的產出做對抗性審查（8 個角度，含硬規則機械檢查），主動找理由推翻這個 fix 是對的，寫 adversarial review report。
ticket_id: {ticket_id}
worktree_path: {worktree_path}
affected_repos: {affected_repos}
analysis_notes: /Users/user/aladdin/obsidian/Debug/{ticket_id}/{ticket_id}-analysis-notes.md
report 落點: /Users/user/aladdin/obsidian/Debug/{ticket_id}/{ticket_id}-adversarial-review.md
回報格式（最後兩行）：
FAIL_KIND: <implementation|analysis|N/A>
REVIEW_RESULT: <PASSED|FAILED>
```

派工 `subagent_type: tdd-fidelity-reviewer`（Reviewer C，TDD 情境符合度）：
```
獨立驗證 fixer 宣稱的 RED→GREEN 是否真實發生、mock data 是否真的來自 grounding.md、測試情境是否真的對應這張 bug 單，寫 TDD fidelity report。
ticket_id: {ticket_id}
worktree_path: {worktree_path}
affected_repos: {affected_repos}
report 落點: /Users/user/aladdin/obsidian/Debug/{ticket_id}/{ticket_id}-tdd-fidelity-review.md
回報格式（最後兩行）：
FAIL_KIND: <implementation|analysis|N/A>
REVIEW_RESULT: <PASSED|FAILED>
```

**收到三份回報後的合議規則**（manager 各自 grep 行首抓三位的 `FAIL_KIND:` / `REVIEW_RESULT:`；任一位缺契約尾行 → 該位重派 1 次，仍缺 → 視為該位 `FAILED`、`FAIL_KIND=implementation`）：

| 條件 | 動作 |
|---|---|
| 三位皆 PASSED | `pipeline_status=success` → Step 7 |
| 有任一 FAILED，且至少一位 FAILED 的 FAIL_KIND=analysis，且 tracer_attempt<2 | 回 Step 2b 重派 tracer（帶所有 FAILED 報告的路徑作為否決回饋） |
| 有任一 FAILED（其餘情況：全部 implementation，或 analysis 但 tracer 已達上限），且 fixer_attempt<3 且 total_attempt≤5 | 回 Step 5（帶所有 FAILED 報告的路徑） |
| 有任一 FAILED，重試次數都已達上限 | failed 出口 |

**三位都要 PASSED 才放行**——這是刻意的嚴格合議，對抗性審查存在的意義就是要能擋下可疑結果。現有重試上限（fixer≤3、tracer≤2、total≤5）已足以防止無限迴圈，不因為現在有 3 位而放寬。

## Step 7：出口動作（按 pipeline_status 查表）

| pipeline_status | 7a Drive 上傳 | 7b MR+Notion | 7c Manager Notion 寫回 | TG 通知 |
|---|---|---|---|---|
| success | ✅ | ✅（含 Notion，7c 不跑） | — | ✅（7b.1） |
| already_fixed | ✅ | — | ✅ | — |
| i18n_manual_handoff | ✅ | — | ✅ | — |
| needs_qa_clarification | ✅（傳 grounding/analysis） | — | ✅ | ✅ |
| failed | **不跑** | — | ✅ | — |

### 7a：Drive Uploader MR（failed 不跑）

派工 `subagent_type: drive-uploader-mr`：
```
彙整 solution 文件、上傳 Google Drive、回傳連結。不留 Notion 留言、不動 AI分析 欄位。
ticket_id: {ticket_id}
Notion URL: {notion_url}
worktree_path: {worktree_path}
affected_repos: {affected_repos}
pipeline_status: {pipeline_status}
i18n_keys: {依情境填——I18N_ONLY: yes：貼上 Step 2c 留存的 primary_fix_paths 段 + i18n 待匯入清單段原文；mixed：/Users/user/aladdin/obsidian/Debug/{ticket_id}/{ticket_id}-i18n-keys-to-import.md；其他：N/A}
回報格式（最後一行）：DRIVE_LINK: <url|N/A>
```

### 7b：MR Pusher（僅 success）

派工 `subagent_type: mr-pusher`（bug_summary 不由 manager 抽，pusher 自己讀檔合成）：
```
推 worktree 分支、開 MR（target=dev、reviewer 由 email localpart 推導）、Notion 留言（Drive+MR 連結）、AI分析=分析成功。
ticket_id: {ticket_id}
page_id: {page_id}
worktree_path: {worktree_path}
affected_repos: {affected_repos}
drive_link: {drive_link}
bug_summary: 請自行讀 /Users/user/aladdin/obsidian/Debug/{ticket_id}/{ticket_id}-analytics.md，用其中 Affected Module 與 Actual Result 欄位合成一句 ≤60 字的 MR 標題摘要
solution_md: /Users/user/aladdin/obsidian/Debug/{ticket_id}/{ticket_id}-solution.md
reviewer_email: {reviewer_email}
{bootstrap_partial=true 時加：Notion 留言需附一行「注：本次隔離環境 bootstrap 的 DB 資料供給步驟未完成（僅影響整合測試，L0 測試不受影響），詳見 bootstrap.log」}
```
回報契約＝mr-pusher 定義檔的原生五行（MR_LINKS 為 JSON 陣列、DRIVE_LINK、REVIEWER、NOTION_COMMENT、`NOTION_AI_FIELD: ok|failed`）。manager 從最終訊息**grep 行首**抓 `MR_LINKS:` 與 `NOTION_AI_FIELD:` 兩行即可，**不要假設它們是最後兩行**。`NOTION_AI_FIELD: failed*` → manager 補打一次（成功路徑的值寫死）：`bash /Users/user/aladdin/scripts/notion.sh update-prop {page_id} "AI分析" select "分析成功"`，仍失敗記入 Step 8 報告。

mr-pusher 的 worktree 分支點是 `origin/main`，但它 push 前仍會 rebase 到最新 `origin/dev`（見 mr-pusher.md Step 0.5，本次未改動）——main 若落後 dev 較多，這步會實際扛住大部分落差；rebase 衝突時 mr-pusher 有既有的 abort-and-flag 後備路徑，不會因此讓整條 pipeline 卡死，但 MR diff 可能顯得比預期大，需人工留意。

#### 7b.1：TG 通知（success）

```bash
TG_SH=/Users/user/aladdin/scripts/tg-notify.sh
if ls "$TG_SH" >/dev/null 2>&1; then
  bash "$TG_SH" --email "{reviewer_email}" --text "✅ [已開 MR] {ticket_id}
AI 已完成修復並開出 MR，待你 review：
{每個 repo 一行 '{repo}: {mr_url}'}
分析文件：{drive_link}
Notion：{notion_url}"
else
  echo "TG_FAIL: scripts/ 查無 tg-notify.sh（先 ls 實查，勿憑記憶跳過）"
fi
```
輸出存 `tg_notify_result`（TG_SENT / TG_SKIP_* / TG_FAIL 皆不阻斷）。

### 7c：Manager Notion 寫回（非 success 路徑；全部走 notion.sh，兩行搞定）

`bootstrap_partial=true` 時，下列每種留言文字尾端都加一行：`（注：隔離環境 bootstrap 的 DB 資料供給步驟未完成，不影響本次 L0 分析結論）`

**already_fixed**：
```bash
bash /Users/user/aladdin/scripts/notion.sh comment-text {page_id} "AI 分析完成。Tracer 確認此 bug 已於 commit {fixed_commit} 修復，無需再發 PR。
分析報告：" "{drive_link}"
bash /Users/user/aladdin/scripts/notion.sh update-prop {page_id} "AI分析" select "分析成功"
```
**i18n_manual_handoff**：
```bash
bash /Users/user/aladdin/scripts/notion.sh comment-text {page_id} "AI 分析完成。主因為 i18n 翻譯缺失/錯誤，依專案規範 AI 不主動修 localizations JSON。已在分析文件附上建議匯入的 key/value 草稿：
請開發者參考 i18n keys 清單從 Google Sheets 匯入：" "{drive_link}"
bash /Users/user/aladdin/scripts/notion.sh update-prop {page_id} "AI分析" select "分析成功"
```
**needs_qa_clarification**（另發 TG）：
```bash
bash /Users/user/aladdin/scripts/notion.sh comment-text {page_id} "AI 在實證 grounding 階段發現 bug 單描述與 CQA 實際狀況可能有出入，需 QA 確認後才繼續分析：
{qa_question}
（完整佐證見分析文件）" "{drive_link}"
bash /Users/user/aladdin/scripts/notion.sh update-prop {page_id} "AI分析" select "待釐清"
bash /Users/user/aladdin/scripts/tg-notify.sh --email "{reviewer_email}" --text "🟡 [待釐清] {ticket_id}
AI 發現 bug 單與 CQA 實況可能有出入，需你確認：
{qa_question}
分析文件：{drive_link}
Notion：{notion_url}"
```
**failed**（無 drive link）：
```bash
bash /Users/user/aladdin/scripts/notion.sh comment-text {page_id} "AI 分析失敗，需人工介入。
失敗原因：{failure_reason}
Tracer 嘗試：{tracer_attempt} 次，Fixer 嘗試：{fixer_attempt} 次（總 {total_attempt}）"
bash /Users/user/aladdin/scripts/notion.sh update-prop {page_id} "AI分析" select "分析失敗"
```

## Step 8：解鎖 + tracker 終態 + 完成報告（**所有出口路徑必經**，包含中途 SKIPPED 之後）

```bash
bash /Users/user/aladdin/scripts/bug-lock.sh release {ticket_id}
```
| pipeline_status | tracker.sh 指令 |
|---|---|
| success / already_fixed / i18n_manual_handoff | `tracker.sh set {ticket_id} done "$(date '+%Y-%m-%d %H%M')"` |
| failed | `tracker.sh set {ticket_id} failed "$(date '+%Y-%m-%d %H%M')"` ＋ `tracker.sh log-fail {ticket_id} "<一句失敗原因，含死在哪一步>"` |
| needs_qa_clarification | `tracker.sh set {ticket_id} needs_qa "$(date '+%Y-%m-%d %H%M')"` |
| Step 0.5 NOT_TECH | `tracker.sh set {ticket_id} pending`（完成時間不填） |

解鎖與 tracker 終態寫完後，緊接著輸出完成報告（不再分獨立步驟）：

```
## {ticket_id} /create-mr Pipeline Complete
- Pipeline status: {pipeline_status}
- Reviewer: {reviewer_email}
- Attempts: tracer {tracer_attempt} / fixer {fixer_attempt} / total {total_attempt}
- Review（Step 6 三位）：A(品質)={PASSED|FAILED} / B(對抗性)={PASSED|FAILED} / C(TDD情境)={PASSED|FAILED}
- Bootstrap: {ok | PARTIAL(db-seed)——已於 Notion 留言披露}
- Fresh pull（Step 0-a）: {FRESH_PULL_OK | FRESH_PULL_FAIL:<原因>}
- Google Drive: {drive_link}
- MR(s): {每 repo 一行；非 success 顯示 "(N/A - {pipeline_status})"}
- Notion AI分析: {分析成功|分析失敗|待釐清}
- TG 通知: {tg_notify_result}；chat_id 同步: {tg_chatid_sync_result}
- Worktree: {worktree_path}；文件: /Users/user/aladdin/obsidian/Debug/{ticket_id}/
```

## Pipeline Failure（統一定義）

任一步驟超過重試上限、或 SETUP_FAIL 二連敗、或 resolve-reviewer 二連 ERROR：
1. `pipeline_status=failed`，`failure_reason` 寫清楚「死在哪一步 + 最後一個錯誤訊息的第一行」。
2. 跳過 7a/7b，走 7c 的 failed 分支。
3. **必跑 Step 8**（解鎖 + `failed` + `log-fail` + 完成報告）。
4. failed 不上傳 Drive、不開 MR、不留成功留言。

**needs_qa_clarification 不是 failed**：它是正常暫停等 QA，走自己的出口（7a+7c+TG+tracker `needs_qa`）。
