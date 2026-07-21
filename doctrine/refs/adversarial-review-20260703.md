# 對抗審查報告（2026-07-03）

> 審查者：fresh-context 對抗審查 agent（未參與撰寫）。對齊標準：內部一致、與環境事實相符、弱模型可無歧義執行。
> 受審物：CLAUDE.md ×2、使用者層 CLAUDE.md、doctrine 00~50 + refs ×4、create-mr.md v2、create-mrs.md v2、scripts/{tracker,setup-worktree,resolve-reviewer,sync-mirrors,notion}.sh、8 個 pipeline agent 定義檔。
> 所有結論皆有實讀 file:line 或實跑證據；實跑僅限唯讀操作（tracker next/row/counts、sync-mirrors --check、setup-worktree --dry-run、awk 離線模擬、sed/cut 重現），未執行任何寫入、未觸碰 Notion/TG API。

## 總判定：FAILED（BLOCKER ×2、MAJOR ×9、MINOR ×17）

---

## BLOCKER（任一存在即不可上線）

### B1. resolve-reviewer.sh 的 token 提取對新版 notion.sh 格式失效 → 每張單 100% 死在 Step 0.5
- 位置：`scripts/resolve-reviewer.sh:20-21`；根因在 `scripts/notion.sh:10` 本次改版（`NOTION_TOKEN="${NOTION_TOKEN:-ntn_…}"` env-override 格式）。
- 問題：`sed 's/^NOTION_TOKEN="//; s/".*$//; …'` 對新格式取回**字面字串** `${NOTION_TOKEN:-ntn_…}`（含 shell 語法，非有效 token）。已實跑重現：`VERDICT: sed extraction BROKEN`；環境亦無 `NOTION_TOKEN` env（實測 NO）。curl 會送無效 Bearer → Notion 回 error → `ERROR:` → create-mr.md Step 0.5 規定二連 ERROR 即 `failed`。**整條 pipeline 每張單都會在 Step 0.5 標 failed 並寫「分析失敗」進 Notion。**
- 連帶：`obsidian/agents/spec-fetcher.md:30`（`cut -d'"' -f2`）同根因壞掉（實測同爛字串）→ Step 2 所有 DB query 401 → 永遠 SPEC_INCOMPLETE（靜默降級，功能全滅）。
- 佐證：change-log.md:7 自承 resolve-reviewer 僅 `bash -n` 驗證、「API 呼叫待首次 pipeline 實跑驗證」——40 號協議第 2 節的一致性檢查（grep 改動關鍵字）若有做 `NOTION_TOKEN=` 就會抓到這兩個消費者。
- 修法：resolve-reviewer.sh 與 spec-fetcher.md 改為 `grep -oE 'ntn_[A-Za-z0-9]+' notion.sh | head -1`，或統一改成 `TOKEN=$(bash -c 'source /Users/user/aladdin/scripts/notion.sh >/dev/null 2>&1; echo "$NOTION_TOKEN"')` 類單一出口；修完對真 API 打一發驗證。

### B2. bug-tracer-with-callgraph 輸出契約值域與 create-mr.md Step 3 互斥
- 位置：`obsidian/agents/bug-tracer-with-callgraph.md:698` vs `obsidian/commands/create-mr/create-mr.md:124-127`。
- 問題：agent 定義檔強制「正常完成則輸出 `TRACER_RESULT: ROOT_CAUSE_FOUND`」（僅兩值：ROOT_CAUSE_FOUND / NEEDS_QA_CLARIFICATION）；dispatch prompt 要求「逐字照格式 `TRACER_RESULT: <OK|ALREADY_FIXED|NEEDS_QA_CLARIFICATION>`」。`OK` 與 `ROOT_CAUSE_FOUND` 互斥；`ALREADY_FIXED` 在定義檔**完全沒有對應尾行**（定義檔 Step 4 有 Already-Fixed Verification 判定邏輯與「已修復紀錄」section，但尾行值域不含它，FIXED_COMMIT 尾行也無定義）。system prompt 與 dispatch prompt 兩源矛盾，弱模型輸出不可預測；manager 收到 `ROOT_CAUSE_FOUND` 這個非法值時 create-mr.md 無 fallback 規則（「尾行缺失補救」只覆蓋 AFFECTED_REPOS/I18N_ONLY），最壞路徑：視為契約缺失重派 → tracer_attempt≤2 耗盡 → 每張正常單 failed。
- 修法：二選一並全鏈同步——(a) 改 tracer 定義檔 line 698 值域為 OK|ALREADY_FIXED|NEEDS_QA_CLARIFICATION 並補 4 行尾行約定（含 FIXED_COMMIT 從「已修復紀錄」取 hash 的規則）；(b) 改 create-mr.md 值域遷就定義檔。修改須同步 bug-tracer.md 雙胞胎（定義檔自身要求）。

---

## MAJOR

