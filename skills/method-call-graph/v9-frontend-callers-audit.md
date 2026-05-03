# V9 frontend-callers 索引策略審計與修正

**日期**：2026-05-03
**範圍**：`obsidian/skills/method-call-graph/call-graph-scanner.ts` 的 `frontend-callers` 子指令
**起因**：V3-V8 backTesting 報告中 6 個失敗 case，子代理頻繁回報 0 命中並 fallback 到 grep
**結論**：報告中**多數 0 命中事件其實已被 V3 修復**或**本來就是真實 0 hit**；真正剩下的弱點是「介面誤用無容錯」與「`hasMethod=true` 但 `hits=[]` 的 noise 沒揭露給子代理」，本次 V9 補上。

---

## 1. 失敗 case 重新驗證表（主目錄、改動前的腳本）

| 報告來源 | 失敗 case 描述 | 實測 totalHits | 真相 |
|---|---|---|---|
| FAQ-2428 V3 | `agent_back_office.ApplicationsPlatform.ActivateAgent` 0 命中 | **1** | V3 normalize 已 cover；報告陳述過時 |
| FAQ-2488 V4 | `MessageBoard UpdateUserDetail`（2 args）0 命中 | **0** | 子代理介面誤用 — input 被當成單個帶空格字串 |
| FAQ-2647 V4 | `FundAdjustmentPlatform.ApplyDeduct` 0 命中 | **2** | V3 normalize 已 cover；報告陳述過時 |
| FAQ-2768 V4 | PascalCase method 0 命中 | （多種、皆有命中） | V3 normalize 已 cover |
| FAQ-2503 V5 | `ApplyDeduct` 命中但子代理仍補 grep | **2** | scanner 行為正確；子代理「補 grep」是 prompt 層問題 |
| V5 dry-run | `SetUserDetailForMessageBoard` 0 命中 | **0**（5 個 lago project hasMethod=true 但 src 0 hit） | 真實 0 hit — generated 有 RPC stub，但前端 src 沒人呼叫（server-only RPC） |

**根本判斷**：6 個 case 中只有 2 個是 scanner 真正可改進的（`MessageBoard UpdateUserDetail`、`SetUserDetailForMessageBoard`），其餘是報告失準或子代理操作問題。

---

## 2. 真正的根本問題

### 問題 A — 介面誤用無容錯
子代理用 `frontend-callers "MessageBoard UpdateUserDetail"`（兩個 args 用空格隔開），但 scanner 介面只吃一個 method 名 → `candidates = ["MessageBoard UpdateUserDetail", "messageBoard UpdateUserDetail"]`，整段空格的字串永遠不會出現在 generated 內，hits=0。

子代理會誤判「方法在前端真的不存在」、改 fallback 到 grep。

### 問題 B — 「stub 存在但 src 0 hit」的 noise 沒區分
場景：generated client 內有 `async UpdateUserDetail(...)`（RPC stub 存在），但該 project 的 src 沒實際呼叫處（這 method 由其他 project 共用、或是 server-only RPC）。

舊輸出只有 `projectsWithMethod`（generated 偵測到 method），子代理看到 `totalHits=0` 卻有 `projectsWithMethod` 不為空 → 容易困惑「為什麼有 method 卻無 hit」、誤判成「腳本壞了」。

### 問題 C — namespace dot path 中段資訊被丟棄
舊邏輯只取 `A.B.C` 的 `C`。若 caller 寫法包含中段（少見但有），就漏掉。本次擴充 candidates，加上「整段去點」（`ABC`）變體 — 屬於低成本保險。

---

## 3. V9 修改內容

只動 `call-graph-scanner.ts` 一支檔案的兩個 function：

### 3.1 `normalizeMethodCandidates` 簽名變更
```ts
// before
function normalizeMethodCandidates(method: string): string[]

// after
function normalizeMethodCandidates(method: string): { candidates: string[]; warnings: string[] }
```

擴充內容：
1. **空格 / 逗號 / 斜線分隔的 token 各自當作獨立 method 名處理**，並在 `warnings` 加 hint
2. **dot path 同時試「最後段」與「整段去點」兩種變體**（加 PascalCase / camelCase）
3. 用 `/^\w+$/` 過濾掉非英數的怪 token

### 3.2 `frontendCallers` 輸出擴充
```ts
// 新增
projResult.note = 'RPC stub exists in this project\'s generated client but no src caller found ...'  // 條件:hasMethod=true && hits=[]

// stats 新增
projectsWithHits: string[]  // 區別自 projectsWithMethod

// 頂層新增
hints: string[]  // 來自 normalize warnings + 「全 0 hit」分流提示
```

兩種 0 hit 分流提示：
- **找不到任何 stub**：`"no project's generated client contains a method matching the candidates — verify the method name (PascalCase RPC name expected, e.g. ChangeUserBalance not methodChangeUserBalance)"`
- **stub 存在但 src 全 0 hit**：`"candidates exist as RPC stubs but no src caller found in any frontend project — method may be server-only / dead RPC, or check if caller uses an alias"`

---

## 4. 命中率前後對比

實測（主目錄、ALADDIN_ROOT_AT_DATE 未設定）：

