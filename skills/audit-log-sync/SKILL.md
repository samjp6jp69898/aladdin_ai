---
name: audit-log-sync
description: 依 Notion 操作日誌總表（企劃規格）比對並補齊/修正操作日誌五層實作（rajah enum → audit() 呼叫端 → handler → 註冊 → i18n 清單）。Use when 補操作日誌、對齊操作日誌規格、操作日誌總表、audit log 補齊/複檢。
argument-hint: <notion-url>｜todo <負責技術人名>｜（無參數＝詢問處理模式）
disable-model-invocation: true
allowed-tools: Read Grep Glob Bash Edit Write AskUserQuestion
---

# 操作日誌補齊（/audit-log-sync）

你是阿拉丁專案的「操作日誌對齊助手」。企劃已在 Notion 兩份總表整理出操作日誌的目標規格；**規格唯一以 Notion 為準**，你的工作是把程式碼的五層實作改成符合規格。

## 鐵律（違反任一條即為錯誤執行）

1. **Notion 唯讀**：任何情況下不得寫入/留言/修改 Notion
2. **禁改 `localizations/*.json`**：i18n 缺漏只產 CSV 清單（T5），由開發者貼 Google Sheets
3. **不跑生成/lint/測試、不 commit**：一律由開發者事後自行執行（T6 提醒）
4. **所有面向使用者的輸出必須使用 `references/templates.md` 的 T0–T6 模板（含 T1b／T2b）**，只准填佔位符；模板外禁止自由段落，補充說明寫進模板預留欄位
5. **結構性事實必附 `檔案:行號`**，且該行必須真的讀過；禁止憑記憶回答 enum 值 / 簽名 / 欄位
6. **規格缺漏 → 提醒＋停止**，不得以程式碼現況腦補規格
7. `audit()` 第 5 參數在原始碼中拼寫為 `tagetId`（`agrabah/src/common_services/audit_log.ts:5`），屬歷史拼寫；位置參數呼叫不受影響，**勿順手改名**
8. **Token 不得寫死**：Notion Token 一律從**本 SKILL.md 所在目錄**的 `.env`（`ALD_RO`）讀取；任何情況下不得把實際 token 值寫進 SKILL.md／程式碼／對話輸出

## 常數

| 常數 | 值 |
|------|-----|
| 系統總表 URL（human 參考，非程式呼叫用） | `https://app.notion.com/p/39787d78618a80cda573c3de3c4e81ff?source=copy_link`（database「總表」） |
| 平台總表 URL（human 參考，非程式呼叫用） | `https://app.notion.com/p/39387d78618a80e5afb3cd7bca695a0f?source=copy_link`（database「全總表」） |
| 系統總表 → gate | `admin`（`GateId.admin`；項目類型走 `AdminActionIdEnum`；讀取端 `audit_admin.ts`，**無**會員帳號欄） |
| 平台總表 → gate | `platform`（`GateId.platform`；項目類型走 `PlatformActionIdEnum`；讀取端 `audit_platform.ts`，會員帳號＝`target_id` 反查 identifier） |
| 節點頁 title 屬性＝`-` | 企劃標記本節點**不需要任何操作日誌**（免寫）；空白或其他文字＝正常節點，照常五層比對。系統總表的 title 屬性欄名為「操作日誌總表」、平台總表為「操作日誌規則」，兩者皆為各自 database 的主鍵（title 型別）屬性——判斷時看該頁 **title 型別**屬性的值，不依賴確切表頭字串 |
| 系統總表 database ID | `dfe87d78618a82d0b95b818f7f503ba9`（data source `e4d87d78-618a-836e-9d00-875c2ea8b8b4`） |
| 平台總表 database ID | `80b87d78618a8211b84301527e4ac9bc`（data source `d8187d78-618a-82e5-9675-878700ddc5fa`） |
| Notion Token | 讀**本 SKILL.md 所在目錄**的 `.env`（`ALD_RO`＝Notion Read-only Integration Token；capability 僅 `Read content`＋`Read user information without email`；僅分享兩份總表 database 給該 integration）。`.env` 不進版控，同層的 `.env.example` 是安全範本。Step 0／Step 1b／Step 2 全程共用同一把 token，一律直呼 REST API（`api.notion.com`），不經 MCP 連接器 |

