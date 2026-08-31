# impact-agent-instructions — 影響範圍分析 worker 指令

供 v2 流程 Stage 5「影響範圍分析」的並行 worker 使用。Manager 派工 12 個 worker（4 repos × 3 versions），每個 worker 拿一份此指令 + 4 個參數（REPO / VER / BRANCH / BASE）。

> **路徑慣例**：以下用 `{WORKDIR}` 代表本次執行的工作目錄，預設為 `/tmp/changelog/v2/`。Manager 派工前需先把 `input-<VER>.json`（從 changes.json 按 ver 過濾後的子集）放到 `{WORKDIR}`。

---

## 你的任務

為指定的 (REPO, VER) 區段，補上每條變更的「影響範圍」欄位，產出 JSON。

## ★ 核心定義（最重要，先讀懂再開工）

**「影響範圍」= 這次改動會「連帶影響到」哪些「其他」（沒被這個 commit 直接修改）的功能 / 頁面 / 流程 / 服務 / 資料消費者。**

讀者拿到 changelog 想問的是：
- 「除了 change 標題說的那個頁面，這次改動還會讓哪些**現有**功能出現變化？」
- 「我用的某個功能會不會因這次改動而變樣？」
- 「我的下游 ETL / 報表 / 串接會不會因這次改動而中斷？」

所以你要找的是 change **直接改動之外** 的 caller / consumer / 跨頁共用使用者 / 跨 server gRPC client / 共用 schema 消費者。

### ❌ 禁止寫的 impact（這些是 change 自己已經做的事，會被重複）

- 「新增 XX 後台 API」← title 已經說了
- 「上述動作補上行為埋點」← subs 已經說了
- 「資料表欄位 32 → 64 位元放大」← 是 change 內容本身
- 「新增功能：列表 / 新增 / 編輯 / 啟用 / 取消」← change 自己內容
- 「精簡為 VIP / 遊戲 / 會員三大類」← change 自己描述

### ✅ 該寫的 impact（這些是「**其他**」被連帶影響的）

- 「後台會員行為日誌列表（abu UserBehaviorLogList.vue）下拉選單原本有 11 大類，重新生成後變 3 大類，原本依賴舊大類的搜尋查詢會失效」
- 「VipLevelService.methodClaimRewardById 等 5 個未在本次直接改動的 method 因 events 表 value 欄位放大，現有寫入路徑會自動使用 64 位整數」
- 「跨 server 呼叫 GetUserLastDeviceInfo 的 event_log Job 與 activity quest base method 必須跟著傳入新增的 platformId 參數，否則執行失敗」
- 「依賴舊 EventStatusCodeEnum 50 多個失敗碼的下游報表 / 稽核紀錄會找不到對應狀態」

### 二者的辨識方法

每寫一句 impact 後問自己兩個問題：
1. **這個被影響的對象，是 change 直接改的程式 / 頁面嗎？** 如果是 → 砍掉重寫
2. **如果讀者只看 change.title + change.subs，他能不能猜到這條 impact？** 如果能 → 這條 impact 沒價值，刪掉

## 範圍規則（只分析這兩種，其他統一寫 N/A）

1. **後端改動**：agrabah 程式碼變更；rajah `.rajah` 契約變更
2. **跨模組改動**：abu / lago 中跨多個頁面共用的 composable / shared component / type 變更（被 ≥ 2 個頁面 import）

下面這些一律標 N/A：

- 純單頁 UI 改動（如某頁面新增一個按鈕、樣式微調、暗黑模式對單頁的顏色變化）
- 純 i18n key 增改
- 純 lint / refactor / 型別搬移
- 純前端文案調整、純彈窗加大、純 placeholder 文字
- 工具函式抽取（如果只在本 module 用）
- **找不到任何「非 change 直接修改」的下游** → 視同 N/A，寫「N/A — 此改動為自閉迴圈，沒有其他功能會被連帶影響」

## 輸入與輸出

- 輸入：`{WORKDIR}/input-<VER>.json`
  陣列，每筆 `{idx, type, leaves, title, subs, tags}`
- 輸出：`{WORKDIR}/impact-<REPO>-<VER>.json`
  Schema：`{ "results": [ { "idx": <number>, "impact": [<string>, ...] } ] }`
- impact 陣列：1-5 條短句，**找不到下游或屬於 N/A 範圍時也要寫一條**，不能省略
- 必須涵蓋 input 全部 idx；缺一視為失敗

## 工作流程

### 步驟 1 — 切目錄

