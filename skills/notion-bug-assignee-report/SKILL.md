---
name: notion-bug-assignee-report
description: 從 Notion Bug List 查狀態為「仍有問題 / 待處理」的 ticket，輸出「一人一列、各嚴重性等級（P1/P2/P3/P4…）一欄」的樞紐表 CSV，並用 tech-users.csv 區分技術/非技術人員。Use when 需要統計待處理 bug 數量、依指派人員分組、看每個人跨嚴重性/優先級的 bug 分布、產生 bug 工單分配報表、盤點各技術/非技術人員手上未解的 bug、輸出 bug 指派 CSV。
---

# notion-bug-assignee-report — Bug 指派人員統計 CSV

## 何時使用

- 「目前狀態仍有問題/待處理的 bug 有幾張？依指派人員看數量」
- 「每個人手上的 bug 在 P1/P2/P3/P4 各等級怎麼分布？一人一列攤開看」
- 「各技術人員手上還有多少未解 bug？跟非技術人員分開」
- 「產出一份 bug 指派分配的 CSV 報表」
- 「盤點未指派的 bug 有幾張」

不適用：需要單號明細、或非「仍有問題/待處理」狀態的查詢——請改寫腳本的篩選條件（見下方「客製」）。

## 使用方式

```bash
bash /Users/user/aladdin/cron/bug-report-run.sh
```

與本機 launchd 排程（`com.aladdin.bug-report`，週一至週五 08:00 觸發）跑的是**同一支腳本**，只維護一份，行為完全一致：

1. 跑 `bug-assignee-report.ts` 產出 FF / 巨星 / 未分類三份 CSV 到 `/tmp/bug-status-by-assignee-<品牌>.csv`。
2. 用 Telegram bot（token 讀 `/Users/user/aladdin/.env` 的 `TELEGRAM_BOT_TOKEN`）把三份 CSV 各自當文件推送到固定 `chat_id`（`5022865804`，Landon），caption 為「Bug 指派人員統計 - <品牌>（日期）」。
3. 任一步驟失敗（報表腳本出錯、CSV 為空、Telegram 推送失敗）會先發一則 `⚠️ Bug 報表排程失敗：...` 文字通知，不會靜默。

若只需要 CSV 內容本身、不需要發 Telegram（例如要在對話中直接分析數字），改跑底層報表腳本即可：

```bash
bun /Users/user/aladdin/obsidian/skills/notion-bug-assignee-report/bug-assignee-report.ts [--out <path>]
```

- CSV 永遠印到 **stdout**，同時寫入 `--out` 指定路徑（預設 `/Users/user/aladdin/tmp/bug-status-by-assignee.csv`）。
- 進度訊息（技術名單載入人數、等級欄、各等級張數、總計、寫入路徑）印到 **stderr**，不汙染 CSV。
- 輸出用 `Bun.write`，`--out` 父目錄不存在會**自動建立**，不需先 mkdir。

## 前置條件與錯誤排查

| 需求 | 說明 / 失敗徵兆 |
|------|----------------|
| 網路可達 Notion API | 無網路 → fetch 拋錯；無輸出 CSV |
| 內嵌 token 有效 | token 失效 → `Notion API error 401`；需更新腳本內 `NOTION_TOKEN`（與 `obsidian/scripts/notion.sh` 同一把） |
| `tech-users.csv` 存在 | 路徑見下表；不存在 → `ENOENT`，全部會被歸成「非技術人員」之前就先 readFileSync 失敗 |

跑前不需手動檢查目錄；失敗時先看 stderr 的錯誤類別（網路 / 401 / ENOENT）對號入座。

## 作法（資料來源與口徑）

| 項目 | 值 |
|------|----|
| Notion data source | `21c87d78-618a-817f-ae71-000baa9ab11b`（Bug List） |
| 篩選狀態 | `狀態` select = `仍有問題` **OR** `待處理` |
| 列（row） | `當前指派`（people），以 **person id** 為主鍵；未指派獨立成「（未指派）」列 |
| 欄（column） | `嚴重性`（select，值如 `P1重點` / `P2較高` / `P3一般` / `P4較低`；未填歸「（未分級）」）每等級一欄；依 `P` 後數字由小到大排序（P0 最優先），未分級殿後；末欄 `小計` = 該人跨等級總量 |
| 技術名單 | `obsidian/commands/create-mr/references/tech-users.csv`，以 **`notion_user_id`** 比對 |
| 分類 | id 命中名單 → `技術人員`；否則 `非技術人員`；無指派 → `未指派` |
| Notion 版本 | `2025-09-03`（data_sources API，需全量分頁） |