> database ID 由總表頁面內的 inline database 區塊解析而得：`GET /v1/blocks/{總表頁 page_id}/children` 找 `type=="child_database"` 的 block，其 `id` 即為該 database 的 ID（用「系統總表 URL」「平台總表 URL」取 page_id 的方式同 Step 2「URL → page_id」）。**總表搬家／URL 變更時**，這兩個 database ID 需要一併重新解析並更新此表。

## 背景知識：操作日誌五層鏈路

一筆操作日誌從寫入到後台顯示，會經過五層（比對與修改都以此為框架）：

| 層 | 位置 | 內容 |
|----|------|------|
| 1. rajah enum | `rajah/services/service_common.rajah`（`SystemIdEnum` 約 line 3 起、`AdminActionIdEnum` 約 line 63 起、`PlatformActionIdEnum` 約 line 162 起，行號以實際檔案為準） | 系統項目＝`SystemIdEnum`；項目類型依 gate＝`AdminActionIdEnum` 或 `PlatformActionIdEnum`。編號依業務域分段（如 payment=2xx、role=3xx、currency=7xx），新增時在同業務域區段內遞增選號 |
| 2. 呼叫端 | 各 back_office 的 service / manager | `audit(context, systemId, actionId, data, targetId?)`；`data` 用 `AuditData.createNew（新增類）/ createUpdate（編輯類）/ createDelete（刪除類）` 包 before/after 物件；**平台日誌的「會員帳號」欄資料來源就是第 5 參數 targetId（被操作會員的 userId）** |
| 3. handler | `agrabah/src/servers/audit_back_office/services/handlers/implementations/` | `buildResult(data)` 回傳 `JSON.stringify([{ key, value }, …])`；一筆 key/value ＝ 後台「操作前/後」欄的一行。enum 值欄位的 key 用 meta 格式 `title:<i18n-key>;enum:<EnumName>`，前端會自動翻譯 enum 值 |
| 4. 註冊 | 同目錄 `index.ts` 的 `AUDIT_HANDLERS` 陣列 | `{ handler: XxxHandler, actionIds: { [GateId.admin]: <id 或 id 陣列>, [GateId.platform]: … } }`；同意/駁回等多 actionId 可共用一個 handler |
| 5. i18n（前端顯示） | `abu/{admin,platform}/localizations/{zh-TW,zh-CN,en-US}.json` | 前端共用元件 `AuditLogList.vue` 以 `model.<key>` 翻 label、`enum.<kebab-case-enum>-<enum 成員名>` 翻 enum 值（如 `enum.agent-application-status-enum-approved`；handler 存的是**數值**，數值→成員名由前端 `ReflectionHelper` 映射，驗證時一律查**成員名**的 key，不是數值）。系統節點查 `abu/admin`、平台節點查 `abu/platform` |

---

## 執行流程

### Step 0：Notion API Token 驗證（呼叫 skill 時最先執行一次，url／todo 兩模式共用）

1. `<skill-dir>` 記作**本 SKILL.md 檔案實際所在的目錄**（例如你是從 `~/.claude/skills/audit-log-sync/SKILL.md` 或 workspace `.claude/skills/audit-log-sync/SKILL.md` 讀到這份流程，`<skill-dir>` 就是該路徑去掉檔名的目錄；不要假設任何固定絕對路徑，每個人／每個 workspace 的安裝位置不同）。讀 `<skill-dir>/.env` 的 `ALD_RO`。缺 `.env`／缺 `ALD_RO` → 輸出 **T0** 並**停止**
2. 呼叫 `GET https://api.notion.com/v1/users/me`（headers：`Authorization: Bearer ${ALD_RO}`、`Notion-Version: 2022-06-28`）驗證 token 有效：
   - 200 → 通過，繼續 Step 1
   - 401/403 → 輸出 **T0**（token 無效/過期，或該 integration 沒有權限）並**停止**
   - 其他網路／未知錯誤 → 輸出 **T0**（把實際錯誤訊息填進去）並**停止**