```
cd /Users/user/aladdin/<REPO>
```

### 步驟 2 — 取本版次 commit list

```
git log --no-merges --format='%h %s' origin/<BASE>..origin/<BRANCH>
```

把這份結果存著當索引；後面對每條 change 都會用 title/subs 關鍵字回查。

### 步驟 3 — 對每條 change 處理

```
for change in input-<VER>.json:
  1. 用 title / subs 的關鍵字（FAQ 編號、英文名、業務詞）grep 上面 commit list
  2. 對找到的 commits：git show --stat <hash> 取得檔案清單
  3. 判斷是否屬於「分析範圍」（見上方規則）
     - 不屬於 → impact = ["N/A — <一句話原因>"]
     - 在本 repo 找不到對應 commit → impact = ["在 <REPO> 找不到對應 commit（可能屬於其他 repo）"]
     - 屬於 → 進步驟 4
  4. 取得呼叫鏈（見下方分支）
  5. 整理 2-5 條 impact 句子
```

### 步驟 4 — 找「下游連帶影響對象」（這是分析的核心 — 重點：找的是非本次 commit 直接修改的東西）

#### 4a. REPO = agrabah（後端）

- 從 diff 找出**本 commit 修改**的 service class + method（這部分**不寫進 impact**，是「自己」）
- 跑 method-call-graph 找**非本 commit 修改**的 caller：
  ```
  bun /Users/user/aladdin/aladdin_ai/skills/method-call-graph/call-graph-scanner.ts local <ServiceClass>.<method>
  ```
  output 中**移除**本次 commit 內變動過的檔案，剩下的才是真正「連帶影響」對象。
- 若該 method 是 RPC handler，加跑：
  ```
  bun /Users/user/aladdin/aladdin_ai/skills/method-call-graph/call-graph-scanner.ts cross <ServiceClass>.<method>
  ```
- 若該 commit 動了 DB table 結構 / enum / 共用 schema，跑：
  ```
  bun /Users/user/aladdin/aladdin_ai/skills/method-call-graph/call-graph-scanner.ts table <table_name>
  ```
  特別注意「**讀**這張表 / 用這個 enum 的其他 service」← 這些就是「下游消費者」
- 解析輸出：列出**真正屬於「其他人」** 的 caller / consumer / table reader

#### 4b. REPO = rajah（RPC 契約）

- 從 diff 找出修改的 `.rajah` service + method / enum / model
- 跑：
  ```
  bun /Users/user/aladdin/aladdin_ai/skills/method-call-graph/call-graph-scanner.ts cross <ServiceClass>.<method>
  ```
- 列出：
  - 哪些後端 server 透過 gRPC client 呼叫這個 method（**這些 client 端如果沒在本次 commit 內被更新就會壞掉**）
  - 哪些前端 .gen 檔案有用到（用 grep）；grep 結果中的 .vue 才是真正受影響的頁面
- **enum 移除值的特殊重點**：grep 整個 agrabah / abu / lago codebase 是否有人引用被移除的 enum value name，那些引用點就是 break 處

#### 4c. REPO = abu / lago（前端）

- 從 diff 找出檔案路徑
- **只關心**這四類：
  - `src/composables/**`
  - `src/components/common/**` 或 `src/shared/**`
  - `src/types/**`
  - `src/utils/**`（且被多個頁面 import）
- 對符合的檔案，grep 找它被哪些**非本次 commit 修改**的 .vue / .ts 檔案 import：
  ```
  cd /Users/user/aladdin/<REPO>
  basename=$(basename <changed_file> .ts)
  grep -rln "from.*${basename}'" src/ --include='*.vue' --include='*.ts' 2>/dev/null | grep -v "<changed_file>" | head -30
  ```
- 受影響檔案 < 2（且都在本 commit diff 內）→ N/A — 自閉迴圈
- ≥ 2 → 從路徑反推業務頁面名稱
- **特別陷阱**：DataTable / PageContent / PropertyFieldEdit 這類「**超共用元件**」即使被 100+ 頁面 import，本次 commit 通常只動了一個小行為（例如預設標題改成「操作」）→ 寫一句總結「影響後台所有列表頁的操作欄預設文字」即可，**不要陷入逐頁列舉**

### 步驟 5 — 整理 impact 句子（★ 必讀句型規則）

> 本階段 worker 輸出可以包含 class / method / table / enum 名，因為 **Stage 6 業務改寫 agent** 會用 i18n-lookup + 中英辭典統一翻譯。worker 只要忠實反映「真實連帶影響鏈」即可。

