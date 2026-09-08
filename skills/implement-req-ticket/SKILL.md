---
name: implement-req-ticket
description: 依已審核通過的需求單 plan 文件（demand-plan-pipeline 產出，或人工寫的同格式 plan.md），依序實作並在本機驗收——explorer 核對現況→gate reviewer 執行前裁決→executor 實作→acceptance reviewer 驗收→commit 並合併回基準分支。可一次餵多張單，會依序處理、卡關就停不跳過。實作完成後提醒使用者手動升版＋部署（不自動 push／觸發 pipeline），使用者確認部署到 dev 完成後可選配進入 Phase 2：開瀏覽器＋查 dev DB 做 e2e 驗收。
---

# Implement Req Ticket

把「已經審核過的需求單 plan 文件」變成「本機分支上已 commit 的實作」的自動化 pipeline。2026-09-05 首次用 ALDREQ-829/831/834/835 四張單跑通並固化成這個 skill；核心邏輯是一支參數化的 Workflow script（`aladdin_ai/workflows/implement-req-ticket.js`，`.claude/workflows/` 是它的 symlink），這份 SKILL.md 只負責「怎麼呼叫它、呼叫前後要做什麼」。

## 適用範圍

- 輸入：一或多份 `<TICKET_ID>-plan.md`（demand-plan-pipeline 那種格式：逐項變更清單／驗證依據／候選範圍清單／判斷決策記錄／待人工處理事項／整體信心評分），選配對應的 Notion 需求文件網址。
- 不適用：沒有 plan 文件、只有一句話需求描述的情況（先用 planning 流程把 plan 寫出來，或at least 手動整理出等價的「逐項變更清單」）。
- 不適用：bug 修復（那是 `/create-mr`，有自己的 tracer/fixer/reviewer 鏈路，不要混用）。

## 呼叫前：一定要問使用者的兩件事

**不要用預設值悄悄帶過，每次呼叫都要問**（AskUserQuestion）：

1. **基準分支是哪一個？** 選項給 `dev`（recommended，理由：功能先進 dev 再視情況 cherry-pick 到 feature/YYYYMMDD 預正式分支，且通常後續要部署到 dev 環境測試）、`main`、或使用者指定的其他分支（如 `feature/YYYYMMDD`、`hotfix/*`）。
2. **是否要用隔離 worktree？** 目前這個 skill **只實作了「直接在本機 checkout 上操作」這個模式**（workflow script 假設 `${ROOT}/{repo}` 就是要切分支的地方）。如果使用者想要隔離 worktree（不動本機 checkout），目前沒有現成支援——如實告知，並詢問是否改用直接 checkout 模式，或先手動比照 `scripts/setup-worktree.sh` 的模式擴充 workflow script（屬額外工程，不要自己在沒問過的情況下擅自加）。

## 呼叫前：安全檢查

對即將處理的所有 repo（可以先全部檢查 rajah/agrabah/abu/lago，反正 workflow 內建的 Setup 階段也會逐一檢查）跑一次 `git -C /Users/user/aladdin/{repo} status --short`。若任何一個不乾淨，先告知使用者，不要直接呼叫 workflow（workflow 內建的 sync 階段也會擋下，但先自己看一眼能更快發現問題、避免使用者等一輪 sync agent 才知道）。

## 呼叫方式

```
Workflow({
  name: 'implement-req-ticket',
  args: {
    baseBranch: 'dev',              // 使用者選的基準分支
    tickets: [
      { id: 'ALDREQ-XXX', planPath: '/絕對路徑/ALDREQ-XXX-plan.md', notionUrl: 'https://...' },
      // 可以放多張，會依序處理；notionUrl 可省略（省略時 explorer/gate/acceptance 只依 plan 內容驗證，不做 Notion 原文交叉核對——品質會下降，能提供就提供）
    ],
  },
})
```

`id` 建議直接從檔名 `<ID>-plan.md` 取；如果檔名不是這個格式，自己讀 plan.md 第一行標題判斷。**不需要**自己算每張單涉及哪些 repo——workflow 內的 explorer 階段會自己從 plan 內文的「檔案:行號」路徑前綴（`rajah/`、`agrabah/`、`abu/`、`lago/`）判斷出來。

