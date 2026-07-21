# 對抗性審查報告 — /daily-code-review v3（2026-07-03）

> **2026-07-03 複核更新**：原 9 條 finding 的修法已由實作方處置，本審查員於乾淨沙盒（`dcr-review-verify-b`）獨立復核。**8/9 修法驗證正確；MAJOR-3 的修法引入一個新缺陷（_rK 世代的完成不被承認 → `--skip-existing` 永不收斂）**，詳見文末「複核記錄」章。以下首輪內容保留未改（歷史快照）。

> 審查者：對抗性審查 agent（未參與 v3 實作）。
> 目標：在弱模型（Sonnet/Opus 非 Fable）照字面執行前，找出會造成錯誤資料、卡死或誤讀的問題。
> 方法紀律：每條 finding 都以實跑腳本或構造反例確認；純推測者明確標注。沙盒：`scratchpad/dcr-review-sandbox`，一律 `--no-fetch --out-root <sandbox>`，未污染真實 `review/`、未對 4 repo 寫入。

---

## 結論摘要

| 嚴重度 | 數量 | 一句話 |
|--------|------|--------|
| BLOCKER | 1 | 每批跑的 `collect-critical.ts --check` 是**全域**掃描，任何非最後一批跑完都會把「還沒派工的後續批次」全報成 MISSING 並 exit 1；且最終 Step 3 聚合又沒有完成度閘門 → 完成度驗收整條斷掉。 |
| MAJOR | 3 | `P0\|P1 \|\|\|` 字面寫法會被 parser 拒收；review-core 規則 13「一律用 git log --author」與模板「不要用 git log 探索 commit」互相矛盾；`--skip-existing` 只看報告檔存在、漏看 critical 檔 → 靜默丟失該 author 的 P0/P1。 |
| MINOR | 5 | CSV 去重鍵不含 severity 的誤去重；`none`/severity token 大小寫敏感；升級派工的失敗軌跡 vs Note 4 相斥；`--skip-existing` 重規劃殘留舊 prompt 檔；git 時窗 TZ 與 label TZ 潛在漂移（本機不觸發）。 |

---

## 逐維度檢查記錄（檢查了什麼、怎麼驗的）

### 維度 1：檔案間矛盾（command / review-core / report-qa / 兩模板 / 腳本五方對照）
- **契約字串逐字比對**：`AUTHOR_DONE`、`RESULT: COMPLETED|PARTIAL|BLOCKED`、`QA_COMPLETE`、`QA_SEVERITY_CHANGE` 在 review-agent.tpl / review-core §4 / qa-agent.tpl / report-qa / command 四~五處**逐字一致**（分隔符 ` ||| `、欄位順序、結尾 RESULT 行都相同）→ 無矛盾。
- **critical 檔格式四處對照**（模板第 6 步 / review-core 規則 14 / report-qa 執行紀律 3 / collect-critical parser）：分隔符 `|||`、`AUTHOR:`/`WINDOW:` 頭兩行、`none` 語意皆一致，**但** QA 升級路徑與 command 補救路徑用了 `P0|P1 |||`（歧義）→ 見 MAJOR-1。
- **git log 探索 commit**：review-core 規則 13 vs review-agent.tpl 步驟 1 直接相斥 → 見 MAJOR-2。
- 驗法：`grep -n` 交叉比對各檔行、實讀全文。