### M1. 「token 單一來源 = notion.sh」宣稱與環境事實不符（誤導未來輪替）
- 位置：`00-diagnosis-20260703.md:60`、`50-letter-to-future-sessions.md:8` vs 實測 grep。
- 問題：明文 token 仍存在於 8 個非 notion.sh 檔案：agents/{bug-report-analyst,drive-uploader-mr,drive-uploader,mr-pusher}.md、obsidian/scripts/{notion-backtest-query,notion-bug-query,notion-bug-query-v2}.ts、sync-bug-tracker.py。50 號信「指令檔的 8 處已清除」對 commands/ 為真，但 00 號「單一來源已實作」為假——未來照信件輪替 token 只改 notion.sh + .env，pipeline 內 4 個 agent 的舊 token 全數失效。
- 修法：agent 檔全部改走 `bash /Users/user/aladdin/scripts/notion.sh`（或 grep 提取單一出口）；修不完就把 00/50 的宣稱改為「已收斂 commands/，agents 與 query 腳本仍有 8 處明文（清單）」。

### M2. pitfalls-worktree.md 的 .env.local 修法條件與 setup-worktree.sh 實作相反
- 位置：`refs/pitfalls-worktree.md:19`（「當 **rajah** 在 affected_repos 時」）vs `scripts/setup-worktree.sh:87`（`is_affected "agrabah"`）。
- 問題：文件宣稱「已固化進腳本」的條件與腳本不同。腳本才對：.env.local 只在 agrabah 是真 worktree 時才缺；照文件條件在「rajah affected、agrabah 為 symlink」情境執行 `ln -sfn` 會穿透 symlink 打到主 repo，把真 .env.local 換成自指 symlink（毀主 repo 配置）。弱模型在腳本異常時按文件手工操作會出事故。
- 修法：依 40 號裁決規則（腳本為準）修 pitfalls-worktree.md line 19 為「當 agrabah 在 affected_repos（即 agrabah 為真 worktree）時」。

### M3. CLAUDE.md「改動任一邊後跑 sync」vs sync-mirrors.sh 單向覆蓋
- 位置：`CLAUDE.md:4`（「改動任一邊後必須執行 sync-mirrors.sh」）vs `scripts/sync-mirrors.sh:25-32`（無條件 root→obsidian `cp`）與 `40-maintenance-protocol.md:9`（「改完**前者**必跑」）。
- 問題：改了 obsidian/CLAUDE.md 再照 CLAUDE.md 指示跑 sync → 修改被 root 版靜默覆蓋（腳本回 SYNCED 無警告）。三處說法不一致，其中 CLAUDE.md 的指示會導致資料丟失。
- 修法：CLAUDE.md line 4 改為「只允許改專案根那份（canonical），改完跑 sync-mirrors.sh 鏡像到 obsidian」；或腳本在 obsidian 側較新時拒絕覆蓋並報 DRIFT。

### M4. mr-pusher 回報契約與 create-mr.md 7b 期待不匹配
- 位置：`create-mr.md:234-236`（「最後兩行：`MR_LINKS: <逗號分隔的 MR URL>`、`NOTION_AI_FIELD: <ok|fail>`」）vs `obsidian/agents/mr-pusher.md:267-273`（五行輸出：MR_LINKS 為 JSON 物件陣列、DRIVE_LINK、REVIEWER、NOTION_COMMENT、`NOTION_AI_FIELD: ok | failed (HTTP <status>)`）。
- 問題：格式（逗號分隔 vs JSON 陣列）、值域（fail vs failed）、位置（最後兩行 vs 倒數第 1/5 行）三重不一致；manager 嚴格抓最後兩行會漏掉 MR_LINKS。
- 修法：統一為一種格式（建議以 agent 定義的五行為準、修 create-mr.md 的期待與抓取說明，值域統一 ok|failed）。

### M5. Step 1 契約值域衝突＋非 tracer/fixer 步驟的重派無上限
- 位置：`create-mr.md:80`（`SCREENSHOT_STATUS: <ok|partial|none>`）vs `obsidian/agents/bug-report-analyst.md:166-171`（`OK|SKIPPED|PARTIAL_FAIL|ALL_FAILED` 且僅約定這一行為最後一行，無 TICKET_ID 行）；`create-mr.md:21`（鐵律 4：契約缺失「計入 attempt 上限後重派」）。
- 問題：兩份指示值域互斥（agent 正常輸出 `SKIPPED (…)` 不在 manager 宣告值域）；且 Step 1/2/2.5/7a 沒有任何 attempt 計數器（total_attempt 明文只算 tracer+fixer），「計入 attempt 上限」對這些步驟是未定義操作——弱模型判定契約不符時可無限重派。
- 修法：create-mr.md Step 1 值域改抄 agent 定義的四值；鐵律 4 補一句「非 tracer/fixer 步驟的契約缺失重派以 1 次為限，再缺失視同該步失敗按其分支處理」。

### M6. Step 7b 的 bug_summary 抽取指令對真實 analytics.md 無效（已實測）
- 位置：`create-mr.md:220-221` vs `obsidian/agents/bug-report-analyst.md:63-118`（文件格式無 `^#` 開頭的標題行、無「Bug 描述」「標題」字樣）。
- 問題：對真實檔案（FAQ-3356-analytics.md）實跑 `grep -m2 -A2 "^#\|Bug 描述\|標題" | head -5`，抓到的是 `## All Comments` 與一條 QA 留言——MR title 會變成 `fix: [FAQ-xxxx] ## All Comments` 級別的垃圾，弱模型會照抄。
- 修法：改抓固定欄位，如 `grep -m1 '^Actual Result:' -A1` 或抓 `Affected Module:` + `Actual Result:` 合成；或要求 bug-report-analyst 在尾行契約加一行 `BUG_SUMMARY: <一句話>`。

