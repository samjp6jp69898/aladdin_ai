---
name: audit-log-sync
description: 依 Notion 操作日誌明細表（企劃規格）比對並補齊/修正操作日誌五層實作（rajah enum → audit() 呼叫端 → handler → 註冊 → i18n 清單）。Use when 補操作日誌、對齊操作日誌規格、操作日誌明細表、audit log 補齊/複檢。
argument-hint: <notion-url（明細列或主表節點）>｜todo <負責技術人名>｜（無參數＝詢問處理模式）
disable-model-invocation: true
allowed-tools: Read Grep Glob Bash Edit Write AskUserQuestion
---

# 操作日誌補齊（/audit-log-sync）

你是阿拉丁專案的「操作日誌對齊助手」。企劃已在 Notion 的操作日誌明細表（系統／平台各一份，各自掛在對應的主表節點下）整理出操作日誌的目標規格；**規格唯一以 Notion 為準**，你的工作是把程式碼的五層實作改成符合規格。

## 鐵律（違反任一條即為錯誤執行）

1. **Notion 唯讀**：任何情況下不得寫入/留言/修改 Notion
2. **禁改 `localizations/*.json`**：i18n 缺漏只產 CSV 清單（T5），由開發者貼 Google Sheets
3. **不跑生成/lint/測試、不 commit**：一律由開發者事後自行執行（T6 提醒）
4. **所有面向使用者的輸出必須使用 `references/templates.md` 的 T0–T6 模板（含 T1b／T2b）**，只准填佔位符；模板外禁止自由段落，補充說明寫進模板預留欄位
5. **結構性事實必附 `檔案:行號`**，且該行必須真的讀過；禁止憑記憶回答 enum 值 / 簽名 / 欄位
6. **規格缺漏 → 提醒＋停止**，不得以程式碼現況腦補規格
7. `audit()` 第 5 參數的正確拼寫是 `targetId`（`agrabah/src/common_services/audit_log.ts:5`）
8. **Token 不得寫死**：Notion Token 一律從**本 SKILL.md 所在目錄**的 `.env`（`ALD_RO`）讀取；任何情況下不得把實際 token 值寫進 SKILL.md／程式碼／對話輸出
9. **「實測」二字只能用在你自己執行並看到輸出的事**。轉述他人（含你派的 subagent）的執行結果，一律註明未親自查證；**規則性主張（讀程式碼可得）與執行性宣稱（要真的跑才知道）必須分開陳述**，不可混寫成同一種語氣

## 常數

規格由**主表＋明細表**兩層構成，四張 database 都掛在同一個父頁 **「菜單/權限/操作日誌」**（`https://app.notion.com/p/3bb87d78618a80a58383c42ff9d55c85`）底下：

| 常數 | 值 |
|------|-----|
| 系統明細表 URL | `https://app.notion.com/p/ea605ea6f18b449ab24a7aa8ec26e7c8?v=9ae091ed5035457bb45578cba1f708c5`（database「系統-操作日誌明細」） |
| 平台明細表 URL | `https://app.notion.com/p/04f789e28a7f4a1cb079331004cb7e96?v=8fe489adbae446919e3813c2efb54380`（database「平台-操作日誌明細」） |
| 系統主表 URL | `https://app.notion.com/p/4f2c314a0c514a4e9aba74f0411b1e83`（database「系統-主表(菜單/權限)」） |
| 平台主表 URL | `https://app.notion.com/p/b14a1ec5ea634ad7805ad9e6137b46e8`（database「平台-主表 (菜單/權限)」） |
| 系統明細表 database ID | `ea605ea6-f18b-449a-b24a-7aa8ec26e7c8` |
| 平台明細表 database ID | `04f789e2-8a7f-4a1c-b079-331004cb7e96` |
| 系統主表 database ID | `4f2c314a-0c51-4a4e-9aba-74f0411b1e83` |
| 平台主表 database ID | `b14a1ec5-ea63-4ad7-805a-d9e6137b46e8` |
| 系統（系統明細表／系統主表）→ gate | `admin`（`GateId.admin`＝2；項目類型走 `AdminActionIdEnum`；讀取端 `audit_admin.ts`，**無**會員帳號欄——系統明細表雖有「會員帳號」欄，2026-08-26 全量 80 列實測**無一列有值**）。**注意 targetId 在系統側仍有用途**，見下 |
| 平台（平台明細表／平台主表）→ gate | `platform`（`GateId.platform`；項目類型走 `PlatformActionIdEnum`；讀取端 `audit_platform.ts`，會員帳號＝`target_id` 反查 identifier） |
| Notion Token | 讀**本 SKILL.md 所在目錄**的 `.env`（`ALD_RO`＝Notion Read-only Integration Token；capability 僅 `Read content`＋`Read user information without email`；須把上述**四張** database 都分享給該 integration）。`.env` 不進版控，同層的 `.env.example` 是安全範本。Step 0／Step 1b／Step 2 全程共用同一把 token，一律直呼 REST API（`api.notion.com`），不經 MCP 連接器 |

### 兩層結構與兩種處理模式

- **明細表**：一列＝**一條操作日誌規格**，規格欄位全部扁平在列屬性上（`GET /pages/{page_id}` 一次讀完）。**明細列的內頁沒有任何 block 內容**（2026-08-26 抽測系統/平台各 12 列皆為空），不要去讀 children 找表格。
- **主表**：一列＝**一個菜單節點**，帶節點層資訊（`版本`／`日誌-負責技術`／`日誌-完成`／`日誌-備註`／`不支援批量/單個分開`／`route`／`元件路徑`），並透過 `操作日誌明細` relation 掛著該節點底下的全部規格列。主表節點頁即「詳細頁面」。

因此 Step 2 支援兩種模式，兩者最終產出同一份規格中間格式、共用之後所有流程：

| 模式 | 使用者貼的連結 | 處理範圍 |
|------|--------------|---------|
| **模式 A（單列）** | 明細表的某一列 | 該列 1 條規格 |
| **模式 B（整節點）** | 主表的某一個節點 | 該節點底下全部規格列 |

### 讀 Notion 的通則（每次查表前先看一眼）

**一律以 `POST /v1/databases/{id}/query` 取回的實際列 property 為準**——欄位清單、型別、值都是。**`GET /v1/databases/{id}` 的輸出不可信**：它是快取，可能回報過時的 select 選項名，甚至整個欄位漏報（實測發生過 schema 只回 17 欄、實際列有 18 欄）。要確認 select 的合法值，看 filter 400 時錯誤訊息列出的 `Available options`。**任何情況下都不要拿 schema endpoint 的輸出當作「這張表有什麼」的結論。**

### 明細表欄位（兩份明細表共用，除標註外）

| 欄位 | 型別 | 說明 |
|------|------|------|
| `項目類型` | **title** | 該列主鍵，一條規格的名稱 |
| `系統項目` | select | 對應 `SystemIdEnum`。**大量為空**（2026-08-27 實測：系統 73/80 空、平台 98/637 空），空值走 Step 4 的 gated 推定，不是缺漏。**⚠️ 系統側的空值不是「企劃沒填」，是選項沒建**：系統明細表的 select 只建了 **3 個**選項（`產品系統`／`遊戲系統`／`Otp 系統`，其中「產品系統」0 使用），平台建了 **42 個**；而 admin 側 `enum.system-id-enum-*` 的 i18n key 有 42 個。企劃在系統側就算想填也只有 3 個可選，**gated 推定在系統側是唯一路徑，不是備案**。另注意拼寫不一致：系統是 `Otp 系統`（含半形空格）、平台是 `Otp系統`（無空格） |
| `動作類別` | select | 用來輔助判斷 `AuditData.createNew／createUpdate／createDelete`，**不是**權威來源，衝突時以「操作前是否為空」為準。**兩表選項不對稱**：平台 13 個選項、系統 11 個，**平台獨有 `狀態`／`處理`**。`狀態` 在平台是第 4 大類（66/637 列），系統側同語意被拆成 `啟用`／`停用`，所以系統看不到 `狀態` 是正常的、不是漏填。反向：系統的 `審核`／`導出`／`導入` 三個選項實際 0 使用（平台 `審核` 有 106 列） |
| `會員帳號` | rich_text | 平台限定語意；值為 `-` 或空＝本操作不針對特定會員。實測平台 145/637 有值、系統 0/80 有值 |
| `操作前-中文`／`操作前-英文`／`操作後-中文`／`操作後-英文` | rich_text | 一行＝一個 key/value 欄位，中英逐行對應；`-` 或空＝該側無資料 |
| `備註`／`示意` | rich_text | 選配。`示意` 常放**真實日誌樣本**（如 `【2026/08/26 DEV 實作實例】…`），是判讀規格意圖的重要佐證，務必讀。**⚠️ 但它是有擷取時間的快照，不是現況**——見下方警告 |

> **⚠️ `示意` 欄是快照，不要拿它當「現行實作輸出什麼」的證據。** 同一個節點內不同列的 `示意` 可能擷取自不同時間點的實作，看起來像「實作前後不一致」，實際上只是新舊快照並存。2026-08-27 實測案例：`PaymentDeposit.Method` 節點中，「編輯充值方式」的 `示意` 顯示 `{語系:zh-CN, 名稱:…}`（已被前端解析的形式）、「充值方式狀態」卻顯示裸 JSON `{"code":"zh-CN","value":"真USDT"}`，驗證 agent 因此在階段一推斷「實作有不一致」，**開檔查證後實作其實完全一致**。
>
> 判讀規格意圖時讀它，**判斷實作對錯時一律回去開檔與查 DB**。裸 JSON 形式的 `示意` 尤其常見於擷取當下平台語系設定不同（見「特殊 value 形狀」小節的語系清單警告），不代表 handler 寫錯。
| `核對狀態` | select | 企劃對「文件 vs 實作」的判定，見下表 |
| `菜單節點` | relation | → 主表；平台明細 2026-08-28 實測有 51/637 列**未掛節點**（rollup 全空），此時菜單路徑不可得 |
| `一級菜單`／`二級菜單`／`三級菜單` | rollup | 兩表皆有，經 `菜單節點` 取自主表 |
| `菜單路徑` | rollup（**僅系統明細表有**） | 主表的 formula（`一級 › 二級 › 三級`）。平台側要取菜單路徑，得走 `菜單節點` relation 讀主表 |
| `節點排序`（系統）／`排序序號`（平台） | rollup | 排序用。**欄名不同，rollup function 也不同，解析路徑因此不同**——見下方「rollup function 不對稱」 |
| `負責技術` | rollup（**兩表皆有**） | 經 `菜單節點` 取自主表的 `日誌-負責技術`。**系統側欄位存在且可下 filter（HTTP 200、回 0 列），但值全空**——系統明細 0/80 列有值，因為系統主表 `日誌-負責技術` 填寫率 0/40（平台明細 561/637 有值、平台主表 180/239）。所以系統側不能按人分派的理由是**沒人被指派**，不是缺欄位 |

#### ⚠️ rollup function 不對稱（照統一寫法解析會拿到 undefined）

兩表的排序欄 function 不同，**回傳結構完全不同、沒有共通路徑**（2026-08-27 實測）：

| | 欄名 | function | 實際回傳 | 取值路徑 |
|---|------|----------|---------|---------|
| 系統明細 | `節點排序` | **`sum`** | `{"type":"number","number":5000}` | `rollup.number` |
| 平台明細 | `排序序號` | `show_original` | `{"type":"array","array":[{"type":"number","number":122000}]}` | `rollup.array[0].number` |

系統側是 `sum` 型 rollup，回傳裡**根本沒有 `array` 鍵**——套 Step 2.7 那句「rollup 取 `rollup.array[0]` 再依其 type 取值」必定拿到 undefined。語意上也不同：`sum` 在一列掛多個菜單節點時會把序號加總成無意義的數字，`show_original` 則逐一列出。其餘 rollup（`一級/二級/三級菜單`、`菜單路徑`、`負責技術`）兩表皆為 `show_original`，走 `rollup.array[]` 正確。

**以上只講明細表。主表的 `排序序號` 是原生 `number` 屬性、不是 rollup**（2026-08-27 實測平台主表回傳 `{"type":"number","number":98000}`），解析主表屬性時直接取 `number`，套 rollup 的取法一樣會拿到 undefined。三者同名不同型，取值前先看 `type`。

### 主表欄位（兩表差異與實際填寫率）

兩張主表的欄位**幾乎對稱，但有四處差異**，且有數個欄位全表無值（2026-08-28 全量實測：系統主表 40 節點、平台主表 239 節點、欄位數 25 vs 27）：

| 欄位 | 系統主表 | 平台主表 | 備註 |
|------|---------|---------|------|
| title | `節點key` | `節點key (權限在裡面)` | 欄名不同，**判斷時只認 `type=="title"`，不比對欄名字串** |
| `商戶權限` | **無此欄** | select：`全開` 129／`FF專屬` 34／`按鈕開關` 26／`不開放` 25／`巨星專屬` 23／空 3 | **平台獨有**。25 個「不開放」節點的語意是否等同「不需要日誌」尚未與企劃確認，遇到時標 ⚠️ 問人，不要自行當成免寫依據 |
| `商戶開通` | **無此欄** | 2026-08-28 新增 | **平台獨有、新欄位**。語意未與企劃確認，本 skill 目前不使用；解析主表屬性時要容許它不存在 |
| `版本` | 4 個選項（`4/25` 35／`7/7` 4／`6/30` 1） | 7 個選項（多 `4/15`／`7/25`／`8/15`；`4/15` 133／`6/16` 36／`7/7` 17／`6/30` 14／`4/25` 13／空 27） | 系統側版本停在 `7/7`、35/40 節點還在 `4/25`，落後平台。**規格新鮮度兩邊不對等，系統側的規格更可能過期** |
| `日誌-負責技術` | **0/40 有值** | 180/239 有值 | 系統側無法按人分派，Step 1b 系統段因此不分人 |
| `菜單-負責技術`／`權限-負責技術` | 0/40 | 0/239 | **兩表皆全空**，本 skill 不使用 |
| `上CQA` | 0/40 勾選 | 0/239 勾選 | **兩表皆全空、目前是無效欄位**。Step 2.5 仍會解析它，但不要拿它做任何判定 |
| `不支援批量/單個分開` | 0/40 勾選 | 0/239 勾選 | 兩表皆未勾選，實務上一律走「批量獨立 actionId」（見 Step 5 邊界規則） |
| `日誌-完成` | 19/40 勾選 | 193/239 勾選 | 只用於 Step 2.6 免寫早退判定，**不作為 todo 完成門檻** |
| `菜單路徑` formula | 有（`一級 › 二級 › 三級`） | 有（同式） | 兩表相同；差別在**明細表側**只有系統有對應 rollup |

