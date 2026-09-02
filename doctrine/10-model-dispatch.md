# 模型調度守則（10-model-dispatch）

> 給每一個擔任「指揮官」（主對話 manager）的 session。目的：貴的模型只做判斷，便宜的模型做勞力，任何長輸出都不准進主對話。
> 環境事實查證日：2026-07-03。發現與實際環境不符時，以實際環境為準並依 `40-maintenance-protocol.md` 更新本檔。

## 0. 環境事實（已驗證，不要憑印象改）

- **Agent tool 每次派工可指定 `model`**：`haiku` / `sonnet` / `opus`（`fable` 僅特殊開通 session 可用，日常不要指定它，指定了會退回或報錯）。不指定 = 繼承 agent 定義檔的 `model:` frontmatter；再無則繼承主對話模型。
- **`.claude/agents/*.md` frontmatter** 支援 `model:`（haiku/sonnet/opus/inherit/完整 model id）與 `effort:`（low/medium/high/xhigh/max）。本專案 25 個 agent（2026-09-02 實測 `ls aladdin_ai/agents/*.md | wc -l`）已全部設好 `model:`（tracer/grounder 類 = opus；create-mr Step 5 fixer + Step 6 三位 reviewer + Step 6.5 final-adversarial-reviewer = opus，2026-09-02 使用者核准調升/新增；mr-pusher/drive-uploader-mr 等其餘類 = sonnet）。
- **Agent tool 沒有 per-call effort 參數**：要調 effort 只能改 agent 定義檔的 frontmatter。
- **每個 subagent 都會載入專案 CLAUDE.md**：所以 CLAUDE.md 越肥，每派一個 agent 就多付一次。
- **成本級距**（每百萬 input/output token）：Haiku $1/$5、Sonnet $2/$10、Opus $5/$25。Opus ≈ 5×Haiku。
- 主對話 context 會被壓縮摘要：**跨步驟的狀態一律寫檔（tracker、lock、*.md），不可依賴對話記憶。**

## 1. 指揮官不下場（鐵律）

主對話（指揮官）**只做**：讀單行/小段結構化輸出、做分支決策、派工、彙整結論。

以下工作**一律派 subagent**，指揮官自己做視為違規：
- 大量讀取（>2 個檔案的通讀、任何 >300 行檔案的通讀）
- 掃 repo / 廣度搜尋（「找出所有用到 X 的地方」）
- 查網頁 / 查官方文件
- 批次改檔（≥3 個檔案的機械性修改）
- 跑長流程並解讀長輸出（測試全量、lint 全量、bootstrap）

指揮官可以自己做：跑一行指令讀一行結果（`tracker.sh next`、`bug-lock.sh claim`）、用 Edit 改單一小檔、讀 subagent 的回報。

**判別口訣：這步的輸出會超過 30 行嗎？會 → 派人，或改用只回一行的腳本。**

## 2. 派工三件套（缺一不派）

每個派工 prompt 必含三段，寫不出來就代表你自己還沒想清楚，先想清楚再派：

1. **目標與動機**：要完成什麼＋為什麼（動機讓 agent 在邊角情況能做對的取捨）。
2. **驗收條件**：可判定的完成標準（測試綠、檔案存在且含某 section、輸出格式合法……）。「做好做滿」不是驗收條件。
3. **回報格式**：明確規定最後幾行的機器可讀格式（例：`RESULT: PASSED|FAILED` + `REPORT_PATH: <路徑>`）。

現成模板：`30-delegation-templates.md`（搜尋/實作/重構/研究/審查五型）。

## 3. 回報合約（subagent 端紀律，寫進每個派工 prompt）

- 長產物一律落檔（報告、diff、清單 → 寫到指定路徑），回報只給**結論 + 檔案路徑 + 關鍵 file:line**。
- 回報最後 N 行必須符合指定格式，供指揮官不讀全文就能分支。
- 禁止把整檔內容、完整測試輸出、完整 diff 貼回主對話；需要證據時貼「關鍵 10 行以內」。
- 找不到 / 做不到就明說 `RESULT: BLOCKED` + 原因，禁止編造。

## 4. 模型分級（按任務性質選，不是按心情）