#### ★ 句型模板（從舊版「受影響的 X」改為新版「連帶影響 X」）

- **正例句型**：`**[<repo>]** 連帶影響 <非本次 commit 修改的下游>：<他們會看到什麼差異>`
- **句子要回答**：「**誰**（不是 change 本身）會因這次改動而變樣？變樣的具體形式是什麼？」
- 標籤一律用：`**[後端 agrabah]**` / `**[RPC 契約 rajah]**` / `**[後台前端 abu]**` / `**[玩家端 lago]**`

#### 寫完每條後自我檢查（兩問題）

1. **「這個被影響的對象，是 change 直接改的程式 / 頁面嗎？」** 如果是 → 砍掉重寫
2. **「如果讀者只看 change.title + change.subs，他能不能猜到這條 impact？」** 如果能 → 沒價值，刪掉重寫

#### 句子範例對比

| ❌ 舊風格（復述 change） | ✅ 新風格（連帶影響） |
| --- | --- |
| 受影響的會員行為日誌查詢頁：新增後台會員操作日誌查詢 API | 連帶影響後台會員詳情頁與風控管理頁：兩處的會員行為日誌彈窗會跟著新 API 的回傳結構顯示新欄位（platformId / 動作分類） |
| 受影響的會員行為日誌資料表：欄位由 32 位整數放大為 64 位整數 | 連帶影響 EventLogJob 之外的 8 個 events 表讀取點（VIP 領獎統計、活動完成查詢、風控 daily summary）：原本以 INT32 解碼大金額會發生溢位，需確認上游消費端是否已換成 INT64 解碼 |
| 受影響的會員操作分類：行為大分類精簡為 VIP／遊戲／會員三大類 | 連帶影響後台「會員行為日誌查詢」與「會員詳情 - 行為日誌」兩分頁：原本 11 個分類下拉重新生成後變 3 個；歷史資料中為已移除 enum 值的紀錄會顯示為「未知」；風控規則若有指向被移除的 enum 值會失效 |

#### 例外句子

- 找不到下游：「N/A — 此改動為自閉迴圈，沒有其他功能會被連帶影響」
- 在本 repo 找不到 commit：「在 <REPO> 找不到對應 commit（可能屬於其他 repo）」
- 純單頁前端 / i18n：「N/A — <一句話原因>」

## 嚴格限制

- 禁止修改任何程式碼（只能讀 + 跑 method-call-graph 腳本 + grep）
- 禁止 `git push` / `git checkout` / `git reset` / `git rebase`（可以 `git log` / `git show` / `git diff`）
- **嚴禁編造**：只能列從 method-call-graph 輸出或 grep 輸出中真實看到的 caller / 受影響檔案
- 禁止讀 `localizations/*.json`（i18n 規範）

## 完成標準

- `impact-<REPO>-<VER>.json` 必須涵蓋 `input-<VER>.json` 的全部 idx
- 每個 idx 的 impact 陣列至少 1 條，最多 5 條
- 若回報的句子提到具體頁面 / 方法，要真的有跑過 method-call-graph 或 grep 才能寫
- 完成後執行驗證：
  ```bash
  node -e "
  const r=require('{WORKDIR}/impact-<REPO>-<VER>.json');
  const i=require('{WORKDIR}/input-<VER>.json');
  console.log('input='+i.length+' output='+r.results.length+' missing='+i.filter(x=>!r.results.find(y=>y.idx===x.idx)).map(x=>x.idx).join(','));
  "
  ```
  確認 missing 為空才算完成

## 輸出範例

```json
{
  "results": [
    {
      "idx": 23,
      "impact": [
        "**[後端 agrabah]** 連帶影響合營代理充值頁（agent_back_office）：分享同一個充值通道列表 method，新增匯入幣別欄位後該頁下拉選項會多出新欄位",
        "**[後端 agrabah]** 連帶影響會員儲值通道（payment_back_office、payment_app）：上游 6 個非本次改動的 callsite 取回 list 時會多出該幣別欄位，需確認展示層是否能處理多幣別"
      ]
    },
    {
      "idx": 24,
      "impact": ["N/A — 純 abu 單頁前端文案調整，不涉及後端或跨頁共用元件"]
    },
    {
      "idx": 25,
      "impact": ["在 agrabah 找不到對應 commit（可能屬於其他 repo）"]
    },
    {
      "idx": 26,
      "impact": ["N/A — 此改動為自閉迴圈，沒有其他功能會被連帶影響"]
    }
  ]
}
```
