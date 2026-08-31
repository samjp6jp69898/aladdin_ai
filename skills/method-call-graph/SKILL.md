---
name: method-call-graph
description: 分析指定 service method 的呼叫鏈，支援四種模式：完整四維度（同 server + 跨 server + 前端 + 三方回調）、local-only（只本服務 caller）、cross-only（只跨服務 gRPC caller）、Table CRUD 模式。Use when: 分析方法呼叫鏈、列出 caller、找 method 被誰呼叫、本服務影響範圍、跨服務影響範圍、who calls this method、find callers、table CRUD 追蹤、哪些方法操作這張表。
---

# Method Call Graph

使用 Bun script 處理所有確定性操作（grep + 過濾 + BFS + 繼承鏈解析），agent 只負責審核 `needsVerification` 的 case 和最終格式化輸出。

**Scanner script 位置**：`/Users/user/aladdin/aladdin_ai/skills/method-call-graph/call-graph-scanner.ts`

支援以下模式：

| 模式 | 指令 | 用途 |
|------|------|------|
| **Service Method 模式**（預設、四維度全掃） | `/method-call-graph <ServiceClass>.<method>` | 同 server + 跨 server + 前端 + 三方回調觸發鏈 |
| **Service Method local-only** | `/method-call-graph local <ServiceClass>.<method>` | **只**跑同 server caller，跳過跨 server / 前端 / entries |
| **Service Method cross-only** | `/method-call-graph cross <ServiceClass>.<method>` | **只**跑跨 server gRPC caller，跳過其他三維度 |
| **Table CRUD 模式** | `/method-call-graph table <server> <table_name>` | 追蹤指定 server 中哪些方法操作該表 + BFS caller |

**模式判斷**：
- 第一個 arg 為 `table` → Table CRUD 模式
- 第一個 arg 為 `local` → Service Method local-only 模式
- 第一個 arg 為 `cross` → Service Method cross-only 模式
- 否則 → Service Method 完整模式

**選用建議**：
- 用戶問「這個 method 在自己 server 內有誰呼叫？」「重構這個 helper 會影響什麼？」 → `local`
- 用戶問「哪些 server 透過 gRPC 呼叫這個 method？」「這支 RPC 跨服務影響範圍？」 → `cross`
- 用戶問「完整呼叫鏈」「整個 method 的影響面」「找入口」 → 不加旗標，跑完整四維度

---

# 模式一：Service Method 模式

## Step 0: Reconnaissance（Script 執行）

```bash
bun call-graph-scanner.ts resolve-method "<input>"
```

輸出 JSON：`{ targetFile, targetLine, targetClass, baseClass, targetMethod, targetServer, rajahServiceName }`

記錄所有欄位供後續使用。若 `error` 欄位存在 → 回報錯誤並停止。

**推導 RPC method name**：`targetMethod` 如果以 `method` 開頭（如 `methodChangeUserBalance`），RPC name = 去掉 `method` 前綴的 PascalCase（`ChangeUserBalance`）。否則 RPC name = 首字母大寫的 `targetMethod`。

## Step 1: 三方 Entry 偵測（Script 執行）

```bash
bun call-graph-scanner.ts detect-entries
```

輸出 JSON：`{ callbackEntries: [{file, methods}], pullJobEntries: [{file, method}] }`

將結果寫入暫存檔 `/tmp/entries.json` 供 Step 2 Agent 4 使用。

## Step 2: 並行執行 4 個 Script + 審核

在同一個 message 中使用 Bash tool 並行執行以下 4 個 script 命令：

### Agent 1 — 同 server caller

```bash
bun call-graph-scanner.ts same-server-callers "<targetFile>" "<targetClass>" "<targetMethod>" "<targetServer>" --base-class=<baseClass> --base-method=<targetMethod>
```

### Agent 2 — 跨 server gRPC caller