### 維度 2：腳本邏輯 bug（實跑 + 構造輸入）
- **collect-critical parser**：構造 9 種 critical 檔（正常 P0/P1、none、`P0|P1 |||`、含逗號欄位、`None` 大寫、跨 author 同 desc+loc、同 author P0+P1 同 desc+loc）實跑 → 逐一觀測 CSV 與 PARSE_ERRORS。
- **冪等去重**：同一組檔連跑 3 次，觀測 `appended`/`duplicates skipped`；逗號欄位以雙引號正確轉義且再讀回可正確去重（run3 appended=0）。
- **--check 完成度**：構造「僅 batch1 完成」狀態實跑 → 觀測到後續批次被全報 MISSING（BLOCKER-1）。
- **--skip-existing 邊界**：構造「報告存在、critical 檔被刪」實跑 → 觀測 author 被靜默跳過（MAJOR-3）。
- **分組邊界**：用真實 20260702 窗口實跑，反推 agent 6（ashliu+anthone+AilesaxPKH+hiro0519 = 12 commits/210 lines → opus）與 agent 7（Blast+Evelyn = 4 commits → sonnet）**逐一驗證** `isIndependent(≥5 commit ∨ ≥200 line)`、合併預判 flush（`bc+next>12 ∨ bl+next>500`）、model 指派（`bc≥8 ∨ bl≥300 → opus`）與 v2 門檻**完全一致**。
- **numstat / NUL 解析**：二進位檔 `-\t-` 不匹配 `^\d+\t\d+\t` 自動略過（碼註解正確）；改用 NUL 分隔避免 `%an`/`%ae` 含 `|` 的切割錯誤（優於 v2 的 `|`）；真實窗口行數（ming 7/921 等）合理 → 無解析錯位。
- **日期/範圍/時區**：實跑空窗口（`[DONE]` exit 0）、2 日範圍（LABEL=`20260701-20260702`、CSV_DATE=`2026/07/01-2026/07/02`）、逆序輸入（自動排序）皆正確；`taipeiYesterday()` 邏輯正確。TZ 潛在漂移見 MINOR-5。

### 維度 3：弱模型誤讀點
- 逐句掃 command Step 2 / 模板 / QA 規範，找雙重讀法：`P0|P1`（可讀成字面）、規則 13「一律用 git log」（可讀成要自行探索）、`--check` 輸出「直接告訴你誰缺」（可讀成含後續批次）、Note 4 vs 升級軌跡（相斥）。
- 驗法：把「照字面執行」的結果實際跑出來（見各 finding）。

### 維度 4：v3 是否遺失 v2 必要行為
- 逐段對照 v2 備份 command / review-core / report-qa：Bootstrap、參數形狀分類、fetch 失敗跳過、dev−pro＋commit-date 窗口、身份消歧（Case A 合併／Case B 不合併）、報告檔名 sanitize＋碰撞、repo 分組表、model 門檻、_r2 後綴、批次併發、每批 QA、CSV 欄位與轉義 → **全部遷入腳本/模板，未遺失**。
- v2「effort=high/medium」宣稱移除：經 doctrine 10 §0 確認 Agent tool 無 per-call effort，這些臨時 agent 也無 frontmatter 可設 → v2 的 effort 本就是 no-op，移除**非**退化。
- v2「讀 CLAUDE.md」移除：**實測驗證**（見下）子代理會自動載入專案 CLAUDE.md → 移除**非**退化。
- v2「碰撞時 alert 使用者」→ v3 改成腳本靜默加 email-localpart 後綴：屬確定化改善，非退化。

### 維度 5：引用完整性
- 逐一 `ls`：7 個 dimension 檔、`daily_bootstrap.sh`、doctrine `10`/`40`/`00-diagnosis`、模板兩檔、author-identities.json **全部存在**。
- doctrine 錨點：command 引用「10-model-dispatch 第 0 節 / 第 5 節」→ 實檔 `## 0.` 與 `## 5.` 皆存在且語意吻合（§0 講 per-call effort 不可設、§5 講升降級）。
- 腳本旗標名：`--no-fetch`/`--skip-existing`/`--out-root`/`--check` 與 command 描述一致。

### 維度 6：契約一致性
- 見維度 1。額外實測：parser 對 `none`（小寫、獨行）通過；對 `P0|P1`、`None` 拒收。

---

## Findings（每條含：嚴重度、file:line、失效場景、建議修法）