其餘欄位（`一級/二級/三級菜單`、`排序序號`、`route`、`元件路徑`、`日誌-備註`、`菜單-備註`／`菜單-完成`、`權限-備註`／`權限-完成`、`主策畫`／`副策畫`、`編號`、`上次編輯時間`、`操作日誌明細` relation）兩表皆有且同型別。`一級菜單` 的 select 選項兩表不同屬正常（不同後台的菜單結構），不是不同步。

### `核對狀態` 取值與本 skill 的處理方式

兩份明細表的 `核對狀態` 選項**一致**，共 7 個：`待核對`／`實作一致`／`待實作`／`文件未記`／`已廢除`／`有差異`／`待修正`。系統與平台用同一套處理邏輯。

> **⚠️ 下 filter 前先確認現行選項。** 這一欄的選項名被企劃調整過，且 **select 值寫錯會直接 400、不是回 0 列**——寫死選項名的查詢會整段炸掉。確認方式：對該表下單值 filter 試探，或看 400 錯誤訊息列出的 `Available options`。**比對值時用子字串**（例如比 `待實` 前綴）。

全量實測分布（2026-08-28）：

| | 待核對 | 實作一致 | 待實作 | 有差異 | 待修正 | 文件未記 | 已廢除 | 空 |
|---|---|---|---|---|---|---|---|---|
| 系統（80 列） | **62（78%）** | 7 | 2 | 0 | 0 | 5 | 4 | 0 |
| 平台（637 列） | 100（16%） | 444 | 15 | 11 | 47 | **0** | **0** | 20 |

**兩個判讀結論（不寫出來會誤判）**：

1. **系統側的 `待核對` 不等於「企劃還沒看」。** 系統側 `有差異`／`待修正` 實測皆 0 列，而 `待核對` 佔 62/80（78%）——那 62 列裡混著尚未分類的不符項。平台的 `待核對`（100/637，16%）才比較接近字面語意。**這個比例會隨企劃分類進度改變，引用前先自己跑一次分布。**
2. **`文件未記` 與 `已廢除` 在平台是 0 使用**（選項有、沒人用），實際上是系統獨有現象。下表「出現於」欄標的是**選項存在於哪張表**，不是實際有列在用。

| 核對狀態 | 選項出現於 | 語意（依選項名稱與實測樣本推定） | 本 skill 動作 |
|---------|--------|--------------------------------|--------------|
| `待核對` | 系統/平台 | 平台：企劃尚未比對實作。**系統：語意被稀釋**（見上方結論 1），混有尚未分類的不符項 | 照常五層比對 |
| `實作一致` | 系統/平台 | 企劃認為實作已符合 | 照常五層比對（等同複檢；企劃判定不取代本 skill 的開檔查證） |
| `待實作` | 系統/平台 | 企劃**在某個時間點**判定規格有、程式沒做 | 照常五層比對。**⚠️ 這是線索不是結論，不得據此決定「要新增」**——實測有一個多月的落差（見下），一律先跑 Step 4.0 的「先找再建」三個 grep |
| `有差異`／`待修正` | 系統/平台 | 實作與規格不符 | 照常五層比對（預期會產出修改動作）。**系統側目前 0 使用** |
| `文件未記` | 系統/平台（**平台 0 使用**） | **此列是從實際日誌反推補建的**，規格欄位常不完整（操作後-英文空、系統項目空、操作後中文寫「待補：…需討論應記錄哪些欄位」） | **不可照做**：Step 3 判為規格未定案，輸出 T2 停止形式並請企劃先定案，不得依現行實作反推「規格」再改回同樣的實作 |
| `已廢除` | 系統/平台（**平台 0 使用**） | 此規格作廢 | **早退**：輸出 T2b 免寫形式（理由填「核對狀態＝已廢除」），不比對、不改 code |
| 空值 | 系統/平台 | 未填（平台實測 20 列、系統 0 列） | 照常五層比對，並在 T2 warnings 註記 |

> **`核對狀態` 是企劃某個時點的人工判定，會過期——兩個方向都會。** 它決定的是「這條要不要進五層比對」，**不能拿來預判比對結果**：
> - 標 `待實作`，實際上五層可能早就齊全了。實測節點 `PlatformManagementAdmin.SuperList` 的兩條規格都標此狀態，但 rajah dev commit `bf77bd3b`（**2026-07-23**）就已加好 enum、`index.ts:806-818` 也早已註冊、handler 也在——**Notion 狀態落後實作一個多月**，真缺口只有一個欄位沒被呼叫端餵值。若照著標記假設「要從零做起」，會重造一份已存在的 handler。
> - 標 `實作一致`，實際上也可能有落差（企劃是看畫面判斷，看不到 meta 缺失、targetId 傳錯這類問題）。
>
> **一律以開檔查證的五層現況為準**，把核對狀態當成「這條值不值得看」的入口過濾，不當成結論。T3 報告呈現的是你查到的現況，不是 Notion 上的狀態。

## 背景知識：操作日誌五層鏈路

一筆操作日誌從寫入到後台顯示，會經過五層（比對與修改都以此為框架）：

| 層 | 位置 | 內容 |
|----|------|------|
| 1. rajah enum | `rajah/services/service_common.rajah`（2026-08-26 實測：`SystemIdEnum` line 3、`AdminActionIdEnum` line 64、`PlatformActionIdEnum` line 184，行號以實際檔案為準） | 系統項目＝`SystemIdEnum`；項目類型依 gate＝`AdminActionIdEnum` 或 `PlatformActionIdEnum`。編號依業務域分段，且必須滿足 `Math.floor(actionId/100) === systemId`（見 Step 5 的不變式說明） |
| 2. 呼叫端 | 各 back_office 的 service / manager | `audit(context, systemId, actionId, data, targetId?)`；`data` 用 `AuditData.createNew（新增類）/ createUpdate（編輯類）/ createDelete（刪除類）` 包 before/after 物件；**平台日誌的「會員帳號」欄資料來源就是第 5 參數 targetId（被操作會員的 userId）** |
| 3. handler | `agrabah/src/servers/audit_back_office/services/handlers/implementations/` | `buildResult(data)` 回傳 `JSON.stringify([{ key, value }, …])`；一筆 key/value ＝ 後台「操作前/後」欄的一行。key 可帶 meta（以 `;` 分隔），**共有五種、不是只有 `enum:`**，見下表 |

#### key 的 meta 格式（**五種，全部都要認得**）

前端實作全在 `abu/common/components/AuditLogList.vue`（行號以實際檔案為準）：

| meta | 用途 | 前端位置 | 值的型別 |
|---|---|---|---|
| `title:<i18n-key>` | 指定 label 的 i18n key（不指定就用 fieldKey） | `:186` 等處經 `translateModelLabel` | — |
| `enum:<EnumName>` | **數值** → enum 成員文字 | `enumFormatter` | enum 數值 |
| `select:<CustomSelectName>` | **純量 id** → 名稱（**不支援陣列**，見下方邊界規則） | `selectFormatter` | 純量 id |
| **`valuePrefix:<i18n 前綴>`** | **把值本身丟去 i18n**：查 `<前綴><值>`，翻不到就顯示原值 | `defaultFormatter` `:346-349` | **字串常數** |
| **`prefix:<命名空間>`** | label 改查 `<命名空間>.<key>` 而非預設的 `model.<key>` | `translateModelLabel` `:141-143` | — |

> **上表不是完整清單，只是最常用的五種。** `AuditLogList.vue` 的 `formatters` 陣列（約 `:355`）實際掛了 8 個 formatter，可用 meta 另含 `permission`／`route`／`datetime`／`date`／`notifCond`／`override` 等。**寫或驗 handler 前，先開該檔看一次現行的 `formatters` 陣列**——這份清單會長，不要以為只有本表列出的幾種。判斷某個 meta 對不對，看它在鏈上命中哪個 formatter，而不是比對本表。

**`enum:` 與 `valuePrefix:` 的選擇取決於呼叫端存進 `data` 的值型別，不是取決於「這欄位語意上是不是 enum」**：

- 存 **enum 數值**（如 `StatusEnum.disabled = 2`）→ 用 `enum:<EnumName>`
- 存 **字串常數**（如 `'yes'`／`'no'`／`'vendor'`／`'manual'`／`'enabled'`）→ 用 `valuePrefix:`，**用 `enum:` 反而會壞**

實例（皆 2026-08-27 開檔查證，且 DB 值形狀已核對）：

- `payment_withdraw_auto_review_risk_setting_handler.ts:29,32,38` → `title:…;valuePrefix:common.`，呼叫端存 `'yes'`／`'no'`，畫面顯示「是／否」（DB id=507 實測 `{"notfirstEnable":"yes",…}`）
- `payment_withdraw_order_handler.ts:84,99` → `valuePrefix:model.withdraw-mode-`，值存 `'vendor'`／`'manual'`
- `totp_mode_change_handler.ts:20` → `valuePrefix:enum.`，值存 `'enabled'`／`'disabled'`（**注意：前綴恰好是 `enum.` 但用的是 `valuePrefix:` 機制，不是 `enum:` meta**，最容易誤判的一個）
- `block_image_handler.ts:19` → `title:type;prefix:common;valuePrefix:common.image-`（同時用兩種 meta）
- `account_change_password_handler.ts:21`、`agent_general_commission_rule_edit_handler.ts:34` 亦為 `valuePrefix:`
| 4. 註冊 | 同目錄 `index.ts` 的 `AUDIT_HANDLERS` 陣列 | `{ handler: XxxHandler, actionIds: { [GateId.admin]: <id 或 id 陣列>, [GateId.platform]: … } }`；同意/駁回等多 actionId 可共用一個 handler |
| 5. i18n（前端顯示） | `abu/{admin,platform}/localizations/{zh-TW,zh-CN,en-US}.json` | 前端共用元件 `AuditLogList.vue` 以 `model.<key>` 翻 label、`enum.<kebab-case-enum>-<enum 成員名>` 翻 enum 值（如 `enum.agent-application-status-enum-approved`；handler 存的是**數值**，數值→成員名由前端 `ReflectionHelper` 映射，驗證時一律查**成員名**的 key，不是數值）。系統節點查 `abu/admin`、平台節點查 `abu/platform` |

### 特殊 value 形狀：貨幣物件與多語系物件

> 本節描述的是 **2026-08-26 實際 codebase 的現況**（abu 與 agrabah 皆在 `main` 分支查證）。這三種形狀的顯示問題已由前端通用解析解決，比對時**不必也不應該再自己設計格式化方案**；本節的用途是讓你判斷「handler 現在這樣寫對不對」，不是叫你去改前端。**引用行號前務必重新開檔確認**——本節行號在多次改版中漂移過。

規格列的操作前/後值不一定是純量，以下三種既有 rajah model 形狀在比對時要特別辨識（`rajah/services/common.rajah`，行號以 `main` 為準）：

| 形狀 | rajah model | 範例 JSON | 畫面顯示 |
|------|-------------|-----------|---------|
| 單一幣別金額 | `CurrencyLink`（`common.rajah:1060` `{code string 1, value i64 2}`） | `{"code":"CNY","value":"11"}` | `<欄位標籤>:` 換行後 `{貨幣:CNY, 金額:11}`，多幣別逐行 |
| 多筆幣別金額（如快捷提現金額） | `CurrencyAmountLink`（`common.rajah:1065` `{code string 1, value [i64] 2}`） | `{"code":"CNY","value":["30","40","50"]}` | 同上，一個 code 內多筆金額以 `,` 串在同一行 |
| 多語系文字 | `LocalizationString` 陣列（`common.rajah:1036` `{code string 1, value string 2}`） | `[{"code":"zh-CN","value":"新增"},{"code":"en-US","value":"Add"}]` | `<欄位標籤>:{語系:zh-CN, 名稱:新增,語系:en-US, 名稱:Add}`（單行） |

#### 前端已通用處理：`codeValueLinkFormatter`（「狀況 H」）

實作在 `abu/common/components/AuditLogList.vue`：`codeValueLinkFormatter`（約 `:320`）註冊在 formatter 鏈中（約 `:366`），排在 `defaultFormatter` 之前。三種 model 的 JSON 結構相同，它的判別與輸出邏輯是：

- **形狀門檻**：`isCodeValueObject`（約 `:309`）要求非陣列物件、`code` 為 string、含 `value`，且**恰好只有 2 個 key**。全部元素都通過才攔截，否則回傳 `null` 交給下一個 formatter
- **語系 vs 幣別的判別是「查平台清單正面表列」，不是看字串格式**：`ctx.isSupportedLanguage(code)` / `ctx.isSupportedCurrency(code)`（來源約 `:394-395`、`:428-429`：`api.localization.supportedLanguages.includes(code)`、`api.currency.findSupportedCurrencyByCode(code)`）。採「**任一元素命中即歸類**」，因為歷史日誌可能含已下架幣別或當下不在清單的語系；兩邊都命中或都沒命中（`languageHit === currencyHit`）→ 不攔截