```bash
bun call-graph-scanner.ts cross-server-callers "<RpcMethodName>" "<targetServer>" "<rajahServiceName>"
# 或便捷格式（自動解析 server / rajahServiceName，RPC name 與 method 前綴 handler name 皆可）：
bun call-graph-scanner.ts cross-server-callers "<ServiceClass.RpcMethodName>"
```

注意：這裡用 **RPC method name**（PascalCase，無 `method` 前綴），因為跨 server 呼叫用的是 `context.remote.*.*.RpcMethodName()`。

### Agent 3 — 前端 caller

```bash
bun call-graph-scanner.ts frontend-callers "<RpcMethodName>"
```

### Agent 4 — 三方回調觸發鏈

```bash
bun call-graph-scanner.ts reverse-bfs-to-entries "<targetFile>" "<targetClass>" "<targetMethod>" "<targetServer>" --entries-json=/tmp/entries.json --rpc-name=<RpcMethodName>
```

注意：`--rpc-name` 傳入 RPC method name（PascalCase），讓反向 BFS 同時搜尋 `methodXxx` 和 `Xxx` 兩種名稱。

## Step 3: 審核 needsVerification

4 個 script 的 JSON 輸出中，`needsVerification` 陣列列出需要人工驗證的 case（receiver type 不確定）。

**審核流程**（每個 `needsVerification` 項目）：

1. Read 該 `file:line` 的上下文（±15 行）
2. 判斷 receiver 變數的型別是否指向 target class
3. 若匹配 → 保留；若不匹配 → 從結果中移除；若無法判定 → 標記 UNRESOLVABLE

**若 `needsVerification` 為空 → 跳過此步驟。**

## Step 4: 整合輸出

讀取 `output-format-method.md` 的模板，將 4 個 script 的結果整合後直接輸出到對話中（不寫檔案）。

---

# 模式一-A：local-only（只看本 server 呼叫鏈）

當用戶只關心「同 server 內被誰呼叫」時，跳過 cross / frontend / entries 三個維度。

## 步驟

```bash
# 1. 解析 method
bun call-graph-scanner.ts resolve-method "<input>"

# 2. 只跑 same-server-callers
bun call-graph-scanner.ts same-server-callers "<targetFile>" "<targetClass>" "<targetMethod>" "<targetServer>" --base-class=<baseClass> --base-method=<targetMethod>
```

## Step L3: 審核 + 輸出

對 `needsVerification` 做型別驗證，輸出時只列「同 server caller」一節，明確告訴用戶「本次未掃跨服務 / 前端 / 三方入口，如需請改跑 `/method-call-graph <input>`（無 local 旗標）」。

---

# 模式一-B：cross-only（只看跨 server gRPC 呼叫）

當用戶只關心「哪些 server 透過 gRPC 呼叫這支 RPC」時，跳過 local / frontend / entries。

## 步驟

```bash
# 1. 解析 method
bun call-graph-scanner.ts resolve-method "<input>"

# 2. 推導 RPC name 後跑 cross-server-callers
bun call-graph-scanner.ts cross-server-callers "<RpcMethodName>" "<targetServer>" "<rajahServiceName>"
```

**RPC name 推導規則**：`targetMethod` 若以 `method` 開頭（如 `methodGetWallets`），RPC name = 去掉 `method` 前綴並保留 PascalCase（`GetWallets`）；否則 RPC name = `targetMethod` 首字大寫。

## Step C3: 審核 + 輸出

對 `needsVerification` 做型別驗證，輸出時只列「跨 server gRPC caller」一節，明確告訴用戶「本次未掃同 server / 前端 / 三方入口」。

---

# 模式二：Table CRUD 模式

## Step T0: 定位 Db* Class（Script 執行）

```bash
bun call-graph-scanner.ts table-locate "<server>" "<tableName>"
```

輸出 JSON：`{ tableName, dbClasses: [{name, file, line, tableName}], server }`

若 `dbClasses` 為空 → 回報找不到表，並停止。
若有多個候選表 → 列出讓使用者選擇。

## Step T1: 掃描 CRUD 操作點（Script 執行）

