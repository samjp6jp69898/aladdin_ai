## 輸出模板（T0–T6）

規則：只准填 `<>` 佔位符與增減表格列；開頭標記逐字保留；模板外不加自由段落。

### T0 環境檢查未通過

```markdown
🔌 [audit-log-sync] T0 環境檢查未通過

| 檢查項 | 結果 |
|--------|------|
| 系統總表直接讀取 | ❌ 失敗 |
| 失敗原因 | <無可用的 Notion 讀取工具 ｜ 未授權/無權限 ｜ 讀取錯誤：<訊息>> |

（本次比對流程已停止）

<僅 Claude Code 環境加上這段詢問：>
要我現在幫你註冊官方 Notion 連接器嗎？我會執行 `claude mcp add --transport http notion https://mcp.notion.com/mcp`；
註冊後仍需你自己完成兩步：輸入 `/mcp` → 選 notion 完成瀏覽器 OAuth → 重新執行 `/audit-log-sync`。
<非 Claude Code 環境改為：>
請依 `lamp/skills/audit-log-sync/README.md`「環境設定」章節完成 Notion 連接器設定後重試。
```

使用者同意註冊並執行完成後，輸出固定收尾句：

```markdown
✅ 已執行連接器註冊指令。請接著：輸入 `/mcp` → 選擇 notion → 完成瀏覽器 OAuth（授權需涵蓋兩份操作日誌總表所在的 workspace）→ 重新執行 `/audit-log-sync`。若 `/mcp` 看不到 notion，請重啟 Claude Code session 再試。
```

渲染範例：

```markdown
🔌 [audit-log-sync] T0 環境檢查未通過

| 檢查項 | 結果 |
|--------|------|
| 系統總表直接讀取 | ❌ 失敗 |
| 失敗原因 | 讀取錯誤：Too many redirects (exceeded 10)（僅有一般 WebFetch，無法通過 Notion 認證） |

（本次比對流程已停止）

要我現在幫你註冊官方 Notion 連接器嗎？我會執行 `claude mcp add --transport http notion https://mcp.notion.com/mcp`；
註冊後仍需你自己完成兩步：輸入 `/mcp` → 選 notion 完成瀏覽器 OAuth → 重新執行 `/audit-log-sync`。
```

### T0b 環境檢查未通過（Todo 模式專用）

```markdown
🔌 [audit-log-sync] T0b 環境檢查未通過（Todo 模式）

| 檢查項 | 結果 |
|--------|------|
| Notion API Token（`.env` 的 `ALD_RO`） | ❌ 失敗 |
| 失敗原因 | <未設定 ALD_RO ｜ token 無效/過期（401/403）｜ 呼叫錯誤：<訊息>> |

（本次 todo 查詢已停止）

請確認 `<skill-dir>/.env`（本 SKILL.md 所在目錄）是否已設定 `ALD_RO=<Notion Read-only Integration Token>`（該 integration 須已被分享兩份操作日誌總表 database；沒有 `.env` 可先複製同層的 `.env.example`），或改用 `/audit-log-sync <節點連結>`（url 模式）。
```

渲染範例：

```markdown
🔌 [audit-log-sync] T0b 環境檢查未通過（Todo 模式）

| 檢查項 | 結果 |
|--------|------|
| Notion API Token（`.env` 的 `ALD_RO`） | ❌ 失敗 |
| 失敗原因 | 未設定 ALD_RO（該目錄下找不到 .env，或 .env 內沒有此變數） |

（本次 todo 查詢已停止）

請確認 `~/.claude/skills/audit-log-sync/.env` 是否已設定 `ALD_RO=<Notion Read-only Integration Token>`（該 integration 須已被分享兩份操作日誌總表 database；沒有 `.env` 可先複製同層的 `.env.example`），或改用 `/audit-log-sync <節點連結>`（url 模式）。
```

### T1 使用說明（無參數時，僅無 AskUserQuestion 工具的環境使用；有該工具一律走「無參數時的模式選擇」）

```markdown
📖 [audit-log-sync] T1 使用說明