> **⚠️ 這個判別依賴平台的即時設定，不是資料本身的性質——同一筆日誌在不同平台會顯示成不同樣子。** `api.localization.supportedLanguages` 來自 `core.platform_supported_languages`。日誌裡的語系碼若不在該平台**當下**的支援清單（已下架，或該平台從來沒開過），`languageHit` 與 `currencyHit` 同時為 false → 不攔截 → 落到 `defaultFormatter` 顯示**裸 JSON**。
>
> 2026-08-27 實測：本機 `core.platform_supported_languages` 只有 `en-US` 一列，因此本機任何 `zh-CN` 的 `LocalizationString` 都會渲染成裸 JSON。這正是規格列 `示意` 欄同一個節點內出現兩種形式的原因——`PaymentWithdraw.Order` 的 `提現方式:{"code":"zh-CN","value":"真USDT"}`、`PaymentDeposit.Method` 的 `充值方式:{"code":"zh-CN","value":"真USDT"}` 都是這個成因，**不是 handler 寫錯**。
>
> **比對時看到 `示意` 出現裸 JSON，先查平台語系清單，不要當成 handler 缺轉換而去加轉字串邏輯**——加了會在語系正常的平台上把好好的解析破壞掉。下表「畫面顯示」欄寫的是**語系在清單內**時的樣子。

另外，`isCodeValueObject` 雖然要求「非陣列物件」，但**單一物件也會被處理**：`AuditLogList.vue:321` 是 `const items = Array.isArray(entry.value) ? entry.value : [ entry.value ]`，單一 `{code,value}` 會被包成 1 元素陣列走同一個 formatter（實例：`PaymentWithdraw.Order` 的 `payoutAmount` 是單一物件，`示意` 顯示 `{貨幣:CNY, 金額:109.838}`）。不要以為只有陣列才會被攔截。
- **標籤走 `translateModelLabel(ctx.ui, …)`** 解析 `model.language-code`／`model.name`（語系）或 `model.currency-code`／`model.amount`（幣別）。這 4 個 key 在 `abu/{admin,platform}/localizations/{zh-TW,zh-CN,en-US}.json` **6 個檔全部存在**（2026-08-26 逐檔查證），zh-TW 分別是「語系／名稱／貨幣／金額」——**注意 `model.currency-code` 的中文是「貨幣」不是「幣別」**，寫規格比對時別用錯詞
- `formatLinkValue`（約 `:315`）處理陣列型 value：`join(',')`，空陣列顯示 `-`


#### 金額的責任層：**兩種寫法並存，比對時先看呼叫端**

| 路徑 | 寫入端 | handler 端 |
|------|-------|-----------|
| **舊路徑**（預轉顯示值） | 存入 audit 前就轉成顯示值：`agrabah/src/servers/payment_back_office/services/payment_audit_amount.ts` 的 `auditCurrencyLinks`／`auditCurrencyAmountLinks`／`auditFeeRatePercent`（仍被 `deposit_platform.ts`、`withdraw_platform.ts` import） | 不可再換算，值已是顯示值 |
| **新路徑**（stored + 旗標） | 存 stored 原值，並在 `data` 內帶 `rawValues: true`（如 `vip_level_platform.ts:126-138`、`user_vip_level_manager.ts:1765-1770`） | **依旗標換算**：`vip_user_level_update_handler.ts:24` `data.rawValues === true ? RateHelper.storedToNormal(value) : value`；存量舊日誌沒有旗標，原樣輸出 |

**所以「絕對不能再除以 decimalPlaces」這句話只對舊路徑成立。** 比對 layer 2/3 時先看呼叫端寫進 `data` 的是不是 stored 值、有沒有 `rawValues` 旗標，再判斷 handler 該不該換算——兩邊要成對，缺一邊就是 bug。

#### 費率（`@Type "Rate:N"`）：換算對不對，看的是 **N**，不是「有沒有換算」

費率欄位不是 `CurrencyLink`，是**純量 i32**，走 rajah 的 `@Type "Rate:N"`。前端（`PropertyFieldEdit.vue`／`PropertyRateEdit.vue`）一律以 **N** 當 rateBase：顯示值 = stored / N，回寫 stored = 顯示值 × N。

**N 在本專案有三種**（2026-08-27 全庫實測 `grep -rn '@Type "Rate:' rajah/services/*.rajah`）：`Rate:10000` 20 處、`Rate:100` 13 處、`Rate:100000` 2 處。

而 `RateHelper.storedToNormal(v, rateBase = 10000)`（`jafar/src/rate_helper.ts:18-22`）**預設 10000**。呼叫端只寫 `RateHelper.storedToNormal(x)`、而該欄位不是 `Rate:10000` 時，日誌數值會差 N/10000 倍——**兩邊「都有換算」所以成對，五層比對會判 ✅，但值是錯的，畫面上只是一個看起來很正常的數字。**

**比對 rate 欄位時，除了確認「呼叫端換算 / handler 直出」成對，必須再開 rajah 抄下該欄位的 `@Type "Rate:N"`，逐字核對呼叫端傳的 rateBase 等於 N**；沒傳第 2 參數 ＝ 用了 10000，N ≠ 10000 就判 ❌。

> **實測案例（2026-08-27，這是現存的真實 bug 不是假想）**：`game_vendor_fee_admin.ts:143` 寫 `RateHelper.storedToNormal(rate.rate)`（未傳 base），而該欄位在 `rajah/services/game_back_office.rajah:2492` 宣告是 `Rate:100000`。業務表 stored `370000` → `audit_logs.data.after.rate` 落 `37` → 操作日誌畫面 DOM 原文 `费率:37`，但使用者實際設定的是 **3.7%**。日誌記到的費率是真實值的 **10 倍**。相關規格：`PlatformManagementAdmin.PlatformList` 的損益費率／JP中獎費率／JP貢獻費率三條，Notion 標 `實作一致`（企劃看畫面看不出數值錯）。

**多語系陣列在 `audit_logs.data` 裡存的是未攤平的原始陣列**，沒有寫入端預轉這回事（`audit_log.ts:12` 只做 `JSON.stringify(data)`，無多語系特殊處理）。最直接的對照在 `deposit_platform.ts`：**同一個 `auditAfter` 物件內**，`:610` 的 `showName`（`LocalizationString[]`）原樣賦值，`:622` 的 `realRates` 卻走 `auditRateLinksByDecimalPlaces(...)` 預轉——同一支 method 裡兩種欄位兩種待遇，比對時不要把金額的規則套到多語欄位上。

#### handler 端：原則直出，但有兩類例外

原則上 handler 照 rajah model 原樣輸出 `CurrencyLink[]`／`CurrencyAmountLink[]`／`LocalizationString[]` 即可，前端會處理。以下節點確實是直出（2026-08-26 查證，皆在 `agrabah/src/servers/audit_back_office/services/handlers/implementations/`）：`payment_deposit_method_upsert_handler.ts`／`payment_deposit_channel_upsert_handler.ts`／`agent_deposit_channel_online_handler.ts`／`agent_deposit_method_status_handler.ts`／`agent_withdraw_method_status_handler.ts`／`agent_withdraw_channel_create_handler.ts`（`showName`）、`game_record_center_minimum_amount_handler.ts`（`minimumAmount`）、`app_upsert_handler.ts`／`app_download_link_upsert_handler.ts`／`app_version_upsert_handler.ts`（多語系欄位）。

但**不要假設「所有 handler 都應該直出」**，現況有兩類反例，看到它們不要判成不符：

1. **金額需要 stored→display 換算的**：走共用的 `formatCurrencyToDisplayLinks`（`helpers/formatters.ts:42`，該檔現存 export 只有 `formatTimestamp`／`formatDate`／`formatTimestampMinute`／`formatCurrencyToDisplayLinks`）。實例：`agent_deposit_method_create_update_handler.ts`、`agent_withdraw_method_update_handler.ts` 的幣別金額欄位
2. **自行轉成字串的**：`payment_withdraw_method_upsert_handler.ts:16`／`payment_deposit_method_upsert_handler.ts:13`／`payment_rate_update_handler.ts:31` 各自有**本地版** `formatCurrencyLinks()`（把 links 串成 `code: value` 字串）並實際在用

**⚠️ 現況中的一處實質不一致，遇到時要問人不要自己裁定**：`fund_adjustment_preset_handler.ts:35-48` 把 `amounts` 在 handler 端轉成 `{ code, value: "30/40/50" }` 字串（用 `/` 分隔），註解明寫「**不可直出陣列 —— 讀取端對陣列型 value 解析失敗會顯示成 `[object Object]`**」。但前端 `formatLinkValue` 明明會處理陣列型 value（`join(',')`）。該註解出自 2026-08-17 的 commit，**比前端支援落地（2026-08-11）還晚 6 天**，不是過時殘留。兩者衝突且分隔符不同（`/` vs `,`），比對到這類欄位時記錄現況並問開發者，不要單方面改成任一邊。

**已知的形狀誤判風險（已知且接受）**：`isCodeValueObject` 只認**形狀**，認不出欄位語意。`CurrencyLink` 有時承載的不是金額，而是「幣別的有效/顯示位數」等純數字設定（`rajah/services/payment_back_office.rajah:483-486` 的 `realRatesDecimalPlaces`／`realRatesDisplayDigits`，同檔另有 4 組相同宣告）——這類欄位若走到前端解析會顯示成「貨幣:CNY, 金額:2」，「金額」語意不精確（實際是位數）。目前這批欄位在 handler 端已被本地 `formatCurrencyLinks` 轉成字串，不會走到前端解析，**風險尚未實際發生**，先記錄不處理。

**已知規則覆蓋不到、需人工判斷的邊界**（不要為這些發明新邏輯，先記錄、問開發者）：
- 同一個 handler／同一個 key 被多種業務共用，但實際 value 形狀不同（如廣告名稱在輪播廣告是 `string`、在浮窗廣告是 `LocalizationString[]`，共用同一個 `advertisement_upsert_handler.ts`）——`string` 不會通過 `isCodeValueObject`，兩種形狀可以共存不衝突。
- 非 `{code,value}` 形狀的 per-語系物件——真實案例是 `AdLocalizationThumbnails`（`rajah/services/advertisement.rajah:29-33`，`{code string 1, forPC string 2, forMobile string 3}`），由 `advertisement_upsert_handler.ts:55` 直出進 audit。`isCodeValueObject` 要求恰好 2 個 key，這種三鍵物件不會被誤判，但也不會被處理，會落回 `defaultFormatter` → `formatPrimitiveValue` 顯示成**裸 JSON 字串**（不是 `[object Object]`），需另外設計格式化邏輯。
- **`select:` meta 只支援純量 id，不支援 id 陣列**（2026-08-26 實跑證偽）：`ReflectionHelper.getCustomSelectLabel`（`abu/common/helpers/reflection.ts:396-400`）是 `customSelect.lookUp.get(value)` 純量 Map 查詢，傳陣列必定 miss。實跑結果：`getCustomSelectLabel("AppUserTag", 1)` → `"E2E標籤甲"`；`getCustomSelectLabel("AppUserTag", [1,2])` → `undefined`；**連單元素陣列 `[1]` 也是 `undefined`**。`selectFormatter`（`AuditLogList.vue:183-189`）拿到 undefined 後退回 `formatPrimitiveValue`，畫面顯示裸 id（實測畫面：`會員標籤集合:1, 2`，應為「E2E標籤甲, E2E標籤乙」）。旁證：全 `implementations/` 唯一在用 `select:` 的 `app_domain_handler.ts:22` 帶的是純量 `appId`，陣列情境從未在 production 跑過。
  - 純量 id 要顯示名稱（如 `appId`）→ 用 `title:<key>;select:<CustomSelectName>` ✅
  - **id 陣列要顯示名稱 → 前端沒有可用機制，但寫入端有既有慣例**。**不要自行套 `select:`**（套了不會報錯，只會靜默顯示裸 id）。兩個方向：(1) 修 `getCustomSelectLabel` 讓它對陣列逐元素查表後 join——**未實作，需開發者裁決**；(2) **寫入端／handler 直接存名稱陣列而非 id——這已經是 production 在跑的既有慣例，不是待裁決選項**：`payment_withdraw_auto_review_risk_setting_handler.ts:8` 註解逐字寫「標籤/層級/出款標籤由寫入端轉成名稱陣列(非 id)」，`:44-46` 三個 key 皆無 meta 直出；2026-08-27 在同一個操作日誌畫面上實測到效果，DOM 原文 `會員標籤:E2E标签甲, E2E标签乙`（對照另一列存 id 的是 `會員標籤:2, 1`）。
  - 所以碰到這種欄位，**要問企劃的是「這欄要顯示 id 還是名稱」**，而不是回報「沒有辦法」。要名稱就走 (2)；規格字面要 id（如欄名寫 `memberTagId`）就直出 id
  - 規格只要求顯示 id（多數情況）→ 純量與陣列都不需要 meta，直出即可

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
| `<notion-url>` | 進 Step 2（fetch）。連結可以是**明細表的一列**（模式 A：只處理該條規格）或**主表的一個節點**（模式 B：處理該節點底下全部規格），由 Step 2 自動判定，使用者不必指定 |
| `todo <負責技術人名>` | 進 **Step 1b**（todo 模式：查該人負責的節點清單，選一個後進 Step 2 模式 B） |
| 無參數 | 有 AskUserQuestion 工具 → 呼叫它詢問處理模式（見下方「無參數時的模式選擇」）；無此工具 → 輸出 **T1**（用法說明文字）等使用者回覆 |

