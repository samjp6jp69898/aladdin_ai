## 輸出模板（T0–T6）

規則：只准填 `<>` 佔位符與增減表格列；開頭標記逐字保留；模板外不加自由段落。

### T0 環境檢查未通過（Notion API Token）

```markdown
🔌 [audit-log-sync] T0 環境檢查未通過

| 檢查項 | 結果 |
|--------|------|
| Notion API Token（`.env` 的 `ALD_RO`） | ❌ 失敗 |
| 失敗原因 | <未設定 ALD_RO ｜ token 無效/過期（401/403）｜ 呼叫錯誤：<訊息>> |

（本次比對流程已停止）

請確認 `<skill-dir>/.env`（本 SKILL.md 所在目錄）是否已設定 `ALD_RO=<Notion Read-only Integration Token>`（該 integration 須已被分享操作日誌的四張 database（系統/平台的主表與明細表）；沒有 `.env` 可先複製同層的 `.env.example`）。詳細申請與設定步驟見 `README.md`「環境設定」。
```

渲染範例：

```markdown
🔌 [audit-log-sync] T0 環境檢查未通過

| 檢查項 | 結果 |
|--------|------|
| Notion API Token（`.env` 的 `ALD_RO`） | ❌ 失敗 |
| 失敗原因 | 未設定 ALD_RO（該目錄下找不到 .env，或 .env 內沒有此變數） |

（本次比對流程已停止）

請確認 `~/.claude/skills/audit-log-sync/.env` 是否已設定 `ALD_RO=<Notion Read-only Integration Token>`（該 integration 須已被分享操作日誌的四張 database（系統/平台的主表與明細表）；沒有 `.env` 可先複製同層的 `.env.example`）。詳細申請與設定步驟見 `README.md`「環境設定」。
```

### T1 使用說明（無參數時，僅無 AskUserQuestion 工具的環境使用；有該工具一律走「無參數時的模式選擇」）

```markdown
📖 [audit-log-sync] T1 使用說明

用法：
- `/audit-log-sync <明細列連結>` — 只處理該一條規格（模式 A）
- `/audit-log-sync <主表節點連結>` — 處理該節點底下全部規格（模式 B）
- `/audit-log-sync todo <負責技術人名>` — 依核對狀態列出待處理節點，選一個後繼續處理（todo 模式）。待處理＝待實作／待修正／有差異／待核對（兩表相同）；平台側依「負責技術」篩人，系統側因主表尚未指派任何人而無法篩人

請貼上要處理的 Notion 連結（明細表的一列，或主表的一個節點；不要貼整張表的連結），或輸入 `todo <你的 Notion 顯示名>` 查詢你的待處理清單。
```

（渲染範例即模板本身，無佔位符。）

### T1b Todo 查詢結果（人名解析／節點清單共用）

```markdown
🗂 [audit-log-sync] T1b Todo 查詢結果 — 輸入：「<使用者輸入的人名>」

<以下三選一>

【情況一：查無此人】
找不到 Notion 顯示名包含「<輸入值>」的成員。請確認顯示名拼法後重試（可到主表任一列的「日誌-負責技術」欄位確認你的顯示名拼法）。

【情況二：多人命中，請確認】
命中多位可能的成員，請回覆更精確的名字：
| # | Notion 顯示名 |
|---|--------------|
| <n> | <顯示名> |

【情況三：待處理清單】
比對到成員：<顯示名>
待處理狀態：待實作／待修正／有差異／待核對（兩表相同）
⚠️ 核對狀態是企劃的人工快照、實測會過期（曾見落後實作一個多月）。「待實作」常見情形是**已實作但規格細節有落差**，不代表從零開始。

### 平台（依「負責技術」篩出你負責的）
| # | 菜單路徑 | 版本 | 待處理列數 | 狀態細分 | 連結 |
|---|---------|------|-----------|---------|------|
| <n> | <一級 › 二級 › 三級> | <版本> | <N> | <待實作 n／待修正 n／…> | <url> |

### 系統（⚠️ 全系統待處理，非依人名篩選）
| # | 菜單路徑 | 版本 | 待處理列數 | 狀態細分 | 連結 |
|---|---------|------|-----------|---------|------|
| <n> | <一級 › 二級 › 三級> | <版本> | <N> | <待實作 n／待核對 n> | <url> |

<系統段固定加：ℹ️ 系統側「有差異／待修正」目前 0 使用，不符的列仍積在「待核對」（62/80），因此系統段的「待核對」量偏大且混雜，不等於「企劃還沒看」。>

共 <N> 個節點、<M> 列待處理（平台 <n1> 列／系統 <n2> 列）。任一段無資料時該段整段省略，改填「（無）」。
<平台側 0 列時加：ℹ️ 你名下的平台明細列目前都不是待處理狀態（多為「實作一致」），沒有待辦項目。>
<有未掛節點的列時加：⚠️ 另有 <n> 列待處理明細未掛菜單節點，無法歸入上表，需個別處理：<url 清單>。>
<分頁讀取中途失敗時加：⚠️ 已讀範圍不完整（<系統｜平台>明細表僅讀到第 <n> 頁），清單可能有遺漏。>
請回覆編號選擇要處理的節點，我會用該節點的連結繼續處理（模式 B：處理該節點底下全部規格列，含已完成的列一併複檢）。
```