**關鍵決策——為何用 id 而非姓名比對技術名單：** Notion 端顯示名常帶前後空白（例如「 benson」「PandaWu 」），靠姓名會誤判分類；`notion_user_id` 是穩定主鍵，必須用它比對。

## 輸出格式

CSV 欄位（樞紐表，欄數隨實際出現的等級動態決定）：`當前指派人員,類別,<P1重點>,<P2較高>,<P3一般>,<P4較低>,…,小計`

- **一人一列**：每個指派人員一列，各嚴重性等級一欄，儲存格 = 該人在該等級的 ticket 數；末欄 `小計` = 跨等級總量。
- 排序：技術人員 → 非技術人員 → 未指派；各組內依 `小計` 由高到低。
- 全檔末尾以空白列分隔後，跨人員彙總列：`技術人員小計` / `非技術人員小計` / `未指派小計` / `總計`（各等級欄亦為分布值）。
- 校驗：任一等級欄三個小計相加 = 該欄總計；所有等級欄的總計相加 = `總計` 欄。

範例（節錄；**數字為某次快照，實際每次跑都會浮動**）：

```csv
當前指派人員,類別,P1重點,P2較高,P3一般,P4較低,小計
Gerubana,技術人員,1,10,15,0,26
KHH Evelyn Lin,技術人員,0,9,10,5,24
...
洋蔥,技術人員,2,11,2,0,15
Ayre Lu KHH,非技術人員,0,13,19,12,44
Tintin Liou KHH,非技術人員,3,14,11,5,33
...
（無名稱）,非技術人員,0,1,0,0,1
（未指派）,未指派,0,19,21,4,44

技術人員小計,技術人員,8,100,96,13,217
非技術人員小計,非技術人員,7,90,74,33,204
未指派小計,未指派,0,19,21,4,44
總計,全部,15,209,191,50,465
```

`（無名稱）` 列會在「指派欄有 person 但 API 未回傳 name」時出現（見下方注意事項）。

## 口徑與注意事項

- **等級欄用 `嚴重性` 欄**：值為 `P1重點` / `P2較高` / `P3一般` / `P4較低`（未來若新增 `P0` 會自動排在最前）；未填的 ticket 歸「（未分級）」欄並殿後。等級欄是**動態**的——只有實際出現的等級才會成欄。
- **狀態拆分已併入小計**：此版本不再單獨列出「仍有問題 / 待處理」兩欄；因篩選本就限定這兩種未解狀態，各等級欄與小計即代表「未解 bug」數。如需還原狀態維度，見「客製」。
- **人次加總 = ticket 去重總數**：此 DB 每張單最多一位指派人，無多重指派重複計算；若未來改成可多指派，人次會大於 ticket 數，需在報告中註明。
- **即時資料波動**：Notion 是即時資料，相隔數分鐘重跑，總數與各人數字可能微幅變動屬正常，非邏輯錯誤。
- **「（無名稱）」列**：指派欄有 person 但 API 未回傳 name，因 id 不在名單，歸非技術人員。
- token 與 data source id 寫死於腳本（沿用 `obsidian/scripts/notion-bug-query-v2.ts` 慣例）。

## 客製（調整篩選或維度）

直接改腳本頂部常數區（檔案開頭 import 後的 `const` 區塊）：
- 換狀態：改 `WANTED_STATUSES`（例：加 `處理中`）。
- 換 DB：改 `DATA_SOURCE_ID`。
- 樞紐欄維度已內建為 `嚴重性`（迴圈內 `props['嚴重性']?.select?.name` → `bump(stat, sev)`）。若要改成「不分等級、只看個人總量」，把 `sev` 固定成單一常數即可（只剩一欄）。
- 換欄維度（例：改用 `影響端口` / `環境` 當欄）：把擷取 `sev` 的那行換成對應 property，並視需要調整 `sevRank` 排序邏輯。
- 還原「仍有問題 / 待處理」狀態維度：把 `bySev` 的 value 從 `number` 改回 `{ '仍有問題', '待處理' }`，或新增一支以狀態為欄的樞紐。