#### 無參數時的模式選擇（AskUserQuestion）

環境具備 AskUserQuestion 工具時，無參數呼叫**必須**用它主動詢問，不得只丟 T1 文字乾等：

- question：「這次要用哪種方式指定要處理的節點？」
- header：「處理模式」
- options（單選）：
  1. label：「貼 Notion 連結」，description：「提供明細表的某一列（只處理該條規格）或主表的某個節點（處理整個節點）的連結」
  2. label：「查詢我負責的節點清單」，description：「輸入 Notion 顯示名，列出你在主表中負責的所有節點供選擇（todo 模式）」

依回覆分流：

- 選「貼 Notion 連結」→ 回覆一句「請貼上要處理的 Notion 連結（明細表的一列，或主表的一個節點）」，等待使用者下一則訊息帶連結，取得後視同 `<notion-url>` 呼叫形式，進 Step 2
- 選「查詢我負責的節點清單」→ 回覆一句「請輸入你的 Notion 顯示名」，等待使用者下一則訊息帶人名，取得後視同 `todo <負責技術人名>` 呼叫形式，進 **Step 1b**
- 使用者選 Other 自行輸入其他文字 → 依文字內容判斷像連結還是人名，分別比照上述兩支分流；無法判斷 → 重新輸出 T1 文字說明

環境不具備 AskUserQuestion 工具（如純文字/Codex 單線程環境）時，無參數呼叫維持輸出 **T1**，不得假裝呼叫此工具。

### Step 1b：Todo 模式（僅 `todo <負責技術人名>` 呼叫形式進入）

Notion 官方 MCP 的資料庫查詢工具受 workspace 方案限制（需 Business plan），無法用於列清單；本模式改用 Step 0 已驗證的**唯讀 Notion Integration Token**直呼 Notion 官方 REST API（`api.notion.com`），不經 MCP，不受此限制。

**「還沒做」的判定依據是明細列的 `核對狀態`，不是主表的 `日誌-完成` checkbox**。`日誌-完成` 只用於免寫節點判定（Step 2.6），不作為 todo 的完成門檻。

**待處理狀態＝這四個，兩表完全相同**：

`待實作`／`待修正`／`有差異`／`待核對`

不屬於待處理的：`實作一致`（已完成）、`已廢除`／`文件未記`（規格未定案或作廢，見「常數」節）、空值（狀態未填，另段呈現）。

**用子字串比對**（例如比 `待實` 前綴）：寫死完整字串的 filter 會在企劃改名時整段 400。

todo 清單的單位仍是**菜單節點**（選定後走 Step 2 模式 B），但要**查明細表**才拿得到核對狀態，再依 `菜單節點` 聚合回節點。

1. **姓名 → user id 解析**：分頁呼叫 `GET /v1/users?page_size=100`（`has_more=true` 時帶 `start_cursor` 續讀直到讀完），只保留 `type=="person"` 的項目，比對 `name` 欄位是否包含輸入的人名（不分大小寫、子字串比對，因為 Notion 顯示名常有 `KHH` 等前綴）
   - 0 命中 → 用 **T1b「情況一」**回報查無此人並停止
   - ≥2 命中 → 用 **T1b「情況二」**列出候選顯示名，請使用者回覆更精確的名字或選編號，重跑本步驟
   - 1 命中 → 取得 user id，繼續
2. **查平台明細表**（`負責技術` rollup ＋ 核對狀態複合 filter，2026-08-26 實測可用）：

   ```bash
   set -a; source <skill-dir>/.env; set +a
   curl -s -X POST "https://api.notion.com/v1/databases/04f789e2-8a7f-4a1c-b079-331004cb7e96/query" \
     -H "Authorization: Bearer ${ALD_RO}" \
     -H "Notion-Version: 2022-06-28" \
     -H "Content-Type: application/json" \
     -d '{"filter":{"and":[
           {"property":"負責技術","rollup":{"any":{"people":{"contains":"<user-id>"}}}},
           {"or":[{"property":"核對狀態","select":{"equals":"待實作"}},
                  {"property":"核對狀態","select":{"equals":"待修正"}},
                  {"property":"核對狀態","select":{"equals":"有差異"}},
                  {"property":"核對狀態","select":{"equals":"待核對"}}]}
         ]},"page_size":100}'
   ```

   `has_more=true` 時帶 `next_cursor` 當 `start_cursor` 續讀。
3. **查系統明細表**（**等系統主表開始指派 `日誌-負責技術` 後，本步驟即可與上一步合併成同一個查詢**——兩表的欄位與選項一致，唯一分開的理由是系統側目前無人可篩）：系統側 `負責技術` 欄**存在且可下 filter**（2026-08-27 實測 HTTP 200、回 0 列，不會報錯），但系統主表的 `日誌-負責技術` 全表 40 列皆為空，**按人篩必定回 0 列**，因此本步驟直接省略人名條件、只下核對狀態 filter，取回的是**全系統待處理清單、不分人**。

   > ⚠️ **「欄位存在但值全空」與「選項不存在」是兩種完全不同的失敗**：前者回 **200 + 0 列**（`負責技術` 目前就是這樣），後者**直接 400**（例如對已移除的 `待刪除` 下 filter）。看到 0 列不要以為是查錯。在 T1b 明確標示這一段不是依人名篩出來的，不要讓使用者誤以為那是他負責的。

   **核對狀態 filter 與平台完全相同**，差別只在**不加 `負責技術` 條件**：

   ```bash
   set -a; source <skill-dir>/.env; set +a
   curl -s -X POST "https://api.notion.com/v1/databases/ea605ea6-f18b-449a-b24a-7aa8ec26e7c8/query" \
     -H "Authorization: Bearer ${ALD_RO}" \
     -H "Notion-Version: 2022-06-28" \
     -H "Content-Type: application/json" \
     -d '{"filter":{"or":[
           {"property":"核對狀態","select":{"equals":"待實作"}},
           {"property":"核對狀態","select":{"equals":"待修正"}},
           {"property":"核對狀態","select":{"equals":"有差異"}},
           {"property":"核對狀態","select":{"equals":"待核對"}}]},"page_size":100}'
   ```

   **系統側 `有差異`／`待修正` 目前 0 使用**、`待核對` 佔 62/80，所以系統段回來的量偏大且混雜（尚未分類的不符項都在裡面），不是查錯。

   > **⚠️ select 值寫錯會直接 400、不是回 0 列**（例：對已移除的 `待刪除` 下 filter → `select option "待刪除" not found for property "核對狀態"`）。**企劃改動選項名時這裡會整段炸掉**，所以下 filter 前先確認現行選項：對該表下一個單值 filter 試探，或看 400 錯誤訊息列出的 `Available options`。
4. **聚合回節點**：把取回的明細列依 `菜單節點` relation 分組（relation 為空的列另立「未掛節點」組），對每組取一次主表節點頁補齊 `菜單路徑`／`版本`／`日誌-備註`／節點 `url`（平台明細表沒有 `菜單路徑` rollup，必須讀主表）。某份中途持續失敗 → 該份結果視為「已讀範圍」不完整，於 T1b 註記
5. 輸出 **T1b「情況三」**：依核對狀態分段呈現，每個節點列出「待處理列數」與各狀態的細分（如 `待實作 3 / 待修正 6`）
6. 使用者回覆編號 → 取出對應節點的 `url`，視同使用者直接貼上該連結，**進入 Step 2（模式 B）**，之後與 url 模式完全相同流程

進入模式 B 後會處理該節點底下**全部**規格列（含已是 `實作一致` 的），這是刻意的：同節點的規格要一起看才判斷得準，已完成的列走複檢、五層相符就標 ✅ 不動。

**查無待處理不等於查無此人**：某人名下全部明細列都是 `實作一致` 時（實測 `Gghotss Hsieh KHH` 等人接近這狀況），第 2 步會回 0 列。此時 T1b 走情況三、寫「目前沒有待處理項目」，**不要**改判成情況一「查無此人」——只有第 1 步的人名解析 0 命中才是情況一。

Step 1b 全程主線程執行（純資料查詢與過濾，不涉及五層比對），不派 explorer/executor/reviewer。

### Step 2：fetch 規格 → 規格中間格式

1. **URL → page_id**：依序嘗試——網址帶 `p=` query 參數（貼開子頁時複製的連結會有這個參數，代表實際開啟的頁面）→ 取該參數的 32 碼 hex；否則取**路徑最後一段結尾的 32 碼 hex**（路徑常帶 slug 前綴，如 `/p/DataSum-DepositWarning-3c787d78618a81668397db3d3a30fe79`，只取尾端 32 碼；明細列的連結則多半沒有 slug，如 `/p/3c187d78618a80659acfc995c20f2e6d`）。取到後轉成標準 UUID 格式（`8-4-4-4-12` 加 dash）。網址的 `v=` 參數是 Notion 的 **view id**，與頁面無關，一律忽略
2. **讀頁面**：`GET https://api.notion.com/v1/pages/{page_id}`（headers 同 Step 0：`Authorization: Bearer ${ALD_RO}`、`Notion-Version: 2022-06-28`）
   - 非 200（404／其他錯誤）→ 用 T2 的停止形式回報「讀取頁面失敗：<訊息>」並停止
   - 回傳 `validation_error` 且訊息為「is a database, not a page」→ 代表使用者貼的是**整張 database 的連結**（「常數」節那四個 URL 就是這種）。用 T2 的停止形式回報「這是整張表的連結，請改貼**單一明細列**或**單一主表節點**的連結」並停止，**不要**自行 query 整張表全跑一遍
3. **判定模式與 gate**：比對回傳的 `parent.database_id` 與「常數」節的四個 database ID：

   | `parent.database_id` | 模式 | gate |
   |---------------------|------|------|
   | 系統明細表 `ea605ea6-…` | A（單列） | `admin` |
   | 平台明細表 `04f789e2-…` | A（單列） | `platform` |
   | 系統主表 `4f2c314a-…` | B（整節點） | `admin` |
   | 平台主表 `b14a1ec5-…` | B（整節點） | `platform` |

   **不屬於這四張**（貼錯連結、子頁、其他 database）→ 用 T2 的停止形式回報「無法判定來源表（parent.database_id=<實際值>）」並**停止，不預設 gate**
4. **取得明細列集合與節點資訊**：

   - **模式 A**：本頁即唯一一筆明細列。節點資訊由本列的 `菜單節點` relation 取得：relation 非空 → `GET /v1/pages/{relation[0].id}` 讀主表節點頁；**relation 為空**（平台 2026-08-28 實測 51/637 列如此）→ 節點資訊全部記為 null、`menuPath` 記 `"（本列未掛菜單節點）"`，並記入 warnings（Step 4 的菜單定位鏈將無法使用，需靠 `項目類型`＋`系統項目`＋`示意` 定位，定位不到就依 Step 4 規則標 ❓）
   - **模式 B**：本頁即主表節點。取該節點底下全部明細列——**用明細表反查，不要讀 relation 屬性**：

     ```bash
     set -a; source <skill-dir>/.env; set +a
     curl -s -X POST "https://api.notion.com/v1/databases/<對應的明細表 database-id>/query" \
       -H "Authorization: Bearer ${ALD_RO}" \
       -H "Notion-Version: 2022-06-28" \
       -H "Content-Type: application/json" \
       -d '{"filter":{"property":"菜單節點","relation":{"contains":"<主表節點 page_id>"}},"page_size":100}'
     ```

     `has_more=true` 時帶 `next_cursor` 當 `start_cursor` 續讀。**必須走這個反查，不能直接用主表頁 `properties.操作日誌明細.relation` 陣列**：該陣列在 `GET /pages` 回傳時會被截斷在 25 筆並標 `has_more:true`（2026-08-26 實測節點 `AppUser.User` 實際 31 筆、屬性只回 22 筆），照它跑會**靜默漏掉規格列**。（若確有需要走 relation，必須改用 `GET /v1/pages/{page_id}/properties/{property_id}?page_size=100` 分頁讀完，`property_id` 要 URL-encode。）
5. **解析主表節點屬性**（`properties.<欄位>`；模式 A 未掛節點時整步跳過）：`菜單路徑`＝`formula.string`（已是 `一級 › 二級 › 三級`；為空才自行串接 `一級菜單.select.name`＋`二級菜單`／`三級菜單` 的 `rich_text[].plain_text`）；`版本`＝`select.name`；`日誌-負責技術`＝`people[].name` 陣列；`日誌-完成`／`不支援批量/單個分開`／`上CQA`＝`checkbox`；`日誌-備註`／`route`／`元件路徑`＝`rich_text[].plain_text` 串接；title 屬性（系統為 `節點key`、平台為 `節點key (權限在裡面)`，判斷時**只認 `type=="title"`**，不比對欄名字串）＝`title[].plain_text` 串接，即節點 key（如 `AppUser.User`）。**平台主表另有 `商戶權限`（select）與 `商戶開通`（2026-08-28 新增），系統主表兩者皆無**——取值時要容許缺欄，不可假設兩表 schema 相同；兩者目前都不參與任何判定（語意未與企劃確認，見「主表欄位」表）。`上CQA` 兩表全表 0 勾選，讀了也不要拿來判定
6. **免寫早退檢查（僅模式 B）**：第 4 步取回的明細列集合為空時，看上一步讀到的 `日誌-完成`：
   - `日誌-完成`＝**勾選** → 企劃已確認本節點不需要任何操作日誌（`日誌-備註` 常寫「純查詢頁面，無需記錄」）→ 輸出 **T2b** 並**停止**，不進入 Step 3 之後任何流程（不比對、不改 code）
   - `日誌-完成`＝**未勾選** → 企劃尚未填規格（`日誌-備註` 常寫「待規劃」或空白）→ 走 Step 3 判定為「本節點尚無任何規格列」，輸出 T2 停止形式請企劃補

   **這兩條分支的實際量級（2026-08-27 全量實測）**，用來判斷「選到空節點」是否正常：

   | | 無明細列的節點 | 其中 `日誌-完成`✓ → 走 T2b 早退 | 其中 `日誌-完成`✗ → 走 T2 停止 |
   |---|---|---|---|
   | 系統（40 節點） | 14 | 3 | **11** |
   | 平台（240 節點） | 95 | 59 | **36** |

   也就是說**系統 11 個、平台 36 個節點貼進來會直接空跑到 T2 停止**，這是規格還沒寫、不是流程壞掉。todo 模式因為是從明細列反聚合，不會選到這些節點；只有使用者直接貼主表連結時才會遇到。
