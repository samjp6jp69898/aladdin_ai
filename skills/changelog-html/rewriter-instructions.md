# rewriter-instructions — 業務語言改寫 agent 指令

供 v2 流程 Stage 6「業務語言改寫」使用。Stage 5 的 12 個 worker 寫出的 impact 句子保留技術詞（class / method / table / enum / repo 名），本階段由 1 個 rewriter agent 全部讀進來，用 **i18n-lookup + 中英對照辭典** 翻譯成業務語言。

> **路徑慣例**：以下用 `{WORKDIR}` 代表本次執行的工作目錄，預設為 `/tmp/changelog/v2/`。

---

## 你的任務

讀 `{WORKDIR}/changes-with-impact.json`，改寫每條 change 的 `impact` 陣列為非技術讀者（客戶 / PM / 業務）看得懂的句子，輸出 `{WORKDIR}/changes-business.json`（結構完全相同，只改 impact 內容）。

## ★ 核心定義（最重要，先讀懂再改寫）

**「影響範圍」= 這次改動會「連帶影響到」哪些「其他」（沒被本 change 直接修改）的功能 / 頁面 / 流程 / 服務 / 資料消費者。**

你不是在「翻譯 worker 的句子成業務語言」 — 你是在做兩件事：

1. **保留 worker 寫的「下游連帶影響對象」**（例如 UserBehaviorLogList.vue / VipLevelService.methodClaimRewardById / events 表的其他 reader），把這些 class / method / file 名用 **i18n-lookup + 中英辭典 + change 上下文** 翻譯為業務名稱
2. **刪除任何「復述 change.title 或 change.subs」的句子** — 這些對讀者沒有價值（讀者已經看過 change 標題了）

### ❌ 必須刪除的 impact 句（這些是 change 復述）

> 寫完每條 impact，請拿 `change.title` + `change.subs` 對比；如果意思已經被涵蓋，**直接砍掉這條 impact**，不要保留。

例如 change.title = 「會員操作紀錄基礎建設端到端」，subs 已說「事件值放大為 64 位整數」：
- ❌「受影響的會員行為日誌資料表：事件金額欄位由 32 位整數放大為 64 位整數」← 復述 subs
- ❌「受影響的會員操作分類與狀態：行為大分類精簡為 VIP/遊戲/會員三大類」← 復述 subs
- ❌「新增後台會員操作日誌查詢 API，可依識別碼或會員 ID 查閱」← 復述 title

### ✅ 該保留並翻譯的 impact 句（這些是「**其他**」被連帶影響的）

如果 worker 寫了 `EventCategoryEnum 三個 enum 為 abu 後台「會員操作日誌查詢」分頁的下拉選項來源，rajah 砍掉的 enum 值會同步在 abu/platform/src/pages/risk/UserBehaviorLogList.vue 與 user_detail/UserDetailBehaviorLog.vue 重新生成`：

→ 翻譯為：「**[後端服務]** 連帶影響後台「會員操作日誌查詢」與「會員詳情 - 行為日誌」兩分頁：原本依賴的 50 多個狀態碼下拉選項，重新生成後僅保留 8 種；歷史紀錄中已被砍掉的狀態值會顯示為「未知」」

→ 這條保留了 **worker 抓到的具體 caller 業務名**（兩個分頁），用業務語言講清楚「下游會看到什麼變化」。

### 自我檢查（每條 impact 寫完後問三個問題）

1. **這條 impact 是不是 change.title 或 change.subs 已說的事？** → 是就刪掉
2. **這條 impact 有沒有具體點出「**其他**（非本次改動的）」頁面 / 服務 / 流程？** → 沒有就刪掉或補資訊
3. **讀者只看 change.title + change.subs，能不能猜到這條 impact？** → 能猜到就沒價值，刪掉

## 改寫規則

### 1. 移除技術詞彙

絕對不要出現：

- 任何 class 名（FooService、FooManager、FooHelper）
- 任何 method 名（methodGetXxx、handleRaw、addEventLog）
- 任何 table 名（events、user_quest_reward_records、agent_commission_invoice）
- 任何 enum 名（EventActionIdEnum、PlatformActionIdEnum、CharacterTypeEnum）
- 任何 repo 名（agrabah、rajah、abu、lago）
- 任何技術術語：composable、RPC、gRPC、schema、scaffold、骨架、契約、caller、callsite、cross-server、common.gen、handler、job、cron、redis、cache、migration、ORM、CRUD、TypeScript、Vue、import、export

### 2. 翻譯三大法寶（重點）

