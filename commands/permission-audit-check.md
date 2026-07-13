---
description: 對指定一級菜單下的權限節點進行程式加規格切片檢查（abu / rajah / 使用者提供切片）
argument-hint: <英文 menu key + 中文一級菜單名，例如 GameMenu遊戲管理>
allowed-tools: Read, Grep, Glob, Bash
---

# 權限節點程式加規格切片檢查（/permission-audit-check）

請你擔任這個專案的「Abu Platform 權限節點檢查助手」，根據指定的一級菜單範圍，檢查 `abu/platform` 與 `rajah` 的權限節點設置是否合理，並額外比對使用者提供的策劃書權限節點切片。

## 檢查目標

這個指令同時做兩件事：

1. 做和 `/permission-check` 相同的**純程式檢查**
2. 將使用者提供的**規格切片**納入比對，確認這段規劃是否已落到程式碼

這個指令要回答的是：

1. `Abu` 指定一級菜單範圍下，實際使用了哪些權限節點
2. `rajah` 在 `abu/platform` 可見範圍內，實際定義了哪些相關權限節點
3. 使用者提供的規格切片，是否能在 `Abu` 與 `rajah` 範圍內找到對應
4. 哪些差異屬於真缺漏，哪些只是中間樹節點或命名落差

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

## 讀檔約束

本任務只讀取程式檢查與規格切片比對所需範圍，避免無關探索。

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

- `doc/golden-spec-2026-05-06.md/**` — 本指令不讀整份黃金標準
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
   - 不做整份 spec 驗證
   - 只要求中文部分存在，並在最終輸出中使用

## 使用者輸入規格切片的規則

你必須主動向使用者索取一段「策劃書上的權限節點切片」再開始做切片比對。

請主動詢問：

`請貼上這次要檢查的策劃書權限節點切片，必須包含明確的一級 / 二級 / 三級路徑，且一次只提供單一路徑主題。`

### 合法輸入要求

規格切片必須同時符合以下條件：

1. **必須包含明確層級路徑**
   - 至少要能辨識一級 / 二級 / 三級菜單歸屬
   - 即使某層沒有 checkbox，只要層級清楚也可接受

2. **必須是單一路徑主題**
   - 一次只接受單一主題分支
   - 例如：`會員管理 > VIP管理 > 節假日獎勵`
   - 不可同時混入多個不同二級或三級分支

3. **必須能落在本次一級菜單之下**
   - 若切片內容顯然屬於其他一級菜單，必須指出並停止

### 合法輸入範例

```markdown
- [ ] 會員管理
  - [ ] VIP管理
    - [ ] 節假日獎勵
      - [ ] VIP節慶獎勵設置 (新增/編輯/複製)
      - 狀態
        - [ ] 開關
      - 操作
        - [ ] 清除紀錄
        - [ ] 刪除
```

### 驗證失敗時的處理

若切片不符合規則，請明確說明原因並停止，不要自行猜測或切分。例如：

- 缺少明確層級路徑
- 同時混入多個主題分支
- 不屬於這次指定的一級菜單

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

### Step 4. 解析使用者提供的規格切片

你要把使用者提供的 markdown / checklist 切片，轉成一份扁平化的「預期權限節點集合」。

處理原則：

1. 先辨識切片中的一級 / 二級 / 三級菜單路徑
2. 再辨識葉節點中的操作語意，例如：
   - 新增
   - 編輯
   - 刪除
   - 匯出
   - 開關
   - 操作底下的子功能
3. 將這段切片轉成「這次應該被檢查的預期節點集合」

**注意**：
- 你要做的是「切片比對」，不是替整份策劃書補全
- 只檢查使用者提供的那一段
- 若某個規格名稱和程式命名不完全一致，但語意高度一致，可標成：
  - `可能對應`
  - 並附理由

### Step 5. 比對三份資料

請交叉比對：

1. Abu 實際使用節點
2. Rajah 實際定義節點
3. 使用者提供切片轉換出的預期節點集合

至少整理出以下幾類差異：

1. `Abu` 有、`Rajah` 沒有
2. `Rajah` 有、`Abu` 沒有
3. 切片有、`Abu` 沒有
4. 切片有、`Rajah` 沒有
5. 疑似中間樹節點
6. 疑似舊節點 / 冗餘節點

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

### 四、規格切片轉換出的預期節點

- 列出這次切片對應出的扁平節點集合
- 若某些節點只能做到語意對應、無法完全確定命名，請標 `可能對應`

### 五、差異分類

請列出：

- `Abu` 有，但 `Rajah` 沒有的
- `Rajah` 有，但 `Abu` 沒有的
- 切片有，但 `Abu` 沒有的
- 切片有，但 `Rajah` 沒有的
- 疑似中間樹節點
- 疑似舊節點 / 冗餘節點
- 可疑但暫時無法定論的

### 六、結論

請給出一句話結論，例如：

- 合理，切片要求已大致落地
- 不合理，前端有使用但 Rajah 未定義
- 不合理，切片要求在程式中缺漏
- 大致合理，僅有中間樹節點或命名落差

## 分析時的重要原則

- 不要把 `Abu` 寫過的權限字串直接視為正確答案
- 不要只看 `menu.ts` 就認定那是一級菜單的全部權限節點
- 不要把 `abu/admin` 的內容混進來
- 不要把 `project.json` 範圍外的 Rajah 節點算進來
- 不要把 `service` 命名當成檢查入口，權限前綴才是入口
- 不要把使用者提供的切片，自動擴充成整份規格
- 若切片有命名語意但程式命名不同，請先標示語意對應，不要直接判死刑
- 若某節點只存在於 Rajah，但 Abu 完全沒用，也要列出
- 若某節點只存在於 Abu，但 Rajah 沒有對應，也要列出
- 若差異看起來只是中間樹節點，請明確說明理由
- 此命令僅讀取與報告，不修改任何檔案

---

開始檢查。
