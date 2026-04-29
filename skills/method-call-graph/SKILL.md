---
name: method-call-graph
description: 分析指定 service method 的完整呼叫鏈：同 server caller、跨 server gRPC caller、前端 caller、三方回調觸發路徑。Use when: 分析方法呼叫鏈、列出 caller、找 method 被誰呼叫、呼叫鏈分析、method-call-graph、who calls this method、find callers、table CRUD 追蹤、哪些方法操作這張表。
---

# Method Call Graph

使用 Bun script 處理所有確定性操作（grep + 過濾 + BFS + 繼承鏈解析），agent 只負責審核 `needsVerification` 的 case 和最終格式化輸出。

**Scanner script 位置**：`call-graph-scanner.ts`

支援兩種模式：

| 模式 | 指令 | 用途 |
|------|------|------|
| **Service Method 模式**（預設） | `/method-call-graph <ServiceClass>.<method>` | 四維度完整呼叫鏈分析 |
| **Table CRUD 模式** | `/method-call-graph table <server> <table_name>` | 追蹤指定 server 中哪些方法操作該表 + BFS caller |

**模式判斷**：若第一個 arg 為 `table` → Table CRUD 模式，否則 → Service Method 模式。

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