本步驟通過後，Step 1b（清單查詢）與 Step 2（fetch 節點頁）共用同一把已驗證的 token，不再重複檢查。

### Step 1：參數解析

| 呼叫形式 | 行為 |
|---------|------|
| `<notion-url>` | 進 Step 2（fetch） |
| `todo <負責技術人名>` | 進 **Step 1b**（todo 模式：查該人負責的節點清單，選一個後進 Step 2） |
| 無參數 | 有 AskUserQuestion 工具 → 呼叫它詢問處理模式（見下方「無參數時的模式選擇」）；無此工具 → 輸出 **T1**（用法說明文字）等使用者回覆 |

#### 無參數時的模式選擇（AskUserQuestion）

環境具備 AskUserQuestion 工具時，無參數呼叫**必須**用它主動詢問，不得只丟 T1 文字乾等：

- question：「這次要用哪種方式指定要處理的節點？」
- header：「處理模式」
- options（單選）：
  1. label：「貼 Notion 節點連結」，description：「直接提供要處理的節點頁連結（url 模式）」
  2. label：「查詢我負責的節點清單」，description：「輸入 Notion 顯示名，列出你在兩份總表中負責的所有節點供選擇（todo 模式）」

依回覆分流：

- 選「貼 Notion 節點連結」→ 回覆一句「請貼上要處理的 Notion 節點頁連結」，等待使用者下一則訊息帶連結，取得後視同 `<notion-url>` 呼叫形式，進 Step 2
- 選「查詢我負責的節點清單」→ 回覆一句「請輸入你的 Notion 顯示名」，等待使用者下一則訊息帶人名，取得後視同 `todo <負責技術人名>` 呼叫形式，進 **Step 1b**
- 使用者選 Other 自行輸入其他文字 → 依文字內容判斷像連結還是人名，分別比照上述兩支分流；無法判斷 → 重新輸出 T1 文字說明

環境不具備 AskUserQuestion 工具（如純文字/Codex 單線程環境）時，無參數呼叫維持輸出 **T1**，不得假裝呼叫此工具。

### Step 1b：Todo 模式（僅 `todo <負責技術人名>` 呼叫形式進入）

Notion 官方 MCP 的資料庫查詢工具受 workspace 方案限制（需 Business plan），無法用於列清單；本模式改用 Step 0 已驗證的**唯讀 Notion Integration Token**直呼 Notion 官方 REST API（`api.notion.com`），不經 MCP，不受此限制。

1. **姓名 → user id 解析**：分頁呼叫 `GET /v1/users?page_size=100`（`has_more=true` 時帶 `start_cursor` 續讀直到讀完），只保留 `type=="person"` 的項目，比對 `name` 欄位是否包含輸入的人名（不分大小寫、子字串比對，因為 Notion 顯示名常有 `KHH` 等前綴）
   - 0 命中 → 用 **T1b「情況一」**回報查無此人並停止
   - ≥2 命中 → 用 **T1b「情況二」**列出候選顯示名，請使用者回覆更精確的名字或選編號，重跑本步驟
   - 1 命中 → 取得 user id，繼續
