---
description: Use when a tech-assigned bug ticket needs the full automated fix pipeline — claims one pending/rerun ticket from bug_analysis_tracker.md, produces root-cause analysis, code fix + L0 tests in an isolated worktree, review, then MR against dev with Notion writeback.
argument-hint: "[ticket_id]"
---

# /create-mr Pipeline v2（claim 一張工單 → 分析 → 修復+L0 測試 → 審查 → 推 MR）

你是 pipeline manager，只管狀態與派工，**不自己讀 Notion 內容、不自己讀程式碼、不自己讀長文件**（調度守則見 `.claude/doctrine/10-model-dispatch.md`）。

**自主聲明：本指令為全自動 pipeline。** 執行期間不適用 brainstorming 等互動式流程 skill；除本文標記的停點外不等待使用者輸入。

## 參數

`$ARGUMENTS`：可選 `ticket_id`（如 `FAQ-1702`）。有 → 處理指定單；無 → 自動挑第一張可認領單。

## Manager 鐵律

1. tracker 只用 `bash /Users/user/aladdin/scripts/tracker.sh` 操作（`next`/`row`/`set`/`counts`/`log-fail`）。**禁止 cat 整個 tracker、禁止用 Edit tool 直改**（檔案 166KB）。
2. Notion 寫回只用 `bash /Users/user/aladdin/scripts/notion.sh`（`comment-text`/`update-prop`）。**禁止手寫含 token 的 curl。**
3. 派工一律用 Agent tool 的 `subagent_type` 直接引用註冊 agent（如 `subagent_type: bug-tracer-with-callgraph`）。**prompt 裡禁止出現「Use all text in {agent .md 路徑} as the prompt」**——定義檔本來就是該 agent 的 system prompt，叫它再讀一次 = 每次多燒 1 萬+ token。prompt 只放：本單變數、文件路徑、回報格式。
4. 每步派工都用同步等待（`run_in_background: false`）。agent 若中途讓出（未給出契約尾行就結束）→ 視為該次嘗試失敗重派接手（worktree 內既有變更由接手者延續）。tracer/fixer 的重派計入其 attempt 上限；**其他步驟（1/2/2.5/6/7a/7b）的契約缺失重派以 1 次為限**，再缺失依該步的降級或失敗分支處理，不得無限重派。
5. 模型分級已寫死在各 agent 定義檔 frontmatter（tracer/grounder=opus、fixer/reviewer/pusher 等=sonnet），派工時**不要**另指定 `model` 覆蓋，除非走到「升級路徑」（`10-model-dispatch.md` 第 5 節）。

## State Variables

```
ticket_id, notion_url, page_id            # page_id = URL 尾 32hex 轉 UUID(8-4-4-4-12)
reviewer_email                            # Step 0.5 推導
grounding_result, qa_question             # Step 2.5
affected_repos = []                       # Step 3 契約尾行
bootstrap_partial = false                 # Step 4（true 時所有出口留言/報告須披露）
tracer_attempt / fixer_attempt / total_attempt = 0
review_result, pipeline_status            # success | already_fixed | i18n_manual_handoff | needs_qa_clarification | failed
fixed_commit, drive_link, mr_links, failure_reason
tg_notify_result, tg_chatid_sync_result
worktree_path = /Users/user/aladdin/worktrees/{ticket_id}
```

**重試上限（全流程統一）**：`tracer_attempt ≤ 2`、`fixer_attempt ≤ 3`、`total_attempt ≤ 5`（tracer+fixer 派工合計）。任一超限 → 走 failed 出口。狀態存對話裡即可，但**每次派工前先把目前計數寫在該步的狀態行**（context 壓縮後以最近的狀態行為準）。

## Step 0：TG chat_id 回填（best-effort，任何錯誤不阻斷、不派 agent）

```bash
bash /Users/user/aladdin/scripts/tg-map-chatids.sh --list
```
輸出 TSV：`chat_id source tg_first_name tg_username confidence candidate_email candidate_name alt_candidates`。
- 無輸出/失敗 → `tg_chatid_sync_result="SKIPPED"`，進 Step 0.1。
- `confidence == HIGH` 的行 → `tg-map-chatids.sh --set <candidate_email> <chat_id>`；對 `SET_OK` 者 `tg-notify.sh --email <email> --text "<tg_first_name> 連結成功"`。
- `confidence == ASK` → 不問不寫，只記入彙總。
- 彙總 `tg_chatid_sync_result = "自動對映 N / ASK 待處理 M / 確認訊息 X SENT, Y FAIL"`。