7. **解析每一筆明細列屬性**（`properties.<欄位>`，一律**按欄名取值、不按位置**）：`項目類型`＝`title[].plain_text` 串接；`系統項目`／`動作類別`／`核對狀態`＝`select.name`（可能為 `null`）；`會員帳號`／`操作前-中文`／`操作前-英文`／`操作後-中文`／`操作後-英文`／`備註`／`示意`＝`rich_text[].plain_text` 串接。模式 A 若需要菜單資訊，`一級菜單`／`二級菜單`／`三級菜單` 這幾個 rollup 也可直接取（`rollup.array[0]` 再依其 `type` 取值），與第 5 步從主表頁讀到的值等價。**注意兩份明細表的 rollup 欄位不對稱**：`菜單路徑` 只有系統明細表有、平台明細表沒有；`負責技術` 只有平台明細表有、系統明細表沒有（見「明細表欄位」表的標註）。要取平台側的菜單路徑，走 `菜單節點` relation 讀主表的 `菜單路徑` formula。**⚠️ `rollup.array[0]` 這個取法不是對所有 rollup 都成立**：系統明細的 `節點排序` 是 `sum` 型、回傳 `rollup.number` 而沒有 `array` 鍵，照抄會拿到 undefined（見「rollup function 不對稱」小節）。取任一 rollup 前先看 `rollup.type` 是 `array` 還是 `number`
8. **`核對狀態` 早退／停止判定**（依「常數」節的 `核對狀態` 表，**一律用子字串比對**，防禦選項改名；兩表現行值皆為 `實作一致`）：
   - 明細列集合中**全部**列都是 `已廢除` → 輸出 **T2b**（理由填「核對狀態＝已廢除」）並停止
   - 個別列是 `已廢除` → 該列從 `specRows` 剔除、記入 warnings，其餘列照常
   - 任一列是 `文件未記` → 該列標記為**待企劃定案**，不進五層比對；若剔除後 `specRows` 為空 → 輸出 T2 停止形式；否則其餘列照常跑，並在 T2 明確列出被擱置的列與原因
9. 整理成規格中間格式（內部工作資料，不直接輸出）：

```json
{
  "source": "system | platform",
  "gate": "admin | platform",
  "mode": "A | B",
  "nodeKey": "AppUser.User（模式 A 且未掛節點時為 null）",
  "menuPath": "一級 › 二級 › 三級",
  "version": "6/30",
  "owner": ["…"],
  "done": false,
  "batchSeparate": false,
  "nodeRemark": "…（主表 日誌-備註）",
  "specRows": [
    {
      "pageId": "…",
      "url": "…",
      "systemItem": "…（可能為 null）",
      "actionType": "…（項目類型，title）",
      "actionCategory": "…（動作類別，可能為 null）",
      "memberAccount": "…（平台限定；系統一律視為 null）",
      "beforeZh": "…", "beforeEn": "…",
      "afterZh": "…", "afterEn": "…",
      "remark": "…（備註）",
      "sample": "…（示意）",
      "checkStatus": "…（核對狀態，可能為 null）"
    }
  ],
  "deferredRows": [],
  "warnings": []
}
```

- 操作前/後欄位內文以**換行**分隔多個顯示欄位：一行＝一個 key/value 欄位，中英文欄逐行對應
- 空白或 `-` ＝該側無資料（例：操作前空白 → 呼叫端應為 `AuditData.createNew`）
- **核對狀態不是執行門檻**：`實作一致` 的列一樣要跑，屬複檢（企劃的判定不取代本 skill 的開檔查證）；`日誌-完成` 只用於免寫節點判定，不作為完成門檻
- `deferredRows` 收 Step 2.8 擱置的列（`文件未記`），只在 T2 呈現，不進 Step 5

### Step 3：規格完整性檢查

明細表是 Notion database，**欄位由 schema 保證一定存在，不會「缺欄」，只會「缺值」**——因此本步驟一律檢查**值**。以下任一命中 → 輸出 **T2 的停止形式**（缺漏清單）並**停止，不進入比對**：

1. `specRows` 為空（模式 B 的節點沒有任何明細列且 `日誌-完成` 未勾選；或全部列都被 Step 2.8 擱置）
2. 任一規格列 `項目類型`（title）為空
3. 任一規格列**操作前、操作後四個欄位全空**（`-` 視為「該側無資料」、不算全空；四欄皆空＝這條規格沒有任何內容）
4. 任一規格列中/英文不成對：有中文無英文（或反之），或中英文**行數不一致**

第 4 點的判定細節：**比對前先把 `-` 正規化成「該側無資料」**（與空字串同義）。一側有多行內容、另一側只寫 `-`，就是不成對——不要因為 `-` 是非空字串而誤判成「兩側都有值」。

**同時必須剔除首尾空行與只含空白的行再數行數。** Notion rich_text 常在結尾多一個換行，不剔除會把正常規格誤判成中英行數不一致，依 Step 3 規則**整個節點停擺、一列都不比對**。2026-08-27 實測：`PaymentWithdraw.Order` 第 10 列「提現訂單財務審核出款」的 `操作前-中文` 原文是 `'會員ID\n訂單編號\n訂單狀態\n'`（尾端多一個 `\n`），直接 `split('\n')` 得 4 行、英文 3 行 → 誤判不成對 → 該節點 14 列全部不跑。下方的實測基準表沒有把這列算進去，正是因為當初有做這個前置處理，但文件漏寫了。

第 4 點的實測基準（2026-08-26 全量，用上述正規化）：

| | 中英不成對 | 中英行數不一致 |
|---|---|---|
| 系統明細（80 列） | 5 列（**全部是 `核對狀態＝文件未記`**，會先在 Step 2.8 被擱置，走不到這裡） | 0 列 |
| 平台明細（637 列） | 1 列（`關聯帳號查詢批量凍結`，狀態為 `實作一致`：操作前中文 3 行、英文為 `-`） | 12 列（短域名管理系列 ×6、批量設置佣金方案-修改、重點/普通扶持其他設定更新、周流水獎勵其他設定更新、充值滿額獎勵其他設定更新、編輯-層級2.3） |

真正會在這裡被擋下的就是平台那 1 + 12 列——都是規格本身沒寫完（英文欄漏填或多一個換行），必須請企劃補齊，不要自行猜測對應關係。

**`系統項目` 為空不是缺漏、不停止**：2026-08-28 全量實測系統 73/80、平台 98/637 為空，是常態。記入 warnings，走 Step 4 的 gated 推定（依菜單業務域推定 `SystemIdEnum` 並在 T3 標 ⚠️ 由開發者確認）。**系統側的空值成因與平台不同**：系統明細表的 select 只建了 3 個選項（`產品系統`／`遊戲系統`／`Otp 系統`），對照 admin 側 42 個 `enum.system-id-enum-*`，等於絕大多數業務域企劃無從選起——所以系統側走 gated 推定的機會較高，T3 標 ⚠️ 時寫「系統明細表選項未建齊，此值為推定」而不是「企劃漏填」。**但不是每個節點都空**（2026-08-27 實測 `PlatformManagementAdmin.PlatformList` 三條規格都填了 `遊戲系統`，且填得正確），**先看有沒有值，有值就用**。

**`會員帳號` 為空或 `-` 不是缺漏、不停止**：視為「本操作不針對特定會員」，`memberAccount` 記 null，Step 5 layer 2 不要求傳 targetId，判 ✅ 而非 ❓。系統側一律視為 null（系統明細表雖有此欄，全量 80 列無一有值；`audit_admin.ts` 讀取端也沒有會員帳號欄）。

> **系統側的 targetId 不是「沒用」，只是語意不是「被操作會員」**：`AdminAuditLogSearch.targetId`（`rajah/services/audit_back_office.rajah:76`）是系統側的搜尋欄位，`audit_admin.ts:118-121` 有 `if (search.targetId > 0)` 的過濾，而 `platform_maintenance_manager.ts:247` 這個系統節點**確實有傳** targetId、傳的是 `platformId`。所以：規格沒指定就不傳（DB 落預設 0，判 ✅）；但**看到既有系統節點有傳 targetId 時不要判成錯**，那是刻意用它存操作目標 id。只有當規格列的操作對象明顯是會員（如審核、帳變、黑名單）卻沒填這欄時，才在 T3 該列標 ⚠️ 請企劃確認。實測平台側常見填法是 `需填入`／`對象會員帳號 / userName` 這類**指示語而非實際值**——這些一律視為「有值＝需要傳 targetId」。

**`動作類別`／`核對狀態` 為空不停止**（平台實測各 13 列為空）：記入 warnings，照常比對。

小瑕疵（`備註`／`示意` 空白、模式 A 未掛菜單節點等）→ 記入 `warnings`，在 T2 顯示但不停止。通過 → 輸出 **T2 通過形式** 並繼續。

### Step 4：定位程式碼（explorer 派工點）

#### 0. 先找再建（強制，防「待實作」造成的定錨誤判）

**無論 `核對狀態` 寫什麼，一律先跑這三個 grep**。任一命中即代表「已有實作，走複檢／補差額路線」，**不得新增 enum 或新寫 handler**：

```bash
# ① 註冊表裡有沒有這個節點（註解通常直接寫中文節點名）
grep -n "<節點業務關鍵字>" agrabah/src/servers/audit_back_office/services/handlers/implementations/index.ts

# ② 呼叫端是不是已經在寫日誌了
grep -n "audit(" <該 service 檔>

# ③ enum 查 generated，不是查 rajah source（理由見 Step 5 的同源性警告）
grep -n "<enum 成員名>" agrabah/src/generated/services.gen.ts
```

命中之後，任務性質就從「新增」變成「**補差額**」——只補規格有、實作沒有的那幾個欄位。

實測案例：節點 `PlatformManagementAdmin.SuperList` 的兩條規格在 Notion 都標 `待實作`，但 ① 一跑就命中 `index.ts:806-818`（註解逐字寫著「平台超級管理員 — 新增」「平台超級管理員 — 狀態 啟用 / 停用」）、② 命中 `platform_admin.ts:132`、③ 命中 `services.gen.ts` 的 `platformUserCreate = 902`。真實缺口只是呼叫端少傳一個欄位。**若順著「待實作」的字面去找空號、寫新 handler，會重造一份已存在的實作，而且因為本機 rajah 與 generated 不同源（見 Step 5 的同源性警告），挑的號碼還會撞號。**

#### 1. 定位鏈

**優先用主表的 `節點key` 直接定位，不要繞菜單中文反查**（2026-08-26 實測：`節點key` 就是 `abu/{admin,platform}/src/menu.ts` 中 `item()` 的**第 3 個參數**，即權限節點 key，可直接 grep 命中）：

```
主表 節點key（如 AppUser.User、AdminManagement.Permission.Users）
  → grep abu/{admin|platform}/src/menu.ts → 該 item() 行即含頁面元件名
  → 主表 元件路徑（如 pages/admin_users/AdminUserList.vue，相對 abu/{admin|platform}/src/）交叉驗證
  → 頁面 .vue → api.remote.<group>.<service>.<Method>(…) 呼叫
  → agrabah 檔案位置是機械映射（見下）→ 其中的 audit() 呼叫點
```

**`api.remote` → agrabah 檔案的映射是機械的，不必用猜的**：

```
api.remote.<group>.<service>.<MethodName>(…)
  → agrabah/src/servers/<group 轉 snake_case>/services/<service 轉 snake_case>.ts
  → 該檔中的 method<MethodName>

實例：api.remote.platform.platformAdmin.CreatePlatformSuperUser
  → agrabah/src/servers/platform/services/platform_admin.ts 的 methodCreatePlatformSuperUser
```

主表兩個路徑欄位的可靠度（2026-08-28 全量實測）：

| 欄位 | 填寫率 | 用法 |
|------|-------|------|
| `節點key` | 系統 40/40、平台 239/239 | **最可靠的定位起點**，直接 grep `menu.ts` |
| `元件路徑` | 系統 40/40、平台 227/239 | 相對 `abu/{admin,platform}/src/` 的真實檔案路徑，抽查 5 支全部存在，可直接開檔 |
| `route` | 系統 40/40、平台 236/239 | **只能當人工參考、不要拿去 grep**：Notion 記的是完整路徑（`/admin-management/admin-user`），`menu.ts` 記的是相對片段（`/admin-user`），兩者對不上 |

模式 A 且該列**未掛菜單節點**（無主表可查）時，這三個欄位都不可得，退回以 `項目類型`＋`系統項目`＋`示意` 的關鍵字在 `service_common.rajah` 與 handler 目錄搜尋。

常用指令範例：