渲染範例（情況三節錄）：

```markdown
🗂 [audit-log-sync] T1b Todo 查詢結果 — 輸入：「Hiro」

比對到成員：KHH Hiro Hsu
待處理狀態：待實作／待修正／有差異／待核對（兩表相同）
⚠️ 核對狀態是企劃的人工快照、實測會過期（曾見落後實作一個多月）。「待實作」常見情形是**已實作但規格細節有落差**，不代表從零開始。

### 平台（依「負責技術」篩出你負責的）
| # | 菜單路徑 | 版本 | 待處理列數 | 狀態細分 | 連結 |
|---|---------|------|-----------|---------|------|
| 1 | 會員管理 › 會員列表 | 6/16 | 3 | 待實作 3 | https://app.notion.com/p/AppUser-User-3b387d78618a817d8efddbea06e3ceb5 |
| 2 | 充值管理 › 充值方式管理 | 4/15 | 6 | 待修正 6 | https://app.notion.com/p/PaymentDeposit-Method-… |

### 系統（⚠️ 全系統待處理，非依人名篩選）
| # | 菜單路徑 | 版本 | 待處理列數 | 狀態細分 | 連結 |
|---|---------|------|-----------|---------|------|
| 3 | 遊戲管理 › 廠商列表 | 4/25 | 4 | 待核對 4 | https://app.notion.com/p/GameVendor-Vendor-3b287d78618a81788890d688735be2f8 |

ℹ️ 系統側「有差異／待修正」目前 0 使用，不符的列仍積在「待核對」（62/80），因此系統段的「待核對」量偏大且混雜，不等於「企劃還沒看」。

共 3 個節點、13 列待處理（平台 9 列／系統 4 列）。
請回覆編號選擇要處理的節點，我會用該節點的連結繼續處理（模式 B：處理該節點底下全部規格列，含已完成的列一併複檢）。
```

### T2 規格摘要（通過／停止共用）

```markdown
📄 [audit-log-sync] T2 規格摘要 — <菜單路徑>

- 來源：<系統（gate=admin）｜平台（gate=platform）｜❌ 無法判定來源表（parent.database_id=<實際值>）>
- 處理模式：<A（單列：只處理這一條規格）｜B（整節點：處理該節點底下全部規格）>
- 節點：<節點key｜（本列未掛菜單節點）> ｜ 版本：<版本> ｜ 負責技術：<名單>
- 核對狀態：待處理 <n> 列（待實作 n／待修正 n／有差異 n／待核對 n）｜已完成 <n> 列（實作一致，本次屬複檢）
- 規格列數：<N><，另擱置 <n> 列>

| # | 項目類型 | 系統項目 | 動作類別 | 會員帳號 | 操作前(中) | 操作後(中) | 核對狀態 |
|---|---------|---------|---------|---------|-----------|-----------|---------|
| <n> | <…> | <…｜（空，將推定）> | <…> | <…｜—> | <…> | <…> | <…｜（空）> |

<有擱置列時加下段，否則整段省略：>
### 擱置列（不進五層比對）
| # | 項目類型 | 核對狀態 | 原因 |
|---|---------|---------|------|
| <n> | <…> | <文件未記｜已廢除> | <…> |

完整性檢查：<✅ 通過 ｜ ❌ 未通過，已停止>
<warnings 或缺漏清單，逐條列出>
<停止時加：請洽企劃補齊上述缺漏後再執行。>
```