| 級別 | 用於 | 本專案實例 |
|---|---|---|
| **haiku** | 機械性、格式固定、判斷含量低：檔案搬運、格式轉換、單檔 read-back 驗證、固定腳本執行與結果轉錄 | 文件上傳類、tracker 轉錄、read-back 驗收 |
| **sonnet**（預設） | 一般工程勞動：實作已規劃好的修改、review 對照、搜尋彙整、研究筆記 | mr-pusher、drive-uploader-mr、bug-report-and-spec-analyst（現況即 sonnet） |
| **opus** | 判斷密集、開放式、錯了很貴：root cause 分析、跨系統影響評估、對抗審查、規格矛盾判定 | bug-tracer-with-callgraph（opus/max）、cqa-grounder（opus/max）、bug-fixer-with-tests（opus/high，2026-09-02 起）、solution-reviewer/adversarial-solution-reviewer/tdd-fidelity-reviewer（opus/high，2026-09-02 起）、final-adversarial-reviewer（opus/high，2026-09-02 新增，create-mr Step 6.5） |

原則：
- **先想「這步錯了的代價」**：錯了會白燒後面整條 pipeline（如 tracer 錯 → fixer/reviewer 全白跑）→ 用 opus。錯了重跑一次就好 → sonnet/haiku。
- **不確定選哪級 → 選 sonnet**，並在驗收條件裡放一個能暴露弱點的檢查。
- 新建 agent 時在 frontmatter 寫死 `model:`，不要依賴 inherit（主對話模型會變）。

## 5. 升降級路徑（照走，不要臨場發明）

- **haiku 錯 1 次** → 直接升 sonnet 重派（不給 haiku 第二次機會，除非錯因是 prompt 缺資訊——那就先修 prompt）。
- **sonnet 同一子任務連錯 2 次** → 升 opus，且派工 prompt 必附**完整失敗軌跡**：兩次分別改了什麼、驗收怎麼失敗的（貼關鍵錯誤訊息）、你懷疑的原因。禁止只說「前面失敗了請重試」。
- **opus 也錯 2 次** → 停。不是模型問題，是任務定義或環境問題：回頭檢查驗收條件是否自相矛盾、環境是否壞了（見 `20-judgment-rubrics.md`「換路訊號」），必要時問使用者。
- **降級**：一旦某類問題被高階模型解出「可複製的模式」（固定改法、固定腳本），後續同型批次工作降回 sonnet/haiku 套用模式，prompt 附上該模式的具體範例。
- **同一件事最多重試兩輪**（含模型升級在內總計 ≤3 次嘗試），之後標記 failed + 記錄軌跡（`tracker.sh log-fail`），繼續下一件事。

## 6. 驗證不自驗（鐵律）

做的人不驗自己的工。驗收一律派 **fresh-context** 的另一個 agent（不給它看實作過程，只給驗收條件）：

- **檔案類**：read-back——驗證檔案存在、必要 section 齊全、與規格宣稱一致（haiku 可勝任）。
- **程式碼類**：跑測試或實跑指令，看 exit code 與輸出，不看 diff 說服自己（sonnet）。
- **高風險判斷類**（root cause、規格矛盾裁定、會推 MR 的結論）：第二意見——再派一個 agent 從反方立場審（「請嘗試推翻這個結論」），或多答案評審選優（opus 出 2-3 案，sonnet 評審表列優劣，指揮官選）。
- 驗收 FAILED 的處理走第 5 節升降級，不要讓原 agent「再看一眼」自我平反。

## 7. 派工操作細節（harness 特性）

- 同一則訊息可以並行派多個互不依賴的 agent；有依賴就必須等前一個結果。
- pipeline 內的步驟派工用**同步**（`run_in_background: false`），避免忙等輪詢；只有真正獨立的側路（如背景研究）才用背景派工。
- 對**已註冊** agent（`.claude/agents/` 裡的）派工：`subagent_type` 直接用 agent 名，prompt 只放變數與回報格式。**嚴禁**在 prompt 裡叫它「把自己的定義檔全文當 prompt 讀一遍」——定義檔本來就是它的 system prompt，再讀一次 = 每次多燒上萬 token（tracer 檔 58KB）。
- 需要延續某個還在的 subagent 的上下文 → 用 SendMessage 續派；全新任務才開新 agent。
- 多 agent 自動編排類工具（若本環境提供，如 Workflow/ultracode）只在使用者明說要用時才用；不確定有沒有就當沒有，用 Agent tool 逐一派。