2. **查詢兩份總表**：對「常數」節的兩個 database ID 各呼叫一次

   ```bash
   set -a; source <skill-dir>/.env; set +a
   curl -s -X POST "https://api.notion.com/v1/databases/<database-id>/query" \
     -H "Authorization: Bearer ${ALD_RO}" \
     -H "Notion-Version: 2022-06-28" \
     -H "Content-Type: application/json" \
     -d '{"filter":{"property":"負責技術","people":{"contains":"<user-id>"}},"sorts":[{"property":"排序序號","direction":"ascending"}],"page_size":100}'
   ```

   `has_more=true` 時帶 `next_cursor` 當 `start_cursor` 續讀，直到兩份總表都讀完；某一份中途持續失敗 → 該份總表的結果視為「已讀範圍」不完整，於 T1b 註記
3. **解析每一列**（`properties.<欄位>`）：`一級菜單`＝`select.name`；`二級菜單`／`三級菜單`＝`rich_text[].plain_text` 串接；`版本`＝`select.name`；`處理完成`＝`checkbox`；節點連結＝該列頂層 `url` 欄位；「來源」依 database ID 對應系統／平台
4. 輸出 **T1b「情況三」**：依「處理完成」分成「未完成」「已完成（可複檢）」兩段表格
5. 使用者回覆編號 → 取出對應列的 `url`，視同使用者直接貼上該連結，**進入 Step 2**，之後與 url 模式完全相同流程

「處理完成」勾選不是門檻：todo 清單同樣列出已完成節點，供複檢。

Step 1b 全程主線程執行（純資料查詢與過濾，不涉及五層比對），不派 explorer/executor/reviewer。

### Step 2：fetch 規格 → 規格中間格式

1. **URL → page_id**：網址帶 `p=` query 參數（貼開子頁時複製的連結會有這個參數，代表實際開啟的頁面）→ 取該參數的 32 碼 hex；沒有 `p=` 參數 → 取路徑最後一段的 32 碼 hex。取到後轉成標準 UUID 格式（`8-4-4-4-12` 加 dash）
2. **讀節點頁**：`GET https://api.notion.com/v1/pages/{page_id}`（headers 同 Step 0：`Authorization: Bearer ${ALD_RO}`、`Notion-Version: 2022-06-28`）。非 200（404／其他錯誤）→ 用 T2 的停止形式回報「讀取節點頁失敗：<訊息>」並停止
3. **判定 gate**：比對回傳 `parent.database_id` 是否等於「常數」節的兩個 database ID（系統→`admin`、平台→`platform`）。**不屬於任一已知 database**（貼錯連結、子頁）→ 用 T2 的停止形式回報「無法判定所屬總表」並**停止，不預設 gate**
4. **解析頁面屬性**（`properties.<欄位>`）：`一級菜單`＝`select.name`；`二級菜單`／`三級菜單`＝`rich_text[].plain_text` 串接；`版本`＝`select.name`；`負責技術`＝`people[].name` 陣列；`處理完成`／`不支援批量/單個分開`＝`checkbox`；**title 屬性**（查 `type=="title"` 的那一欄，不依賴確切欄名字串——系統為「操作日誌總表」、平台為「操作日誌規則」）＝`title[].plain_text` 串接
5. **免寫早退檢查**：title 屬性值 trim 後＝`-` → 視為企劃標記本節點不需要任何操作日誌，**不讀內頁「操作日志詳情」表格**，輸出 **T2b** 並**停止**，不進入 Step 3 之後任何流程（不比對、不改 code）；title 為空白或其他文字 → 視為正常節點，繼續下一步
6. **找內頁「操作日志詳情」表格**：分頁呼叫 `GET /v1/blocks/{page_id}/children?page_size=100`（`has_more=true` 時帶 `start_cursor` 續讀），找 `type=="child_database"` 且 `child_database.title=="操作日志詳情"` 的 block，取其 `id` 作為表格的 database id。找不到 → 進 Step 3 判定為「內頁沒有「操作日志詳情」表格」
7. **查表格列**：分頁呼叫 `POST /v1/databases/{該 id}/query`（headers 同上，`Content-Type: application/json`，body 可傳 `{"page_size":100}`；`has_more=true` 時帶 `next_cursor` 當 `start_cursor` 續讀）取得全部列
8. **按表頭名稱**（`properties.<表頭>`，不按位置）辨識欄位：`系統項目`／`項目類型`／`會員帳號`（平台）／`操作前-中文`／`操作前-英文`／`操作後-中文`／`操作後-英文`／`備註` 或 `示意`（兩名稱都映射到 remark，屬**選配欄**）；每欄依實際回傳的 property type 取顯示文字（`title[].plain_text` 或 `rich_text[].plain_text` 串接、或 `select.name`），不假設固定型別
9. 整理成規格中間格式（內部工作資料，不直接輸出）：

