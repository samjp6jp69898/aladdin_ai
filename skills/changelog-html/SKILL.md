---
name: changelog-html
description: 從多個 feature branch 提取變更，按 abu/lago 真實菜單階層生成客戶可閱讀的互動式 HTML 變更摘要，內含影響範圍追蹤鏈分析（透過 method-call-graph + i18n + 中英辭典翻譯成業務語言）。Use when 需要做版次 release notes、給客戶/企劃看的 changelog、把多個 repo 的 feature branch diff 整合成單檔 HTML、做菜單對齊的 release summary，並希望每條變更都附有「會連帶影響到哪些其他功能」的客戶可讀分析。
---

# changelog-html — 多 repo feature branch → 客戶可讀互動式 HTML changelog（v2 影響範圍 + v3 前端 app filter）

把 aladdin 多個 repo（abu / lago / agrabah / rajah）的 feature branch 差異，整合成一份按真實菜單階層瀏覽的互動式 HTML changelog，每條變更都附「影響範圍」摺疊區塊與「受影響前端 app」標籤，供非技術讀者（客戶／企劃）閱讀並依需要 filter。

## 何時使用

- 「整理 5/26 版相對於 5/22 版的變更給客戶看」
- 「把三個 feature branch 的差異做成可瀏覽的 HTML」
- 「按後台菜單顯示每個分頁這次改了什麼」
- 「想知道每個改動會連帶影響哪些其他功能」（v2 流程）
- 「我要 changelog 但讀者只關心某個前端 app（例如只看 pk 受影響的）」（v3 流程）

## 流程總覽（7 階段）

```
1. 確認 branch 與基準           ← 與用戶確認 diff 三角
2. 提取 changes（並行 sub-agent）← 每 repo 一個 agent，輸出 markdown 中間檔
3. 解析 abu menu.ts             ← parse-abu-menu.js → menu-tree.json
4. 映射 changes → menu leaves   ← 手寫 changes.json，每條 change 帶 `leaves`
5. 影響範圍分析（12 並行 worker）← 4 repos × 3 versions，跑 method-call-graph + grep
6. 業務語言改寫（1 rewriter agent）← 用 i18n-lookup + 中英辭典翻譯成客戶語言
7. 組裝 HTML                    ← build-html.js
```

> **v1 流程**（沒有影響範圍分析）只需階段 1–4 + 7，跳過 5、6。
> **v2 流程**（含影響範圍）執行全部 7 階段。
> **v3 流程**（v2 + 前端 app 多選 chip filter）執行全部 7 階段，且階段 2 / 4 額外處理 `apps` 欄位；HTML 頂部多 5 個 chip（platform / admin / n8 / ny / pk），所有 leaves / changes / pill / lago tag 都依當下勾選的 apps 動態過濾。本 skill **預設走 v3**，因為「影響哪個前端」與「影響範圍」都是非技術讀者最關心的資訊。

---

## 階段 1：確認 branch

用 `AskUserQuestion` 確認：

- 要對比哪些 branch？通常每個 repo 有相同命名（如 `feature/20260518`、`feature/20260522`、`feature/20260526`）
- 每個 branch 的 diff base？三種選擇：
  - `vs pro`（每段都對正式版，內容會重疊）
  - `vs 上一版`（**推薦**，呈現增量）
  - `vs dev`（看相對於開發主線）
- 要涵蓋哪些 repo？通常 `abu`、`lago`、`agrabah`、`rajah` 四個；前三個沒變更可跳過
- 是否要影響範圍分析？**預設 yes**（v2 流程）；若用戶只要快速 changelog 可選 no（v1 流程）
- 輸出位置？預設 `obsidian/Projects/changelog/Release Changelog <YYYY-MM>.html`

---

## 階段 2：提取 changes（並行 sub-agent）

每個 repo 派一個 `general-purpose` sub-agent，並行執行。每個 agent 收下面這份 prompt 樣板（替換 `<REPO>` / `<PAIRS>`）：