### BLOCKER-1 — 每批 `--check` 為全域掃描，完成度驗收整條斷裂
- **file:line**：`obsidian/commands/daily-code-review.md:74`（每批跑 `collect-critical.ts {LABEL} --check`）＋ `:77`（依缺檔名單重派）；`obsidian/skills/daily-code-review/collect-critical.ts:54-63`（`--check` 迴圈遍歷 `dispatch.agents` **全部** agent，無批次過濾）；`daily-code-review.md:95-100`（Step 3 聚合，**無**任何完成度檢查）。
- **失效場景（實測）**：沙盒 20260702（12 agents / 3 batches）。模擬 batch1（agents 1-5）全部完成、產出報告＋critical 檔後跑 `--check`：

  ```
  6  ashliu     MISSING MISSING
  ...
  12 Landon     MISSING MISSING
  [CHECK] 11 author(s) incomplete   exit=1
  ```

  command Step 2.2 明寫「該批全部回報後，跑批次驗收…輸出直接告訴你誰缺」，Step 2.3 又說「有缺檔 → 升降級重派…另加一行 `Only process author(s): <缺的名單>`」。弱 manager 照字面把這 11 個（全是 batch2/3 **尚未派工**的 author）當「缺檔」→ **提前把後續批次全部 agent 一次派出**（破壞批次/併發序）或陷入「永遠 exit 1、無法取得乾淨的單批訊號」。且最終 Step 3 聚合**沒有**完成度閘門，真正漏掉的 critical 檔會被**靜默**略過、CSV 不完整卻無錯誤。
- **建議修法**：給 `--check` 加 `--batch N`（或 `--agents id,id`）過濾，command 只對「當前批次的 agent_ids」驗收；並在 Step 3 之前補一次「對 dispatch.json 全量」的完成度檢查作為最終閘門（真缺 → 明確列出、要求補派，而非靜默出 CSV）。

### MAJOR-1 — `P0|P1 |||` 字面寫法被 parser 拒收（且補救指令自我下毒）
- **file:line**：`report-qa.md:30`、`templates/qa-agent.tpl.md:28`（QA 升級時「新增一行 `P0|P1 ||| <描述> ||| <位置>`」）、`commands/daily-code-review.md:100`（parse-error 補救時「修成 `P0|P1 ||| 描述 ||| 位置`」）；parser 於 `collect-critical.ts:87` regex `^(P0|P1)\s*\|\|\|`。
- **失效場景（實測）**：critical 檔寫 `P0|P1 ||| race condition on balance ||| agrabah/wallet.ts:88`：

  ```
  [PARSE_ERRORS] Carol_testlabel.critical.md: unparseable line: P0|P1 ||| race condition on balance ...
  exit=1
  ```

  `P0|P1` 意為「P0 或 P1 擇一」，但弱模型（QA 為 sonnet）易照字面寫下 `P0|P1`。regex 匹配到 `P0` 後要求緊接 `|||`，實際是 `|P1 |||` → 不匹配 → 整檔判 `no issue lines and no 'none'`、exit 1。**更糟**：command:100 的補救指令**本身**用同一個 `P0|P1 |||` 範式，弱 manager 照它「修檔」→ 重跑仍 parse fail → **補救迴圈卡死**。對照組：review-agent.tpl 第 6 步用**分開**的 `P0 ||| …` / `P1 ||| …` 兩行示例，不會被誤讀。
- **建議修法**：三處一律改為 `<P0 或 P1> ||| <描述> ||| <位置>`（英文檔 `<P0 or P1> ||| …`），與 review 模板的無歧義寫法對齊。