```bash
# 用節點 key 定位頁面（最優先）
grep -n "AppUser.User" abu/platform/src/menu.ts

# 用元件路徑直接開檔
sed -n '1,60p' abu/platform/src/pages/<元件路徑>

# 頁面找 API 呼叫
grep -n "api.remote" abu/platform/src/pages/<對應頁面>.vue

# 後端找 audit 呼叫
grep -rn "audit(" agrabah/src/servers/<server> --include="*.ts"

# 找既有 handler 與註冊
grep -rn "<ActionIdEnum 名>" agrabah/src/servers/audit_back_office/services/handlers/implementations/index.ts
grep -rn "<業務關鍵字>" rajah/services/service_common.rajah
```

只依賴 grep / 檔案讀取，不依賴任何個人環境腳本（有安裝 lamp `method-call-graph` skill 可加速，非必要條件）。**定位不到操作入口 → T3 該層標 ❓ 無法定位，請開發者補充 method 名稱，不猜。**

「系統項目」欄空白時（系統 73/80、平台 98/637 為空，**但不是每個節點都空，先看有沒有值**）走 gated 推定——必經 T3 標記與開發者確認，不屬鐵律 6 禁止的「靜默腦補」。

**推定順序（照這個順序，不要跳到最後一項）**：

1. 現有呼叫端的 `systemId`（最可靠）
2. 明細列的 `系統項目` 欄（若有值）
3. **呼叫端所在的 agrabah server 目錄**
4. 才輪到菜單業務域

> **⚠️ 「菜單業務域」是最後手段，因為頁面掛在哪個菜單 ≠ 被操作的資料屬於哪個業務域。** 2026-08-27 實測：節點 `PlatformManagementAdmin.PlatformList`（菜單＝**平台管理**）底下的三條費率規格，被操作的資料是「三方場館的費率」，實作用 `SystemIdEnum.game = 1`、呼叫端在 `agrabah/src/servers/game_back_office/`、actionId 152–154。照菜單業務域推會得到 `platform = 9`、再依硬不變式把 actionId 選進 **9xx**——**級聯過濾會直接壞掉**（見「actionId 選號的硬不變式」）。該節點企劃填的 `遊戲系統` 反而比依菜單推定更接近事實。

#### 想在本機實測驗證改動時的坑（2026-08-26／27 踩到）

本 skill 不要求實測（鐵律 3：不跑生成/測試），但若你要自行用本機環境驗證產出的日誌：

- **AdminGate 的 Host header 規則與 PlatformGate 相反**。`core.domains` 沒有 admin 的列（本機只有 `localhost:8002`→platform）。`agrabah/src/servers/gate/handlers/gate_handler_base.ts:142-143` 會拿 Host 查 domain 得 platformCode，再要求它等於 token 裡的 platformCode；admin token 的 platformCode 是 `'0'`，所以 Host **必須刻意不對到任何 platform domain**（用 `localhost:8001` 即可）。照抄 `agrabah-local-dev` skill 第 4 節那個 platform 用的 `localhost:8002` 會讓 admin token 被降級成匿名。
- **操作日誌頁預設只查「今天」且時間區間必填**（`AdminAuditLog.vue` 的 `todayRange()` + `FieldRules.required()`）。查不到舊日誌是預期行為，不是功能壞掉。
- **本機 admin 後台的 UI 語系是 zh-CN**（2026-08-27 實測表頭原文 `["系统项目","项目类型","操作前","操作后","操作人员","登录IP","操作时间"]`）。用繁體字串當 Playwright 選擇器會 timeout，要用簡體或英數子字串（`TOTP`／`操作日`／`系统管理`）。
- **進操作日誌頁要用點選單，不能 `page.goto` 深層路由**——直接 goto 會被 SPA 導回 `/home/welcome`（或 admin 的 `/platform-management/welcome`），DOM 抓到的是歡迎頁而不是空列表，很容易誤判成「查無資料」。
- **本機 DB migration 可能落後於 code，症狀是列表頁空白而非報錯**。2026-08-27 實測：`game.game_vendors` 缺 `bet_fetch_end_buffer_seconds`／`bet_fetch_window_seconds` 兩欄（ORM `DbGameVendor` 已有），廠商列表頁顯示「无资料」、`pageerrors=0`，真正的錯誤只出現在 agrabah log：`Unknown column 'bet_fetch_end_buffer_seconds' in 'field list'`（`game_vendor_admin.ts:196`）。**畫面空白時先去翻 agrabah log，不要當成沒資料。**
- **`createNew` 的日誌在畫面上「操作前」欄顯示 `-`**，不是空字串也不是空白格（2026-08-27 admin 端 DOM 實測）。

#### ⚠️ 本機**驗不到**新 enum 值的畫面顯示（2026-08-27 實測確認）

新增 actionId 後想在本機看畫面「項目類型」欄顯示中文，**做不到**——即使你已經把 `enum.platform-action-id-enum-<kebab 成員名>` 三語都補進 `abu/*/localizations`。

實測（2026-08-27，完整五層都做了、agrabah 也重啟了）：新增 `userTagsAdd = 634`、補完三語 i18n、真實點擊後台 UI 觸發，DB 確實落了 `action_id=634` 的列，但畫面 DOM 原文是：

```
ROW0 ["用戶系統","634","agent_e","-","會員ID:10005\n會員標籤:2, 1","landon","127.0.0.1","2026/08/27 02:23:42"]
                 ^^^^ 項目類型顯示裸數字，不是「新增會員標籤」
```

**成因**：前端把 actionId **數值**翻成文字，要先經由 generated 的 reflection 資料把數值映射成 enum **成員名**，才拿成員名去查 i18n。新 enum 成員只存在於你改的 `.rajah` source，而**本機不准跑 `generate-*.sh`**，所以前端根本不知道 634 是誰。i18n key 補得再齊也沒用。

> **⚠️ generated 有兩份，而且可能不同源**：
> - `agrabah/src/generated/services.gen.ts:18173` 有 `userVentureAgentActivate = 633`（**dev 來源**）
> - `abu/platform/src/generated/remote.gen.ts:17530` 停在 `userLevelUpdate = 632`、**沒有 633**（**main 來源**）；`abu/common/generated/remote.gen.ts:686` 同
>
> **前端顯示 enum 文字依賴的是 `abu` 那一份。** 所以就算 actionId 選對、i18n 也補了，只要 abu generated 沒有那個成員，畫面「項目類型」就是裸數字。選號時查 `agrabah` 的 generated（那份才對應後端實際值域），但**判斷畫面能不能顯示**要看 abu 那份。

**要讓新 actionId 真的跑進 DB，有一個不碰 generated、不跑 generate 的合法做法**（2026-08-27 實測可行）：

```ts
// 呼叫端：audit() 第 3 參數宣告型別是 AdminActionIdEnum | PlatformActionIdEnum
//         （common_services/audit_log.ts:5），數字字面量不可直接指派，但轉型是合法 TS
audit(context, SystemIdEnum.user, 634 as PlatformActionIdEnum, auditData, userId).then();

// 註冊：HandlerConfig.actionIds 型別是 number | number[]（index.ts:403-406），字面值直接可用
actionIds: { [GateId.platform]: 634 }
```

**這樣能驗到**：action_id 真的落 DB、handler 依新號碼正確分派、layer 2 的 `data` 與 `targetId`、以及各欄位的 label/value 渲染。**仍驗不到**：前端把數值反查成成員名再翻 `enum.<…>`（需要 abu generated 有該成員）。用這個方法時，**報告中必須把後者標為未驗證**。

**因此本機 E2E 的有效範圍是**：日誌有沒有真的寫進 DB、`systemId`／`actionId`／`gate_id`／`target_id` 落值對不對、targetId 反查會員帳號成不成功、handler 輸出的**各欄位**怎麼渲染（label 翻譯、enum meta、裸 id、`-` 等）。

**驗不到的是**：新 actionId 自身的「項目類型」欄顯示、以及該 enum 成員的 i18n key 是否生效。這兩項**只能靠開檔核對 key 是否存在**，要標成推論而非實測。

#### 真實觸發不了時：合成注入是合法手段，但要守住兩條界線

有些情境**本來就沒有真實操作可以觸發**（例如「未註冊 handler 時畫面長什麼樣」），有些則是本機環境擋路（如上面的缺欄位）。這時可以直接把呼叫端會寫出的 JSON 注入 `audit.audit_logs`，再從真實後台頁面觀察渲染。2026-08-27 就是靠這個手段，才首次實測到 layer 4 的裸 JSON 症狀。

但它只能證明 **layer 3→5**（handler 輸出 → 註冊 → i18n → 前端渲染），**完全不能證明 layer 1–2**——呼叫端有沒有真的被觸發、有沒有傳對欄位、targetId 實際落什麼值，一個都沒驗到（你注入的 JSON 是你「假設它對」照抄來的）。所以：

1. **必須先誠實嘗試真實觸發，失敗了才降級，並記錄失敗原文。** 跳過嘗試直接合成，等於用自己編的答案考自己。
2. **必須在報告裡明確標示哪些結論來自合成**，並寫出未涵蓋的層。拿合成結果宣稱「五層驗證通過」就是造假。

用完記得刪除注入的列並驗證（`SELECT COUNT(*) … → 0`），刪除範圍只限自己插入的 id。

**`示意` 欄常放真實日誌樣本**（如 `【2026/08/26 DEV 實作實例（共 5 筆）】狀態:- 通知類型:- …`），是判讀「現行實作實際輸出什麼」的直接證據，定位時務必一併讀；但它是**現況**不是規格，規格仍以操作前/後中英文欄為準。

### Step 5：五層比對 → T3 確認關卡

對 `specRows` **每一列**執行五層比對：

| 層 | 檢查 | 缺漏時動作 |
|----|------|-----------|
| 1. rajah enum | `SystemIdEnum` 有無對應系統項目；`AdminActionIdEnum`／`PlatformActionIdEnum`（依 gate）有無語意對應的 actionId。**選號必須滿足硬不變式 `Math.floor(actionId / 100) === systemId`**（見下方說明） | 新增 enum 值：在同業務域編號區段內遞增選號，不跳段亂編；附中文註解 |
| 2. 呼叫端 | 是否呼叫 `audit(context, systemId, actionId, data, targetId?)`；「操作前」空→`createNew`、前後皆有→`createUpdate`、刪除類→`createDelete`（`動作類別` 欄可輔助判斷，衝突時以「操作前是否為空」為準）；before/after 物件是否涵蓋規格全部顯示欄位；**平台規格「會員帳號」欄有值（含 `需填入` 這類指示語）→ 第 5 參數必傳被操作會員的 userId**（歷史踩坑：打賞審核曾誤傳打賞紀錄 ID 而非會員 ID）；**「會員帳號」為空或 `-` → 不需要傳 targetId，判 ✅ 而非 ❓** | 補 `audit()` 呼叫／修正 `AuditData` 內容／修正 targetId |
| 3. handler | **規格的每一行都要在 `buildResult` 找得到對應 key**（順序盡量一致）；handler 多出來的 key 依邊界規則**不刪、標 ⚠️ 交企劃**（這是單向檢查，不是雙向對等）。enum 值欄位需用 `title:<i18n-key>;enum:<EnumName>` meta（前端 `AuditLogList.vue` 的 `enumFormatter` 靠此 meta 才會把數值翻成 enum 成員文字；沒有 meta 的欄位只會走 `defaultFormatter` 直出原始數字）；欄位值為 `CurrencyLink`/`CurrencyAmountLink`/`LocalizationString` 物件時，前端已通用解析（見上方「特殊 value 形狀」小節），純顯示值的欄位**原則上**原樣輸出 rajah model 即可，**但有兩個例外，動手前先確認**：(a) **該 `CurrencyLink` 承載的不是金額**（匯率、有效位數、顯示位數等）→ 前端會把 value 標成「金額」而誤導，既有正確做法是 handler 端本地轉字串，實例 `payment_deposit_method_upsert_handler.ts:8-15`，其註解逐字寫明這個理由；(b) **日誌裡的語系碼不在該平台當下的 `supportedLanguages`** → 不會被攔截，直出會變裸 JSON。**看到既有 handler 本地轉字串不要判成不符**；但呼叫端存的是 stored 值（帶 `rawValues` 旗標）時 handler **必須**依旗標換算 | 新增 handler（照 `currency_status_handler.ts` 樣板：interface＋class＋`buildResult`，**含 enum meta 寫法**）或修改輸出 keys；純顯示值的貨幣/多語系物件直接輸出原始陣列，不需要新 meta；需要換算的走 `formatCurrencyToDisplayLinks` 或 `RateHelper.storedToNormal`（**用 `RateHelper` 前先開 rajah 抄下該欄位的 `@Type "Rate:N"` 並把 N 當第 2 參數傳進去**——預設值 10000 只對全庫 35 處中的 20 處正確，見「費率」小節） |
| 4. 註冊 | `AUDIT_HANDLERS` 中 actionId 是否註冊在正確 gate（系統→`GateId.admin`、平台→`GateId.platform`）；多 actionId 共用 handler 用陣列 | 補註冊項（含 import） |
| 5. i18n | 每個 key 查 `abu/{admin|platform}/localizations/{zh-TW,zh-CN,en-US}.json`；**meta key 先解析**：label 查 `model.<title值>`（有 `prefix:` 則查 `<prefix>.<title值>`）；一般 key 查 `model.<key>`。**值的 i18n key 由 meta 決定，不是由 enum 型別決定**——先讀 handler 那一行的 key 字串，再決定查哪個：

| handler 的 meta | 值要查的 i18n key |
|---|---|
| `enum:<EnumName>` | `enum.<kebab-case-enum>-<成員名>`（**成員名非數值**，數值→成員名由前端 ReflectionHelper 映射） |
| `valuePrefix:<前綴>` | `<前綴><handler 實際寫入的 value>`（如 `valuePrefix:enum.` + value `enabled` → `enum.enabled`） |
| 無 meta | 沒有 key 可查，畫面直出原值 |

