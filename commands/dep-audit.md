---
name: dep-audit
description: 定期套件漏洞掃描與升級相容性審查 — 掃各專案實際安裝版本、查 OSV 漏洞、網路研究 breaking changes、在隔離 worktree 實測升版，產出單檔 HTML 報告。唯讀主 repo，不 commit 不 push。
user-invocable: true
---

# /dep-audit — 套件漏洞與升級相容性流程

你是本次審查的 **manager**。盤點、漏洞比對、最小修補版計算、相容性靜態預檢已由 `dep-scan.ts` 確定性完成——你的工作只有四件：**分級 → 網路研究 → worktree 實測 → 出報告**。

鐵律（違反即為事故）：

- **不憑記憶回答任何版本或漏洞事實**。版本、漏洞、修補版一律引用 `scan.json`；breaking change 一律附**你真的用 WebFetch 讀過**的網址。模型的訓練資料對套件版本永遠是過時的。
- **沒跑過的不准寫成 PASS**，沒研究過的不准填 `breakingChanges`。該欄位留空、把項目放進 `notResearched` / `notVerified` 並附理由——報告會誠實把它列進「已知限制」。
- **只在 worktree 內改 package.json**。主 repo 的任何檔案（含 lockfile）一律不動。
- **禁 commit、禁 push**（本流程不交付程式碼，只交付報告；worktree 刻意用 detached HEAD，沒有分支可推）。
- 全量 lint / build 必帶 `NODE_OPTIONS=--max-old-space-size=8192`；`exit 137` / `SIGKILL` / `heap out of memory` 是 OOM 不是升版失敗（見 `.claude/doctrine/refs/build-oom.md`）。
- 本流程為自主 pipeline：除本檔明寫的回報時機外，全程不停下來等使用者。

掃描範圍與各專案的驗證指令，唯一事實源是 `obsidian/skills/dep-audit/projects.json`。要增減專案或改驗證指令 → 改該檔，不要在本檔或 prompt 內硬寫。

## Parameters

`$ARGUMENTS`：`/dep-audit [label] [--project <id>]... [--scope P0|P1|P2|P3] [--only <套件@版本>]... [--skip-verify] [--no-cache]`

- `label`：批次標籤，預設台北時區今天的 `YYYYMMDD`。產物落在 `audit-reports/dep-audit-<label>/`。
- `--project`：只掃指定專案（可重複）。省略＝`projects.json` 全部 10 個。
- `--scope`：只對此優先序**以上**的項目做研究與實測（預設 `P1`）。`P3` ＝全做，會很久。
- `--only`：只處理指定的 `套件@版本`（可重複），覆蓋 `--scope`。用於補做單一項目。
- `--skip-verify`：跳過 Step 5 實測，只出到研究層級。報告會把該批項目標成「未實測」。
- `--no-cache`：忽略 OSV / registry 本機快取，強制重查。

例：`/dep-audit`、`/dep-audit 20260729 --project agrabah --scope P2`、`/dep-audit 20260729 --only handlebars@4.7.8 --only vite@5.4.21`

### 續跑（補做既有批次的缺口）

同一個 `label` 重跑就是續跑。HTML 報告底部會直接把這幾行指令印給讀者，所以**它們必須真的能跑**：

- Step 1 掃描照跑（走快取，數秒），`scan.json` 覆蓋更新。
- Step 3 / Step 5 **必須先讀既有的 `research.json` / `verify.json`，把本次結果合併進去再寫回**——不是覆蓋整檔。既有項目除非本次重新研究過，否則原樣保留。
- 合併時以 `key`（`套件@版本`）為準；本次有做的覆蓋同 key 舊值，本次沒碰的保持不動。
- 若本次處理的項目原本在 `notResearched` / `notVerified` 名單裡，記得把它從名單移除，否則報告會同時顯示「已研究」與「未研究理由」。

## Step 0：前置檢查

```bash
cd /Users/user/aladdin && git status --porcelain | head -20
```

- 主 repo 有未提交變更 → **不影響本流程**（本流程唯讀主 repo、實測在獨立 worktree）。不要清理、不要 stash、不要提醒使用者提交。
- 確認 `bun --version` 可用。`bun audit` 在 1.2.9 **不存在**，不要嘗試——漏洞資料一律走 `dep-scan.ts`（OSV.dev）。

## Step 1：掃描（腳本，一條指令）

```bash
bun /Users/user/aladdin/obsidian/skills/dep-audit/dep-scan.ts scan --label <label> [--project <id>]... [--no-cache]
```

