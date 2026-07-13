# audit-log-sync

這個 skill 用來把**操作日誌的程式碼實作**對齊**企劃在 Notion 整理的操作日誌總表規格**（規格以 Notion 為準）。

它會做：

- 從 Notion 總表拉指定菜單節點的操作日誌規格
- 比對五層實作現況：rajah enum → `audit()` 呼叫端 → handler → `AUDIT_HANDLERS` 註冊 → i18n 翻譯
- 產出五層差異報告，經你確認後**直接修改程式碼**
- 產出 i18n 待補 CSV（`key,zh-TW,zh-CN,en-US`）讓你貼到 Google Sheets 多語表

它不會做：

- 寫入 Notion（全程唯讀）
- 修改 `localizations/*.json`（只產 CSV）
- 跑 rajah 生成、lint、測試、commit（收尾會提醒你自己跑）

## 典型使用流程

兩種呼叫形式擇一：

**A. Todo 模式（推薦，免手動找連結）**

```
/audit-log-sync todo <你的 Notion 顯示名>   ← 列出你在兩份總表中負責的所有節點（未完成／已完成分段）
```

回覆清單裡的編號，會直接用該節點的連結繼續下面的規格摘要 → 差異報告流程。

**B. Url 模式（手動貼連結）**

1. 到 Notion 開「系統操作日誌總表」或「平台操作日誌總表」，用「**負責技術＝你自己**」篩選，開啟要處理的菜單節點頁、複製連結
2. 執行：

```
/audit-log-sync <節點頁連結>      ← 規格摘要 → 差異報告 → 你確認 → 改 code → 變更清單＋i18n CSV
```

已勾「處理完成」的節點也可以跑，作為複檢：五層全符合會輸出「複檢通過」報告，不改任何 code。

## 環境設定

### 前置需求：Notion Read-only Integration Token

不需要 Notion 連接器（MCP connector）／OAuth 授權，全程改用團隊共用的**唯讀** Notion Integration Token 直呼官方 REST API（`api.notion.com`）：

1. 到 [notion.so/my-integrations](https://www.notion.so/my-integrations) 建立（或請已有 token 的同事提供）一個 internal integration，Capabilities 只勾：
   - Content Capabilities：**只勾 `Read content`**（`Update content`／`Insert content` 都不要勾）
   - User Capabilities：`Read user information without email`
   - Comment Capabilities：都不要勾
2. 到「系統操作日誌總表」「平台操作日誌總表」兩個 database 各自的 `···` → `Connections`，把這個 integration 加進去（只分享這兩個 database，不要分享整個 workspace；分享 database 後，其底下所有節點頁與節點頁內的「操作日誌詳情」表格會一併可讀）
3. 在**這個 skill 安裝到的目錄**（例如 `~/.claude/skills/audit-log-sync/` 或 workspace `.claude/skills/audit-log-sync/`——跟 `SKILL.md` 同一層）複製一份 `.env.example` 為 `.env`，把 token 填進去：

   ```bash
   cp .env.example .env
   chmod 600 .env
   # 編輯 .env，把 ALD_RO= 後面補上你的 token
   ```

`.env` 已被 `.gitignore` 排除，不會進版控；每個開發者在自己安裝 skill 的地方各自維護一份，不集中放在專案根目錄（team 裡不是每個人都會有一個共用的根目錄 `.env`）。skill 只會從**本 SKILL.md 所在目錄**的 `.env` 讀 token，不會寫死在任何檔案或對話輸出裡。沒有 `.env`／沒設定 `ALD_RO`，或 token 失效，兩種模式（url／todo）都會停在 T0。

### 安裝 skill

**Claude Code 使用者**：把 `lamp/skills/audit-log-sync/` 複製到 workspace 的 `.claude/skills/`（或個人的 `~/.claude/skills/`），即可用 `/audit-log-sync` 呼叫。

**Codex 使用者**：在 lamp 目錄執行 `./sync-ai-files.sh`，取得同步到 workspace `.agents/commands/` 的 `audit-log-sync.md` 指令（薄殼，會引導讀取本 skill 的 SKILL.md）。

## 常見問題

| 問題 | 處理 |
|------|------|
| 啟動就停在 T0 環境檢查 | 依上方「環境設定」申請並設定 `ALD_RO`；確認該 integration 已被分享兩份總表 database |
| 想列出「我負責的所有節點」 | 用 `/audit-log-sync todo <你的 Notion 顯示名>` |
| Todo 模式查無此人 | 用 Notion 顯示名（不是暱稱或帳號），可到任一總表列的「負責技術」欄位確認正確拼法 |
| 規格摘要（T2）就停止 | 節點內頁的「操作日志詳情」表格缺必備欄位或沒填，請洽企劃補齊 |
| 出現 T2b「免寫節點」就停止 | 正常現象，不是錯誤：企劃已在總表把該節點頁的 title 屬性（系統總表叫「操作日誌總表」、平台總表叫「操作日誌規則」）填成 `-`，代表明確不需要操作日誌，不用回報企劃 |
| 總表搬家／URL 變更 | 更新 `SKILL.md`「常數」一節的兩個總表 URL，以及對應的兩個 database ID |