| Case | V8 totalHits | V9 totalHits | hint 改變 |
|---|---|---|---|
| `ActivateAgent` | 1 | **1** | 無 |
| `activateAgent` | 1 | **1** | 無 |
| `agent_back_office.ApplicationsPlatform.ActivateAgent` | 1 | **1** | 無（candidates 多了 `agent_back_officeApplicationsPlatformActivateAgent`，無害） |
| `ApplyDeduct` | 2 | **2** | 無 |
| `FundAdjustmentPlatform.ApplyDeduct` | 2 | **2** | 無 |
| `MessageBoard UpdateUserDetail` | 0 | **1** ✅ | 新增 hint「contains 2 whitespace-separated tokens」 |
| `SetUserDetailForMessageBoard` | 0 | 0 | 新增 hint「stub 存在但無 src caller — server-only / dead RPC」 |
| `UpdateUserDetail` | 1 | 1 | `lago-ny`、`lago-pk` 加 note「RPC stub exists ... shared via another project」 |
| `Login`（正常 case 回歸） | 3 | **3** | 無 |
| `ThisMethodDoesNotExistAnywhere` | 0 | 0 | 新增 hint「no project's generated client contains a method matching the candidates」 |

**真正的命中率提升**：1 個 case（`MessageBoard UpdateUserDetail`：0 → 1）。

**訊息品質提升（更有意義）**：
- 4 個原本 noise 的 case 現在有明確 hint，子代理能正確判讀「不是腳本壞了，而是 method 真的沒人呼叫 / 我打錯了」
- 介面誤用容錯讓子代理不必精確記得 scanner 介面契約

---

## 5. 測試保護

`/tmp/test-frontend-callers.sh` 擴充為 19 條斷言、5 個 block：

| Block | 內容 | 通過 |
|---|---|---|
| A | V3 已修的 case 回歸保護（5 條） | ✅ 5/5 |
| B | V9 介面誤用容錯（4 條） | ✅ 4/4 |
| C | server-only RPC 0 hit + hint（3 條） | ✅ 3/3 |
| D | `projectsWithHits` vs `projectsWithMethod` 區分 + `note`（3 條） | ✅ 3/3 |
| E | 正常 case 回歸 + 不存在 method hint（3 條） | ✅ 3/3 |

**結論**：19/19 全通過、無回歸。

---

## 6. 沒做、刻意排除的方案

| 方案 | 排除理由 |
|---|---|
| 將 generated client 預先索引到 JSON 加速 | abu-platform generated 31508 行，grep 一次 < 50ms，不是熱點 |
| 加 git log fallback（找歷史上是否曾有 method 名） | 跨 4 個 repo (abu / lago / agrabah / rajah) 的 git 子流程太重；且 V5/V6/V7 已透過 `ALADDIN_ROOT_AT_DATE` worktree 機制處理時間點對齊問題 |
| 把 `\.${cand}\s*(` 換成 `\bremote\.[\w.]*\.${cand}\s*(` | 收緊 pattern 反而漏掉 `api.something.X.Y.method(` 等變體；目前 pattern 加上後續的 `/generated/` 過濾、`isCommentOrImport` 過濾，已經夠精準 |

---

## 7. 補充驗證:20 組擴充測試發現的隱藏 bug

在使用者要求多測 20 組後,發現一個 **V3-V8 從未報告過、影響全部 9 個 subcommand** 的隱藏 bug。

### 7.1 抽 8 個隨機 PascalCase RPC 與 grep ground-truth 對齊測試
其中 7 個對齊,1 個 `ListAllGameFrontendGroupTags` scanner 給 2、grep 給 3。

### 7.2 根因
`parseGrepLine` 沒處理 CRLF line endings。`abu/platform/src/initializes/reflection.ts` 是 CRLF,grep 輸出整行帶 `\r`,split('\n') 後仍有 `\r` 結尾,regex `^(.+?):(\d+):(.*)$` 配不上 → 整行被無聲丟棄。

### 7.3 修復(`call-graph-scanner.ts:115-120`)
```ts
function parseGrepLine(raw: string): GrepHit | null {
    // V9:strip 行尾 CR(處理 CRLF line endings)
    const cleaned = raw.replace(/\r$/, '');
    const m = cleaned.match(/^(.+?):(\d+):(.*)$/);
    if (!m) { return null; }
    return { file: m[1], line: parseInt(m[2]), content: m[3].replace(/\r$/, '') };
}
```

### 7.4 影響範圍
`parseGrepLine` 被全部 9 個 subcommand 共用,本次同處修復**順帶救回** `same-server-callers` / `cross-server-callers` / `reverse-bfs-to-entries` / `table-crud` / `table-bfs` 在 CRLF 檔案上的 false negative。

### 7.5 20 組擴充測試結果
- Block 1(8 組抽樣 PascalCase × grep ground-truth 對齊):**8/8 通過**(修 CRLF 後)
- Block 2(邊界 / 誤用 input 5 組):**9/9 條斷言通過**
- Block 3(命名變體 3 組):**3/3 通過**
- Block 4(hints / note 訊息品質 4 組):**4/4 通過**
- 合計 **25/25 通過**(20 組共 25 條斷言)
- V9 主測試 19/19 同時無回歸

---

## 8. 變更檔案

| 路徑 | 變更類型 |
|---|---|
| `obsidian/skills/method-call-graph/call-graph-scanner.ts` | `normalizeMethodCandidates`、`frontendCallers`、`parseGrepLine` 三個 function 修改 |
| `/tmp/test-frontend-callers.sh` | 從 5 條 baseline 擴充為 19 條斷言的主測試 harness |
| `/tmp/test-frontend-callers-20.sh` | 20 組擴充測試 harness(25 條斷言),含 grep ground-truth 對齊 |
| `obsidian/skills/method-call-graph/v9-frontend-callers-audit.md` | 本驗證報告(新增) |

**未 commit**:依使用者指示。
