---
description: 對指定一級菜單下的權限節點進行純程式檢查（只比對 abu 與 rajah，不檢查策劃書）
argument-hint: <英文 menu key + 中文一級菜單名，例如 GameMenu遊戲管理>
allowed-tools: Read, Grep, Glob, Bash
---

# 權限節點純程式檢查（/permission-check）

請你擔任這個專案的「Abu Platform 權限節點檢查助手」，根據指定的一級菜單範圍，檢查 `abu/platform` 與 `rajah` 的權限節點設置是否自洽。

## 檢查目標

這個指令只做**程式碼層**的權限節點檢查，不檢查策劃書，不需要使用者額外提供黃金標準清單或角色權限頁現況。

這個指令要回答的是：

1. `Abu` 指定一級菜單範圍下，實際使用了哪些權限節點
2. `rajah` 在 `abu/platform` 可見範圍內，實際定義了哪些相關權限節點
3. 兩邊是否有不合理差異

這次只檢查：
- `abu/platform`
- 不檢查 `abu/admin`

## 共同規則來源

開始前請先理解：

- `.claude/rules/permission-rule.md` — 權限檢查共同口徑
- `rajah/CLAUDE.md` — `@Permission` 綁定規則的單一真實來源
- `abu/CLAUDE.md` — Abu 權限消費方式與 menu / 頁面結構

若上述三份文件內容有衝突：
- 權限綁定與 `@Permission` 是否生效，以 `rajah/CLAUDE.md` 為準
- 權限檢查流程與範圍口徑，以 `.claude/rules/permission-rule.md` 為準
- Abu 頁面 / menu / `hasPermission()` 的消費方式，以 `abu/CLAUDE.md` 為準

## 前置檢查

開始正式檢查前，先確認目前 workspace 內存在：

- `.claude/rules/permission-rule.md`

若不存在：

1. 立即停止，不要繼續做後續檢查
2. 明確提示使用者：
   - 缺少必要規則檔：`.claude/rules/permission-rule.md`
   - 這個 command 本身不會自動帶入 `rules`
   - 請先同步 Lamp 的共用 rules 到目前 workspace，再重新執行

可使用的提示文案：

```md
缺少必要規則檔：`.claude/rules/permission-rule.md`

這個 command 不會自動帶入 Lamp 的共用 rules。
請先將 Lamp 的共用 rules 同步到目前 workspace，再重新執行本 command。
```

## 讀檔約束（重要）

本任務只讀取純程式檢查所需範圍，避免無關探索。

### 允許讀取

- `.claude/rules/permission-rule.md`
- `rajah/CLAUDE.md`
- `abu/CLAUDE.md`
- `abu/platform/rajah/project.json`
- `abu/platform/src/menu.ts`
- `abu/platform/src/pages/**`
- `abu/common/**` 中被本次一級菜單頁面實際引用，且屬於本菜單範圍的子檔
- `rajah/services/**/*.rajah` 中，屬於 `abu/platform/rajah/project.json` 範圍的 service 區塊

### 禁止讀取

- `doc/golden-spec-2026-05-06.md/**` — 本指令不檢查規格
- `abu/admin/**`
- 任何 `generated/` 目錄
- 與本次一級菜單無關的頁面、元件、service 區塊
- `.rajah` 檔案中的 `model`、`enum` 區塊

## 本次檢查的一級菜單

`$ARGUMENTS` 必須是「**英文 menu key + 中文一級菜單名**」直接串接的字串，例如：

- `GameMenu遊戲管理`
- `ReportMenu報表分析`
- `BonusCenterMenu優惠中心`

### 解析規則

- **英文部分**：從字串開頭起連續的 `[A-Za-z]+` 字元，必須是 `abu/platform/src/menu.ts` 中的一級菜單變數名
- **中文部分**：英文部分之後連續的中文字元，作為本次輸出的中文菜單名稱

### 嚴格驗證

任何一項失敗就列出錯誤後立即停止，不繼續往下檢查：

1. **格式驗證**
   - `$ARGUMENTS` 不可為空
   - 不可含空白
   - 必須符合「英文 + 中文」順序

2. **英文 menu key 驗證**
   - 用 `Grep "^const <英文部分>: MenuGroup" abu/platform/src/menu.ts` 必須找到至少一筆匹配

3. **中文部分驗證**
   - 不做策劃書驗證
   - 只要求中文部分存在，並在最終輸出中使用

## 你必須先理解的規則

### 1. Abu 不定義權限節點，只消費權限節點

- `rajah` 的 `@Permission` 是權限節點來源
- `abu/platform` 只透過 `menu.ts` 與 `hasPermission()` 等方式使用權限 key
- **不能因為前端寫了字串，就假設該權限合法**

### 2. 檢查單位是一級菜單

- 每次只檢查一個一級菜單
- 所有頁面、彈窗、子組件、helper、composable 的納入與排除，都要以該一級菜單為邊界

### 3. 結構節點不一定是實質異常

- `Ops`、`Status`、`Setting`、`Share` 等節點，常常只是由 `.` 展開形成的中間樹節點
- 如果它沒有被 `menu.ts`、`hasPermission()` 或有效 `@Permission` 精確使用，通常不算實質異常
- 但若它本身被精確使用或精確定義，仍要視為實質節點

### 4. Rajah 範圍以前綴為入口，不以 service 名稱為入口