### M7. `AFFECTED_REPOS: none` 續行導向死路
- 位置：`create-mr.md:140`（「none 也續（Step 4 不帶 repo 參數）」）→ Step 5 派 fixer；`obsidian/agents/bug-fixer-with-tests.md:25`（symlink repo 唯讀、禁改主 checkout）。
- 問題：none 時 worktree 全為 symlink，fixer 無合法落筆處（改任何檔都違規），也無 repo 可 commit——必然以違規或卡死收場。none（根因在 jasmine/genie/jafar 共用庫、或無 code 改動的結論）沒有自己的出口。
- 修法：`AFFECTED_REPOS: none` 且 TRACER_RESULT: OK 時定義專屬出口（如視同 needs_qa/failed 附原因，或人工 handoff），不進 Step 4/5。

### M8. tracker.sh next 的 exclude 清單被「逗號+空格」打壞（已實測）
- 位置：`scripts/tracker.sh:27-31` vs `create-mrs.md:30-33`（skip_list「逗號串」無格式警告）。
- 問題：實測 `next "FAQ-3757, FAQ-3468"`（逗號後帶空格）仍回 FAQ-3468——排除靜默失效。弱模型 append skip_list 高機率帶空格 → batch 反覆挑到已 SKIP 的鎖定單，形成同單循環。
- 修法：tracker.sh next 對 EXCLUDE 先 `gsub(/ /,"",ex)`（一行）；create-mrs.md 同步註明「不含空格」。

### M9. Step 6「FAILED 且 report 明指分析錯誤 → 回 Step 3」對 manager 不可判定
- 位置：`create-mr.md:185-190` 分支表 vs `obsidian/agents/solution-reviewer.md:205-220`（契約僅 `REVIEW_RESULT: PASSED|FAILED` 一行）。
- 問題：manager 被鐵律禁止讀長文件，而「是否明指分析錯誤」只能讀 reviewer report 全文才知道；且該行與「FAILED 且 fixer<3 → 回 Step 5」可同時滿足，表格未定優先序。弱模型只能永遠走回 Step 5 或違規讀全文。
- 修法：reviewer 契約加一行 `FAIL_KIND: implementation|analysis|N/A`（create-mr.md 與 solution-reviewer.md 同步），分支表改依 FAIL_KIND 判斷並明定優先序。

### M10. i18n_manual_handoff 的 i18n_keys 參數語意斷裂
- 位置：`create-mr.md:212`（7a prompt：「i18n_keys: {i18n_manual_handoff 時傳**清單檔路徑**}」）vs `obsidian/agents/drive-uploader-mr.md:39`（期待「i18n_keys **清單**（從 Tracer 的 primary_fix_paths 解析）」並自產 i18n-keys-to-import.md）。
- 問題：yes 路徑早停於 Step 3，無人產過清單檔（該檔只在 mixed 路徑由 fixer 產出）；manager 也無明文步驟從 analysis-notes 抽 keys（鐵律禁整讀）。弱模型 manager 不知道該填什麼——填不存在的路徑或 N/A，i18n 出口交付物（keys 清單）品質崩壞。
- 修法：create-mr.md 在 I18N_ONLY: yes 分支明文「用 Step 3 的 sed 補救指令抽 primary_fix_paths 段，把其中 localizations 路徑/keys 原文貼進 7a prompt 的 i18n_keys」；或讓 drive-uploader-mr 定義自己從 analysis-notes 抽（它本就要讀該檔）。

---

## MINOR