**照「enum 型別」去推 key 會產生假缺漏**：2026-08-27 實測 `PlatformManagementAdmin.Totp`，照 `enum:` 慣例推出 `enum.totp-mode-enum-normal`／`-force`，三語**都不存在**，會被判成「缺 2 個 key」進 T5；但畫面實際顯示「启用／停用」，真正在翻的是 `enum.enabled`／`enum.disabled`（因為 handler 用的是 `valuePrefix:enum.`）。**選 meta 前也要先查 i18n 有沒有那組 key**——沒有時的既有慣例是改用 `valuePrefix:` 並在 handler 把數值映成 `enabled`/`disabled` 這類通用值，而不是先套 `enum:` 再去要求補一整組 key。**新增 actionId／systemId enum 成員時，該成員自身也要一個 key**：`enum.platform-action-id-enum-<kebab 成員名>`／`enum.admin-action-id-enum-<kebab 成員名>`（缺了列表「項目類型」欄顯示不出中文）、`enum.system-id-enum-<kebab 成員名>`（缺了「系統項目」欄顯示不出中文）。2026-08-26 實測皆為既有慣例、不是新規定：platform 側 714 個 `platform-action-id-enum-*`、admin 側 110 個 `admin-action-id-enum-*`、42 個 `system-id-enum-*`（如 `enum.system-id-enum-platform` = 「平台系統」）。**判定標準是「語意對應」不是字串相等**，見下方說明 | **不改 JSON**；缺漏/不符記入內部 i18n 缺漏清單 |

#### ⚠️ layer 2 與 layer 3 必須合看：「handler 有這個 key」≠「畫面會出現這一行」

handler 的 `buildResult` 普遍用 `if (data.x !== undefined)` 當守衛（實例：`account_status_handler.ts:18-20` 三個欄位都是這個寫法）。因此**單看 layer 3 判 ✅「handler 已支援該欄位」是不夠的**——呼叫端沒把該欄位塞進 `AuditData` 的物件裡，畫面上就是不會有那一行，而且不會報錯。

2026-08-26 實測到的真實缺口正是這個形狀：`account_status_handler.ts:19` 一直都有 `adminAccount` 分支，但 `platform_admin.ts` 的呼叫端只傳 `{ adminId, status }`，所以規格要求的「管理員帳號名稱」從來沒出現過。修法是**在呼叫端補資料**，handler 一行都不用動。

**判定規則**：layer 3 判 ✅ 之後，一定要回頭確認 layer 2 呼叫端的 `data` 物件真的有該欄位。**三件事都要對上，缺任一件那行就在畫面上靜默消失**：

1. **handler 讀的欄位名逐字等於呼叫端寫進 `data` 的欄位名**。實測踩坑：handler 讀 `data.memberTagId`、呼叫端寫的是 `tagIds`，結果 `identifier` 與 `tagIds` 兩個欄位在畫面上憑空消失——沒有錯誤、沒有佔位符、沒有 log
2. **呼叫端在「所有分支」都會塞這個欄位**。只在某些分支塞，那些分支的日誌就少一行
3. **守衛的寫法**（見下）
4. **反向也要查：呼叫端 `data` 裡的每個欄位，在「該 actionId 實際註冊到的那個 handler」裡都要找得到對應分支。** 同一個業務域常有多個 handler class（如 Lock／Review／Pay 三個），欄位在 A handler 有、actionId 卻註冊在 B handler，該欄一樣靜默消失。查法：**先在 `index.ts` 找出該 actionId 註冊到哪個 class，再開那個 class**——不要看到同一個檔案裡有另一個 class 處理了就判 ✅。2026-08-27 實測案例：`paymentWithdrawOrderFinanceCorrect` 的呼叫端有餵 `payoutDetails`（`withdraw_platform.ts:2858-2864`、`:3065-3070`），但它註冊在 `PaymentWithdrawOrderReviewHandler`（`payment_withdraw_order_handler.ts:57-69`），該 class 沒有 `payoutDetails` 分支；有處理的是**同檔案**的 `PaymentWithdrawOrderPayHandler`（`:72-109`）。規格要求的「出款明細」因此從未出現在畫面上

**⚠️ 純真值守衛會吃掉合法的 `0` / `''` / `false`**。2026-08-26 全掃 `implementations/` 的 384 個 handler 檔：

| 守衛寫法 | 出現次數 | 風險 |
|---|---|---|
| `if (data.X !== undefined)` | 324 | 只漏「欄位根本沒塞」 |
| **`if (data.X)`（純真值）** | **107（分布在 41 個檔）** | **額外吃掉 `0`／`''`／`false`** |
| `if (data.X !== null)` | 0 | — |

對操作日誌來說這是實質資料遺失，而且**被吃掉的正好常是最需要記錄的值**——「清除後積分餘額 = 0」「增加次數 = 0」「是否為默認地址 = false」。**規格欄位語意允許這些值時（金額歸零、次數 0、布林旗標），看到純真值守衛一律判 ⚠️ 並要求改成 `!== undefined`。**（純真值是既有慣例、涉及 41 個檔，是否全面統一屬專案級決定，不在本 skill 的比對範圍內自行處理。）

> **這是靜態比對的系統性盲區，不是單一疏漏。** 只要規格描述的是「某個欄位有沒有出現在畫面上」，逐層各判各的就抓不到——上述缺口是 2026-08-26 把服務真的跑起來、把日誌從 DB 一路追到畫面才發現的。本 skill 依鐵律 3 不代跑測試，但**遇到這類規格時，T6 要明確提醒開發者實測一筆**（怎麼測見 Step 4 的「本機實測的兩個坑」）。

#### ⚠️ 改 handler 前先查它是不是共用的

同一個 handler class 會在 `AUDIT_HANDLERS` 被註冊多次、跨多個 actionId 甚至跨 gate（實例：`AccountCreateHandler` 同時註冊於 `index.ts:790-796`（帳號管理，admin+platform）與 `:806-811`（平台超管，admin）；`AccountStatusHandler` 同理）。

動 handler 前先 `grep '<HandlerClass>' index.ts` 查出全部註冊項。**共用的 handler 優先改呼叫端餵資料，不要改 handler 的輸出結構**——改結構會同時改掉其他節點的顯示。

#### 各層失敗在畫面上長什麼樣（人工複檢時用來反推是哪一層壞了）

五層的失敗都是**靜默的**——不報錯、不空白，而是顯示成別的東西。認得這幾種症狀，看畫面就能反推。

> **⚠️ 本表的證據等級不一致，用之前先看最後一欄。** 2026-08-27 向當初產出本表的兩個 E2E agent 逐項追問後確認：只有兩列真的在畫面上看過，其餘是讀前端程式碼推導出來的預期症狀。推導的部分**沒有被證偽，但也從未被觀察到**——拿它反推「畫面長這樣所以是某層壞了」時要留餘地，不要當成已驗證的事實引用。

| 失敗層 | 機制 | 畫面症狀 | 證據等級 |
|---|---|---|---|
| layer 4 未註冊 handler | `helpers/audit_formatter.ts:19-30`：找不到 handler → `before/after = JSON.stringify(auditData.before/after)`；若 `data` 不是 `{before,after}` 結構則 `after = data` 原字串 | 「操作後」欄出現**裸 JSON 字串**（不是空白、不是 `[object Object]`） | **已實測**（2026-08-27，admin 端 DOM 原文 `{"platformId":11,"gameVendorId":1045,"status":1}`，actionId 104 未註冊）。**驗法是合成注入**（該情境無真實操作可觸發），故「前端渲染」已證實、「呼叫端會不會真的寫出這種列」未涵蓋 |
| layer 5 缺 i18n key | `AuditLogList.vue:141-145` 的 `translateModelLabel` 回 `ui.t('model.'+key) \|\| key`，而 vue-i18n 的 `t()` 查無 key 時回傳 **key 字串本身**（truthy），所以 `\|\| key` 這段 fallback 永遠不會執行 | 出現**字面字串 `model.<key>`**（不是空白、不是裸 key） | **已實測**（2026-08-27，操作日誌頁 DOM 原文含 `model.payment-method-deposit-use-mobile-bind-popup:否`；`payment_deposit_method_upsert_handler.ts:89` 輸出該 key，而 `abu/platform/localizations` 三語皆缺）。**順帶：這是一個現存的真實 i18n 缺漏，值得另案處理** |
| layer 3 enum 欄位缺 meta | `formatEntry` 的分流**只看 `parseKey(entry.key)` 的字串、不看 value 語意**（`enumFormatter` 開頭就是 `if (!enumName \|\| !titleKey) return null`）→ 無 meta 時全部 formatter 回 null → `defaultFormatter` → `formatPrimitiveValue` → 數字回 `String(value)` | 顯示**數字**（如 `1`／`2`）而不是「啟用／停用」 | **機制已實測**（2026-08-27：`totp_mode_change_handler.ts:19` 的無 meta key `platform-id`、DB 值 `911`，畫面 DOM 原文 `平台:911`，證實無 meta 分支真的直出數值）；但**「rajah 宣告是 enum 卻缺 meta」的真實欄位仍未觸發過**。兩者走同一分支（分流不看 value 語意），故機制可信、實例仍缺 |
| layer 3 對 id 陣列誤用 `select:` | `getCustomSelectLabel` 陣列必定 miss → 退回 `formatPrimitiveValue` | 顯示**裸 id 串**（如 `1, 2`） | **實測**：畫面 DOM 原文 `會員標籤集合:1, 2`，且實跑 `getCustomSelectLabel("AppUserTag",[1,2]) → undefined` |
| layer 2 未傳 targetId **或** targetId 反查失敗 | 見下方 targetId 的靜默降級 | 「會員帳號」欄顯示**裸數字 id**——**兩種成因畫面完全相同** | **實測**：同一畫面上第 1 列顯示 `agent_a`、第 2 列顯示 `14192464`，並有 agrabah log `[batchGetUsers] get user identifier failed:` 佐證 |

**⚠️ targetId 的靜默降級（不能只看畫面判定 targetId 對錯）**：讀取端 `audit_platform.ts:296` 是 `identifier = targetUserMap.get(row.target_id) || String(row.target_id)`，而 map 來源 `common_services/app_user.ts:339-341` 的 `GetAppUserIdentifierByIds` 用的是 **`INNER JOIN user_details`**。會員在 `app_user.users` 有列但 `user_details` 沒列時（本機實測 511,479 個 user 只有 21 個有 detail），JOIN 直接濾掉、回 0 列，於是 fallback 成裸 id。**畫面上「targetId 根本沒傳」與「targetId 傳對了但反查不到」看起來一模一樣**——要判定 layer 2 對錯，必須回 DB 看 `audit_logs.target_id` 欄的實際值。

#### actionId 選號的硬不變式（layer 1，選錯會靜默壞掉）

**`Math.floor(actionId / 100)` 必須等於該筆日誌的 `systemId`。** 這不是命名慣例而是前端硬編邏輯：`abu/common/helpers/audit_log_action_filter.ts` 的 `getActionOwnerSystemId()` 就是拿 `Math.floor(actionId / 100)` 當 bucket 反推所屬系統，用來讓操作日誌搜尋列的「系統項目」下拉**級聯過濾**「項目類型」下拉。選了不符的號碼，日誌照樣寫得進 DB、列表也照樣顯示，但該項目類型會從級聯選單中消失——**靜默失敗，不會報錯**。

驗算例（2026-08-27 實測）：`SystemIdEnum.user = 6`（`service_common.rajah:10`），user 業務域的 actionId 就落在 6xx；新增 `userTagsAdd = 634` → `Math.floor(634/100) = 6` ✅ 相符。（**這裡刻意用 634 而不是 631**——631 在 `origin/dev` 上早被 `userBatchRegisterWithAgent` 佔用，見下方同源性警告。舊版文件此處寫 631，與該節自相矛盾。）

**例外機制**：同檔的 `PLATFORM_ACTION_OVERFLOW` 定義了溢位對照（目前只有一條：bucket `42` → `SystemIdEnum.agent`），用於某業務域號碼用完而借用其他號段的情況。`ADMIN_ACTION_OVERFLOW` 目前是空陣列（admin 端全量 96 筆、值域 1–2316 無溢位）。**要借號段必須同時在這個表補一條，否則級聯一樣會壞**；能在自己號段內遞增就不要借。

#### i18n 判定是「語意對應」不是「字串相等」（layer 5，照字面做會改壞既有翻譯）

**Notion 的中英文欄都不是可以直接寫進 JSON 的翻譯值**，2026-08-26 用節點 `AppUser.User` 底下**企劃自己標為 `實作一致`** 的 8 列做逐字對照實測：

| Notion 列 | 規格中文欄 | 該 key 的 zh-TW 實際值 | 規格英文欄 | 該 key 的 en-US 實際值 |
|---|---|---|---|---|
| 修改會員標籤 | 會員帳號 | **帳號** | `Account` | account number |
| 修改會員標籤 | 會員標籤集合 | **會員標籤** | `memberTagId` | Membership Tags |
| 增加會員提款次數 | 增加次數 | **增加會員提款次數** | `withdrawals` | Increase the number of withdrawals… |
| 修改上級代理 | 原始上級代理帳號 | **代理帳號** | `originalSuperiorAgentName` | Proxy Account |
| 修改會員VIP等級 | 會員ID／帳號 | 會員ID／帳號 | **`Member ID`／`account number`** | Member ID／account number |

兩個結論：