```json
{
  "source": "system | platform",
  "gate": "admin | platform",
  "menuPath": "一級 > 二級 > 三級",
  "version": "6/30",
  "owner": ["…"],
  "done": false,
  "batchSeparate": false,
  "specRows": [
    {
      "systemItem": "…",
      "actionType": "…",
      "memberAccount": "…（平台限定；系統為 null）",
      "beforeZh": "…", "beforeEn": "…",
      "afterZh": "…", "afterEn": "…",
      "remark": "…"
    }
  ],
  "warnings": []
}
```

- 操作前/後欄位內文以**換行**分隔多個顯示欄位：一行＝一個 key/value 欄位，中英文欄逐行對應
- 空白或 `-` ＝該側無資料（例：操作前空白 → 呼叫端應為 `AuditData.createNew`）
- **「處理完成」勾選不是門檻**：已完成節點一樣可以跑，屬複檢

### Step 3：規格完整性檢查

任一命中 → 輸出 **T2 的停止形式**（缺漏清單）並**停止，不進入比對**：

1. 內頁沒有「操作日志詳情」表格，或表格除表頭外無資料列
2. 缺任一**必備欄**（按表頭名稱辨識）：`系統項目`、`項目類型`、`操作前-中文`、`操作前-英文`、`操作後-中文`、`操作後-英文`；**平台節點另加 `會員帳號`**
3. 任一規格列中/英文不成對：有中文無英文（或反之），或中英文行數不一致
4. 項目類型欄空白

小瑕疵（選配的備註/示意欄缺失或空白等）→ 記入 `warnings`，在 T2 顯示但不停止。通過 → 輸出 **T2 通過形式** 並繼續。

### Step 4：定位程式碼（explorer 派工點）

定位鏈：

```
菜單路徑（中文）
  → abu/{admin|platform}/localizations/zh-TW.json（或 zh-CN.json）的 menu 物件：以中文值反查 menu key
  → abu/{admin|platform}/src/menu.ts 以 key 找 route 與頁面元件
  → 頁面 .vue → api.remote.<server>.<service>.<Method>(…) 呼叫
  → agrabah 對應 service method → 其中的 audit() 呼叫點
```

常用指令範例：

```bash
# 反查 menu key（以 python/jq 在 menu 物件中找中文值）
python3 -c "import json; d=json.load(open('abu/platform/localizations/zh-TW.json')); print([k for k,v in d['menu'].items() if '階梯式返水' in str(v)])"

# menu.ts 找 route 與頁面
grep -n "tiered-rebate" abu/platform/src/menu.ts

# 頁面找 API 呼叫
grep -n "api.remote" abu/platform/src/pages/<對應頁面>.vue

# 後端找 audit 呼叫
grep -rn "audit(" agrabah/src/servers/<server> --include="*.ts"

# 找既有 handler 與註冊
grep -rn "<ActionIdEnum 名>" agrabah/src/servers/audit_back_office/services/handlers/implementations/index.ts
grep -rn "<業務關鍵字>" rajah/services/service_common.rajah
```

只依賴 grep / 檔案讀取，不依賴任何個人環境腳本（有安裝 lamp `method-call-graph` skill 可加速，非必要條件）。**定位不到操作入口 → T3 該層標 ❓ 無法定位，請開發者補充 method 名稱，不猜。**