### MAJOR-2 — review-core 規則 13「一律用 git log --author」與模板「禁用 git log 探索」相斥
- **file:line**：`review-core.md:119`（「收集某 author 的 commits **一律用** `git log --author="<email>"`」）vs `templates/review-agent.tpl.md:33`（「**Do NOT run `git log` to discover commits** … these SHAs are the complete and only set」）。模板「Review Standards — Read in Order」要求 agent **必讀** review-core.md，故兩條同時進 agent 視野。
- **失效場景**：v3 已改為「腳本給定精確 SHA、agent 不自行探索」，但規則 13 開頭句是 v2 遺留的探索式指令。弱 agent 若順從規則 13 跑 `git log --author="<email>"`（未帶 `origin/dev --not origin/pro` 與時窗），會拉進**時窗外／已進 pro** 的 commit 一起審 → 產出超範圍 issue（或對 author 掛錯 commit）。雖模板 step 4 的 scope-check 會擋掉一部分，但屬「規則互相矛盾 → 弱模型現場即興」——正是 v3 要消滅的失焦模式（見 00-diagnosis 失焦 2）。
- **建議修法**：規則 13 開頭改為「本流程中 commit 清單由派工 prompt 給定；email（`%ae`）僅作**驗證錨**（`git show` 的 `Author:` 行必須相符），**不**用來自行 `git log` 探索」；(a)(b)(c) 三個補掃子項標注「僅適用人工補掃既有報告，不適用自動派工的 review agent」。

### MAJOR-3 — `--skip-existing` 只看報告檔、漏看 critical 檔 → 靜默丟失 P0/P1
- **file:line**：`scan-workload.ts:179-186`。判斷式 `if (fs.existsSync(`${outDir}/${base}.md`))`（僅檢查報告 `.md`），`:180` `if (skipExisting) { skippedAuthors.push(...); authors.delete(a.email); return; }` 直接把該 author 移出派工。
- **失效場景（實測）**：review agent 模板是「step 5 寫報告 → step 6 寫 critical 檔」兩次 Write。若 agent 在兩者之間中斷（或該 author 回 PARTIAL 只落了報告），報告存在、critical 缺。`--skip-existing` 是 command Step 1 明訂的「中斷後接續」路徑。實測刪掉 ming 的 critical 檔、保留報告後跑 `--skip-existing`：

  ```
  [SKIPPED_AUTHORS] 5 already reported: …; ming <pkh_ming0802@…>; …
  ming in new dispatch.json agents: false
  ```

  ming 被靜默跳過、其 critical 檔永不產生，最終聚合（讀 `_critical/*.critical.md`）**靜默漏掉 ming 的 P0/P1、無任何錯誤**。屬「出錯資料」，只因觸發需「兩次 Write 之間中斷 + 用 --skip-existing 續跑」而列 MAJOR（貼近 BLOCKER）。
- **建議修法**：skip 條件改為「**報告檔 AND critical 檔皆存在**才跳過」；只有報告、缺 critical 者視為未完成、照常重新派工。

### MINOR-1 — CSV 去重鍵不含 severity → P0+P1 同 desc+loc 會被誤去重
- **file:line**：`collect-critical.ts:110`（去重鍵 `[esc(desc),esc(loc),esc(author),esc(date)].join(",")`，**不含 severity、無序號**）。
- **失效場景（實測）**：同一 author 檔內兩行 `P0 ||| 權限檢查遺漏 ||| svc.ts:100` 與 `P1 ||| 權限檢查遺漏 ||| svc.ts:100` → 只輸出 1 列（`duplicates skipped: 1`）。兩筆若確為不同問題（描述與位置恰好相同、僅嚴重度不同），會被折疊成一列而少一筆。觸發窄（需 desc+loc 完全相同），但屬靜默。回答任務提問「兩筆合法且相同的 issue 會被誤去重嗎」：**會**，唯一乾淨情境即「同 author、desc 與 loc 逐字相同」；跨 author 因 author 進鍵**不會**被誤去重（實測 Alice/Frank 同 desc+loc 兩列都在）。
- **建議修法**：若要區分，去重鍵改含 severity（需同步在 CSV 加回 Severity 欄，屬紅區語意變更、先問使用者）；或明白接受「同 desc+loc 視為同一 issue」為設計。