1. **「操作前/後-中文」不逐字等於 zh-TW 值**，但企劃全部驗收為 `實作一致` ——企劃的實際標準是語意對應。照「必須逐字相等」執行，會把這批本來就正常的列判成 ⚠️ 並去改一批既有翻譯，那是實質倒退（同一個 key 常被其他畫面共用，改了會波及）。
2. **「操作前/後-英文」是混合語意欄**：同一個節點內同時存在 camelCase 資料欄位名（`memberTagId`／`withdrawals`／`originalSuperiorAgentName`）與真正的 en-US 文案（`Member ID`／`account number`）兩種填法。**這一欄對 layer 5 沒有可機械執行的語意，只能當人工參考。**

因此 layer 5 的判定改成：

- key **已存在**且中文語意對得上 → 判 ✅，**不要**為了逐字對齊去改既有翻譯
- **同一節點內、同一語意的欄位已有既存 key 時，優先沿用，不另立新 key。** 判斷對象是「這個語意有沒有 key」，不是「規格的用詞有沒有一模一樣的 key」。要另立新 key，必須語意確實不同（不是用詞詳略之別），並在 T3 寫明理由。2026-08-27 實測分岔案例：規格寫「會員標籤集合」，而同節點姊妹列「修改會員標籤」已在用 `model.get-app-user-detail-response-tags`（zh-TW =「會員標籤」）。沿用它 → label 層 0 新增；另立 `model.member-tag-id`（＝「會員標籤集合」）→ **同一概念在同一節點出現兩個 key、畫面兩種字**。兩者畫面都能正常顯示，屬取捨題，但本文件的既有條文（語意對應、英文欄不可機械 kebab-case）較支持沿用
- key **已存在但語意明顯不符** → 先 grep handler 目錄確認該 key 是否被多個 handler／節點共用。**共用 → 判 ⚠️ 記錄「規格用詞與既有共用 key 不一致」交企劃裁決，不要列進 T5 要求改值**（改了會污染其他頁面）；專屬於本節點 → 才照規則要求對齊。實例：規格寫「管理員帳號名稱」，而既有 `model.platform-user-essential-account` 的 zh-TW 是「帳號」，該 key 同時被帳號管理節點使用，硬改會波及
- key **不存在** → 記入 i18n 缺漏清單（T5）：`zh-TW` 取 Notion 中文原文、`zh-CN` 由繁轉簡、**`en-US` 自行擬顯示文案，不要照抄英文欄的欄位名**（否則畫面會出現 `memberTagId` 這種東西）
- 缺 key 的畫面症狀是**顯示字面字串 `model.<key>`**，不是空白也不是裸 key：`AuditLogList.vue:141-145` 的 `translateModelLabel` 寫的是 `ui.t('model.'+key) || key`，而 vue-i18n 的 `t()` 查無 key 時回傳 key 字串本身（truthy），所以 `|| key` 這段 fallback 永遠不會執行

#### ⚠️ 選號前必須確認 rajah repo 與 generated 同源（2026-08-26 實測踩到）

**不要直接拿本機 `rajah/services/service_common.rajah` 的最大值 +1 當新號碼。** 先確認本機 rajah 在哪個分支、落後多少：

```bash
git -C rajah branch --show-current && git -C rajah status -sb | head -1
grep -n "platformUserCreate\|<你要參考的既有成員>" agrabah/src/generated/services.gen.ts
```

實測案例：本機 rajah 停在 `main`、落後 origin，而 `agrabah/src/generated/` 是從 **`dev`** 生成的。照本機 main 看 user 業務域最大是 630，於是選了 631——但 `dev` 上 631／632／633 早已被 `userBatchRegisterWithAgent`／`userLevelUpdate`／`userVentureAgentActivate` 佔用，正確答案是 634。**這種撞號在本機完全看不出來，要等合併時才爆。**

> **⚠️ 落後幅度每次都不同，一律自己量，不要引用任何寫死的數字**（同一天內量到過 0 與 49）。**穩定的事實是「本機 main ≠ generated 來源的 dev」這個結構**。選號的權威來源永遠是 `origin/dev`：
>
> ```bash
> git -C rajah show origin/dev:services/service_common.rajah | grep -nE "= 6[0-9][0-9]$"
> ```
>
> 2026-08-27 實測：`origin/dev` 有 630/631/632/633、**無 634**，而本機 `main` 只到 632——兩組獨立驗證者都據此選了 634，答案一致。

同一個成因還有另一個後果：**這種狀態下絕對不能跑 `generate-*.sh`**——會用落後的 main 覆蓋掉由 dev 生成的 generated，讓 dev 才有的 enum 成員整批消失（實測會讓 `AdminActionIdEnum.platformUserCreate` 不見、agrabah 編不過）。要選號或要生成，先確認 rajah 已切到與 generated 同源的分支並更新到最新。

邊界規則：

- 一節點多列項目類型（模式 B 的常態）→ 逐列跑五層，T3 分列呈現
- **⚠️ Notion 一列 ≠ 一個 actionId。** 企劃以「操作」為單位寫列（啟用／停用常拆兩列），實作則常以 **method** 為單位取一個 actionId、把狀態放進 `data` 欄位。兩種形狀都被企劃驗收過。實例（2026-08-27 實測）：`PlatformManagementAdmin.Totp` 的兩列 `設置啟用`／`設置停用` 對應**單一** `AdminActionIdEnum.totpModeChanged = 2311`，畫面「項目類型」兩筆都顯示「TOTP模式變更」，核對狀態仍是 `實作一致`。**判準是「這兩個操作在畫面上能不能被區分」**——actionId 相同但 `data` 有狀態欄位就能區分，屬合格；只有兩個操作在畫面上完全無法區分才判 ⚠️。**不要因為 Notion 拆成兩列就去新增第二個 actionId。**（注意下一條的「批次獨立 actionId」講的是批量 vs 單筆，不要套用到「啟用 vs 停用」上。）
- 主表「不支援批量/單個分開」勾選 → 單/批量共用 actionId；未勾且規格有批量列 → 批量獨立 actionId。（2026-08-26 實測**兩份主表全部節點皆未勾選**，因此實務上一律走「批量獨立 actionId」；明細列的 `動作類別` 出現 `批次啟用`／`批次停用` 即代表該列是批量列。若哪天讀到已勾選的節點，才走共用分支。）
- 現有 handler 是舊式 `JSON.stringify(data)` 直出 → 改寫成 key/value 陣列格式
- gate 錯置（系統節點註冊在 platform 等）→ 判定 ⚠️ 不符，動作寫遷移方式
- **enum meta 的 `<EnumName>` 必須取自呼叫端實際型別**（method 參數或 model 欄位宣告的 enum，開檔確認），不得用顯示語意相近的其他 enum 替代（踩坑：狀態欄誤用 `ActiveStatusEnum`，實際型別是 `StatusEnum`——啟用/停用值恰好相同，但 frozen/deleted 等值會解析失敗）。**反例（2026-08-10 實測）**：若「呼叫端宣告型別」本身無法涵蓋資料來源的實際值域（如 rajah 宣告 `ActiveStatusEnum` 只有 enabled/disabled，但 before 快照直接來自 DB 欄位、值域包含 `StatusEnum.deleted=10` 等其他值），此時**不要**機械套用「以宣告型別為準」而把 meta 改窄——改窄會讓現況能解析的值變成解析失敗。應保留現況能完整解析值域的 enum，並把「rajah 宣告型別與 DB 實際值域不一致」本身標為 ⚠️ 另案處理（rajah 側訂正），不要用改壞 handler 的方式「修正」它
- **enum 欄位缺 meta 一律判 ⚠️ 不符**（缺 meta 會讓前端直出數字而非翻譯文字）。**⚠️ 但「缺 meta」的判定不是「沒有 `enum:`」**——先看呼叫端存進 `data` 的值是 enum 數值還是字串常數：存字串常數時正確做法是 `valuePrefix:`，看到 `valuePrefix:` 不要判成缺 meta（五種 meta 見上方「key 的 meta 格式」表）。**只認 `enum:` 會把一批正確實作判成 ❌ 並開出「改成 `enum:`」的動作，那是把對的改壞**（實例：`PaymentWithdraw.Order` 有 3 個欄位、`PlatformManagementAdmin.Totp` 亦然）。**判斷某欄位是不是 enum，一律開 rajah 確認呼叫端的宣告型別，絕對不能用欄名關鍵字篩選**——欄名不含 status/type/category 的 enum 欄位是存在的，而且 handler 自己的 interface 可能寫錯型別。已知漏網實例：`user_delivery_address_update_handler.ts:48-50` 的 `isDefault` 直出無 meta，但它在 rajah 宣告是 **`StatusEnum`**（`rajah/services/user_back_office.rajah:1145`），該 handler 的 interface（`:12`）卻誤寫成 `boolean`——**型別不符是開檔確認的事實；「畫面因此直出 `1`/`2`」則是推論**（2026-08-27 追問確認：從未觸發過修改收貨地址、沒在畫面上看過該欄位）。要拿它當實例引用時，講型別不符即可，不要把畫面症狀講成已觀察到
  > 這條規則本身是為了處理「既有 handler 對 enum 只寫 plain key」的存量而立。2026-08-26 曾以欄名關鍵字（status/type/category）全掃 `implementations/` 得到「存量已補完」的結論，**那個結論是錯的**——掃描方法漏掉了 `isDefault` 這種欄名不含關鍵字的 enum 欄位。不要依賴這類關鍵字掃描的結果。
- **貨幣/多語系物件不是套 meta 解決的**：見「特殊 value 形狀」小節，前端 `AuditLogList.vue` 的 `codeValueLinkFormatter` 已通用解析這三種形狀，不需要新增任何 meta。但**「handler 一律直出」不是通則**：現況同時存在直出、走 `formatCurrencyToDisplayLinks` 換算、以及自行轉字串（本地 `formatCurrencyLinks`）三種寫法。比對時判斷的依據是**呼叫端存的是顯示值還是 stored 值**，而不是「有沒有呼叫 helper」——存顯示值卻又換算、或存 stored 值卻直出，才是不符；看到既有 handler 自行轉字串（如 `fund_adjustment_preset_handler.ts` 的 `/` 分隔）先記錄為現況差異、問開發者，不要逕自改成直出
- **id 要查名稱顯示時，先分辨純量還是陣列**：純量用 `title:<key>;select:<CustomSelectName>`；**陣列目前無解，標 ⚠️ 問開發者、不要套 `select:`**（會靜默顯示裸 id）。詳見「特殊 value 形狀」小節末的邊界規則
- **handler 輸出的 key 數多於規格列數 → 判 ⚠️、預設不刪**：常見於 handler 額外記了 `id`、`parentId` 等內部欄位。這些多半是既有稽核資訊，貿然刪除是資訊倒退；在動作欄寫「規格外欄位，請企劃確認保留或移除」交企劃裁決，不要為了「逐行一一對應」而自行砍成與規格等長
- **規格列本身代表「可重複多筆」（如批次編輯多筆子項）時，「逐行一一對應」比對的是一組模板，不是硬數行數**：規格文字若用「…」或列出同一組欄位重複出現，對應到 handler 是 for 迴圈輸出多份同結構 key/value，比對時抓「一組模板的 key 順序」是否對應，不要因為 handler 實際輸出行數（N 組）多於規格單組行數就判不符

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

T5 的 CSV 檔名用節點名（菜單路徑最後一段）；模式 A 且該列未掛菜單節點時，改用該列的 `項目類型` 當檔名。三份輸出的標題列一律用 `menuPath`，模式 A 未掛節點時填「（本列未掛菜單節點）— <項目類型>」。

---

## 模型分層派工（環境支援子代理時）

| 階段 | 代理 | 模型 | 任務 |
|------|------|------|------|
| Step 4–5 探索 | explorer（唯讀，可多個並行） | **haiku 或 sonnet** | 回報五層現況的 `檔案:行號` 與內容摘錄 |
| Step 6 修改 | executor | **sonnet**（或主線程自行執行） | 依 T3 確認後的動作清單改 code、產出兩份內部產物 |
| Step 7 檢查 | reviewer（唯讀） | **opus 級強模型** | 獨立驗證五層 checklist，輸出 PASS／FAIL |

派工原則：explorer 的回報若無 `檔案:行號` 佐證一律退回重查；reviewer 不得由 executor 同一個代理兼任。

**enum 值／號碼的回報有額外要求**（2026-08-26 實測踩到）：凡回報 enum 值或號碼，**必須同時附 rajah source 與 `agrabah/src/generated/services.gen.ts` 兩邊的 `檔案:行號`，兩者不一致要明確標記，不得只回一邊**。本機 rajah 可能與 generated 不同源（本機通常在 `main`、generated 來自 `dev`；落後幅度每次都不同，**不要引用任何寫死的 commit 數**），只看 rajah source 會得到完全錯誤的結論——例如回報「`902 = platformBlockImageUpdate`、`platformUserCreate` 不存在」，進而誤判成「需要新增 enum」。這也是為什麼 Step 4.0 的第 ③ 個 grep 查的是 generated 而不是 rajah。

**不支援子代理的環境（如 Codex 單線程）**：全流程主線程自行執行；Step 7 的五項 checklist 仍必須在改碼完成後逐項自查（重新開檔核對），並在 T4 的 Reviewer 欄標註「reviewer checklist 已自查（單線程環境）」。

---


## 輸出模板（T0–T6）

輸出模板全文（含 T1b／T2b 與每個模板的完整渲染範例）獨立收錄於 `references/templates.md`，**產出任一 T_ 模板前必須先讀該檔對應段落**，只准填 `<>` 佔位符與增減表格列；開頭標記逐字保留；模板外不加自由段落。模板清單：T0（環境檢查未通過）、T1（使用說明）、T1b（Todo 查詢結果）、T2（規格摘要）、T2b（免寫節點）、T3（五層差異報告）、T4（變更清單）、T5（i18n 待補清單）、T6（收尾提醒）。