- stdout 最後印 `SCAN_OK <path>` 與一張摘要表；完整結果在 `audit-reports/dep-audit-<label>/scan.json`。
- 分析單位是 **(套件, 版本)** 不是套件：同一套件在同專案可能同時裝了多個版本（實例：agrabah 直接宣告 `protobufjs` 8.0.2，另有 `protobufjs-cli` 以 peerDependency 拉進來的 7.x），兩者漏洞集合與修補路徑完全不同。**不要在後續步驟把它們合併討論。**
- 腳本非 0 結束 → 把錯誤原文回報使用者並停止。**不要**改用 `npm audit` / `bun outdated` 替代（前者需要 package-lock 且解的是宣告範圍而非實裝版本，後者不含漏洞資料）。
- `scan.json` 很大（數百 KB），**不要整檔 Read**。用 `python3 -c` 或 `bun -e` 取需要的欄位。

## Step 2：分級（你的判斷，非腳本）

對每個 finding 定 `P0`–`P3`。分級只依下列因子，**不要**直接把 CVSS 嚴重度當優先序——`scan.json` 的 `maxSeverity` 是套件本身的嚴重度，不是它在我們系統中的風險。

| 因子 | 從哪來 | 怎麼影響 |
|---|---|---|
| 攻擊向量與觸發前提 | advisory 原文（Step 3 讀） | 需本地存取 / 需開發者互動 → 降級；純遠端無互動 → 升級 |
| 是否對外 | `audiences` 含 `public` | 對外站台升級 |
| runtime vs build-time | `occurrences[].depKind` + 套件性質 | 只在 build/dev 期執行（vite、esbuild、rollup、eslint 系）→ 主要威脅是開發機與 CI，非線上產物 → 通常降到 P2/P3 |
| 直接 vs 間接 | `anyDirect` / `dependents` | 間接且無父套件可升 → 需 `overrides`，成本高 → 多半 P2 |
| 我們是否真的走到那條路徑 | Step 4 的程式碼佐證 | 查無使用證據 → 降級，但**必須在報告寫明「查無使用證據」而非「不受影響」** |
| 升版成本 | `recommendation.bumpType`、`compat.blockingPeers` | patch/minor 且無阻擋 peer → 即使風險中等也值得順手升 |

優先序定義：

- **P0 立即處理**：可被外部觸發，且落在對外站台或後端 runtime 路徑上的 CRITICAL/HIGH。
- **P1 本週期內**：CRITICAL/HIGH 的直接依賴，但觸發條件受限（需特定輸入、僅內部後台）。
- **P2 排入排程**：需跨 major、需 `overrides` 的間接依賴、或只影響 build 期的高危項。
- **P3 觀察即可**：查無使用證據、或僅影響開發期且無實際暴露面。

分級結果先記在心裡，Step 3 研究完後連同理由一起寫進 `research.json` 的 `priority` / `priorityReason`。**分級若與 advisory 嚴重度不同向，理由必須寫得夠具體到能被反駁**（例：「vite 的 `server.fs.deny` 系列 CVE 只影響 `vite dev` 開發伺服器，我們的產出是 `vite build` 靜態產物，線上不跑 dev server」——這是可查證的主張，不是感覺）。

## Step 3：網路研究（WebSearch / WebFetch）

對 `--scope` 範圍內的每一項，逐項查以下五類。**P0/P1 每項至少 2 個獨立來源且必須實際 WebFetch 讀過內文**；P2/P3 可只讀 advisory 原文。

1. **Advisory 原文** — `scan.json` 每個 vuln 都有 `url`（osv.dev）。要抓的是 **precondition / workaround / 受影響的 API 路徑**，不是摘要那一行。
2. **目標版本的 release notes / CHANGELOG** — 找 breaking change。跨 major 時整份 migration guide 都要看。
3. **官方 migration guide**（僅跨 major 必查）。
4. **該版本發布後的回歸回報** — 搜 `<套件> <目標版> issue` / `regression` / `broken`。發布未滿一個月的版本要特別查。
5. **周邊生態是否跟上**（僅跨 major）— 我們用的 plugin / preset 是否已支援目標 major。`scan.json` 的 `compat.reversePeers` 已列出所有宣告 peer 的套件與判定結果，先讀它再決定要查哪些。

寫入 `audit-reports/dep-audit-<label>/research.json`，格式與欄位語意見 `obsidian/skills/dep-audit/examples/research.example.json`（**必讀**）。要點：

- `key` 必須逐字等於 `package + "@" + version`，否則報告 join 不到、會顯示成「未做網路研究」。
- `sources` 只放真的讀過的網址。查不到就留空陣列，不要放搜尋結果頁充數。
- 決定不研究的項目 → 放 `notResearched` 並附理由。
- **檔案已存在（續跑）→ 先讀進來合併**，見 Parameters 的「續跑」節。不要整檔覆蓋掉前一輪的研究成果。

項目多（P0+P1 超過 5 項）時可並行派研究 subagent，一個 agent 負責一項，回傳的 JSON 由你彙整成單一 `research.json`；不確定時序列做也完全正確，寧慢勿亂。