### MINOR-2 — `none` 與 severity token 大小寫/字面敏感
- **file:line**：`collect-critical.ts:86`（`if (line === "none")`，嚴格等值）、`:87`（僅認 `P0`/`P1`）。
- **失效場景（實測）**：critical 檔寫 `None`（大寫）→ `unparseable line: None` + `no issue lines and no 'none'`、exit 1。弱 agent 可能寫 `None`/`NONE`/`無`/`- none`。屬「loud」錯誤（會 exit 1、列檔名），但每次都要人工/補救迴圈處理。
- **建議修法**：`none` 比對改 `line.toLowerCase() === "none"`；或模板/規範對 `none` 再加一句「必須小寫、獨佔一行、不加任何符號」。

### MINOR-3 — 升級派工需附「失敗軌跡」與 Note 4「不塞額外指示」相斥
- **file:line**：`daily-code-review.md:77`（走 doctrine §5「sonnet 連錯 2 次升 opus **並附完整失敗軌跡**」）vs `:115` Note 4（「不要在派工時往 prompt 塞額外指示（Step 2.3 的**重派名單**例外）」）。
- **失效場景**：Note 4 只把「重派名單」列為例外，未含「失敗軌跡」。弱 manager 若嚴守 Note 4 → 升 opus 時**不附**失敗軌跡 → opus 缺脈絡、重蹈 sonnet 覆轍；反之照 §5 附軌跡又自覺違反 Note 4。
- **建議修法**：Note 4 括號改為「（Step 2.3 的重派名單**與升級時的失敗軌跡**例外）」。

### MINOR-4 — `--skip-existing` 重規劃殘留舊 prompt 檔
- **file:line**：`scan-workload.ts:217`（`fs.mkdirSync(_dispatch,{recursive})` 後直接覆寫，**未清理**舊 `agent-*.md`/`qa-batch-*.md`）。
- **失效場景（實測）**：首跑產 12 agents/3 batches；`--skip-existing` 重跑剩 7 agents/2 batches，`_dispatch/` 仍留 `agent-8..12.md` 與 `qa-batch-3.md`（孤兒）。新 dispatch.json 只引用 agent-1..7，故嚴格照 dispatch.json.batches 派工者無害；但掃目錄的弱 manager 可能被孤兒檔誤導；且新 `agent-6.md` 已覆寫成不同 author 群。
- **建議修法**：重生成前先清 `_dispatch/agent-*.md` 與 `qa-batch-*.md`（或整個 `_dispatch/` 除 dispatch.json 外）。

### MINOR-5 — git 時窗（本機 TZ）與 label（Asia/Taipei）潛在漂移（本機不觸發、v2 沿用）
- **file:line**：`scan-workload.ts:59-65`（`taipeiYesterday` 用 Asia/Taipei）vs `:107-108`（`--after/--before` 無 TZ，git 以**本機**時區解讀）。
- **失效場景**：本機實測 `Asia/Taipei (CST +0800)`，兩者一致、**目前不漂移**。但若在非 Taipei 時區主機跑，label 用 Taipei 昨天、git 窗界用本機時區 → 邊界 commit 可能錯落一天。屬 v2 既有行為、非 v3 退化。
- **建議修法**：git 呼叫加 `TZ=Asia/Taipei` env（或 `--date` 相關設定）使窗界與 label 同基準。優先度低（本機不觸發）。

---

## 已驗證為正常、無需修（避免後續誤修）