Workflow 在背景執行，會在完成或卡關時收到 task notification。

## 卡關時：不要只回報，要自己動手排除

Workflow 的 executor→acceptance 迴圈最多重試 2 次；連續 2 次驗收 FAIL、或 gate 判 NO_GO，workflow 會自動停止該張單（並保留 `impl/<ticket_id>` 分支供檢查），**不會跳過繼續做下一張單**。

收到卡關通知後，你（呼叫這個 skill 的 session）不是只把 workflow 回傳的失敗理由轉述給使用者就結束——要真的去讀 acceptance reviewer 指出的問題檔案，自己判斷根因，嘗試修好，再派一個獨立的 fresh reviewer agent 重新驗收整張單（不要餵它任何「上一輪失敗」的預設立場，讓它自己重新核對）。

**真實案例（2026-09-05，ALDREQ-829）**：acceptance reviewer 抓到「拉黑時顯示備註欄」的做法（把欄位塞進 `hideProperties` 又掛同名 slot）在 `DataEdit.vue` 的渲染邏輯下永遠不會顯示——這是 plan 自己也预先標記的風險點（"待實作階段查證 DataEditPopup/PropertyFieldEdit 是否支援依他欄位值決定顯示"）。處理方式：
1. 直接讀 `DataEdit.vue` 的 `isHide`/`canShow`/`hidePropertySet`/`rows computed` 邏輯，搞懂它其實是靠 `hidePropertySet` 是 `computed(() => new Set(props.hideProperties))` 這個響應式鏈路運作。
2. 把原本靜態的 `hideProperties` 陣列改成依表單當下狀態動態計算的 `computed`（不是新元件、不是新機制，是用既有的響應式管線）。
3. 派一個全新、獨立的 acceptance reviewer 重新驗收整張單（不只驗 4f，是重新核對全部「納入」項目），PASS 後才進入 commit/merge。

修好後，若這張單还在 workflow 的 tickets 陣列裡卡著，最乾淨的做法是：**手動**（不透過 workflow）派 commit+merge agent 把這張單收尾，然後把這張單從 `args.tickets` 移除，用同一個 `scriptPath`／`name` 對剩下的單重新呼叫一次 Workflow（若沒改動 Setup 階段的 prompt，`resumeFromRunId` 可以讓 Setup 那次 agent call 命中快取，省一點時間）。不要為了「讓 workflow 自動處理到底」而放寬重試上限或改重試邏輯去容忍明顯不對的實作。

## Workflow 完成後：你要做的收尾

1. **彙整 i18n 待辦**：每張單的 executor 回報都有 `pendingI18nKeys`（新增/變更的 key 與建議三語值）。收集成一份清單給使用者，說明這些需要走 Google Sheets 匯入（硬規則禁止直接寫 `localizations/*.json`），不是遺漏。
2. **彙整待業主/PM確認事項**：從各張單 executor 的 `itemsSkipped` 裡挑出「不是 i18n、而是需要業務判斷」的項目（plan 的「待人工處理事項」章節通常已經列好），整理給使用者一次看完，不要讓他自己去翻每張單的細節。
3. **提醒使用者手動升版＋部署**：跟使用者說一句話提醒，不要自己動手做——「實作都完成了，記得自己手動把 agrabah／abu（依實際改到的 repo）的版本號 +1、push，然後到 GitLab 手動跑 build/{repo} pipeline 部署到 dev」。不要自動接手 push、不要自動改 package.json、不要自動觸發 pipeline（見下方「已下架的功能」）。
4. **問使用者要不要進入 Phase 2（dev 環境 e2e 驗收）**：見下一節。不要自己開瀏覽器測，先問使用者「已經部署到 dev 了嗎，要不要幫你驗收」，使用者確認部署完成才開始。

## Phase 2：Dev 環境 e2e 驗收（選配，需使用者確認已部署才做）