用法：
- `/audit-log-sync <Notion 節點頁連結>` — 直接處理指定節點（url 模式）
- `/audit-log-sync todo <負責技術人名>` — 列出該人在兩份總表中負責的所有節點，選一個後繼續處理（todo 模式）

請貼上要處理的 Notion 節點頁連結，或輸入 `todo <你的 Notion 顯示名>` 查詢你負責的節點清單。
```

（渲染範例即模板本身，無佔位符。）

### T1b Todo 查詢結果（人名解析／節點清單共用）

```markdown
🗂 [audit-log-sync] T1b Todo 查詢結果 — 輸入：「<使用者輸入的人名>」

<以下三選一>

【情況一：查無此人】
找不到 Notion 顯示名包含「<輸入值>」的成員。請確認顯示名拼法後重試（可到任一總表列的「負責技術」欄位確認你的顯示名拼法）。

【情況二：多人命中，請確認】
命中多位可能的成員，請回覆更精確的名字：
| # | Notion 顯示名 |
|---|--------------|
| <n> | <顯示名> |

【情況三：節點清單】
比對到成員：<顯示名>

### 未完成
| # | 來源 | 菜單路徑 | 版本 | 連結 |
|---|------|---------|------|------|
| <n> | <系統｜平台> | <一級 > 二級 > 三級> | <版本> | <url> |

### 已完成（可複檢）
| # | 來源 | 菜單路徑 | 版本 | 連結 |
|---|------|---------|------|------|
| <n> | <系統｜平台> | <一級 > 二級 > 三級> | <版本> | <url> |

共 <N> 筆（未完成 <n1>／已完成 <n2>）。任一段無資料時該段整段省略，改填「（無）」。
<分頁讀取中途失敗時加：⚠️ 已讀範圍不完整（<系統｜平台>總表僅讀到第 <n> 頁），清單可能有遺漏。>
請回覆編號選擇要處理的節點，我會直接用該節點的連結繼續處理。
```

渲染範例（情況三節錄）：

```markdown
🗂 [audit-log-sync] T1b Todo 查詢結果 — 輸入：「Evelyn」

比對到成員：KHH Evelyn Lin

### 未完成
| # | 來源 | 菜單路徑 | 版本 | 連結 |
|---|------|---------|------|------|
| 1 | 平台 | 會員管理 > 投注數據 > 投注記錄 | 4/25 | https://app.notion.com/p/39387d78618a815f8d1dceae864a2de8 |

### 已完成（可複檢）
| # | 來源 | 菜單路徑 | 版本 | 連結 |
|---|------|---------|------|------|
| 2 | 平台 | 遊戲管理 > 廠商列表 | 4/25 | https://app.notion.com/p/39387d78618a8176a044fad27ee25eb1 |

共 2 筆（未完成 1／已完成 1）。
請回覆編號選擇要處理的節點，我會直接用該節點的連結繼續處理。
```

### T2 規格摘要（通過／停止共用）

```markdown
📄 [audit-log-sync] T2 規格摘要 — <菜單路徑>

- 來源總表：<系統（gate=admin）｜平台（gate=platform）｜❌ 無法判定所屬總表>
- 版本：<版本> ｜ 負責技術：<名單> ｜ 處理完成：<是（本次屬複檢）｜否>
- 規格列數：<N>

| # | 系統項目 | 項目類型 | 會員帳號 | 操作前(中) | 操作後(中) | 備註/示意 |
|---|---------|---------|---------|-----------|-----------|----------|
| <n> | <…> | <…> | <…｜（系統節點填 —）> | <…> | <…> | <…> |

完整性檢查：<✅ 通過 ｜ ❌ 未通過，已停止>
<warnings 或缺漏清單，逐條列出>
<停止時加：請洽企劃補齊上述缺漏後再執行。>
```

渲染範例（停止形式）：

```markdown
📄 [audit-log-sync] T2 規格摘要 — 邀請好友 > 好友數據列表