- **子代理自動載入 CLAUDE.md**：實派一個 general-purpose 探針 agent、禁用工具，僅憑 context 即正確引述 CLAUDE.md 的 `git push` 硬規則與 `NODE_OPTIONS` 規則（`PROBE_RESULT: LOADED`）→ 模板「Do NOT read CLAUDE.md，already loaded」成立，移除 v2 顯式讀取**安全**。
- **契約字串**（AUTHOR_DONE / RESULT / QA_COMPLETE / QA_SEVERITY_CHANGE）四~五處逐字相容。
- **分組/合併/model 門檻**（5/200/12/500/8/300）與 v2 完全一致，且對真實 20260702 資料反算逐一吻合。
- **冪等聚合**：連跑 3 次 `appended` 由 4→1→0；含逗號欄位正確雙引號轉義且再讀回可去重。
- **身份消歧**：同 email 多 `%an`（HasegawaShiro / AilesaxPKH）正確合併為單一 author；跨 email 因以 `%ae` 為鍵自動保持獨立。
- **作者數 16 vs v2 報告 18**：差 Vic、JeffKuo，實查為其 commit 已併入 `origin/pro`（`dev−pro` 不再含），屬 command 明載的「重掃結果可不同」設計行為，非消歧 bug。
- **日期處理**：空窗 `[DONE]` exit 0、2 日範圍 LABEL/CSV_DATE、逆序自動排序、`>2 日` usage exit 2、`concurrent<1` usage 皆正確。
- **numstat**：二進位 `-\t-` 略過、NUL 分隔防 `|` 污染、rename/merge 不致解析錯位。
- **引用完整性**：7 dimension 檔、bootstrap、doctrine `10`/`40`/`00`、兩模板、author-identities.json、doctrine §0/§5 錨點全部存在且吻合。
- **模板佔位符**：對真實窗口生成的所有 `_dispatch/*.md` 掃描無殘留 `{{…}}`；殘留時 render() 於 `scan-workload.ts:223-224` 會 exit 3。

---

## 附：復現指令（沙盒）

```bash
S=/private/tmp/claude-502/-Users-user-aladdin/1528f8b5-b9ec-4fb5-b019-65bfbdb4b558/scratchpad/dcr-review-sandbox
# BLOCKER-1：僅 batch1 完成後跑 --check → 後續批次全報 MISSING
bun obsidian/skills/daily-code-review/collect-critical.ts 20260702 --check --out-root "$S"
# MAJOR-1 / MINOR-2：P0|P1 與 None 被 parser 拒收（見 _critical 內構造檔）
bun obsidian/skills/daily-code-review/collect-critical.ts testlabel --out-root "$S"
# MAJOR-3：報告在、critical 缺，--skip-existing 仍跳過該 author
bun obsidian/skills/daily-code-review/scan-workload.ts 20260702 --no-fetch --skip-existing --out-root "$S"
```

---

# 複核記錄（2026-07-03 同日，修法驗證）

> 沙盒：`scratchpad/dcr-review-verify-b`（全新目錄，`--no-fetch --out-root`）。逐條實跑驗證，非讀碼放行。

## 逐條複核結果

| # | 原 finding | 修法 | 複核結果 |
|---|-----------|------|---------|
| 1 | BLOCKER-1 --check 全域掃描 | `--batch N` 過濾＋scope 尾行＋command Step 2.2 必帶＋Step 3 全量閘門 | ✅ **通過**（見下方實測） |
| 2 | MAJOR-1 `P0\|P1` 字面 | 三處改「行首 P0 或 P1 擇一＋範例＋明文勿照抄字面」 | ✅ 通過（grep 僅剩告誡句；parser 對字面仍拒收＝與 docs-fix 策略一致） |
| 3 | MAJOR-2 規則 13 矛盾 | 改寫為「不自行探索、email 只作 git show 驗證錨、(a)(b)(c) 僅人工補掃」 | ✅ 通過（與模板 `Do NOT run git log` 無殘餘矛盾） |
| 4 | MAJOR-3 skip 漏看 critical | skip 條件改「報告 AND critical 皆存在」、缺 critical 走 _r2 | ⚠️ **原 bug 已修，但引入新缺陷**（見「新 finding」） |
| 5 | MINOR-1 去重鍵 | 不改行為、加設計決策註解（collect-critical.ts:115-116） | ✅ 通過 |
| 6 | MINOR-2 none 大小寫 | `line.toLowerCase() === "none"`（collect-critical.ts:100） | ✅ 通過（None/NONE/none 實測皆收） |
| 7 | MINOR-3 Note 4 例外 | 補「升級重派時按 doctrine/10 第 5 節必附的失敗軌跡」（command:124） | ✅ 通過 |
| 8 | MINOR-4 孤兒 prompt | 生成前清 `agent-*.md`/`qa-batch-*.md`（scan-workload.ts:223-226） | ✅ 通過（12→8 agents 重規劃無孤兒；清理位於兩個 `[DONE]` early-exit **之後**，`[DONE]` 路徑實測不誤刪 `_dispatch/`） |
| 9 | MINOR-5 TZ 漂移 | git log env 加 `TZ: "Asia/Taipei"`（scan-workload.ts:110） | ✅ 通過（`{ ...process.env, TZ }` 展開順序正確，未丟 PATH） |