```bash
bun call-graph-scanner.ts table-crud "<server>" "<tableName>" '<dbClassNamesJsonArray>'
```

其中 `<dbClassNamesJsonArray>` 例如 `'["DbPaymentDiscountRecord"]'`。

輸出 JSON：`{ crud: { C: [...], R: [...], U: [...], D: [...] }, allRefs, stats, bfsTargets }`

## Step T2: BFS Caller 追蹤（Script 執行）

```bash
bun call-graph-scanner.ts table-bfs "<server>" '<bfsTargetsJsonArray>'
```

其中 `<bfsTargetsJsonArray>` = Step T1 輸出的 `bfsTargets` JSON 陣列。

輸出 JSON：`{ results: [{ target, callers, stats }] }`

## Step T3: 審核 + 整合輸出

**審核**：同模式一 Step 3，對 `needsVerification` 項目做型別驗證。

讀取 `output-format-table.md` 的模板，將結果整合後直接輸出到對話中（不寫檔案）。

---

# 給子代理的使用指引

子代理（Agent tool 派遣的 sub-agent）**無法呼叫 Skill tool**，但可以直接執行 scanner script。父代理派子代理進行呼叫鏈分析時，請複製以下資訊給它：

## Scanner 腳本位置

```
/Users/user/aladdin/aladdin_ai/skills/method-call-graph/call-graph-scanner.ts
```

（也可從 `/Users/user/aladdin/agrabah/.claude/skills/method-call-graph/call-graph-scanner.ts` 執行；兩處都會自動定位 agrabah 根目錄）

## 9 個 subcommand cheatsheet（給子代理）

| 用途 | 命令 |
|------|------|
| 解析 `<Class>.<method>` → 取得 file/line/server/baseClass/rajahServiceName | `resolve-method "<Class>.<method>"` |
| 同 server caller BFS | `same-server-callers "<file>" "<class>" "<method>" "<server>" --base-class=<X> --base-method=<Y>` |
| 跨 server gRPC caller | `cross-server-callers "<RpcMethodName>" "<server>" "<rajahServiceName>"` |
| 前端 caller（abu / lago） | `frontend-callers "<RpcMethodName>"` |
| 偵測三方 entry（callback / pull job） | `detect-entries` |
| 反向 BFS 到三方 entry | `reverse-bfs-to-entries "<file>" "<class>" "<method>" "<server>" --entries-json=/tmp/e.json --rpc-name=<RpcName>` |
| 定位 DB Class | `table-locate "<server>" "<tableName>"` |
| 掃描 table CRUD 點 | `table-crud "<server>" "<tableName>" '<dbClassesJsonArray>'` |
| Table BFS caller | `table-bfs "<server>" '<bfsTargetsJsonArray>'` |

## 子代理常用組合範例

**只查同 server caller**（最輕量，1 次 script）：
```bash
bun /Users/user/aladdin/aladdin_ai/skills/method-call-graph/call-graph-scanner.ts resolve-method "WalletService.methodGetWallets"
# 取出輸出後接：
bun /Users/user/aladdin/aladdin_ai/skills/method-call-graph/call-graph-scanner.ts same-server-callers \
    "/Users/user/aladdin/agrabah/src/servers/wallet/services/wallet.ts" \
    "WalletService" "methodGetWallets" "wallet" \
    --base-class=WalletBaseService --base-method=methodGetWallets
```

**只查跨 server gRPC caller**：
```bash
bun .../call-graph-scanner.ts resolve-method "WalletService.methodGetWallets"
# 推導 RPC name：methodGetWallets → GetWallets
bun .../call-graph-scanner.ts cross-server-callers "GetWallets" "wallet" "Wallet"
```

## 注意事項

- 所有 subcommand 輸出都是 **JSON 到 stdout**，子代理可直接 parse
- `needsVerification` 陣列若非空，子代理需 Read 相關 file:line 上下文做型別驗證後再決定是否保留
- 不要傳遞 stale 的 entries.json，每次新分析都重新跑一次 `detect-entries`