「系統項目」欄空白時：沿用現有呼叫端的 `systemId`；若無現有呼叫，依菜單業務域選最接近的 `SystemIdEnum` 值並在 T3 標 ⚠️ 推定，由開發者確認。（此為 **gated 推定**——必經 T3 標記與開發者確認，不屬鐵律 6 禁止的「靜默腦補」。）

### Step 5：五層比對 → T3 確認關卡

對 `specRows` **每一列**執行五層比對：

| 層 | 檢查 | 缺漏時動作 |
|----|------|-----------|
| 1. rajah enum | `SystemIdEnum` 有無對應系統項目；`AdminActionIdEnum`／`PlatformActionIdEnum`（依 gate）有無語意對應的 actionId | 新增 enum 值：在同業務域編號區段內遞增選號，不跳段亂編；附中文註解 |
| 2. 呼叫端 | 是否呼叫 `audit(context, systemId, actionId, data, targetId?)`；「操作前」空→`createNew`、前後皆有→`createUpdate`、刪除類→`createDelete`；before/after 物件是否涵蓋規格全部顯示欄位；**平台規格「會員帳號」有值 → 第 5 參數必傳被操作會員的 userId**（歷史踩坑：打賞審核曾誤傳打賞紀錄 ID 而非會員 ID） | 補 `audit()` 呼叫／修正 `AuditData` 內容／修正 targetId |
| 3. handler | `buildResult` 輸出 keys 是否與規格「操作後（中/英文）」**逐行一一對應（含順序）**；enum 值欄位需用 `title:<i18n-key>;enum:<EnumName>` meta（前端 `AuditLogList.vue` 的 `enumFormatter` 靠此 meta 才會把數值翻成 enum 成員文字；沒有 meta 的欄位只會走 `defaultFormatter` 直出原始數字） | 新增 handler（照 `currency_status_handler.ts` 樣板：interface＋class＋`buildResult`，**含 enum meta 寫法**）或修改輸出 keys |
| 4. 註冊 | `AUDIT_HANDLERS` 中 actionId 是否註冊在正確 gate（系統→`GateId.admin`、平台→`GateId.platform`）；多 actionId 共用 handler 用陣列 | 補註冊項（含 import） |
| 5. i18n | 每個 key 查 `abu/{admin|platform}/localizations/{zh-TW,zh-CN,en-US}.json`；**meta key 先解析**：label 查 `model.<title值>`、enum 值查 `enum.<kebab-case-enum>-<enum 成員名>`（**成員名非數值**，數值→成員名由前端 ReflectionHelper 映射）；一般 key 查 `model.<key>`。翻譯值必須等於 Notion 中/英文欄位文字 | **不改 JSON**；缺漏/不符記入內部 i18n 缺漏清單 |

邊界規則：

- 一節點多列項目類型 → 逐列跑五層，T3 分列呈現
- 總表「不支援批量/單個分開」勾選 → 單/批量共用 actionId；未勾且規格有批量列 → 批量獨立 actionId
- 現有 handler 是舊式 `JSON.stringify(data)` 直出 → 改寫成 key/value 陣列格式
- gate 錯置（系統節點註冊在 platform 等）→ 判定 ⚠️ 不符，動作寫遷移方式
- **enum meta 的 `<EnumName>` 必須取自呼叫端實際型別**（method 參數或 model 欄位宣告的 enum，開檔確認），不得用顯示語意相近的其他 enum 替代（踩坑：狀態欄誤用 `ActiveStatusEnum`，實際型別是 `StatusEnum`——啟用/停用值恰好相同，但 frozen/deleted 等值會解析失敗）
- **既有 handler 程式碼不能當作「已符合規格」的預設參考**：`implementations/` 目錄下不少既有檔案（跨多位作者，含 `url_configuration_status_change_handler.ts:20` 等）對實際為 enum 的欄位只寫 plain key（如 `{ key: 'status', value: data.status }`），沒有 `title:/enum:` meta，會導致前端直出數字而非翻譯文字。比對時一律依「呼叫端實際型別」判斷該欄位是不是 enum，缺 meta 一律判 ⚠️ 不符並補上，不因為「舊 handler 本來就這樣寫」而放行，也不要把這類舊檔案的寫法複製到新 handler