## BLOCKER-1 修法實測摘錄

- 全新計畫（12 agents/3 batches）、零完成時 `--check --batch 1` → 只列 agent 1-5、`[CHECK] batch 1: 5 author(s) incomplete`、exit 1。
- batch1 補齊後 `--batch 1` → `all done` exit 0；`--batch 2` → 只列 agent 6-10；不帶 `--batch` → `[CHECK] ALL: 11 author(s) incomplete`。
- 防呆全數 loud：`--batch 99`（列合法範圍 1..3）、`--batch` 不搭 `--check`、`--batch abc`、`--batch 0` 均 exit 2。
- command Step 3 閘門文字：「閘門不過，不准聚合」與「3 次仍缺 → 記錄後聚合照做」的例外在 :100 與 :102 各明說一次，弱模型不會卡死迴圈。

## 新 finding（由修法 4 引入）

### MAJOR-4 — `--skip-existing` 對「已在 _rK 完成」的 author 永不收斂，每次 resume 重複重審
- **file:line**：`scan-workload.ts:179-190`。skip 判定只看**原始 base 名**的 critical 檔（`_critical/${base}.critical.md`），而重派後 agent 依 dispatch 表寫到 `_rK` 路徑，原始 base 名的 critical **永遠不會出現**。
- **失效場景（實測，三連跑）**：
  1. ming 報告在、critical 缺（模擬 crash）→ `--skip-existing` 正確改派 `ming_20260702_r2`（原 MAJOR-3 已修 ✅）；
  2. `_r2` 報告＋critical **皆完成**後再跑 `--skip-existing` → ming 仍被改派 `ming_20260702_r3`（`[AUTHORS] 1 → 1 agents`，未出 `[DONE]`）；
  3. 第三次 `--skip-existing` → 仍派 `_r3`。唯有手動在**原始 base 名**補 critical 檔後才會 `[DONE] all 16 author(s)`。
- **影響**：每次 resume 都重燒一個 opus agent 重審同一 author（觸發此情境者往往是工作量最大的 author）；重審 critical 檔全數進聚合，措辭稍異即出**近重複 CSV 列**（去重鍵僅擋逐字相同）；該 label 永遠到不了 `[DONE]`。無資料遺失、無卡死 → MAJOR。
- **建議修法**（利用既有 while 迴圈，改動極小）：完成判定改看「最新一代」——

  ```ts
  if (fs.existsSync(`${outDir}/${base}.md`)) {
    let latest = base, k = 2;
    while (fs.existsSync(`${outDir}/${base}_r${k}.md`)) { latest = `${base}_r${k}`; k++; }
    if (skipExisting && fs.existsSync(`${outDir}/_critical/${latest}.critical.md`)) {
      skippedAuthors.push(`${a.name} <${a.email}>`); authors.delete(a.email); return;
    }
    base = `${base}_r${k}`;
  }
  ```

  語意：最新一代報告有配對 critical＝該 author 完成；否則派到下一個空位 `_rK`。

## 殘餘 nits（不擋驗收，順手修即可）