## Step 4：實際用法佐證（在 codebase 找證據）

Step 3 查到的 breaking change，要對上我們**真的用到的 API 面**才有意義。對 `--scope` 內每項：

```bash
grep -rn "from ['\"]<套件名>" --include=*.ts --include=*.vue /Users/user/aladdin/<專案路徑>/src | head -30
```

- 找到 → 讀那幾個檔案，確認用到哪些 API、是否落在 advisory 的受影響路徑上、是否踩到 breaking change。證據寫進 `research.json` 的 `usageEvidence`（附 `file:line`）。
- 找不到 → 該套件多半是間接依賴或只在建置期使用。**寫「查無直接使用證據」，不要寫「不受影響」**——間接呼叫鏈仍可能觸發。
- 後端跨服務影響面若有疑慮，用 `method-call-graph` skill，不要自己臆測呼叫鏈。

## Step 5：Worktree 實測（`--skip-verify` 時跳過）

### 5.1 建環境

```bash
bash /Users/user/aladdin/obsidian/skills/dep-audit/dep-worktree.sh create <label> <repo...>
bash /Users/user/aladdin/obsidian/skills/dep-audit/dep-worktree.sh install <label>
```

`repo ∈ agrabah|abu|lago|rajah`，只帶本次要驗的。腳本會建 detached worktree、symlink `genie/jafar/jasmine`（相對路徑依賴少了會 install 失敗）、鏡像 `.env*`（缺了 vite build 會用另一組設定編譯，結果不可信）。最後一行 `WORKTREE_OK` / `INSTALL_OK n/n` 才算成功；`INSTALL_PARTIAL` → 讀 `<worktree>/.install-<proj>.log` 判斷，裝不起來的專案整個放進 `notVerified`，不要硬驗。

install 慢屬正常（agrabah + abu + lago 全裝可能十幾分鐘），畫面無輸出不代表卡住。

### 5.2 基準線（**不可跳過**）

**先在未升版狀態跑一次** `projects.json` 內該專案的 `verify` 指令，逐項記錄 PASS/FAIL 與耗時。

沒有基準線就無法區分「升版打壞的」和「本來就壞的」。兩個實測到的例子：`rajah` 的 `bun run build` 指向不存在的 `build.ts`，在 `origin/dev` 上就是紅的；`agrabah` 的 `tsc --noEmit` 在主 repo 就有 753 個既有型別錯誤（2026-07-29 實測）。把這些當成升版回歸會得出完全錯誤的結論。

**基準線是紅的時候，比對必須逐行做**：把 baseline 與 after 的錯誤行各自排序後 `diff`，只有「零新增行」才算非回歸。只比錯誤總數會漏掉「舊錯誤消失、新錯誤出現」的等量替換。

```bash
cd /Users/user/aladdin/worktrees/dep-audit-<label>
grep -E "error TS" .verify-baseline-<proj>-<step>.log | sort > /tmp/b.txt
grep -E "error TS" .verify-after-<proj>-<step>.log    | sort > /tmp/a.txt
diff /tmp/b.txt /tmp/a.txt          # 有 ">" 行＝升版新增的錯誤＝回歸
```

### 5.3 升版

在 **worktree 內**改 package.json：

- **直接依賴**：直接改版本宣告，再跑該專案的 `install` 指令。
- **間接依賴**：優先升「能帶動它的父套件」（看 `dependents[].via`）。父套件無新版時，才在 worktree 的 package.json 加 `overrides`（bun 與 npm 皆支援）：
  ```json
  { "overrides": { "<套件名>": "<目標版>" } }
  ```
  用了 `overrides` 必須在 `research.json` 的 `migrationSteps` 寫明——這是要一併帶進正式修改的東西，漏掉等於升版沒生效。

**驗證粒度**：P0/P1 一次只升一個套件、單獨驗證（失敗才能歸因）。P2/P3 可同專案批次升；批次失敗時二分法拆開重驗，不要把整批標成 BLOCKED。

### 5.4 升版後驗證

重跑同一組 `verify` 指令，逐項記錄。此外：

- agrabah 的預設驗證不含 `bun test`（多數測試需 DB，worktree 未跑 bootstrap/migrate）。若 Step 4 找到該套件的使用位置且附近有測試，**額外針對那些測試檔跑** `bun test <path>` 並記進 `after`。
- 指令用 pipe 接 `tail` 時，`$?` 拿到的是 `tail` 的結果。要判斷成敗請用 `${PIPESTATUS[0]}`，或不接 pipe 直接看 exit code。

### 5.5 判定