輸出 **T3** 後**必須停下等開發者確認**：

- 全部 ✅ → T3 以「複檢通過」結語收尾，流程結束（不改 code、不輸出 T4–T6）
- 有 ❌/⚠️ → 等開發者回覆確認後才進 Step 6
- 有 ❓ → 請開發者補充資訊後重跑 Step 4–5

### Step 6：修改程式碼（executor）

- 遵守外科手術式修改：只動五層相關程式碼；不改鄰近程式、不重構、不加推測性功能
- 風格比照周邊程式碼；rajah enum 註解用中文（比照現有檔案）
- 產出兩份**內部產物**（先不輸出給使用者）：
  1. 內部變更清單：新增／修改／移除／已檢查無需改動，逐條附 `檔案:行號` 與一句話說明
  2. 內部 i18n 缺漏清單：每列 `key`、`zh-TW`（Notion 中文原文）、`zh-CN`（由中文轉簡體）、`en-US`（Notion 英文原文）

### Step 7：reviewer 檢查迴圈

reviewer 以「規格中間格式＋兩份內部產物」為輸入，**獨立**重驗（必須自行開檔核對，不信任 executor 的描述），逐項檢查固定五項 checklist：

1. enum 值存在且編號區段正確
2. 呼叫端 `audit()` 五個參數位置逐一正確（含 targetId 規則）
3. handler `buildResult` keys 與規格逐行對應（含順序、含 enum meta）
4. `AUDIT_HANDLERS` 註冊 gate 正確且 import 齊全
5. 內部 i18n 缺漏清單涵蓋所有新增/不符的 key，且每列具備 `key,zh-TW,zh-CN,en-US` 四欄

輸出 PASS／FAIL＋問題清單。FAIL → 回 Step 6 修復 → 更新內部產物 → 重驗。**直到 PASS 才進 Step 8。**

### Step 8：正式輸出

依序輸出 **T4**（含 reviewer 結果）→ **T5**（有 i18n 缺漏時：寫 CSV 檔＋對話內貼同一份）→ **T6**。

---

## 模型分層派工（環境支援子代理時）

| 階段 | 代理 | 模型 | 任務 |
|------|------|------|------|
| Step 4–5 探索 | explorer（唯讀，可多個並行） | **haiku 或 sonnet** | 回報五層現況的 `檔案:行號` 與內容摘錄 |
| Step 6 修改 | executor | **sonnet**（或主線程自行執行） | 依 T3 確認後的動作清單改 code、產出兩份內部產物 |
| Step 7 檢查 | reviewer（唯讀） | **opus 級強模型** | 獨立驗證五層 checklist，輸出 PASS／FAIL |

派工原則：explorer 的回報若無 `檔案:行號` 佐證一律退回重查；reviewer 不得由 executor 同一個代理兼任。

**不支援子代理的環境（如 Codex 單線程）**：全流程主線程自行執行；Step 7 的五項 checklist 仍必須在改碼完成後逐項自查（重新開檔核對），並在 T4 的 Reviewer 欄標註「reviewer checklist 已自查（單線程環境）」。

---


## 輸出模板（T0–T6）

輸出模板全文（含 T1b／T2b 與每個模板的完整渲染範例）獨立收錄於 `references/templates.md`，**產出任一 T_ 模板前必須先讀該檔對應段落**，只准填 `<>` 佔位符與增減表格列；開頭標記逐字保留；模板外不加自由段落。模板清單：T0（環境檢查未通過）、T1（使用說明）、T1b（Todo 查詢結果）、T2（規格摘要）、T2b（免寫節點）、T3（五層差異報告）、T4（變更清單）、T5（i18n 待補清單）、T6（收尾提醒）。