```
為 <REPO> 整理三段時間區間的客戶面 changelog。
比較：
  1. <BRANCH_A> vs <BASE_A>
  2. <BRANCH_B> vs <BASE_B>
  3. <BRANCH_C> vs <BASE_C>

工作方法：
1. commit messages 優先（`git log --no-merges --format='%h %s' <base>..<branch>`）
2. 看 `git diff --stat` 的檔案路徑分群
3. 挑代表檔讀 JSDoc / Vue script setup comment
4. 補 obsidian/Projects/_index.md 業務脈絡
5. i18n key 反查：`bun /Users/user/aladdin/obsidian/skills/i18n-lookup/i18n-lookup.ts key <key>`
6. 禁止讀 localizations/*.json、禁止改任何程式碼

客戶可讀標準：
- 不要寫：重構/lint/型別/組件抽取/refactor
- 要寫：「XX 頁面新增 YY 功能」「XX 修正 YY 問題」
- 純技術變更歸併「內部優化」一行

**v3 新增 — abu / lago 必須在每條 markdown 後標 `[app: ...]`**：
- `abu/platform/` 路徑 → `[app: platform]`
- `abu/admin/` 路徑 → `[app: admin]`
- `abu/common/` 或共用 → `[app: platform, admin]`
- `lago/n8-gaming/` → `[app: n8]`
- `lago/ny-gaming/` → `[app: ny]`
- `lago/pk-gaming/` → `[app: pk]`
- `lago/common/` 共用 → grep 受影響的子 app 子集，標 `[app: n8, ny, pk]` 等

agrabah / rajah 後端 markdown **不必標** apps（由階段 4 mapper 依業務領域推斷）。

輸出到 /tmp/changelog/<REPO>.md，按版本三段；每段條目以業務分群（新增/調整/修正/內部優化）。
```

agent 完成後，把四份 `/tmp/changelog/*.md` 集合起來。

---

## 階段 3：解析 abu menu.ts

```bash
node /Users/user/aladdin/.claude/skills/changelog-html/parse-abu-menu.js
```

腳本動作：

- 讀 `abu/platform/src/menu.ts` 與 `abu/admin/src/menu.ts`
- evaluate `group()` / `item()` 呼叫成樹（stub Vue component imports）
- 從 `abu/<app>/localizations/zh-TW.json` 撈 `menu.<name>` 中文 label
- 輸出到 **`/tmp/changelog/menu-tree.json`**

輸出結構：

```json
{
  "platform": [
    { "name": "report-analysis", "label": "報表分析", "perm": "ReportAnalysis", "route": "/report", "type": "group", "depth": 0,
      "children": [
        { "name": "game-report", "label": "遊戲報表", "type": "item", "depth": 1, "children": [] }
      ]
    }
  ],
  "admin": [ ... ]
}
```

---

## 階段 4：映射 changes → menu leaves

讀 `menu-tree.json` 取得所有 leaf `name`，然後**手寫**或讓 sub-agent 寫一份 `changes.json`。schema：

```ts
type App = 'platform' | 'admin' | 'n8' | 'ny' | 'pk';

type Change = {
  ver: '518' | '522' | '526';                  // 自訂版本 ID（對應 UI 彩色標籤）
  type: 'add' | 'adj' | 'fix' | 'internal';    // 新增 / 調整 / 修正 / 內部
  leaves: string[];                             // 多葉節點（跨菜單同一改動可放多個）
  apps?: App[];                                 // ← v3 新增：受影響的前端 app subset；驅動 HTML 頂部 5 chip filter
  title: string;
  subs?: string[];                              // 編號子項目
  tags?: string[];                              // FAQ 編號等 tag
  impact?: string[];                            // ← v2 階段 5 + 6 補上的影響範圍
};

type ChangesFile = {
  versions: { id: string; label: string; cls: string }[];   // 版本定義
  lago: { name: string; label: string; tags?: App[] }[];     // lago 自訂菜單；tags 同時驅動 lago leaf 的 app filter
  other: { name: string; label: string }[];                  // 內部優化等非菜單分類
  changes: Change[];
};
```

`leaves` 欄位允許的值：

- **abu/platform**：直接用 menu.ts 第一參數 `name`（如 `game-report`、`user-list`、`activity-review`）
- **abu/admin**：前綴 `admin:`（如 `admin:bet-records`、`admin:game-vendor-list`）
- **lago**：自訂 `_lago.<area>`（如 `_lago.sport`、`_lago.darkmode`）
- **內部優化**：`_internal.frontend` / `_internal.backend` / `_internal.rajah`