| verdict | 條件 |
|---|---|
| `SAFE` | 基準線綠、升版後也綠；或基準線紅、升版後**錯誤行集合完全相同** → 非回歸 |
| `SAFE_WITH_CHANGES` | 升版後需連帶改碼才綠；改了什麼寫進 `codeChangesNeeded` |
| `BLOCKED` | 升版後仍紅且無法在合理成本內解決 |
| `NOT_VERIFIED` | 沒實測（含 install 失敗） |

寫入 `audit-reports/dep-audit-<label>/verify.json`，格式見 `obsidian/skills/dep-audit/examples/verify.example.json`（**必讀**）。檔案已存在（續跑）→ 先讀進來合併，規則同 Step 3。

### 5.5b 實測環境的三個已知限制（判定前必看）

1. **`genie` / `jafar` / `jasmine` 在 worktree 內是主 repo 的 symlink**，改它們的 `package.json` 等同改主 repo，鐵律禁止。因此「共用庫自己的依賴升版」（例：genie 釘死 `protobufjs: 8.0.0`）**無法在本流程中實測**——一律放進 `notVerified` 並寫明此原因。替代的間接證據：在下游專案（agrabah）用 `overrides` 強制同一版本後驗證，可證明該版本在此 runtime 下可編譯，但不等於驗過共用庫本身。
2. **agrabah 的 `bun run lint` 會改檔**（`eslint --fix "**/*"`）。基準線那一跑就已經把可自動修的問題修掉了，所以基準線必須在任何升版動作**之前**跑完；順序顛倒會讓兩次比較失去意義。
3. **agrabah 全量 lint 在 `--max-old-space-size=8192` 下會 OOM**（2026-07-29 實測：8076 MB 撞頂、SIGABRT + `<--- Last few GCs --->`）。已依 `.claude/doctrine/refs/build-oom.md` 把 `projects.json` 調到 16384。若換機器仍 OOM，照該 doctrine 處理，**不要縮小 lint 範圍或關掉 type-aware rules**。基準線與升版後必須用**同一個** heap 上限跑，否則不可比。

### 5.6 收工

```bash
bash /Users/user/aladdin/obsidian/skills/dep-audit/dep-worktree.sh remove <label>
```

**確認報告已產出後才移除**（Step 6 之後）。移除前若使用者可能想自己看，先問。

## Step 6：產出 HTML 報告

```bash
bun /Users/user/aladdin/obsidian/skills/dep-audit/build-report.ts <label>
```

- 輸出 `audit-reports/dep-audit-<label>/dependency-audit-<label>.html`（單檔、無外部資源、可直接寄給主管）。
- 最後印 `REPORT_OK <path>`；若提示缺 `research.json` / `verify.json`，代表該層級全未做——確認這是預期的（如 `--skip-verify`）才繼續。
- 報告產生後**開一次確認渲染正常**（有 Playwright：`cqa-e2e/node_modules/playwright`）。至少確認項目數與 `scan.json` 一致、篩選器能動。

## Step 7：回報使用者

一則訊息收尾，含：

- 掃描範圍（幾個專案、幾組唯一套件版本）與嚴重度分布
- **P0 / P1 逐項一行**：`套件@現版 → 目標版（幅度）| 影響專案 | 實測結果`
- 需跨 major 或需 `overrides` 的項目，各一句成本說明
- 明確列出 `notResearched` / `notVerified` 的項目與理由（**不要省略**）
- 報告路徑

不要在對話中複述報告全文——事實源是 HTML 檔。

## Notes

1. **本流程唯讀主 repo**。升版只發生在 `worktrees/dep-audit-<label>/`。要把結論落地成真正的修改，是另一件事（走 `/create-mr` 或人工），本流程不做。
2. **快取**：OSV advisory 快取 24h、registry metadata 6h，存在 `audit-reports/.dep-audit-cache/`。同日重跑很快（實測全量 20 秒→5 秒）。懷疑資料過時用 `--no-cache`。
3. **重跑語意**：同 label 重跑＝續跑，`scan.json` 與 HTML 覆蓋更新，`research.json` / `verify.json` **合併**（見 Parameters「續跑」節）。要保留舊批次整份就換 label。
4. **報告的誠實性是硬要求**：`build-report.ts` 會把沒有 research / verify 的項目明確標成「未做網路研究」/「未實測」，並在「方法論與已知限制」列出 `notResearched` / `notVerified`。**不要為了讓報告好看而填空欄位**——這份報告的價值全部建立在「標示綠燈的項目是真的驗過」上。
5. **不涵蓋範圍**（報告已載明，回報時若被問到要能答）：非 npm 生態相依（Docker base image、系統套件）、私有 registry 套件、尚未公開揭露的漏洞。
6. **要改掃描範圍 / 驗證指令 / 報告版型**：先讀 `.claude/doctrine/40-maintenance-protocol.md`，再改 `projects.json` / `build-report.ts`。新增專案時務必先在主 repo 實測其 `verify` 指令能跑，否則基準線全紅、比較失去意義。
