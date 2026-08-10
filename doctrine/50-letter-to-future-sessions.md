# 給未來 session 的信（50-letter-to-future-sessions）

寫於 2026-07-03，由一個一次性的 Fable 5 session 留下。你（正在讀信的模型）多半是 Sonnet 或 Opus。這封信講三件沒人問但重要的事、這套制度會怎麼壞掉、以及交接中的未竟事項。

## 一、三件沒被問到、但對這個環境最重要的事

### 1. 安全姿態需要使用者做兩個決定（AI 不可代做）
- **Notion token 單源化＋輪替全部完成（2026-07-03）**：token 只存在 `/Users/user/aladdin/.env` 的 `NOTION_TOKEN=` 一行；9 個消費端全讀 .env（新 token 已實測 API 200）；使用者已輪替，備份與 git 歷史裡的舊值已失效。未來輪替 SOP：Notion 後台換發 → 改 .env 一行 → `notion.sh fetch <任一 page>` 驗證。
- ~~使用者層 settings.json 的 mysql MCP root 寫權限~~ 已處理（2026-07-03）：整個 `mcpServers.mysql` 區塊依使用者指示移除（備份在 `backups/20260703-fable/settings.json.user.v2`，要復原貼回去即可）。專案層 `.mcp.json` 的 mysql-dev / mysql-local 不受影響。
- ~~settings.json 寫死 fable model~~ 已處理（2026-07-03）：`model` key 已移除，回歸 Claude Code 預設；superpowers plugin 已依使用者指示全域停用（`enabledPlugins` 設 false，SessionStart hook 與其 skills 一併消失；要恢復改回 true 即可）。

### 2. 品質飛輪已經存在，但還沒閉環（最高 ROI 的下一步）
回測系統量化了分析品質：**完全正確 52.9%、命中 86.5%、分析錯誤 13.5%**（885 單）。錯誤模式已被人工蒸餾成 `obsidian/Rules/` 的「分析與失效模式」27 條——**但 tracer 從來不讀它們**。
閉環做法（綠區，可直接做）：在 `/create-mr` Step 3 的 tracer 派工 prompt 里加一行素材：「歷史失效模式：先讀 obsidian/Rules/_index.md 的『分析與失效模式』分類中與本模組相關的條目」。更進一步（需驗證效果）：每季把回測新增的錯誤模式蒸餾成 tracer 的 pre-flight checklist。**改善 13.5% 錯誤率的槓桿在這裡，不在換更大的模型。**

### 3. superpowers plugin 與自主 pipeline 存在結構性衝突
SessionStart hook 每個 session 注入約 1.2k token 的「任何動作前必須先 invoke skill、創作前必須 brainstorming」指令——對互動式開發有價值，對 `/create-mrs` 這類全自動批次是干擾（弱模型可能停下來等使用者）。本次的緩解：pipeline 指令檔開頭加了「自主聲明」豁免。根本解需要使用者選擇：(a) 停用 superpowers plugin（他們的方法論已內化進 bug-tracer 等 agent 定義檔，runtime 不依賴 plugin）；(b) 維持現狀靠豁免聲明；(c) 試專案層 settings.json 覆蓋同名 hook（文件說可行，未實測）。

## 二、這套制度最可能的退化方式（與預防）

1. **CLAUDE.md 再度肥大**——每次踩坑都有人想「加一段就好」。預防：踩坑有固定去處（`40-maintenance-protocol.md` 第 3 節），CLAUDE.md 超 120 行觸發抽離（第 4 節）。看到有人往 CLAUDE.md 塞敘事，指給他 40 號文件。
2. **文件與環境漂移**——模型名、工具名、路徑會變，文件不會自己變。預防：所有環境事實都標了驗證日期；`40` 第 7 節有健檢清單；裁決規則是「實測 > 腳本 > 文件」。**你發現文件說謊時，修文件是你的職責的一部分，不是可選項。**
3. **回報合約腐蝕**——某天某個 agent 沒照契約尾行回報，manager「將就」著從自由文本裡猜。猜一次，契約就死了。預防：契約缺失 = 該次嘗試失敗，重派（已寫進 create-mr 鐵律 4）。不要好心幫爛輸出擦屁股。
4. **模板儀式化**——抄了 T2 模板但驗收條件寫「功能正常」。預防：槽位填不出來=沒想清楚（30 號文件開頭）；T5 審查明確查「驗收條件是否可判定」。
5. **例外堆疊**——pipeline 遇到新情況，最順手的動作是加一個 if 分支。三次之後沒人看得懂流程。預防：語意變更屬紅區（40 第 1 節）；先問「這是不是該用腳本消滅的坑」。
6. **backups 或舊快照被當成現行版**——預防：搜尋排除 `backups/`；`00-diagnosis-*` 是 dated 快照不回改。

## 三、交接：未竟事項