**apps 對應規則（v3，每條 change 都必須有非空 apps 陣列）**：

- **abu changes**：直接讀 stage 2 markdown 中的 `[app: platform]` / `[app: admin]` / `[app: platform, admin]` 標記
- **lago changes**：直接讀 stage 2 markdown 中的 `[app: pk]` / `[app: n8, ny, pk]` 等標記
- **agrabah / rajah changes**：依業務領域推斷：
  - 「代理後台」「平台後台」「業務後台」「結算」「報表」「審核」相關 → `["platform"]`
  - 「系統後台」「廠商管理」「權限」「audit」相關 → `["admin"]`
  - 「會員」「VIP」「直播」「娛樂城」「體育」「充值」「提現」「活動」（玩家側功能）→ `["pk"]`，並加上 n8/ny 若 lago markdown 對該 area 有對應
  - 「板球」「全民代理（玩家端）」「公司資訊頁」→ `["n8"]`
  - 「暗黑模式」→ `["ny"]`
  - 不確定 / 跨多 app 的後端基礎建設（如全鏈路 event-log、跨服務通知系統）→ 保守 `["platform","admin","n8","ny","pk"]`
  - 純後端契約整理（`_internal.rajah`、`_internal.backend`）→ 保守全選

**範例** 見 `examples/changes-202605.json`（v1 mapping）、`examples/changes-202605-v2-business.json`（含 v2 impact）、`examples/changes-202605-v3.json`（含 v3 `apps` 欄位）。

階段 4 結束時，產出 `changes.json`（無 impact 欄位）。若要 v2/v3 流程，繼續階段 5；否則直接跳階段 7。

**v3 mapper 完成時必須跑下面 validation**（在原本 leaves validation 之外加 apps validation）：

```bash
node -e "
const cd = JSON.parse(require('fs').readFileSync('/tmp/changelog/changes.json','utf8'));
const VALID = new Set(['platform','admin','n8','ny','pk']);
let bad = 0;
for (const c of cd.changes) {
  if (!Array.isArray(c.apps) || c.apps.length === 0) { console.log('NO apps:', c.title); bad++; continue; }
  for (const a of c.apps) if (!VALID.has(a)) { console.log('BAD app:', a, 'in', c.title); bad++; }
}
console.log('bad apps:', bad);
"
```
必須 `bad apps: 0` 才算完成。

---

## 階段 5：影響範圍分析（12 並行 worker）

> **目的**：每條 change 透過 source code 追蹤鏈，找出真實會被連帶影響的下游模組／頁面／RPC 客戶端。  
> **手法**：依 (repo, ver) 切 12 個 worker，每個 worker 跑 method-call-graph + git diff + grep。  
> **輸出**：12 份 `impact-<repo>-<ver>.json`，再合併為單一 `changes-with-impact.json`。

### 5.1 準備 input

先把 `changes.json` 加 `idx` 後拆分為三份 per-version input。建議放在工作目錄 `/tmp/changelog/v2/`（讓 v2 中間檔與 v1 隔開）：

```bash
mkdir -p /tmp/changelog/v2
cp /tmp/changelog/changes.json /tmp/changelog/v2/changes-source.json
node -e "
const fs = require('fs');
const data = JSON.parse(fs.readFileSync('/tmp/changelog/v2/changes-source.json', 'utf8'));
data.changes.forEach((c, i) => c.idx = i);
fs.writeFileSync('/tmp/changelog/v2/changes-source.json', JSON.stringify(data, null, 2));
const vers = Array.from(new Set(data.changes.map(c => c.ver)));
for (const v of vers) {
  const subset = data.changes.filter(c => c.ver === v)
    .map(c => ({ idx: c.idx, type: c.type, leaves: c.leaves, title: c.title, subs: c.subs || [], tags: c.tags || [] }));
  fs.writeFileSync('/tmp/changelog/v2/input-' + v + '.json', JSON.stringify(subset, null, 2));
  console.log('ver', v, '→', subset.length, 'changes');
}
"
```

### 5.2 派 12 個 worker（一次性 parallel 派出）

對每個 (repo, ver) 組合派一個 `general-purpose` sub-agent。每個 agent 收：