渲染範例（通過形式）：

```markdown
📄 [audit-log-sync] T2 規格摘要 — 優惠中心 › 活動管理 › 活動黑名單

- 來源：平台（gate=platform）
- 處理模式：B（整節點：處理該節點底下全部規格）
- 節點：BonusCenter.Activity.BlackUser ｜ 版本：6/16 ｜ 負責技術：Yotsai Su KHH
- 核對狀態：待處理 0 列｜已完成 2 列（實作一致，本次屬複檢）
- 規格列數：2

| # | 項目類型 | 系統項目 | 動作類別 | 會員帳號 | 操作前(中) | 操作後(中) | 核對狀態 |
|---|---------|---------|---------|---------|-----------|-----------|---------|
| 1 | 添加黑名單 | 活動系統 | 新增 | 需填入 | - | 會員ID/會員帳號/備註 | 實作一致 |
| 2 | 刪除黑名單 | 活動系統 | 刪除 | 需填入 | - | 會員ID/會員帳號/備註 | 實作一致 |

完整性檢查：✅ 通過
```

渲染範例（停止形式）：

```markdown
📄 [audit-log-sync] T2 規格摘要 — 遊戲管理 › 廠商列表

- 來源：系統（gate=admin）
- 處理模式：A（單列：只處理這一條規格）
- 節點：GameVendor.Vendor ｜ 版本：4/25 ｜ 負責技術：（未指派）
- 核對狀態：待處理 0 列｜已完成 0 列（本列為文件未記，已擱置）
- 規格列數：0，另擱置 1 列

### 擱置列（不進五層比對）
| # | 項目類型 | 核對狀態 | 原因 |
|---|---------|---------|------|
| 1 | 廠商平台狀態變更 | 文件未記 | 依實際日誌反推補建，操作後中文只寫了一句「待補」的待辦、操作後英文空白、系統項目空白，規格尚未定案 |

完整性檢查：❌ 未通過，已停止
1. 剔除擱置列後 specRows 為空，本次沒有可比對的規格
請洽企劃補齊上述缺漏後再執行。
```

> **本例是「貼該明細列」的模式 A 情形。** 同一個節點若貼**主表連結**走模式 B，會拉到 7 列、擱置 1 列後仍有 6 列可比對，輸出的是 T2 **通過形式**＋擱置列段落，**不是停止形式**。不要照這個範例去預期模式 B 的輸出。
>
> 另注意：擱置原因欄**不要對 Notion 原文做半逐字引用**（加引號卻刪字或順手改錯字）。要嘛完整照抄原文，要嘛用不加引號的轉述——鐵律 5 的精神同樣適用於引用企劃文字。

### T2b 免寫節點（早退）

```markdown
🚫 [audit-log-sync] T2b 免寫節點 — <菜單路徑>

- 來源：<系統（gate=admin）｜平台（gate=platform）>
- 節點：<節點key> ｜ 版本：<版本> ｜ 負責技術：<名單>
- 免寫依據：<本節點無任何操作日誌明細列，且「日誌-完成」已勾選 ｜ 本節點全部 <N> 列明細的核對狀態皆為「已廢除」>
- 日誌-備註：<主表 日誌-備註 原文｜（空白）>

企劃已確認本節點不需要任何操作日誌，不進行五層比對，不修改任何程式碼。
（本次比對流程已結束）
```

渲染範例：

```markdown
🚫 [audit-log-sync] T2b 免寫節點 — 大舞台中心 › 動態/評論管理 › 打賞收入統計

- 來源：平台（gate=platform）
- 節點：MessageBoard.MbPost.TipIncomeMgmt ｜ 版本：6/16 ｜ 負責技術：KHH Landon Lo
- 免寫依據：本節點無任何操作日誌明細列，且「日誌-完成」已勾選
- 日誌-備註：純查詢頁面，無需記錄

企劃已確認本節點不需要任何操作日誌，不進行五層比對，不修改任何程式碼。
（本次比對流程已結束）
```