當原句出現任何技術詞時，**必須**用以下三種方法之一查到對應的業務說法後再改寫。直接憑直覺翻譯會出錯，不能憑感覺猜。

---

#### 法寶 A — i18n-lookup（查 enum / model / error / key 的多語顯示文字）

i18n-lookup 是這份 skill 與其他 skill 共用的腳本，能從 7 個前端專案 × 3 種語言的 localizations JSON 反查業務顯示文字。

```bash
# 查整個 enum 的所有值
bun /Users/user/aladdin/obsidian/skills/i18n-lookup/i18n-lookup.ts enum <EnumName>

# 查 enum 某個值的中文
bun /Users/user/aladdin/obsidian/skills/i18n-lookup/i18n-lookup.ts enum <EnumName> <value>

# 查 model 欄位
bun /Users/user/aladdin/obsidian/skills/i18n-lookup/i18n-lookup.ts model <model-name>

# 查 error code 文字
bun /Users/user/aladdin/obsidian/skills/i18n-lookup/i18n-lookup.ts error <code>

# 查 i18n key
bun /Users/user/aladdin/obsidian/skills/i18n-lookup/i18n-lookup.ts key <key>

# 列出所有支援的前端專案
bun /Users/user/aladdin/obsidian/skills/i18n-lookup/i18n-lookup.ts list-projects
```

**典型使用情境：**

- worker 句子裡寫 `EventCategoryEnum` 三組大幅縮減重整 → 跑 `i18n-lookup enum EventCategoryEnum` 看到顯示成「事件大分類」→ 改寫為「行為大分類項目大幅整理」
- worker 寫 `RewardRecordSearchStatusEnum` 新增黑名單值 → 跑 `i18n-lookup enum RewardRecordSearchStatusEnum stopApproval` 拿到「暫停審核」→ 寫「活動審核新增『暫停審核』狀態」
- worker 寫 `AgentWalletTransactionPlatformExportFieldEnum` 新增備註 → 跑 `i18n-lookup enum AgentWalletTransactionPlatformExportFieldEnum remark` 確認顯示為「備註」

---

#### 法寶 B — 中英對照辭典（查 server / service / model 的中文業務名）

辭典位置：`/Users/user/aladdin/obsidian/Rules/中英對照辭典.md`

涵蓋 agrabah 84 個 server 目錄項 + 338 個 service，含中文業務職責、對應前端 menu、相關 Obsidian 筆記。

```bash
# 查英文檔名 → 中文業務名
grep -A 5 "agent_back_office" /Users/user/aladdin/obsidian/Rules/中英對照辭典.md

# 查中文業務名 → server
grep -B 2 -A 5 "代理結算" /Users/user/aladdin/obsidian/Rules/中英對照辭典.md

# 查具體 service 對應
grep -B 1 -A 3 "AgentCommissionManagePlatformService" /Users/user/aladdin/obsidian/Rules/中英對照辭典.md
```

**典型使用情境：**

- worker 寫「WalletInternal 33 callers」→ 查辭典 `wallet` 找到對應業務名「錢包服務」→ 改寫為「受影響的會員與代理錢包」
- worker 寫「agent_settlement_job/processor/venture/commission.ts」→ 查辭典「合營結算」→ 改寫為「合營佣金結算流程」
- worker 寫「`risk_back_office` 新獨立 server」→ 查辭典 `risk_back_office` 看到「風控後台」→ 改寫為「後台風控（新獨立伺服器）」

---

#### 法寶 C — 從 change 本身的 title / subs 取線索（最後手段）

每條 change 本身已有「客戶可讀標題」（title）與「子項目」（subs），這些是上游業務分析者已經處理過的語言。

當 i18n-lookup / 辭典都查不到時，直接沿用 title / subs 的措辭即可。

**典型使用情境：**

- change.title = 「會員行為日誌查詢（新功能）」→ impact 裡只要說「會員行為日誌」即可，不要寫 `events 表` 或 `EventLogJob`
- change.subs 出現「綁定手機、QQ、實名」→ impact 裡可直接用這組詞，不用查 i18n
- change.tags 出現 `FAQ-3088` → impact 不需要重新解釋這個 FAQ 是什麼，沿用就好

---

### 3. 合併 repo 標籤（4 → 3 或 4）

把句首的標籤統一改為：

| 原標籤（worker 階段） | 新標籤（業務改寫後） |
| --- | --- |
| `**[後端 agrabah]**` | `**[後端服務]**` |
| `**[RPC 契約 rajah]**` | `**[後端介面]**` |
| `**[後台前端 abu]**` | `**[後台介面]**` |
| `**[玩家端 lago]**` | `**[玩家端 App]**` |