- **共用指令檔**：`/Users/user/aladdin/.claude/skills/changelog-html/impact-agent-instructions.md`（worker 必讀）
- **4 個參數**：`REPO` / `VER` / `BRANCH` / `BASE`
- **工作目錄**：預設 `/tmp/changelog/v2/`

prompt 樣板：

```
你是 changelog v2 影響範圍分析 worker。**先讀完 `/Users/user/aladdin/.claude/skills/changelog-html/impact-agent-instructions.md` 整份指令再開工**。

【本 cell 參數】
- REPO = <repo>
- VER = <ver>
- BRANCH = <branch>
- BASE = <base>
- 輸入：/tmp/changelog/v2/input-<ver>.json
- 輸出：/tmp/changelog/v2/impact-<repo>-<ver>.json

【特別提醒】<repo 特定的提示>

完成後執行 instructions 末尾的驗證指令，確認 missing 為空再回報。
```

worker 內部會：

1. `cd /Users/user/aladdin/<repo>`
2. `git log origin/<base>..origin/<branch>` 取 commit list
3. 對每條 input change，用 title/subs 關鍵字 grep 對應 commit
4. 對 commit 跑 `git show --stat` 看檔案，分流到：
   - agrabah / rajah → 跑 `method-call-graph local|cross|table` 找 caller
   - abu / lago → grep import 找跨頁共用元件
5. 寫成 1-5 條 impact 句子（這階段允許保留技術詞，stage 6 會翻譯）

worker 標籤一律用：`**[後端 agrabah]**` / `**[RPC 契約 rajah]**` / `**[後台前端 abu]**` / `**[玩家端 lago]**`（stage 6 會合併簡化）。

### 5.3 合併 12 份 impact

```bash
node /Users/user/aladdin/.claude/skills/changelog-html/merge-impact.js \
  /tmp/changelog/v2 \
  /tmp/changelog/v2/changes-source.json
```

腳本動作：

- 依 idx 從 4 個 repo 各自的 impact-*.json 收集每條 change 的 impact
- 過濾「找不到對應 commit」雜訊
- N/A 與真實影響分開：有真實影響時放真實的，沒有時保留 N/A 理由
- 全部 4 repo 都找不到時，落到「（4 個 repo 皆無對應 commit；推測為純文件 / 配置 / i18n 變更）」
- 輸出：`/tmp/changelog/v2/changes-with-impact.json`

階段 5 結束時 impact 仍含技術詞（class / method / table / enum / repo 名），準備進階段 6 翻譯。

---

## 階段 6：業務語言改寫（i18n + 中英辭典）

> **目的**：把 worker 寫的技術句子翻譯成非技術讀者看得懂的業務語言。  
> **手法**：派 1 個 rewriter agent，讀 stage 5 輸出，全程使用 **i18n-lookup 腳本 + 中英對照辭典** 查業務名稱，禁止憑記憶猜。  
> **輸出**：`changes-business.json`（schema 同 stage 5 輸出，只改 `impact` 文字）。

### 6.1 翻譯的三大法寶（rewriter 必須使用）

#### 法寶 A — i18n-lookup（查 enum / model / error / key 顯示文字）

```bash
# 查整個 enum 的所有值
bun /Users/user/aladdin/obsidian/skills/i18n-lookup/i18n-lookup.ts enum <EnumName>
# 查 enum 某個值
bun /Users/user/aladdin/obsidian/skills/i18n-lookup/i18n-lookup.ts enum <EnumName> <value>
# 查 model 欄位
bun /Users/user/aladdin/obsidian/skills/i18n-lookup/i18n-lookup.ts model <model-name>
# 查 error code
bun /Users/user/aladdin/obsidian/skills/i18n-lookup/i18n-lookup.ts error <code>
# 查 i18n key
bun /Users/user/aladdin/obsidian/skills/i18n-lookup/i18n-lookup.ts key <key>
```

範例：worker 寫 `EventCategoryEnum` 三組大幅縮減重整  
→ 跑 `i18n-lookup enum EventCategoryEnum` 看到顯示「事件大分類」  
→ 改寫為「行為大分類項目大幅整理，後台查詢下拉選單與標籤顯示會跟著更新」