1. `CLAUDE.md:4`（兩副本同文）— obsidian 副本中「本檔與 `obsidian/CLAUDE.md` 為兩個副本」變成自指；建議改寫為並列兩個絕對路徑，使同一句在兩邊都成立。
2. `obsidian/agents/cqa-grounder.md:16`、`mr-pusher.md:22` — 引用「CLAUDE.md 的放行條款」該 section 已抽到 `refs/permissions-worktree.md`，引用斷鏈；改指 refs 檔。
3. `bug-fixer-with-tests.md:209-217`、`drive-uploader-mr.md:147`、`spec-fetcher.md:184` — 殘留 v3 名詞「Evaluator」（實際為 solution-reviewer / fixer 寫測試），弱模型會找不到對應角色；改名詞。
4. `mr-pusher.md:3,22` — 自稱「the only agent … permitted to run git push」與 CLAUDE.md「唯二例外」（mr-feedback-pusher 亦可 push）矛盾；改為「/create-mr 流程中唯一」或「唯二之一」。
5. `setup-worktree.sh:17-19` 檔頭 — 「判別法：主 repo 跑同指令若同錯」描述的是人工流程，腳本實作僅 grep 錯誤樣式、不做主 repo 對照；檔頭措辭改「以錯誤樣式判別（人工復核法：主 repo 跑同指令）」。
6. `tracker.sh:5` 檔頭 — 「7 欄 markdown table」與示例/實際（6 個內容欄）不符；改「6 欄」。
7. `10-model-dispatch.md:83` — 「Workflow 工具」非本環境存在的工具名（deferred 清單無此工具）；刪除或改為實際存在的編排機制名。
8. `30-delegation-templates.md` T1/T4 — 缺「驗收條件」槽位，與 10 號「三件套缺一不派」形式不齊（僅有「要求」段）；補槽位或在檔頭註明 T1/T4 的「要求」即驗收條件。
9. `create-mr.md:242-243` — `ls "$TG_SH" … || echo "TG_FAIL…"` 後無短路，弱模型照抄仍會執行下一行 `bash "$TG_SH"`（不阻斷但必報錯）；改成 `if ls…; then bash…; else echo TG_FAIL; fi`。
10. `notion.sh:98,130,172` — curl 空回應（網路失敗）時 python 解析錯誤被 `2>/dev/null` 吞掉 → exit 0 假成功；`notion.sh:154-158` update-prop text 分支把 `$PROP_NAME`/`$PROP_VALUE` 內插進 python 原始碼（引號注入；pipeline 現只用 select 不受影響）。加空回應檢查、text 分支改 argv 傳參。
11. `create-mr.md:90` — `SPEC_RESULT: <found|not_found>` 與 spec-fetcher 內部狀態（SPEC_COMPLETE/INCOMPLETE 四原因）對映未定義；因兩分支處理相同無實質後果，補一句對映即可。
12. `create-mr.md:68` vs `:298` — NOT_TECH 善後在 Step 0.5 與 Step 8 表重複描述同一動作（release 冪等、set pending 冪等，無實害）；建議 Step 0.5 改為「走 Step 8 的 NOT_TECH 行」單一出處。
13. `create-mrs.md:39` — 「context 未經壓縮可沿用流程文本」鼓勵憑記憶執行，與「檔案是唯一事實」精神相悖，且模型自知壓縮與否的能力存疑（有 fail-safe 方向但判準模糊）；建議改為一律重新 invoke。
14. `resolve-reviewer.sh:37` — 依賴 jq（環境有）但未前置檢查，jq 缺失時 `2>/dev/null` 吞錯 → 靜默 NOT_TECH 誤判（單被無限還原 pending）；開頭加 `command -v jq` 檢查改走 ERROR。
15. `40-maintenance-protocol.md:37` — 一致性檢查 grep 用相對路徑（`obsidian/commands/ … CLAUDE.md`），隱含 cwd=/Users/user/aladdin 前提未寫明；改絕對路徑。
16. `tracker.sh:47-54` set — 全檔重寫無檔級鎖，兩 session（create-mrs 明文預期並行）同時 set 不同單有毫秒級覆蓋窗口（bug-lock 為 per-ticket，保護不了 tracker 檔）；屬既有風險非本次引入，可加 mkdir 自旋鎖消除。
17. `.claude/backups/20260703-fable` — 實際備份目錄帶 `-fable` 後綴，與 40 號儀式模板 `backups/$(date +%Y%m%d)/` 不一致；統一其一。

---

## 七維度執行紀錄（查了什麼、怎麼查）