2026-09-05 對 ALDREQ-829/831/834/835 四張單實際跑過一輪、抓到一個真的 bug（829 的備註欄不會顯示，見上面「卡關時」的案例）並全部驗證通過後固化的流程。核心原則：**真的操作瀏覽器＋真的查 DB，不是憑截圖用眼睛猜**，且過程要讓使用者看得到（開有畫面的瀏覽器，不要 headless，也不要截完圖就馬上關）。

### 前提

- 使用者已明確告知「dev 已經部署完成」才開始，不要自己假設。
- 只能對 `*.alddev.com` 這個 dev 環境操作，嚴禁對 CQA（`*.ald777.com`）或 production 做任何操作。
- 每張工單先重讀一次它的 plan.md「逐項變更清單」，把每一項換算成「要去哪個頁面看什麼、要不要實際操作、DB 要查哪張表哪個欄位」的具體檢查清單，不要憑印象亂測。

### 工具

- 登入＋session：`node /Users/user/aladdin/dev-e2e/lib/login-backend.cjs admin|pk-platform`（後台）、`node /Users/user/aladdin/dev-e2e/lib/login-app.cjs pk-app [2|3|4]`（前台，dev 無驗證碼一段式登入）。session 存在 `dev-e2e/sessions/*.json`，同一次 e2e 過程可重複使用不用每次重登。目前 `.env.dev` 只有 `admin`／`pk-platform`／`pk-app` 三個 site key 有帳密（6t 尚未建）。
- DB 查詢（唯讀）：`bash /Users/user/aladdin/conn/db-dev-query.sh <schema> "<SELECT/SHOW/DESCRIBE>"`。不確定表在哪個 schema，先 `bash conn/db-dev-query.sh information_schema "SELECT table_schema, table_name FROM tables WHERE table_name='xxx'"` 查（踩坑實例：`events` 表在 `event` schema，不在 `message_board`）。
- 導頁＋截圖：**不要用 `dev-e2e/lib/capture.cjs` 直接打 route URL**——這幾個後台 SPA 是分頁式介面，直接改網址列不會真的切換到目標分頁（分頁會開在背景，畫面還停在「歡迎頁」），實測過會誤判。改成寫一次性 Playwright script，登入後**真的點側邊選單**（例如先點一級選單展開，再點子選單），跟真人操作一致。

### 執行方式

1. **一律用有畫面的瀏覽器**：`chromium.launch({ headless: false, slowMo: 200~300 })`，不要 headless。
2. **同一張工單的操作盡量放在同一個瀏覽器視窗裡連續做**，不要每截一張圖就關掉瀏覽器再開新的——使用者會想全程看著，開開關關會讓畫面一直閃爍。
3. **每個關鍵畫面停留至少 15-20 秒**（`page.waitForTimeout(...)`）再繼續下一步或關閉，讓使用者來得及看清楚，不要截完圖立刻 `browser.close()`。
4. **只用既有測試帳號**，不要挑資料庫裡看起來像真人的資料亂測。找測試帳號的方法：登入 pk-app 後讀 `localStorage` 裡 `common.uid_map:<uid>` 這類 key 反查目前登入帳號的真實 user id（今天用的是 265434 / `shin01`）；後台測試帳號同理找帳號名清楚含 `test`／`ZZZ_TEST`／`dev驗收` 字樣的資料，或使用者指定的帳號。
5. **會員狀態的操作（拉黑/解黑等）盡量做完整個來回**：例如要驗證「拉黑同步XX」，就先建立好前置狀態、拉黑、查 DB 確認、必要時解黑復原，不要留著測試帳號卡在異常狀態不收尾。
6. **只是想看某個彈窗/功能長什麼樣、不是真的要測試那個寫入動作時，不要按確認**：開彈窗看完 UI 結構後按取消/關閉，不要順手把表單送出去，除非那正是這次要驗證的操作本身。
7. **i18n 尚未匯入是正常情況，不是 bug**：畫面上看到 `model.xxx-yyy` 這種原始 key 字串、或欄位標籤是英文 fallback，只要不是本單要求的行為都算正常，不要誤判成缺陷；真正要驗證的是資料有沒有正確流動、欄位有沒有真的出現/隱藏、DB 有沒有寫對值。
8. **每項檢查都要有兩個獨立證據**：畫面截圖（或你親眼在瀏覽器裡看到的行為）+ DB 查詢結果，兩者對得上才算通過；只有畫面沒有 DB 佐證（或反過來）就繼續查，不要提早下結論。