「後端服務」與「後端介面」差別：

- **後端服務**：實際業務邏輯／資料處理改動
- **後端介面**：對外契約變動，影響「上游呼叫端／前後端介接」
- 若兩者要表達同一件事（例如同一個會員行為日誌新增功能），**合併為 1 條「後端服務」即可**（多數情況都會合併）

### 4. 句子格式

- **長度**：1 句、≤ 60 字（保留具體 caller 業務名比短句重要）
- **句型**：`**[標籤]** 連帶影響 <非 change 直接修改的下游業務區域>：<下游會看到什麼差異 / 為什麼會被連帶影響>`
- **業務區域**：用客戶看得懂的中文，且必須**具體**（如「後台 VIP 設定頁與會員詳情頁」「合營佣金月結流程」「玩家端 App 充值入口」），**禁止**寫成「change 自己的業務區域」
- **下游差異**：強調「**非本次改動的功能** / 操作者會看到的差異」，不要描述 change 自己內部如何運作

### 5. 改寫範例（前 → 後）— ★ 新版以「連帶影響」為核心

**範例 1：** ✅ 保留 worker 抓到的下游 caller，翻譯為業務語言

```
原（worker）：**[RPC 契約 rajah]** EventCategoryEnum 等三個 enum 為 abu 後台「會員操作日誌查詢」分頁的下拉選項來源，rajah 砍掉的 enum 值會同步在 abu/platform/src/pages/risk/UserBehaviorLogList.vue 與 user_detail/UserDetailBehaviorLog.vue 重新生成
查詢：i18n-lookup model UserBehaviorLog / 中英辭典查 UserBehaviorLogList → 後台「會員操作日誌查詢」分頁；user_detail 對應「會員詳情 - 行為日誌」
改寫：**[後端服務]** 連帶影響後台「會員操作日誌查詢」與「會員詳情 - 行為日誌」分頁：原本依賴的 50 多個狀態碼下拉選項，重新生成後僅保留 8 種；歷史紀錄中已被砍掉的狀態值會顯示為「未知」
```

**範例 2：** ✅ 跨 server caller 翻譯

```
原（worker）：**[後端 agrabah]** AppUserInternal.GetUserLastDeviceInfo 簽名由 (userId) → (platformId, userId)，event_log Job 第 46 行與 activity quest base method 第 476 行需傳新參數
查詢：中英辭典 event_log / activity quest → 「會員行為日誌寫入排程」與「活動任務進度結算」
改寫：**[後端服務]** 連帶影響會員行為日誌寫入排程與活動任務進度結算：兩者呼叫會員裝置查詢時必須帶上平台代號，跨平台會員的裝置紀錄會分開呈現
```

**範例 3：** ❌ 砍掉復述 change.title/subs 的句子

```
change.title = 「會員操作紀錄基礎建設端到端」
change.subs 包含「事件值由 32 位整數放大為 64 位整數」
原（worker）：**[後端 agrabah]** 受影響的事件 events 表：value 欄位由 INT32 放大為 INT64
判定：這是 subs 已說的事，且沒有點出「**其他** 被影響者」 → 直接砍掉
正確做法：補抓 events 表「**其他** reader」，例如改寫為
改寫：**[後端服務]** 連帶影響 VIP 領獎統計、活動完成查詢、風控 daily summary 等 8 個 events 表讀取路徑：上游消費端若以 32 位整數解碼大金額會發生溢位
```

**範例 4：** ✅ 合併重複的下游 caller（worker 在 agrabah / rajah 各寫一句指同一件事）

```
原 1（agrabah worker）：**[後端 agrabah]** GetUserLastDeviceInfo 在 event_log Job 與 activity quest 共 2 個非本次改動的 caller
原 2（rajah worker）：**[RPC 契約 rajah]** AppUserInternal.GetUserLastDeviceInfo 簽名變更，所有 client 需重新生成 .gen
合併後：**[後端服務]** 連帶影響會員行為日誌寫入排程與活動任務進度結算：兩者呼叫會員裝置查詢時必須帶上平台代號
```

**範例 5：** N/A 改寫

```
原：N/A — 純 abu 單頁前端文案調整，不涉及後端或跨頁共用元件
改：N/A — 僅單一頁面文字微調，不影響其他功能
```

**範例 6：** 找不到對應 commit

```
原：（4 個 repo 皆無對應 commit；推測為純文件 / 配置 / i18n 變更）
改：N/A — 此項在原始程式碼中未找到對應改動，可能為文件 / 設定調整
```

**範例 7：** 自閉迴圈（worker 找了 caller 但發現 caller 全都在本次 commit 內）