- 來源總表：平台（gate=platform）
- 版本：6/16 ｜ 負責技術：KHH Evelyn Lin ｜ 處理完成：是（本次屬複檢）
- 規格列數：0

| # | 系統項目 | 項目類型 | 會員帳號 | 操作前(中) | 操作後(中) | 備註/示意 |
|---|---------|---------|---------|-----------|-----------|----------|

完整性檢查：❌ 未通過，已停止
1. 內頁沒有「操作日志詳情」表格
請洽企劃補齊上述缺漏後再執行。
```

### T2b 免寫節點（title 屬性早退）

```markdown
🚫 [audit-log-sync] T2b 免寫節點 — <菜單路徑>

- 來源總表：<系統（gate=admin）｜平台（gate=platform）>
- 節點頁 title 屬性值：`-`
- 版本：<版本> ｜ 負責技術：<名單> ｜ 處理完成：<是｜否>

企劃已在總表將本節點標記為「不需要任何操作日誌」（title 屬性＝`-`），不進行五層比對，不修改任何程式碼。
（本次比對流程已結束）
```

渲染範例：

```markdown
🚫 [audit-log-sync] T2b 免寫節點 — 合營代理 > 帳變紀錄

- 來源總表：平台（gate=platform）
- 節點頁 title 屬性值：`-`
- 版本：4/25 ｜ 負責技術：洋蔥 ｜ 處理完成：否

企劃已在總表將本節點標記為「不需要任何操作日誌」（title 屬性＝`-`），不進行五層比對，不修改任何程式碼。
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
📋 [audit-log-sync] T3 差異報告 — 優惠中心 > 階梯式返水 > 階梯式返水審核

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

Reviewer：<PASS（opus 級 reviewer 五項 checklist 通過）｜reviewer checklist 已自查（單線程環境）>
```

渲染範例：

```markdown
🛠 [audit-log-sync] T4 變更清單 — 優惠中心 > 階梯式返水 > 階梯式返水審核

## 新增
- agrabah/src/servers/audit_back_office/services/handlers/implementations/tiered_rebate_audit_handler.ts:1 — 新增 handler（輸出 status＋invoice-no）
## 修改
- agrabah/src/servers/rebate_back_office/services/tiered_rebate_platform.ts:143 — audit() 補第 5 參數 targetId（被審會員 userId）
- agrabah/src/servers/audit_back_office/services/handlers/implementations/index.ts:388 — AUDIT_HANDLERS 註冊改指向新 handler
## 移除
-（無）
## 已檢查・無需改動
- rajah/services/service_common.rajah:210 — actionId tieredRebateAudit=2601 已存在且區段正確

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
🌐 [audit-log-sync] T5 i18n 待補清單 — 優惠中心 > 階梯式返水 > 階梯式返水審核

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
2. Lint：`NODE_OPTIONS=--max-old-space-size=8192 bun run lint`
3. i18n：把 T5 的 CSV 貼到 Google Sheets 多語表並匯入
4. 檢視 diff 後自行 commit（本 skill 不代 commit）
```

渲染範例：

```markdown
✅ [audit-log-sync] T6 收尾提醒 — 優惠中心 > 階梯式返水 > 階梯式返水配置

本 skill 不代跑以下步驟，請自行執行：
1. rajah 生成（更新 agrabah/abu 的 generated 檔）：`cd rajah && ./generate-agrabah.sh && ./generate-abu.sh`（或 `./generate-all.sh`）
2. Lint：`NODE_OPTIONS=--max-old-space-size=8192 bun run lint`
3. i18n：把 T5 的 CSV 貼到 Google Sheets 多語表並匯入
4. 檢視 diff 後自行 commit（本 skill 不代 commit）
```

（未動 rajah 時第 1 點可標「（本次未動 rajah，可略）」。）