## Step 0.1：Claim

1. 取目標行（單行輸出，不讀全檔）：
   - 有參數：`bash /Users/user/aladdin/scripts/tracker.sh row {ticket_id}` → 狀態不是 `pending`/`rerun` → 輸出 `SKIPPED: {ticket_id} not claimable` 後結束。
   - 無參數：`bash /Users/user/aladdin/scripts/tracker.sh next` → `NO_CLAIMABLE` → 輸出 `No pending tickets. Run: bun obsidian/scripts/notion-bug-query-v2.ts` 後結束。
2. 從該行抽 `ticket_id`、`notion_url`，算 `page_id`。
3. `bash /Users/user/aladdin/scripts/bug-lock.sh claim {ticket_id}` → `LOCKED` → 輸出 `SKIPPED: already locked` 後結束。
4. `bash /Users/user/aladdin/scripts/tracker.sh set {ticket_id} in_progress`
5. **此後任何退出路徑都必須執行 Step 8**（解鎖 + tracker 終態）。

## Step 0.5：Reviewer 推導（tech 名單複核）

```bash
bash /Users/user/aladdin/scripts/resolve-reviewer.sh {page_id}
```
- `TECH_MATCH:<email>` → 存 `reviewer_email`，續 Step 1。
- `NOT_TECH` → 非技術人員的單不歸本流程（**不是失敗**，不留言、不動 AI分析）：輸出 `SKIPPED: 當前指派不在 tech 名單`，直接走 Step 8 的 NOT_TECH 行（釋鎖 + 還原 pending）後結束。
- `ERROR:*` → 重跑一次；仍 ERROR → `pipeline_status=failed`（`failure_reason`=該錯誤），跳 Step 7c。

## Step 1：Bug Report Analyst

派工 `subagent_type: bug-report-analyst`：
```
分析這張 Notion bug 工單並依你的職責產出分析文件。
Notion URL: {notion_url}
ticket_id: {ticket_id}
回報格式（最後一行，值域照你的定義檔）：
SCREENSHOT_STATUS: <OK|SKIPPED|PARTIAL_FAIL|ALL_FAILED>（可附括號說明）
```
等待完成。文件落點：`/Users/user/aladdin/obsidian/Debug/{ticket_id}/{ticket_id}-analytics.md`。
尾行缺失時：`ls` 該 analytics.md——存在 → 視為完成續行；不存在 → 重派 1 次；仍無 → analytics 是全流程根基，走 failed 出口（`failure_reason="Step 1 無法產出 analytics.md"`）。

## Step 2：Spec Fetcher（可降級）

派工 `subagent_type: spec-fetcher`：
```
為受影響模組尋找業務規格文件並產出 spec 摘要。
ticket_id: {ticket_id}
回報格式（最後一行）：SPEC_RESULT: <found|not_found> PATH: <spec.md 路徑或 N/A>
```
對映：agent 內部的 `SPEC_COMPLETE` = `found`；`SPEC_INCOMPLETE`（不論何種原因）= `not_found`。兩者後續處理相同：`not_found` → 繼續（graceful degradation）。

## Step 2.5：CQA Grounder（實證 grounding，可早停）

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
- `NEEDS_QA_CLARIFICATION` → `pipeline_status=needs_qa_clarification`、存 `qa_question` → 跳 Step 7（走 7a+7c）。
- grounder 整個失敗/未產出 grounding.md → 當作 CONSISTENT 繼續（不擋流程）。
- 否則續 Step 3，tracer prompt 附 grounding 路徑。

## Step 3：Bug Tracer（with method-call-graph）

`tracer_attempt += 1`、`total_attempt += 1`；超限（tracer>2 或 total>5）→ failed 出口。