| 維度 | 查了什麼、怎麼查 | 結果 |
|---|---|---|
| 1. 規則互打 | 逐主題比對：重試上限（create-mr:39 唯一出處，Step 3/5/6 門檻互驗一致；與 10 號通用 ≤3 相容）、出口表（Step 7 表 vs Pipeline Failure 段 vs 7a 標題 vs drive-uploader-mr 表——failed 不跑 7a 四處一致 ✓）、tracker 狀態集合（tracker.sh 六值 ⊇ create-mr Step 8 / create-mrs 用值 ✓）、claim/lock 分工（create-mrs 不 claim、create-mr Step 0.1 claim，double-claim 已修 ✓）、OOM（CLAUDE.md/build-oom/fixer/reviewer 相容 ✓）、i18n 禁令（四處一致 ✓）、git push 授權（CLAUDE.md 唯二 vs mr-pusher 自稱唯一 → MINOR-4；permissions-worktree 與 agent 操作清單逐條對過 ✓）、.env.local 條件（→ M2）、sync 方向（→ M3） | M2、M3、MINOR-4 |
| 2. 路徑與工具名實在性 | 對文件引用的 33+ 絕對路徑逐一 `ls -ld`（6 個 doctrine 檔、5 個 skill 腳本、5+4 支 scripts、bug-lock/tg-notify/tg-map-chatids/daily_bootstrap/notion-bug-query-v2/cqa-query/gdrive/cqa-e2e libs/tech-users.csv/tracker/worktrees/backups/鎖目錄）→ 全部存在 ✓；Agent tool 的 8 個 subagent_type 逐一對照本環境註冊清單 ✓；Skill tool 名與 `create-mr:create-mr` 技能名 ✓；create-mr/create-mrs 無 SlashCommand 殘留 ✓（50 號信對 analyze-*/refine-mr 的殘留宣稱亦實測為真 ✓）；21 個 agent 全有 model frontmatter ✓；superpowers hook 路徑 ✓；腳本檔頭用法 vs 文件宣稱（tracker 五子指令 ✓、bug-lock claim/release 輸出 CLAIMED/LOCKED/RELEASED/NOT_LOCKED 冪等 ✓、tg-map-chatids --list 8 欄 TSV 與 create-mr Step 0 完全一致 ✓、tg-notify --email/--text ✓） | 全過（工具名無漂移） |
| 3. 雙實體同步 | `diff -q` 兩份 CLAUDE.md → IDENTICAL ✓；`sync-mirrors.sh --check` 實跑 → CLAUDE.md OK + 四 symlink 全 SYMLINK_OK、exit 0 ✓ | 過；附帶發現 M3（方向語意）與 MINOR-1（自指） |
| 4. 契約閉環 | 逐 agent 比對 dispatch prompt 要求 vs 定義檔輸出約定：tracer（→ B2）、fixer（FIXER_RESULT 三值 prompt 自足，但定義檔 Step 0 的 `BRANCH_ERROR: <描述>` 單行格式與 prompt 尾行格式並存、ANALYSIS_MISMATCH 僅存在於 prompt——可運作，計入 B2 同類觀察不另立）、reviewer（REVIEW_RESULT ✓ 但 FAIL_KIND 缺 → M9）、grounder（GROUNDING_RESULT/QA_QUESTION 兩行完全一致 ✓、降級行為與 Step 2.5 一致 ✓）、drive-uploader-mr（DRIVE_LINK ✓、failed 防禦性描述與「failed 不跑 7a」不衝突 ✓、i18n_keys → M10）、mr-pusher（→ M4）、bug-report-analyst（→ M5）、spec-fetcher（SPEC_RESULT 靠 prompt、found/not_found 對映 → MINOR-11；spec.md 保證產出 → Step 2.5/3 的 spec 路徑永遠有效 ✓） | B2、M4、M5、M9、M10 |
| 5. 弱模型誤讀點 | 佔位符逐一檢查（affected_repos 逗號→空格轉換有寫明 ✓、page_id 公式 ✓、qa_question 兩來源有寫 ✓、skip_list 格式無警告 → M8）、步驟跳轉（Step 2.5→7、3→7/4、5→4/3、6→5/3/7 編號全部存在且一致 ✓；「跳 Step 7（7a+7c）」與出口表互驗 ✓）、隱含前提（40 號 grep 相對路徑 → MINOR-15；bug_summary 抽取假設檔案格式 → M6 實測否證）、同名概念（create-mrs completed 有明文定義=done/failed/needs_qa ✓ 檔內一致；tracker done ≠ batch completed 已隔離 ✓）、none 分支（→ M7）、NOT_TECH 重複（→ MINOR-12）、7b.1 不短路（→ MINOR-9） | M6、M7、M8 + 多條 MINOR |
| 6. 腳本正確性抽查 | 五腳本 `bash -n` 全過 ✓；tracker.sh：awk $5=狀態/$7=完成時間以離線 awk 對 scratch 副本模擬 set（含帶/不帶 done_at）→ 欄位變換正確 ✓，counts 含 needs_qa 六狀態白名單 ✓，next 實跑（rerun 優先邏輯、pending 內 FAQ 降冪=3757 ✓、exclude 正常格式 ✓、exclude 帶空格失效 → M8）；setup-worktree.sh：`--dry-run FAQ-9999 agrabah` SETUP_OK ✓、爛 ticket/爛 repo → SETUP_FAIL exit 1 ✓、**空 REPOS**（bash 3.2.57 實機 + `${AFFECTED[@]:-}`）→ 正常全 symlink 不炸 ✓、CJK 前空格 workaround 在錯誤訊息中確認 ✓、.env.local 條件=agrabah-affected（dry-run 佐證）→ 與文件矛盾即 M2；resolve-reviewer.sh：CSV 實查 42 行×5 欄、pushed_repos 用**分號**、無引號欄 → `IFS=, read` 前三欄安全 ✓（name 含逗號的脆弱性 → 併 MINOR-14 註記）、token sed 實跑重現 BROKEN → B1、jq 存在 ✓ 但依賴未宣告 → MINOR-14；sync-mirrors.sh：cmp 邏輯 ✓、--check 實跑全綠 exit 0 ✓、單向覆蓋語意 → M3 | B1、M2、M3、M8 |
| 7. 與使用者原始需求對照 | 20 號：第 1~5 節每節皆有 ✅ 正例＋❌ 反例（1:15-16、2:24-26、3:36-38、4:48-50、5:64-65）✓；第 6 節為「無判準」誠實條款、第 7 節為快查表，性質非判準，不適用正反例要求（判定：符合）。30 號：T2/T3/T5 有驗收槽位+回報格式 ✓；T1/T4 有回報格式但缺「驗收條件」具名槽位 → MINOR-8。40 號：綠區（第 1 節 6 項）/紅區（6 項）明確分列 ✓、模糊時當紅區 ✓、改檔儀式/踩坑格式/精簡上限/裁決規則/健檢清單齊備 ✓（實測 CLAUDE.md 67 行 <120、doctrine 各檔 <300、commands 324/69 <400 全在上限內 ✓） | MINOR-8，餘過 |

## 通過項（找過、沒碴）