### T3 五層差異報告

```markdown
📋 [audit-log-sync] T3 差異報告 — <菜單路徑>

### 規格列 <n>／<N>：<項目類型>
| 層 | 規格要求 | 現況（檔案:行號） | 判定 | 擬執行動作 |
|----|---------|-----------------|------|-----------|
| 1 rajah enum | <…> | <檔案:行號 摘錄｜（無）> | <✅｜❌｜⚠️｜❓> | <…｜無> |
| 2 呼叫端 | <…> | <…> | <…> | <…> |
| 3 handler | <…> | <…> | <…> | <…> |
| 4 註冊 | <…> | <…> | <…> | <…> |
| 5 i18n | <…> | <…> | <…> | <進 i18n 待補清單｜無> |

範圍外觀察（僅記錄，不屬本次動作）：<條列跨列/範圍外發現；無則整段省略>

<以下三選一收尾>
✅ 複檢通過：本節點五層實作皆符合 Notion 規格，無需改動。
請確認以上擬執行動作後回覆「確認」開始修改，或指出需調整之處。
❓ 有無法定位項，請提供對應的 service method 名稱後我再重新比對。
```

渲染範例（節錄一列）：

```markdown
📋 [audit-log-sync] T3 差異報告 — 優惠中心 › 階梯式返水 › 階梯式返水審核

### 規格列 1／2：階梯式返水審核
| 層 | 規格要求 | 現況（檔案:行號） | 判定 | 擬執行動作 |
|----|---------|-----------------|------|-----------|
| 1 rajah enum | PlatformActionIdEnum 需有階梯式返水審核 actionId | rajah/services/service_common.rajah:210 tieredRebateAudit = 2601 | ✅ | 無 |
| 2 呼叫端 | 會員帳號有值→targetId 傳被審會員 userId | agrabah/src/servers/rebate_back_office/services/tiered_rebate_platform.ts:143 audit(...) 未傳第 5 參數 | ❌ | 補 targetId=invoice.userId |
| 3 handler | 操作後輸出：狀態、返水單號 | implementations/tiered_rebate_audit_handler.ts:12 僅輸出 id | ⚠️ | buildResult 補 status（enum meta）與 invoice-no |
| 4 註冊 | platform gate | implementations/index.ts:388 已註冊 GateId.platform | ✅ | 無 |
| 5 i18n | model.tiered-rebate-invoice-no 中=返水單號/en=Invoice No | abu/platform/localizations/zh-TW.json 無此 key | ❌ | 進 i18n 待補清單 |

請確認以上擬執行動作後回覆「確認」開始修改，或指出需調整之處。
```

### T4 變更清單

```markdown
🛠 [audit-log-sync] T4 變更清單 — <菜單路徑>

## 新增
- <檔案:行號> — <一句話說明>
## 修改
- <檔案:行號> — <一句話說明>
## 移除
- <檔案:行號> — <一句話說明>（無則填「（無）」）
## 已檢查・無需改動
- <檔案:行號> — <一句話說明>

## 核對狀態需訂正的列（Notion 唯讀，請手動去更新）
- <項目類型> — Notion 標「<Notion 上的核對狀態>」，實測應為「<實際狀態>」：<一句話依據，附 檔案:行號>
（無則填「（無）」）

Reviewer：<PASS（opus 級 reviewer 五項 checklist 通過）｜reviewer checklist 已自查（單線程環境）>
```

渲染範例：