派工 `subagent_type: bug-tracer-with-callgraph`：
```
分析此 bug、追出 root cause、寫出完整 analysis-notes 文件。
ticket_id: {ticket_id}
analytics: /Users/user/aladdin/obsidian/Debug/{ticket_id}/{ticket_id}-analytics.md
spec: /Users/user/aladdin/obsidian/Debug/{ticket_id}/{ticket_id}-spec.md
grounding: /Users/user/aladdin/obsidian/Debug/{ticket_id}/{ticket_id}-grounding.md
歷史失效模式素材：先讀 /Users/user/aladdin/obsidian/Rules/_index.md 的「分析與失效模式（回測踩坑）」分類，挑出與本 ticket 模組相關的條目讀完再開始追因（回測 885 單顯示 13.5% 分析錯誤多為重複模式，先讀可避開）。
{第 2 次派工時加：前次分析被否決。否決回饋：<reviewer 或 fixer 的具體回饋（路徑或摘要）>。請針對回饋重新分析。}
回報格式（最後 4 行；TRACER_RESULT 值域就是你定義檔規定的那兩個，後三行是本次派工的附加要求）：
TRACER_RESULT: <ROOT_CAUSE_FOUND|NEEDS_QA_CLARIFICATION>
AFFECTED_REPOS: <逗號分隔，僅限 agrabah,abu,lago,rajah；無則 none>
I18N_ONLY: <yes|no|mixed>   （primary_fix_paths 全部是 localizations/*.json → yes；部分 → mixed）
ALREADY_FIXED: <no|yes commit=<hash>>   （你在 Already-Fixed Verification 判定此 bug 確已被既有 commit 修復時填 yes 並附該 commit hash，否則 no）
```
**收到回報後，manager 依序做（全部是定向抽取，不整讀 analysis-notes）：**

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
- `I18N_ONLY: yes` → `pipeline_status=i18n_manual_handoff`；先用第 2 點的 sed 指令把 primary_fix_paths 段**原文留存**（Step 7a 的 i18n_keys 要用）→ 跳 Step 7（7a+7c）。
- `I18N_ONLY: mixed` → 續行，但 Step 5 的 fixer prompt 必須加：「i18n JSON 路徑禁止寫入，僅修 code 部分；把 i18n key 清單寫入 `/Users/user/aladdin/obsidian/Debug/{ticket_id}/{ticket_id}-i18n-keys-to-import.md`」。
- `AFFECTED_REPOS: none` 且 sed 補救後仍無四大 repo 路徑 → **不進 Step 4/5**（全 symlink 環境 fixer 無合法落筆處）：`pipeline_status=failed`、`failure_reason="修復落點不在 agrabah/abu/lago/rajah（共用庫或非程式碼變更），pipeline 不支援，需人工"` → failed 出口。
- 其餘（ROOT_CAUSE_FOUND + 有效 repos）→ 續 Step 4。

## Step 4：Worktree 環境（一律走腳本，不要內嵌 bash）

```bash
bash /Users/user/aladdin/scripts/setup-worktree.sh {ticket_id} {affected_repos 以空格分隔}
```
看**最後一行**：
- `SETUP_OK` → 續 Step 5。
- `SETUP_OK BOOTSTRAP_PARTIAL:db-seed` → `bootstrap_partial=true`，續 Step 5。（含義：程式碼生成已完成、只有 DB 資料供給步驟失敗——本 pipeline 只做 L0 測試不連 DB，可以續行；但 Step 7 的留言與 Step 9 報告**必須披露**這件事。log 在 `{worktree_path}/bootstrap.log`。）
- `SETUP_FAIL:*` → 再跑一次；仍失敗 → failed 出口（`failure_reason` = 該行）。

## Step 5：Bug Fixer With Tests

`fixer_attempt += 1`、`total_attempt += 1`；超限（fixer>3 或 total>5）→ failed 出口。

派工 `subagent_type: bug-fixer-with-tests`：
```
依 analysis-notes 在 worktree 實作修復並撰寫純 L0 單元測試，同一個 commit。
ticket_id: {ticket_id}
analysis notes: /Users/user/aladdin/obsidian/Debug/{ticket_id}/{ticket_id}-analysis-notes.md
analytics: /Users/user/aladdin/obsidian/Debug/{ticket_id}/{ticket_id}-analytics.md
worktree_path: {worktree_path}
affected_repos: {affected_repos}
{mixed 時加 i18n 禁令，見 Step 3}
{重派時加：前次審查未過。reviewer 回饋：/Users/user/aladdin/obsidian/Debug/{ticket_id}/{ticket_id}-reviewer-report.md。請在同分支上修正後重新 commit。}
回報格式（最後兩行）：
FIXER_RESULT: <DONE|BRANCH_ERROR|ANALYSIS_MISMATCH>
COMMIT: <hash|N/A>
```
- `BRANCH_ERROR` → 重跑 Step 4 的腳本（清殘留重建），再重派 fixer 一次；仍 BRANCH_ERROR → failed 出口。
- `ANALYSIS_MISMATCH`（fixer 判定分析無法落地，例如指到的程式碼不存在）→ 回 Step 3 重派 tracer（帶 fixer 的具體回饋）；tracer 已達上限 → failed 出口。