- 兩份 CLAUDE.md byte-identical；四個 symlink 健檢全綠。
- create-mr v2 的三處歷史矛盾修復（double-claim、failed/7a、SlashCommand→Skill）經實讀確認已修，無回滲。
- 重試上限、出口表、tracker 狀態集合、i18n 禁令、OOM 規則跨檔一致。
- 21 個 agent frontmatter model 分級與 create-mr 鐵律 5、10 號檔宣稱相符（tracer/grounder=opus、其餘=sonnet）。
- change-log 的行數宣稱（665→324、202→69）實測相符；50 號信對三個未改造指令檔的殘留宣稱實測相符。
- setup-worktree.sh 的 bash 3.2 空陣列、CJK 插值、失敗路徑契約（最後一行 SETUP_OK/SETUP_FAIL）實測全對。
- tg-map-chatids --list 的 8 欄 TSV 與 create-mr Step 0 宣稱逐欄一致；bug-lock.sh release 冪等（Step 8 重複執行安全）。

---

## 復核 2026-07-03（delta re-verification，同一 fresh-context 審查 agent）

> 對 29 項修復逐項重驗（重讀相關段落＋重跑原重現步驟，維持唯讀紀律），並檢查是否引入新矛盾。

### 復核判定：ISSUES_REMAIN（原 29 項中 28 項確認修復；1 項半套；另發現新問題 1 BLOCKER + 2 MINOR）

### 原發現逐項驗證

| 項 | 狀態 | 驗證方式與證據 |
|---|---|---|
| B1 | ✅ 修復 | notion.sh:10 還原純字面 token；resolve-reviewer.sh:19-24 jq 前置檢查＋env 優先＋`grep -oE 'ntn_…'`＋case 前綴驗證。實跑重現：新提取法 `EXTRACT_OK len=50`；spec-fetcher 的 cut 法對還原格式 `CUT_OK len=50` |
| B2 | ✅ 契約矛盾已解，但替代方案引入 NEW-1（見下） | create-mr.md:124 值域改 ROOT_CAUSE_FOUND\|NEEDS_QA_CLARIFICATION（遷就定義檔）；:130 非法值 fallback 明定；FIXED_COMMIT 尾行已刪 |
| M1 | ✅ | 00-diagnosis:60「token 並未全域單源化」＋8 檔清單；50-letter:8 九檔清單＋輪替全改警告＋spec-fetcher cut 格式依賴警告（清單與我原 grep 實測一致） |
| M2 | ✅ | pitfalls-worktree.md 修法段改「agrabah 在 affected_repos（真 worktree）」＋symlink 穿透毀主 repo 警告＋保留原始紀錄說明；CLAUDE.md 速記行同步（「agrabah 為真 worktree 時補 .env.local」） |
| M3 | ✅ | CLAUDE.md:4 canonical/唯讀鏡像語意（兩副本同文皆真，兼修 MINOR-1）；sync-mirrors.sh 新增 `-nt` CONFLICT 分支（順序：cmp→--check→-nt→cp，`cp -p` 保 mtime 不會自製衝突）；40 號 §0 同步。實跑 --check 全綠＋diff PAIR_IDENTICAL |
| M4 | ✅ | create-mr.md:243 改原生五行契約＋「grep 行首抓取、不假設最後兩行」＋NOTION_AI_FIELD failed 補打（補打值指涉小疵 → NEW-4） |
| M5 | ✅ | Step 1 值域改抄 agent 四值（OK\|SKIPPED\|PARTIAL_FAIL\|ALL_FAILED）、刪 TICKET_ID 行、加 ls analytics.md fallback；鐵律 4 補「其他步驟契約缺失重派以 1 次為限」 |
| M6 | ⚠ 半套（REMAINING-1） | create-mr.md 側 ✅（垃圾 grep 已刪、7b prompt 改為要 pusher 自讀合成）；但 mr-pusher.md:31 **未同步**，仍寫「由 manager 從 analytics.md 抽取的一句話」——prompt 傳入的是指示文字，定義檔期待成品值，弱模型可能把整段指示塞進 `--title`（M6 原症狀換形式重現）。修法：mr-pusher.md:31 改為「槽位可能是成品或『自行合成』指示；收到指示時讀 analytics.md 的 Affected Module＋Actual Result 合成 ≤60 字」並在 Execution Steps 加對應動作 |
| M7 | ✅ | create-mr.md:146 none（sed 補救後仍無四 repo 路徑）→ 不進 Step 4/5、failed 出口＋明確 failure_reason；與 Step 7 出口表 failed 行（不跑 7a）一致 |
| M8 | ✅ | tracker.sh:30 awk `BEGIN { gsub(/ /,"",ex) }`。實跑重現：`next "FAQ-3757, FAQ-3468"`（帶空格）→ 回 FAQ-3387，兩單皆正確排除；create-mrs.md:30 註明「不含空格」 |
| M9 | ✅ | solution-reviewer.md 檔內三處同步（report 模板尾兩行 :205-206、契約說明 :209-211、stdout 範例 :218-224）；create-mr.md:194-202 決策表明定優先序（analysis 分支在 fixer 分支之前）＋FAIL_KIND 缺失視為 implementation。無檔內殘留舊「最後一行」約定 |
| M10 | ✅ | create-mr.md:144 yes 分支明文「先留存 primary_fix_paths 段原文」；:224 7a i18n_keys 三分支（yes=貼原文／mixed=清單檔路徑／其他=N/A），與 drive-uploader-mr 期待對齊 |
| MINOR 1-17 | ✅ 全數落地 | 逐一 grep/實測：1 canonical 措辭（兩邊皆真）；2 cqa-grounder:16、mr-pusher:22 改指 refs/permissions-worktree.md；3 Evaluator 三處改名（fixer:209「Reviewer Rejection」、drive-uploader:147「bug-fixer-with-tests 撰寫」、spec-fetcher:184）grep 零殘留；4 唯一性宣稱改「/create-mr 流程中唯一」＋括號說明（description 同步）；5 setup-worktree 檔頭「以錯誤樣式 grep 判別；人工復核法」；6 tracker.sh 檔頭「6 個內容欄」；7 10 號:83 改條件式「若本環境提供…不確定就當沒有」；8 30 號 T1:18／T4:78 補驗收條件槽；9 7b.1 改 if/else；10 notion.sh 三處空回應檢查（:96/:130/:172）＋update-prop text 改 sys.argv（:158）；11 create-mr.md:92 SPEC_COMPLETE=found 對映句；12 Step 0.5 NOT_TECH 指向 Step 8 單一出處；13 create-mrs.md:36「每一張都重新 invoke」；14 resolve-reviewer:19 jq 檢查；15 40 號:37 grep 絕對路徑（且補入 obsidian/scripts/）；16 tracker.sh:48-55 mkdir 自旋鎖（trap 設於取鎖後、逾時不誤刪他鎖、set 內遞迴 row 為子進程無死鎖——靜態核對正確；引出 NEW-3 父目錄邊角）；17 40 號:35 允許日期後綴 |