#### 法寶 B — 中英對照辭典（查 server / service 中文業務名）

辭典：`/Users/user/aladdin/obsidian/Rules/中英對照辭典.md`（涵蓋 agrabah 84 server + 338 service）

```bash
grep -B 2 -A 5 "agent_back_office" /Users/user/aladdin/obsidian/Rules/中英對照辭典.md
grep -B 2 -A 5 "代理結算" /Users/user/aladdin/obsidian/Rules/中英對照辭典.md
grep -B 2 -A 5 "AgentCommissionManagePlatformService" /Users/user/aladdin/obsidian/Rules/中英對照辭典.md
```

範例：worker 寫 `agent_settlement_job/processor/venture/commission.ts`  
→ 查辭典「合營結算」確認業務名  
→ 改寫為「合營佣金結算流程內的扣款與計算邏輯同步調整，當月結算金額會反映新規則」

#### 法寶 C — 從 change.title / subs 取線索（最後手段）

每條 change 本身的 title / subs 是上游業務分析者已經處理過的語言，i18n / 辭典都查不到時直接沿用。

範例：change.title = 「會員行為日誌查詢（新功能）」  
→ impact 裡只要說「會員行為日誌」即可，不要寫 `events 表` 或 `EventLogJob`

### 6.2 標籤合併（4 → 4 業務標籤，多數會壓成 1）

| Worker 標籤 | Rewriter 業務標籤 |
| --- | --- |
| `**[後端 agrabah]**` | `**[後端服務]**` |
| `**[RPC 契約 rajah]**` | `**[後端介面]**`（多數合併進「後端服務」） |
| `**[後台前端 abu]**` | `**[後台介面]**` |
| `**[玩家端 lago]**` | `**[玩家端 App]**` |

「後端服務」與「後端介面」的差別只有在「對外契約 break change」這種少見情境才會分開；多數同一個改動 worker 在 agrabah 和 rajah 都會寫一句，rewriter 要合併為單一「後端服務」。

### 6.3 派 rewriter agent

```
你是 changelog v2 影響範圍改寫員。
**先讀完 `/Users/user/aladdin/.claude/skills/changelog-html/rewriter-instructions.md` 整份指令再開工**。

【關鍵要求】
- 輸入：`/tmp/changelog/v2/changes-with-impact.json`（N 條 changes）
- 輸出：`/tmp/changelog/v2/changes-business.json`（同結構，只替換 impact 內容）
- 必須通過驗證指令 `total bad: 0`（即沒有任何技術詞殘留）
- 三大翻譯法寶按順序使用：i18n-lookup → 中英辭典 → change.title/subs

【完成前自我檢查】
1. 跑 instructions 末尾的驗證指令確認 `total bad: 0`
2. 抽 5 條人工讀過一遍，確保完全業務語言
3. 確認 N 條全部有 impact，最少 1 條最多 5 條

完成後回報：改寫了幾條、合併了幾條、驗證輸出。
```

驗證指令（rewriter 必須跑通才算完工）：

```bash
node -e "
const d = require('/tmp/changelog/v2/changes-business.json');
const TECH = /agrabah|rajah|\babu\b|\blago\b|composable|gRPC|\bRPC\b|enum|schema|scaffold|骨架|契約|callsite|caller|common\.gen|handler|cron|redis|cache|migration|ORM|CRUD|Vue|TypeScript|\.ts\b|\.vue\b|Service|Manager|Method|Helper|Job/;
let bad = 0;
for (const c of d.changes) {
  if (!Array.isArray(c.impact)) { console.log('MISSING impact:', c.idx); bad++; continue; }
  for (const s of c.impact) if (TECH.test(s)) { console.log('TECH WORD in idx', c.idx, ':', s); bad++; }
}
console.log('total bad:', bad, '/ total impact lines:', d.changes.reduce((s,c)=>s+(c.impact||[]).length,0));
"
```

---

## 階段 7：組裝 HTML

```bash
node /Users/user/aladdin/.claude/skills/changelog-html/build-html.js \
  /tmp/changelog/menu-tree.json \
  /tmp/changelog/v2/changes-business.json \
  "<output-path>.html"
```

> v1 流程跑這條時把 changes.json 改成階段 4 的輸出即可。