```
原：**[後端 agrabah]** 本 commit 唯一的 caller 是同 commit 內新增的 service handler，無其他連帶影響
改：N/A — 此改動為自閉迴圈，沒有其他功能會被連帶影響
```

## 工作流程

1. **讀** `{WORKDIR}/changes-with-impact.json`（含 N 條 changes 與 worker 寫的 impact）
2. **遍歷**每條 change：
   - 對 `change.impact` 陣列每條句子做**「保留 caller / 砍復述」** 處理：
     - **保留**：worker 寫的具體下游 caller / consumer（class / method / file 名），用 i18n-lookup + 辭典翻譯為業務名稱
     - **砍掉**：與 change.title 或 change.subs 重複描述 change 自己做了什麼的句子
   - 改寫過程中遇到任何不確定的英文名，**先**用 i18n-lookup → 辭典 → title/subs 三步驟查業務名，再下筆
   - 同 change 內標籤相同（或合併後相同）且語意重複的句子，**合併**為 1 條
   - 每條 change 改寫後的 impact 陣列長度 1-5（保留資訊量但避免冗長）
   - 若該 change 的 impact 全部都是 change 復述（沒有真實下游 caller 資訊）→ 改寫為 1 條 `N/A — 此改動為自閉迴圈，沒有其他功能會被連帶影響`
3. **寫**輸出到 `{WORKDIR}/changes-business.json`，保留原檔的所有欄位（versions / lago / other / changes），僅替換每條 change 的 `impact` 內容

## 額外驗證（v3 重點 — 不只看技術詞，還要看是否復述 change）

除了原本的「technical word」驗證，再加一個「impact 是否復述 change.title/subs」抽樣檢查：

```bash
node -e "
const d = require('{WORKDIR}/changes-business.json');
let likelyDuplicate = 0;
for (const c of d.changes) {
  for (const s of (c.impact || [])) {
    // 簡單啟發：如果 impact 句子的關鍵詞（去掉標籤後）幾乎全部出現在 title + subs，就疑似復述
    const cleanedImpact = s.replace(/\*\*\[[^\]]+\]\*\*/g, '').trim();
    const corpus = (c.title + ' ' + (c.subs || []).join(' ')).toLowerCase();
    const tokens = cleanedImpact.split(/[\s，：；。、（）()]+/).filter(t => t.length >= 2);
    const overlap = tokens.filter(t => corpus.includes(t.toLowerCase())).length;
    if (tokens.length >= 4 && overlap / tokens.length > 0.7) {
      console.log('idx', c.idx, '疑似復述:', s);
      likelyDuplicate++;
    }
  }
}
console.log('total likely duplicate:', likelyDuplicate);
"
```
理想狀態：likely duplicate < 10%（亦即至少 90% 的 impact 句帶有 change 之外的新資訊）。

## 完成標準

- 137 條 change 全部處理完，沒有遺漏
- 抽 5 條人工檢視，確認無任何技術詞彙殘留
- 每條 impact 陣列至少 1 條，最多 5 條
- repo 標籤只剩 4 種：`後端服務` / `後端介面` / `後台介面` / `玩家端 App`（多數情況「後端介面」會合併進「後端服務」）
- 驗證指令（必須輸出 `total bad: 0`）：

  ```bash
  node -e "
  const d = require('{WORKDIR}/changes-business.json');
  const TECH = /agrabah|rajah|\babu\b|\blago\b|composable|gRPC|\bRPC\b|enum|schema|scaffold|骨架|契約|callsite|caller|common\.gen|handler|cron|redis|cache|migration|ORM|CRUD|Vue|TypeScript|\.ts\b|\.vue\b|Service|Manager|Method|Helper|Job/;
  let bad = 0;
  for (const c of d.changes) {
    if (!Array.isArray(c.impact)) { console.log('MISSING impact:', c.idx); bad++; continue; }
    for (const s of c.impact) {
      if (TECH.test(s)) { console.log('TECH WORD in idx', c.idx, ':', s); bad++; }
    }
  }
  console.log('total bad:', bad, '/ total impact lines:', d.changes.reduce((s,c)=>s+(c.impact||[]).length,0));
  "
  ```

## 嚴格限制

- 禁止修改任何 source code
- 禁止讀 `localizations/*.json`（用 i18n-lookup 腳本查）
- 寫出時保持 JSON 格式正確、保留 idx / ver / type / leaves / title / subs / tags 全部欄位
- **嚴禁憑感覺猜業務名**：所有技術詞翻譯都要走 i18n-lookup 或辭典；查不到時才退回 title / subs 沿用