## Step 6：Solution Reviewer

派工 `subagent_type: solution-reviewer`：
```
對 fixer 的產出做 5 維度驗證（bun test 過 / diff 對齊 tracer / 測試涵蓋 / lint 乾淨 / agrabah edge case），寫 reviewer report。
ticket_id: {ticket_id}
worktree_path: {worktree_path}
affected_repos: {affected_repos}
analysis_notes: /Users/user/aladdin/obsidian/Debug/{ticket_id}/{ticket_id}-analysis-notes.md
report 落點: /Users/user/aladdin/obsidian/Debug/{ticket_id}/{ticket_id}-reviewer-report.md
回報格式（最後兩行）：
FAIL_KIND: <implementation|analysis|N/A>   （FAILED 時判定問題出在實作還是 tracer 的分析本身；PASSED 填 N/A）
REVIEW_RESULT: <PASSED|FAILED>
```
決策（按此優先序，第一個命中就走）：
| 條件 | 動作 |
|---|---|
| PASSED | `pipeline_status=success` → Step 7 |
| FAILED 且 FAIL_KIND=analysis 且 tracer_attempt<2 | 回 Step 3 重派 tracer（帶 reviewer report 路徑作為否決回饋） |
| FAILED 且 fixer_attempt<3 且 total_attempt≤5 | 回 Step 5（帶 reviewer report） |
| 其餘 FAILED（已達上限） | failed 出口 |

FAIL_KIND 行缺失 → 視為 `implementation`（走 fixer 重試分支），不要為了它重派 reviewer。

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
i18n_keys: {依情境填——I18N_ONLY: yes：貼上 Step 3 留存的 primary_fix_paths 段原文；mixed：/Users/user/aladdin/obsidian/Debug/{ticket_id}/{ticket_id}-i18n-keys-to-import.md；其他：N/A}
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
回報契約＝mr-pusher 定義檔的原生五行（MR_LINKS 為 JSON 陣列、DRIVE_LINK、REVIEWER、NOTION_COMMENT、`NOTION_AI_FIELD: ok|failed`）。manager 從最終訊息**grep 行首**抓 `MR_LINKS:` 與 `NOTION_AI_FIELD:` 兩行即可，**不要假設它們是最後兩行**。`NOTION_AI_FIELD: failed*` → manager 補打一次（成功路徑的值寫死）：`bash /Users/user/aladdin/scripts/notion.sh update-prop {page_id} "AI分析" select "分析成功"`，仍失敗記入 Step 9 報告。

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
bash /Users/user/aladdin/scripts/notion.sh comment-text {page_id} "AI 分析完成。主因為 i18n 翻譯缺失/錯誤，依專案規範 AI 不主動修 localizations JSON。
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

## Step 8：解鎖 + tracker 終態（**所有出口路徑必經**，包含中途 SKIPPED 之後）

```bash
bash /Users/user/aladdin/scripts/bug-lock.sh release {ticket_id}
```
| pipeline_status | tracker.sh 指令 |
|---|---|
| success / already_fixed / i18n_manual_handoff | `tracker.sh set {ticket_id} done "$(date '+%Y-%m-%d %H%M')"` |
| failed | `tracker.sh set {ticket_id} failed "$(date '+%Y-%m-%d %H%M')"` ＋ `tracker.sh log-fail {ticket_id} "<一句失敗原因，含死在哪一步>"` |
| needs_qa_clarification | `tracker.sh set {ticket_id} needs_qa "$(date '+%Y-%m-%d %H%M')"` |
| Step 0.5 NOT_TECH | `tracker.sh set {ticket_id} pending`（完成時間不填） |

## Step 9：完成報告

```
## {ticket_id} /create-mr Pipeline Complete
- Pipeline status: {pipeline_status}
- Reviewer: {reviewer_email}
- Attempts: tracer {tracer_attempt} / fixer {fixer_attempt} / total {total_attempt}
- Review: {review_result}
- Bootstrap: {ok | PARTIAL(db-seed)——已於 Notion 留言披露}
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
3. **必跑 Step 8**（解鎖 + `failed` + `log-fail`）。
4. failed 不上傳 Drive、不開 MR、不留成功留言。

**needs_qa_clarification 不是 failed**：它是正常暫停等 QA，走自己的出口（7a+7c+TG+tracker `needs_qa`）。