輸出 HTML 特性：

- 單檔（無外部依賴），可直接 email 或上傳 Drive
- 左側菜單樹完整呈現 abu 三級階層（用 menu.ts 真實節點＋多語中文）
- 上方版本切換按鈕 + 搜尋框 + 「顯示無變更項目」 toggle
- 每個葉節點點開後依版本分組顯示變更（新增/調整/修正/內部分類）
- 跨菜單同一改動會在每個 leaf 顯示，並以「同步影響」交叉連結
- **v2 新增**：每條變更下「影響範圍 ▶」摺疊區塊，預設收合；點開後依「後端服務 / 後端介面 / 後台介面 / 玩家端 App」四色標籤分類顯示
- **v3 新增**：頂部加 5 個前端 app chip filter（platform / admin / n8 / ny / pk），可多選 toggle（與既有 3 個版本 chip 並排）。chip 影響四處渲染，所有規則都在 `template.html` 內：
  - **左側 section 隱藏**：`activeApps` 不含 `platform` 時整個「平台後台 (abu/platform)」section 不渲染；不含 `admin` 時「系統後台 (abu/admin)」section 不渲染
  - **左側 lago leaf 隱藏**：當 lago leaf 的 `tags ∩ activeApps == ∅` 時整個 leaf 不渲染
  - **左側 lago leaf 旁的 app-tag chip**：只顯示「leaf 自己有 ∩ 當前選中」的 app（例如 `_lago.home` 有 `[n8,ny,pk]` tag，只選 pk 時只顯示 `[pk]`）
  - **右側 change 卡片**：依 `change.apps ∩ activeApps` 過濾顯示；同時卡片標題旁的 app-pill 也只顯示「change.apps ∩ activeApps」的子集；當交集為空或交集等於完整 5 個時 pill 整個不渲染（避免噪音）
  - 至少要保留一個 chip 啟用（不允許全關）；若當前選取的 leaf 因 app filter 被隱藏，會自動 fallback 回「版本總覽」

---

## 完整範例（2026 年 5 月三版）

來源檔已保留：

- `examples/changes-202605.json`：v1 完整 137 條變更的 mapping
- `examples/changes-202605-v2-business.json`：v2 含影響範圍與業務語言改寫
- `examples/changes-202605-v3.json`：v3 含 `apps` 欄位（190 條 change，每條都標 apps）
- 輸出 HTML（v2）：`obsidian/Projects/changelog/Release Changelog 2026-05 v2.html`
- 輸出 HTML（v3）：`obsidian/Projects/changelog/Release Changelog 2026-05 v3.html`

v2 階段統計：

- 12 個 worker 並行（agrabah / rajah / abu / lago × 5/18 / 5/22 / 5/26）
- worker 原始輸出 463 句技術描述
- rewriter 合併 + 翻譯後 252 句業務描述（壓縮率 ~55%）
- 137 條 change 標籤分佈：後端服務 128、後台介面 71、玩家端 App 11、N/A 42

v3 階段統計（5/18 / 5/22 / 5/26 三段都 vs origin/pro，每版列該分支獨有新增）：

- stage 2 並行 4 sub-agent 提取 281 條原始 changes
- stage 4 mapper 合併為 190 條（去重 ~32%）
- stage 5 12 worker 跑影響範圍（其中 2 個曾 stall 重派；instructions 已補入 time-cap）
- stage 6 rewriter 把 543 句技術描述去重 + 翻譯為 351 句業務描述
- changes 三版分佈：518=38、522=89、526=63
- type 分佈：add 66、adj 62、fix 48、internal 14
- apps 分佈：platform 143、admin 23、n8 28、ny 19、pk 34（後端常為保守全 5）
- 業務標籤：後端服務 217、後台介面 70、玩家端 App 30、N/A 34

## 限制與注意事項