- 先由 Abu 收集本次一級菜單範圍下的權限節點與前綴
- 再回到 `rajah/services/**/*.rajah` 搜尋相同前綴的 `@Permission`
- `service` 只是結果，不是入口
- 不要先猜「應該是哪幾個 service」

## 你的檢查流程

### Step 1. 鎖定 Abu 檢查範圍

根據 `abu/platform/src/menu.ts`：

1. 找出本次指定一級菜單下面的所有二級 / 三級菜單
2. 找出這些菜單對應的主頁面
3. 遞迴找出主頁面引用的彈窗 / 子組件 / composable / helper
4. 只納入「實際屬於該一級菜單」的檔案
5. 若某檔是跨模組共用元件，原則上排除；但若其中有本菜單實際使用的 `hasPermission()`，仍要納入
6. 也納入主頁面透過 `router.push`、`router-link`、彈窗流程或明確頁面跳轉所到達的本菜單專用頁面，即使該頁面沒有直接寫在 `menu.ts`

### Step 2. 收集 Abu 實際使用的權限節點

請分成兩類整理：

1. **menu.ts 菜單節點**
   - 一級 / 二級 / 三級菜單上的 permission key

2. **頁面 / 子檔權限節點**
   - 來自本次檢查範圍檔案中的 `hasPermission("...")`
   - 以及其他等價的權限傳遞方式

如果某個頁面只有菜單節點、沒有額外 `hasPermission()`，要明確註明：
- `未發現額外操作權限節點`

### Step 3. 收集 Rajah 實際定義的相關權限節點

#### Step 3.1 先確定 Abu Platform 可見範圍

1. 讀取 `abu/platform/rajah/project.json`
2. 取得：
   - `rajahClientFilenames`
   - `rajahClientServiceGroups`

只檢查這兩者交集下，`abu/platform` 真正可見的權限節點。

#### Step 3.2 以前綴搜尋 Rajah

1. 從 Step 2 收集到的 Abu 節點，整理出本次一級菜單的權限前綴
2. 在 `rajah/services/**/*.rajah` 中搜尋同前綴的 `@Permission`
3. 只保留：
   - 檔案在 `rajahClientFilenames` 範圍內
   - service 在 `rajahClientServiceGroups` 範圍內

#### Step 3.3 只讀 service 區塊

`.rajah` 檔案中只有 `service` 區塊內可能出現 `@Permission`，不要讀整個檔案。

建議流程：

1. `Grep "^service " <file> -n` 取得所有 service 起始行
2. `Grep "^}" <file> -n` 取得 top-level closing brace 行
3. 配對出各 service 區塊範圍
4. 只 `Read` 相關 service 區塊

#### Step 3.4 判定哪些 `@Permission` 真的有效

對每個 `@Permission`，依 `rajah/CLAUDE.md` 的「權限節點（@Permission）綁定規則」判斷：

- 是否會真的進入前端權限樹
- 是菜單 / placeholder 節點，還是 API / 操作節點
- 是否屬於可能被靜默丟棄的情況

### Step 4. 比對 Abu 與 Rajah

請至少整理出以下幾類差異：

1. `Abu` 有、`Rajah` 沒有
2. `Rajah` 有、`Abu` 沒有
3. 疑似中間樹節點
4. 疑似舊節點 / 冗餘節點

若有不確定的節點，不要直接下結論，請標記：
- `可疑`
- 並附上理由

## 你要輸出的結果格式

請用下面格式輸出，務必清楚分段：

### 一、這次檢查範圍

- 一級菜單名稱（英文 + 中文）
- `menu.ts` 對應的二級 / 三級菜單
- 這次納入檢查的頁面檔案
- 這次納入檢查的非共用子檔案
- 這次對應到的 rajah 檔案與 service
- 若某些檔案 / service 雖然搜尋到，但不在 `project.json` 範圍內，也請簡短註明「不納入檢查」

### 二、Abu Platform 目前實際使用的權限節點

分成：
- `menu.ts` 菜單節點
- 頁面 `hasPermission` 節點

### 三、Rajah 目前實際定義的相關權限節點

分成：
- 菜單 / placeholder 節點
- API / 操作節點

### 四、差異分類

請列出：

- `Abu` 有，但 `Rajah` 沒有的
- `Rajah` 有，但 `Abu` 沒有的
- 疑似中間樹節點
- 疑似舊節點 / 冗餘節點
- 可疑但暫時無法定論的

### 五、結論

請給出一句話結論，例如：

- 合理，未發現實質差異
- 不合理，前端有使用但 Rajah 未定義
- 不合理，Rajah 有殘留或疑似舊節點
- 大致合理，僅有中間樹節點差異

## 分析時的重要原則

- 不要把 `Abu` 寫過的權限字串直接視為正確答案
- 不要只看 `menu.ts` 就認定那是一級菜單的全部權限節點
- 不要把 `abu/admin` 的內容混進來
- 不要把 `project.json` 範圍外的 Rajah 節點算進來
- 不要把 `service` 命名當成檢查入口，權限前綴才是入口
- 若某節點只存在於 Rajah，但 Abu 完全沒用，也要列出
- 若某節點只存在於 Abu，但 Rajah 沒有對應，也要列出
- 若差異看起來只是中間樹節點，請明確說明理由
- 此命令僅讀取與報告，不修改任何檔案

---

開始檢查。
