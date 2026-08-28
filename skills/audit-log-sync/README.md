# audit-log-sync

這個 skill 用來把**操作日誌的程式碼實作**對齊**企劃在 Notion 整理的操作日誌規格**（規格以 Notion 為準）。

它會做：

- 從 Notion 操作日誌明細表拉指定規格（單一條，或整個菜單節點底下全部）
- 比對五層實作現況：rajah enum → `audit()` 呼叫端 → handler → `AUDIT_HANDLERS` 註冊 → i18n 翻譯
- 產出五層差異報告，經你確認後**直接修改程式碼**
- 產出 i18n 待補 CSV（`key,zh-TW,zh-CN,en-US`）讓你貼到 Google Sheets 多語表

它不會做：

- 寫入 Notion（全程唯讀）
- 修改 `localizations/*.json`（只產 CSV）
- 跑 rajah 生成、lint、測試、commit（收尾會提醒你自己跑）

## Notion 規格長什麼樣

規格分兩層，四張 database 都在父頁「菜單/權限/操作日誌」底下：

| 層 | database | 一列代表 |
|----|----------|---------|
| 明細表 | 系統-操作日誌明細／平台-操作日誌明細 | **一條操作日誌規格**（項目類型、系統項目、動作類別、會員帳號、操作前/後中英文、備註、示意、核對狀態） |
| 主表 | 系統-主表(菜單/權限)／平台-主表 (菜單/權限) | **一個菜單節點**（節點key、菜單路徑、版本、日誌-負責技術、日誌-完成、route、元件路徑），並掛著該節點底下全部明細列 |

## 典型使用流程

三種呼叫形式擇一：

**A. Todo 模式（推薦，免手動找連結）**

```
/audit-log-sync todo <你的 Notion 顯示名>   ← 列出你名下「待處理」的節點
```

**待處理的判定是明細列的「核對狀態」**（不是主表的「日誌-完成」勾選），四個狀態算待處理：`實作未做`／`待修正`／`有差異`／`待核對`。`實作一致` 視為已完成不列；`已廢除`／`待刪除`／`文件未記` 屬規格未定案或作廢，也不列。

回覆清單裡的編號，會用該節點的連結繼續下面的規格摘要 → 差異報告流程（模式 B：該節點底下全部規格列一起處理，已完成的列一併複檢）。

> 兩點資料現況，不是錯誤：**平台**側能依「負責技術」篩出你負責的；**系統**側沒有負責技術可篩（系統明細表無此欄、系統主表 40 列全未指派），所以系統段列的是**全系統待處理**、不分人。另外，若你名下的列都是「實作一致」，清單會是空的。

**B. 貼明細列連結（處理單一條規格）**

到「系統-操作日誌明細」或「平台-操作日誌明細」，找到要處理的那一列、開啟它並複製連結：

```
/audit-log-sync <明細列連結>
```

**C. 貼主表節點連結（處理整個節點）**

到「系統-主表(菜單/權限)」或「平台-主表 (菜單/權限)」，開啟要處理的節點頁、複製連結：

```
/audit-log-sync <主表節點連結>
```

B 與 C 不必自己指定模式，skill 會依連結所屬的 database 自動判定。**不要貼整張 database 的連結**（網址帶 `?v=` 的那種），那是整張表，skill 會請你改貼單一列。

已完成（核對狀態＝實作一致）的節點也可以跑，作為複檢：五層全符合會輸出「複檢通過」報告，不改任何 code。

## 環境設定

### 前置需求：Notion Read-only Integration Token

不需要 Notion 連接器（MCP connector）／OAuth 授權，全程改用團隊共用的**唯讀** Notion Integration Token 直呼官方 REST API（`api.notion.com`）：

1. 到 [notion.so/my-integrations](https://www.notion.so/my-integrations) 建立（或請已有 token 的同事提供）一個 internal integration，Capabilities 只勾：
   - Content Capabilities：**只勾 `Read content`**（`Update content`／`Insert content` 都不要勾）
   - User Capabilities：`Read user information without email`
   - Comment Capabilities：都不要勾
2. 到上表**四張 database** 各自的 `···` → `Connections`，把這個 integration 加進去（只分享這四張 database，不要分享整個 workspace）。主表與明細表都要分享：明細表提供規格內容，主表提供菜單路徑、版本、負責技術與免寫節點判定
3. 在**這個 skill 安裝到的目錄**（例如 `~/.claude/skills/audit-log-sync/` 或 workspace `.claude/skills/audit-log-sync/`——跟 `SKILL.md` 同一層）複製一份 `.env.example` 為 `.env`，把 token 填進去：

   ```bash
   cp .env.example .env
   chmod 600 .env
   # 編輯 .env，把 ALD_RO= 後面補上你的 token
   ```

`.env` 已被 `.gitignore` 排除，不會進版控；每個開發者在自己安裝 skill 的地方各自維護一份，不集中放在專案根目錄（team 裡不是每個人都會有一個共用的根目錄 `.env`）。skill 只會從**本 SKILL.md 所在目錄**的 `.env` 讀 token，不會寫死在任何檔案或對話輸出裡。沒有 `.env`／沒設定 `ALD_RO`，或 token 失效，所有模式都會停在 T0。

### 安裝 skill

**Claude Code 使用者**：把 `lamp/skills/audit-log-sync/` 複製到 workspace 的 `.claude/skills/`（或個人的 `~/.claude/skills/`），即可用 `/audit-log-sync` 呼叫。

**Codex 使用者**：在 lamp 目錄執行 `./sync-ai-files.sh`，取得同步到 workspace `.agents/commands/` 的 `audit-log-sync.md` 指令（薄殼，會引導讀取本 skill 的 SKILL.md）。

## 常見問題

| 問題 | 處理 |
|------|------|
| 啟動就停在 T0 環境檢查 | 依上方「環境設定」申請並設定 `ALD_RO`；確認該 integration 已被分享四張 database |
| 想列出「我還沒做的」 | 用 `/audit-log-sync todo <你的 Notion 顯示名>`，依核對狀態列出待處理節點 |
| Todo 模式查無此人 | 用 Notion 顯示名（不是暱稱或帳號），可到主表任一列的「日誌-負責技術」欄位確認正確拼法 |
| Todo 模式的系統段列出一堆不是我的 | 系統側沒有負責技術欄可篩，該段是全系統待處理清單，需自行認領 |
| Todo 清單是空的 | 你名下的明細列目前都不是待處理狀態（多為「實作一致」），沒有待辦 |
| 貼了連結卻說「這是整張表的連結」 | 你貼到的是 database 本身（網址帶 `?v=`），請改開單一明細列或單一主表節點再複製連結 |
| 規格摘要（T2）就停止 | 規格列缺值（項目類型空、操作前後四欄全空、中英不成對或行數不一致），或該列核對狀態是「文件未記」「待刪除」代表規格未定案，請洽企劃 |
| 出現 T2b「免寫節點」就停止 | 正常現象，不是錯誤：該節點沒有任何明細列且已勾「日誌-完成」（備註常寫「純查詢頁面，無需記錄」），或全部明細列都標「已廢除」，代表企劃確認不需要操作日誌 |
| database 搬家／URL 變更 | 更新 `SKILL.md`「常數」一節的四個 URL 與四個 database ID |