### 新問題（修復引入或修復揭露）

#### NEW-1（BLOCKER）：Step 3 的 already-fixed 定向 grep 會大面積誤判——比原 B2 危害更大
- 位置：`create-mr.md:136-143`（`grep -m1 -A3 "已修復紀錄"` 命中即判 `already_fixed`，再 `grep -oE '[0-9a-f]{7,40}' | head -1` 抽 hash）。
- 實證：935 份歷史 analysis-notes 中 **831 份（88.9%）含「已修復紀錄」字樣**（tracer 定義檔 :611 的輸出模板含 `### 已修復紀錄(如適用…)` section，實務上 tracer 幾乎總寫它——包括用來記**否定**結論）。抽樣：FAQ-1029 標題即為「### 已修復紀錄（未修復）」；FAQ-1059 的 -A3 內容含 commit `2dc8a1461`（被 tracer 明文「依 §A 零命中硬閘不得標已確認修復」的 commit），會被 hash 抽取誤收為 `fixed_commit`。「修復 Commit」行同樣無鑑別力（800/935 檔含之，含「未找到修復 Commit」「修復 Commit:**無**」等變體；且 fixer append 的「### 修復紀錄」也含此行）。
- 後果：絕大多數正常單被導向 already_fixed 出口——Notion 留言「已於 commit {誤抽 hash} 修復，無需再發 PR」＋AI分析=分析成功、tracker 標 done，**bug 實際沒修**。原 B2 最壞是可見的 failed；這是靜默假成功，會直接誤導人類停止追蹤真 bug。
- 修法：放棄對 analysis-notes 的內容 grep。在 tracer dispatch prompt 的附加行（與 AFFECTED_REPOS/I18N_ONLY 同性質，**不觸碰**定義檔 :698 的 TRACER_RESULT 值域，無兩源衝突）加第 4 行：`ALREADY_FIXED: <no|yes commit=<hash>>`（判定依據＝定義檔 Step 4 Already-Fixed Verification 的結論；yes 需通過 §A/§B.1 鐵律）。manager 憑該行分支；該行缺失 → 保守走 ROOT_CAUSE_FOUND 正常路（寧可 fixer 白跑，不可假成功）。
- 補充：Step 3 分支順序（NEEDS_QA 先於 already-fixed 偵測）本身正確，不受影響。

#### NEW-2 → 歸入 REMAINING-1（M6 半套，見上表 M6 行）

#### NEW-3（MINOR）：tracker.sh set 的 SETLOCK 缺父目錄防護
- 位置：`tracker.sh:49-51`。`mkdir /tmp/bug-analysis-locks/.tracker-set-lock` 在父目錄不存在時 ENOENT 失敗（已用 scratchpad 一次性路徑實證 mkdir 對缺失父目錄必敗）→ 自旋 50×0.1s 後 ERROR 逾時。macOS 重開機清 /tmp 後、未經 bug-lock.sh（它有 `mkdir -p`）的獨立 set 場景會踩到；create-mr 正常序（Step 0.1 claim 先建父目錄）不受影響。
- 修法：SETLOCK 賦值後加一行 `mkdir -p "${SETLOCK%/*}"`。