- `collect-critical.ts:28` usage 字串漏列 `--batch N`（檔頭註解 :10-13 有）——manager 打錯參數時看到的 usage 不含新旗標。
- skip 語意文字未同步新條件：`daily-code-review.md:53`「已有**報告檔**的 author 會被跳過」、`scan-workload.ts:14` 同句——修法後實為「報告＋critical 皆存在才跳過」。純描述漂移，腳本行為不受影響。

## 複核結論

`FINAL_RESULT: REJECTED ||| scan-workload.ts:179-190 —— MAJOR-3 修法引入新缺陷：完成判定只認原始 base 名的 critical 檔，crash-recovery author 在 _rK 完成後仍被每次 --skip-existing 重複改派（實測 _r2 完成→仍派 _r3、永不 [DONE]），造成重複 opus 重審與近重複 CSV 列；按上方建議改為「最新一代報告＋critical 配對」判定即可，其餘 8 條修法全數驗證通過。`

---

# 複核記錄（第二輪，2026-07-03 — 收斂缺陷修法驗證）

> 沙盒：`dcr-review-verify-c` / `-d`（全新目錄，`--no-fetch --out-root`）。針對 MAJOR-4 修法（scan-workload.ts:179-192「最新一代」判定）與兩項 nits。

## 驗證結果：全數通過 → APPROVED

| 攻擊情境 | 期望 | 實測 |
|---------|------|------|
| crash 狀態（只有 base 報告）＋ skip | 改派 `_r2` | ✅ `_r2`（MAJOR-3 語意保留） |
| `_r2` 報告＋critical 齊 ＋ skip | 跳過（不再派 `_r3`） | ✅ SKIPPED（MAJOR-4 收斂修復） |
| 全員補齊後連跑兩次 skip | 穩定 `[DONE]`、磁碟無 `_r3` | ✅ 兩次 `[DONE] all 16 author(s)`，ming 世代止於 `_r2` |
| **非 skip** 模式、base＋`_r2` 皆在 | 派 `_r3`（預設重審語意不變） | ✅ `_r3` |
| 怪狀態：base 報告不存在、`_r2` 配對齊 ＋ skip | 以 latest（`_r2`）判定 → 跳過 | ✅ SKIPPED（乾淨重建於 verify-d 確認） |
| 同狀態非 skip / `_r2` 缺 critical ＋ skip | 派 `_r3` | ✅ `_r3` |
| 世代空洞（base 在、`_r2` 缺、`_r3` 在） | 不 crash、填空位 `_r2` | ✅ `_r2`，無覆蓋、無錯誤 |
| 回歸：空窗口 / 全新計畫 | `[DONE]` / 16→12 agents 不變 | ✅ |
| Nit A：usage 字串 | 含 `[--batch N]` | ✅ collect-critical.ts:28 |
| Nit B：skip 措辭 | 「最新一代配對俱全才跳過」 | ✅ daily-code-review.md:53、scan-workload.ts:14 |

## 過程中排除的偽陽性（留檔防後人誤判）

verify-c 首測「base 缺、`_r2` 齊、skip」曾觀測到 ming 疑似仍被改派 `_r3`——追查後確認為**測試手法瑕疵，非程式 bug**：該狀態下全員可跳過 → 腳本走 `[DONE]` early-exit（scan-workload.ts:192-195），**依設計不重寫 dispatch.json**，測試 helper 讀到的是上一輪（非 skip）的舊計畫。乾淨重建（verify-d）證實實際行為正確（SKIPPED）。附帶事實：`[DONE]` 路徑下 `_dispatch/dispatch.json` 保留上一輪內容屬既有設計（command Step 1 規定 `[DONE]` 即回報並結束、不讀 dispatch），非本輪修法引入。

## 第二輪結論

`FINAL_RESULT: APPROVED`（MAJOR-4 收斂缺陷已按「最新一代報告＋critical 配對」語意正確修復；預設 `_rK` 重審、怪狀態、世代空洞、回歸全數通過；兩項 nits 已落實。）