- [x] `analyze-single-bug.md`、`refine-mr.md` 的「Use all text in {agent.md} as the prompt」雙重載入、`analyze-bugs.md` 的「SlashCommand tool」— **2026-07-03 已完成**（9 處雙載改 `subagent_type` 直引、SlashCommand→Skill、analyze-bugs 的 tracker 整檔讀/Edit 直改全部改走 tracker.sh；見 change-log）。
- [x] CQA 唯讀 DB 連線——**2026-07-03 實測已恢復**：TCP 通、`ai` 帳號可查全部服務 schema（歷史筆記說的「反覆連不上」已不成立）。注意：`landon_ai` 是帳號不是庫名，查詢要用服務 schema（core/payment/…）。若 grounder 再回報 DEGRADED，先跑 `bash conn/db-cqa-query.sh information_schema "SHOW DATABASES"` 實測再接受降級，不要照歷史印象直接降。
- [x] tracer 失效模式閉環（見上文第一節之 2）— **2026-07-03 已完成第一步**：create-mr Step 3 與 analyze-single-bug Step 4b 的 tracer 派工 prompt 已加「先讀 Rules/_index.md『分析與失效模式』相關條目」素材行。進階項（每季蒸餾回測新錯誤模式進 tracer pre-flight checklist）仍待做，且應先用回測驗證第一步對錯誤率的實際效果。
- [ ] 若本 session 的收尾對抗審查未完成（見 change-log 是否有「對抗審查」條目），請照 `30` 的 T5 模板，派 fresh-context agent 審查 doctrine 全部檔案 + 新版 create-mr/create-mrs + 五支腳本，重點查：規則互相打架、路徑錯誤、弱模型會誤讀的措辭。

## 三.五、給下一個 session：v2 首跑 canary 清單 + 優化停損準則

**首跑 canary（新版 create-mr 還沒跑過真單；第一張單用這份清單盯）：**
1. Step 4 `setup-worktree.sh` 首次真跑（至今只 dry-run 過）：看最後一行是否 `SETUP_OK`；若 `BOOTSTRAP_PARTIAL:db-seed` 屬預期（本機 ControlCenter 連不上是既有環境問題）；`SETUP_FAIL` → 讀 `{worktree}/bootstrap.log` 再判，勿直接重試三次。
2. tracer 的 4 行契約尾行是否完整出現（`TRACER_RESULT`/`AFFECTED_REPOS`/`I18N_ONLY`/`ALREADY_FIXED`）——缺行時走 sed 補救是正常路徑，但**記下缺了哪行**，連缺兩單就該把該行的措辭改進派工 prompt（綠區）。
3. solution-reviewer 是否輸出 `FAIL_KIND` 行（新契約首次實戰）。
4. `notion.sh comment-text` 首次真實寫入（至今只驗過唯讀 fetch）：Notion 留言的換行與連結是否正常呈現。
5. mr-pusher 的五行原生契約：manager 用行首 grep 抓 `MR_LINKS:` / `NOTION_AI_FIELD:` 是否順利。
首跑結果（不論好壞）記一行進 change-log；有坑照 40 號第 3 節寫回。

**優化停損準則（below 這些事，做了大概率是浪費——除非先有數據推翻）：**
- ❌ 不要憑直覺動 58KB 的 tracer 定義檔做「prompt 手術」——分析品質的改善路徑是回測飛輪（量化 → 蒸餾 → 閉環），不是重寫 prompt。動它前先問：回測數據指出了哪個具體失效模式？
- ❌ 不要為假想情境加 pipeline 分支（「如果哪天…」）——等真的發生、進了 pipeline-failures.md 再說（退化模式 5：例外堆疊）。
- ❌ 不要整批調整 agent 的 model 分級——現行分級（tracer/grounder=opus、其餘=sonnet）沒有成本或品質數據支持變更前不動。
- ❌ 不要建 token 成本儀表板之類的「監測基建」——現階段 /cost + change-log 足夠，痛了再建。
- ✅ 值得做（任何 session、照 doctrine 即可）：refine-mr.md 的完整 v2 化（比照 create-mr：契約尾行、腳本化、出口表——已有 worked example 可抄）；首跑 canary 發現的任何實際坑。

## 四、harness 的極限（誠實條款）

這套制度能穩定「執行品質」：拆解、契約、驗證、升降級管的是這個。它**補不了**兩樣東西：
1. **規格模糊與業務品味**——這環境的頭號實際卡點（grounding 的 ~10% 走 needs_qa，全是規格矛盾）。不要試圖用更多流程去「解決」它；正確動作永遠是把問題整理成可裁定的形式交給人（`20` 第 3、6 節）。
2. **新穎問題的第一直覺**——分析錯誤率 13.5% 的殘差多屬此類。流程能降低愚蠢錯誤，不能製造洞察。承認信心等級、用第二意見對沖、讓回測繼續量化你——這是誠實的上限管理。

最後一句：這套檔案的價值不在它寫了什麼，在於**它被跑**。每次你按 40 號文件改了一行、按 20 號文件停下來問了一次人、按 10 號文件拒絕自己下場讀大檔——制度就活著。祝順利。