#### NEW-4（MINOR）：7b 補打 update-prop 的值指涉不明
- 位置：`create-mr.md:243`「`NOTION_AI_FIELD: failed*` → 用 Step 7c 的指令補打一次 `update-prop`」。7c 有四個分支、select 值各異（分析成功／分析失敗／待釐清）；success 語境下應補「分析成功」，弱模型可能抄到 failed 分支的「分析失敗」，把成功單標成失敗。
- 修法：寫死完整指令 `bash /Users/user/aladdin/scripts/notion.sh update-prop {page_id} "AI分析" select "分析成功"`。

### 新矛盾專項檢查（協調者點名四項）

1. **Step 3 新分支順序 vs Step 7 出口表**：五分支（NEEDS_QA→already-fixed→yes→mixed→none→其餘）按序判定明確；needs_qa/already_fixed/i18n 走 7a+7c、none 走 failed（不跑 7a）——與出口表逐行一致 ✓（already-fixed 分支本身的觸發可靠性問題＝NEW-1，屬偵測層非表層矛盾）。
2. **FAIL_KIND vs solution-reviewer 檔內其他段落**：report 模板、契約說明、stdout 範例三處同步，無殘留舊「最後一行」措辭 ✓。
3. **notion.sh 還原後 comment-text**：子指令仍在（:105），三處空回應檢查已加，update-prop text 改 argv 傳參 ✓；resolve-reviewer 自帶 env 優先（:22），與 notion.sh 撤回 env-override 無矛盾；50 號信已不再宣稱 notion.sh 支援 env 覆蓋 ✓（change-log 舊行為 append-only 歷史，新行已記撤回）。
4. **tracker.sh 自旋鎖 trap/EXIT**：trap 設於 mkdir 成功之後（逾時路徑不會誤刪他人鎖）；set 尾端遞迴呼叫 `row` 為子進程、不繼承 trap、row 不取鎖 → 無死鎖；kill -9 殘留有逾時 ERROR＋自救指引 ✓。唯一邊角＝NEW-3 父目錄。

### 復核用重現步驟（全部唯讀）
token 新舊兩法提取重跑、tracker `next` 帶空格 exclude 重跑、`sync-mirrors.sh --check`＋`diff -q` 重跑、`bash -n`（隱含於讀檔）、歷史 analysis-notes 的「已修復紀錄／修復 Commit」出現率統計與 -A3 內容抽樣、scratchpad 一次性路徑的 mkdir ENOENT 實證。未執行任何寫入、未觸碰 Notion/TG API、未跑 tracker.sh set。

### 最終確認（同日第三輪，僅驗 4 個 delta）

| 項 | 判定 | 依據 |
|---|---|---|
| NEW-1 | ✅ 修復落地、無歧義、無新衝突 | create-mr.md Step 3：(a) 第 4 附加尾行 `ALREADY_FIXED: <no|yes commit=<hash>>`，判定依據明文錨定 tracer 定義檔的「Already-Fixed Verification」真實 section 名；標題「最後 4 行／後三行是附加要求」數字自洽；grep「已修復紀錄」偵測整段刪除（殘留檢查：全檔僅剩補救段的禁令行本身，含 88.9% 理由）；分支表只認 `yes commit=<hash>` 全形，缺失／只有 yes 無 hash 都落到保守正常路（寧白跑不假成功，方向正確）。(b) TRACER_RESULT 值域未動、附加行走 dispatch prompt 機制（與 AFFECTED_REPOS/I18N_ONLY 同性質），tracer 定義檔零改動 → 雙胞胎（bug-tracer.md）同步義務不觸發，無兩源衝突；定義檔 Step 4 的 §A/§B.1 鐵律自然約束 yes 的輸出門檻，語意相容。(c) 其他分支文字未變、分支順序（NEEDS_QA→ALREADY_FIXED→i18n→none→其餘）合理、Step 7 出口表與 7c 留言的 {fixed_commit} 來源現在可靠 |
| REMAINING-1（M6 補完） | ✅ | mr-pusher.md:31 改為兩種形式說明（直接一句話／自讀 analytics.md 以 Affected Module + Actual Result 合成 <60 字），與 create-mr.md 7b prompt 指示語一致；加「MR title 嚴禁塞指示文字、段落原文或 markdown 標題」禁令（直接封死原 M6 的 `## All Comments` 症狀形式）；:157/:174/:283 的 title 模板與 :195 JSON 安全段引用的 {bug_summary} 語意（合成後一句話）全檔一致 |
| NEW-3 | ✅ | tracker.sh set：SETLOCK 賦值後、自旋前加 `mkdir -p "${SETLOCK%/*}"`（含註解）；`%/*` 展開正確、冪等、不影響 trap 時序（仍在取鎖成功後才設）與逾時邏輯 |
| NEW-4 | ✅ | create-mr.md:243 補打指令寫死為完整 `notion.sh update-prop {page_id} "AI分析" select "分析成功"`＋「成功路徑的值寫死」說明，指涉歧義消除；同段五行契約與 grep 行首說明未受波及 |

**最終判定：ALL_CLEAR。** 兩輪 BLOCKER（B1/B2/NEW-1）均已以「消除兩源矛盾」而非「加補丁」的方式收斂（值域遷就定義檔＋附加行機制），與 doctrine 的維護原則（腳本/定義檔為準、修引用方）一致。