```markdown
🛠 [audit-log-sync] T4 變更清單 — 優惠中心 › 階梯式返水 › 階梯式返水審核

## 新增
- agrabah/src/servers/audit_back_office/services/handlers/implementations/tiered_rebate_audit_handler.ts:1 — 新增 handler（輸出 status＋invoice-no）
## 修改
- agrabah/src/servers/rebate_back_office/services/tiered_rebate_platform.ts:143 — audit() 補第 5 參數 targetId（被審會員 userId）
- agrabah/src/servers/audit_back_office/services/handlers/implementations/index.ts:388 — AUDIT_HANDLERS 註冊改指向新 handler
## 移除
-（無）
## 已檢查・無需改動
- rajah/services/service_common.rajah:210 — actionId tieredRebateAudit=2601 已存在且區段正確

## 核對狀態需訂正的列（Notion 唯讀，請手動去更新）
- 階梯式返水審核 — Notion 標「待實做」，實測應為「有差異」：enum/註冊/handler 皆已存在（implementations/index.ts:388），僅呼叫端未傳 targetId

Reviewer：PASS（opus 級 reviewer 五項 checklist 通過）
```

### T5 i18n 待補清單

````markdown
🌐 [audit-log-sync] T5 i18n 待補清單 — <菜單路徑>

已寫檔：<workspace 根目錄>/操作日誌i18n待補-<YYYYMMDD>-<節點名>.csv

```csv
key,zh-TW,zh-CN,en-US
<key>,<繁中>,<簡中>,<英文>
```

請貼到 Google Sheets 多語表後由既有流程匯入；本 skill 不會直接修改 localizations/*.json。
````

渲染範例：

````markdown
🌐 [audit-log-sync] T5 i18n 待補清單 — 優惠中心 › 階梯式返水 › 階梯式返水審核

已寫檔：操作日誌i18n待補-20260709-階梯式返水審核.csv

```csv
key,zh-TW,zh-CN,en-US
model.tiered-rebate-invoice-no,返水單號,返水单号,Invoice No
```

請貼到 Google Sheets 多語表後由既有流程匯入；本 skill 不會直接修改 localizations/*.json。
````

### T6 收尾提醒

```markdown
✅ [audit-log-sync] T6 收尾提醒 — <菜單路徑>

本 skill 不代跑以下步驟，請自行執行：
1. rajah 生成（更新 agrabah/abu 的 generated 檔）：`cd rajah && ./generate-agrabah.sh && ./generate-abu.sh`（或 `./generate-all.sh`）
   ⚠️ 生成前先確認 rajah 在與 generated 同源的分支且已更新，分支不同源時**不要生成**（理由見 SKILL.md「選號前必須確認 rajah repo 與 generated 同源」）
2. Lint：`NODE_OPTIONS=--max-old-space-size=8192 bun run lint`
3. i18n：把 T5 的 CSV 貼到 Google Sheets 多語表並匯入
4. 檢視 diff 後自行 commit（本 skill 不代 commit）
<本次規格涉及「某欄位是否出現在畫面上」時加：
5. **建議實測一筆**：靜態五層比對抓不到「handler 有 `if (data.x !== undefined)` 守衛、但呼叫端沒餵值」這類缺口——畫面上該行就是不會出現，且不會報錯。本機實測方式與兩個坑見 SKILL.md Step 4。>
```

渲染範例：

```markdown
✅ [audit-log-sync] T6 收尾提醒 — 優惠中心 › 階梯式返水 › 階梯式返水配置

本 skill 不代跑以下步驟，請自行執行：
1. rajah 生成（更新 agrabah/abu 的 generated 檔）：`cd rajah && ./generate-agrabah.sh && ./generate-abu.sh`（或 `./generate-all.sh`）
   ⚠️ 生成前先確認 rajah 在與 generated 同源的分支且已更新，分支不同源時**不要生成**（理由見 SKILL.md「選號前必須確認 rajah repo 與 generated 同源」）
2. Lint：`NODE_OPTIONS=--max-old-space-size=8192 bun run lint`
3. i18n：把 T5 的 CSV 貼到 Google Sheets 多語表並匯入
4. 檢視 diff 後自行 commit（本 skill 不代 commit）
<本次規格涉及「某欄位是否出現在畫面上」時加：
5. **建議實測一筆**：靜態五層比對抓不到「handler 有 `if (data.x !== undefined)` 守衛、但呼叫端沒餵值」這類缺口——畫面上該行就是不會出現，且不會報錯。本機實測方式與兩個坑見 SKILL.md Step 4。>
```

（未動 rajah 時第 1 點可標「（本次未動 rajah，可略）」。）