- **不修改任何程式碼**：本 skill 只讀 menu.ts / git / source code，不會 edit/write source
- **不讀 localizations 編寫**：i18n 只透過 i18n-lookup 反查，**不可** Edit/Write `localizations/*.json`
- **lago 沒有真正的 menu.ts**：lago 採 route + 玩家可感受領域的歸納（n8/ny/pk 三 app 用 tag 區分；v3 加上 chip filter 後此 tag 同時驅動 leaf 是否顯示）
- **重新跑 menu 解析**：abu menu.ts 變更後（新頁面上線），務必重跑 `parse-abu-menu.js` 重新生成 menu-tree.json
- **leaf 名稱驗證**：build-html.js 會 validate `changes.json` 裡所有 `leaves` 是否都對應到 menu-tree 中真實節點；失敗會直接 exit 1
- **apps 欄位向後相容**：build-html.js 不驗證 apps（缺值時 template 視為全 5）。v3 流程的 mapper 必須在輸出前自行跑 apps validation（見階段 4）
- **影響範圍嚴禁編造**：worker 只能引用 method-call-graph / grep 輸出真實看到的 caller；rewriter 只能引用 i18n-lookup / 辭典查到的業務名
- **避免 worker stall**：若 method-call-graph 某 method 有 100+ caller，或 grep 某 super-shared 元件有 300+ importer（如 abu DataTable），worker 必須直接寫總結句「影響後台 N+ 頁」，不要逐一列舉。stage 5 派工時務必在 prompt 內提醒 time-cap（每條 ≤ 30 秒、call-graph ≤ 1 次）

## 檔案清單

```
changelog-html/
├── SKILL.md                       # 本檔
├── parse-abu-menu.js              # abu menu.ts → menu-tree.json
├── build-html.js                  # menu-tree + changes → HTML（schema 註解已含 apps 欄位）
├── template.html                  # HTML template（含 impact 摺疊區塊 + v3 5 app chip filter）
├── merge-impact.js                # v2 階段 5.3：12 worker 輸出 → changes-with-impact.json
├── impact-agent-instructions.md   # v2 階段 5：12 worker 共用指令
├── rewriter-instructions.md       # v2 階段 6：rewriter agent 指令（i18n + 辭典翻譯流程）
└── examples/
    ├── changes-202605.json                  # v1 範例：137 條（無 impact）
    ├── changes-202605-v2-business.json      # v2 範例：含業務語言 impact
    └── changes-202605-v3.json               # v3 範例：含業務 impact + apps 欄位（190 條）
```

## template.html 修改點摘要（v3 加上 5 app chip filter）

供 future maintainer 快速定位（行號可能漂移，以實際內容為準）：

1. **CSS**：新增 `.app-btn`、`.app-btn.active.app-{platform|admin|n8|ny|pk}`、`.filter-sep`、`.filter-label`、`.change-apps`、`.app-pill.app-pill-{...}`
2. **topbar HTML**：在既有 3 個 `ver-btn` 之後加 `<span class="filter-sep">` + 5 個 `app-btn`，皆預設 `active`
3. **JS state**：加 `activeApps: new Set(ALL_APPS)` 與常數 `ALL_APPS = ['platform','admin','n8','ny','pk']`
4. **JS 三個輔助函式**：`leafToApps(id)`（leaf id → app subset）、`changeVisible(c)`（ver + app 雙過濾）、`leafAppVisible(id)`（leaf 是否該渲染）
5. **`countActiveAt` / `renderContent` 內 changes 過濾**：從 `state.activeVers.has(c.ver)` 改為 `changeVisible(c)`
6. **`renderTree` section 隱藏**：sec-platform / sec-admin 在 chip 關時 `continue`
7. **`makeNode` lago leaf 隱藏**：開頭加 `if (id.startsWith('_lago.') && !leafAppVisible(id)) return wrap;`
8. **`makeNode` lago tag 渲染**：`if (!state.activeApps.has(t)) continue;`（只顯示當前選中的 tag）
9. **renderContent app pill 渲染**：先 `c.apps.filter(a => state.activeApps.has(a))`，再判斷 `visibleApps.length > 0 && < ALL_APPS.length` 才渲染
10. **App button 事件**：toggle 後若當前 leaf 因 filter 被隱藏，state.selected 退回 overview

如果只想再加新 app（例如新增第 6 個前端），就只要：
1. 在 `ALL_APPS` 加值
2. CSS 補一個 `.app-btn.active.app-<new>` 與 `.app-pill.app-pill-<new>` 配色
3. topbar HTML 加一個 `<button class="app-btn app-<new> active" data-app="<new>">`