### 完成後

把每張工單的檢查結果（哪幾項通過、截圖存在哪、DB 查詢關鍵結果）整理成清單回報使用者；過程中如果像 2026-09-05 ALDREQ-829 那樣意外發現一個真的 bug，比照「卡關時」那節的做法自己動手排查修好，不要只回報「有問題」就結束。

## 已下架的功能：自動 push＋版本升級＋觸發部署

2026-09-05 曾經建過一版「Phase 2」（跟上面現在的「Phase 2：Dev 環境 e2e 驗收」是不同東西、後來被取代掉的舊版本，注意不要搞混），把 push＋版本升級 commit＋觸發 GitLab build pipeline 整套自動化，同日就被使用者要求拔掉，原因：
- `glab api` 觸發 `build/{repo}` pipeline 已實測確認技術上不可行——`.gitlab-ci.yml` 的 `.manual` 規則寫死 `if: $CI_PIPELINE_SOURCE == "web" then always else never`，只認真人在 GitLab 網頁手動點「Run pipeline」，API 觸發的 pipeline 會整個被 skip（實測 `build/agrabah` #12652：pipeline 建立成功但 `build-entries` job 從未執行，安全地什麼都沒做）。
- 嘗試改用 Playwright 開真的瀏覽器讓使用者手動登入 GitLab 網頁、再由 agent 接手操作按鈕（這樣產生的 `source` 才會是 `"web"`），但登入等待流程不穩定（第一次 5 分鐘超時、第二次判斷邏輯誤判「about:blank」為登入成功，實際沒有拿到任何 gitlab.the777.pro 的 cookie）。
- 使用者最終裁定：**不值得為了這一步做這麼多工程**，改成 skill 完成後單純提醒使用者自己手動升版＋部署即可（見上一節第 3 點）。

**不要重新加回這個自動化**，除非使用者明確要求。若使用者之後又想要自動化這一步，比較可行的方向是：先確認 GitLab 網頁登入不需要互動式 2FA（例如有沒有 App Password / Personal Access Token 可以繞過網頁登入的替代路徑），或者請使用者主動放寬 `build/{repo}` 的 `.gitlab-ci.yml` rule 也接受 `api` 來源——這兩者都不要自己決定要不要做。

CLAUDE.md 硬規則裡的「需求單部署派送」push 例外（2026-09-05 新增，只在測試時手動對 agrabah 用過一次驗證確實能 push）已於 **2026-09-06 使用者要求撤掉**，`rajah`/`agrabah`/`abu`/`lago` 現在完全不在任何 push 例外清單內，跟這個 skill 剛建立前的狀態一致。

## 已知限制（誠實列出，不要假裝沒有）

- 只支援直接在本機 checkout 上操作，不支援隔離 worktree。
- `pendingI18nKeys`／`itemsSkipped` 的品質完全取決於 executor agent 那一輪的判斷，仍建議使用者最終自己過一眼 diff，不要無條件全信。
- 重試上限固定 2 次（1 次原始嘗試＋1 次修正重試），沒有可調參數；卡關後的排除是「你」的工作，不是 workflow 自己會做的事（見上一節）。
- 目前只測過 4 張單、單一次呼叫；沒測過同一次呼叫裡多張單分屬「不同」基準分支的情境（`args.baseBranch` 是整次呼叫共用一個值，若要混用不同基準分支，要拆成多次呼叫）。
- 不包含 push／版本升級／觸發部署（見上方「已下架的功能」）——skill 完成後只提醒使用者自己做。
- Phase 2（e2e 驗收）目前只涵蓋 `admin`／`pk-platform`／`pk-app` 三個 site（`.env.dev` 現況），6t 系列尚無 dev 測試帳密；遇到需求單涉及 6t 就無法照本流程做，先跟使用者確認怎麼處理。
