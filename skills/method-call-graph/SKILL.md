---
name: method-call-graph
description: 分析指定 service method 的完整呼叫鏈：同 server caller、跨 server gRPC caller、前端 caller、三方回調觸發路徑。Use when: 分析方法呼叫鏈、列出 caller、找 method 被誰呼叫、呼叫鏈分析、method-call-graph、who calls this method、find callers、table CRUD 追蹤、哪些方法操作這張表。
---

# Method Call Graph

使用 Bun script 處理所有確定性操作（grep + 過濾 + BFS + 繼承鏈解析），agent 只負責審核 `needsVerification` 的 case 和最終格式化輸出。

**Scanner script 位置**：`/Users/user/aladdin/.claude/skills/method-call-graph/call-graph-scanner.ts`

支援兩種模式：

| 模式 | 指令 | 用途 |
|------|------|------|
| **Service Method 模式**（預設） | `/method-call-graph <ServiceClass>.<method>` | 四維度完整呼叫鏈分析 |
| **Table CRUD 模式** | `/method-call-graph table <server> <table_name>` | 追蹤指定 server 中哪些方法操作該表 + BFS caller |

**模式判斷**：若第一個 arg 為 `table` → Table CRUD ��式，否則 → Service Method 模式。

---

# 模式一：Service Method 模式

## Step 0: Reconnaissance（Script 執行）

```bash
bun /Users/user/aladdin/.claude/skills/method-call-graph/call-graph-scanner.ts resolve-method "<input>"
```

輸出 JSON：`{ targetFile, targetLine, targetClass, baseClass, targetMethod, targetServer, rajahServiceName }`

記錄所有欄位供後續使用。若 `error` 欄位存在 → 回報錯誤並停止。

**推導 RPC method name**：`targetMethod` 如果以 `method` 開頭（如 `methodChangeUserBalance`），RPC name = 去掉 `method` 前綴的 PascalCase（`ChangeUserBalance`）。否則 RPC name = 首字母大寫的 `targetMethod`。

## Step 1: 三方 Entry 偵測（Script 執���）

```bash
bun /Users/user/aladdin/.claude/skills/method-call-graph/call-graph-scanner.ts detect-entries
```

輸出 JSON：`{ callbackEntries: [{file, methods}], pullJobEntries: [{file, method}] }`

將結果寫入暫存檔 `/tmp/entries.json` 供 Step 2 Agent 4 使用���

## Step 2: 並行執行 4 個 Script + 審核

在同一個 message 中使用 Bash tool 並行執行以下 4 個 script 命令：

### Agent 1 — 同 server caller

```bash
bun /Users/user/aladdin/.claude/skills/method-call-graph/call-graph-scanner.ts same-server-callers "<targetFile>" "<targetClass>" "<targetMethod>" "<targetServer>" --base-class=<baseClass> --base-method=<targetMethod>
```

### Agent 2 — 跨 server gRPC caller

```bash
bun /Users/user/aladdin/.claude/skills/method-call-graph/call-graph-scanner.ts cross-server-callers "<RpcMethodName>" "<targetServer>" "<rajahServiceName>"
```

注意：這裡用 **RPC method name**（PascalCase，無 `method` 前綴），因為跨 server 呼叫用的是 `context.remote.*.*.RpcMethodName()`。

### Agent 3 — 前端 caller

```bash
bun /Users/user/aladdin/.claude/skills/method-call-graph/call-graph-scanner.ts frontend-callers "<RpcMethodName>"
```

### Agent 4 — 三方回調觸發鏈

```bash
bun /Users/user/aladdin/.claude/skills/method-call-graph/call-graph-scanner.ts reverse-bfs-to-entries "<targetFile>" "<targetClass>" "<targetMethod>" "<targetServer>" --entries-json=/tmp/entries.json --rpc-name=<RpcMethodName>
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

將 4 個 script 的結果整合為以下格式，直接輸出到對話中（不寫檔案）：

```
# 方法呼叫鏈分析：<targetClass>.<targetMethod>

目標檔案：<relPath(targetFile)>:<targetLine>
所屬 server：<targetServer>
繼��鏈：<targetClass> extends <baseClass>（若無繼承則省略此行）

═���═════════════════════════════════════════════════════
① 同 server 呼叫（共 N 筆，BFS 完整追蹤）
════════════���═════════════════════════════��════════════

（從 same-server-callers 的 callers 陣列格式化：
  [直接] <file>:<line> — <className>.<methodName>
  [L2]   <file>:<line> — <className>.<methodName>
    └─ 被 <calledBy> 呼叫
按 level 排列，同 level 按 file:line 排列）

═══════════════════════════════════════════════════════
② 跨 server gRPC 呼叫（共 N 筆）
════════��══════════════════════════════════════════════

（從 cross-server-callers 的 callers 陣列格式化，按 server 分組：
- server: <serverName>
  <file>:<line> — <className>.<methodName>
  gRPC path: <gRpcPath>

過濾掉 gRpcPath 為 null 且 needsVerification 被排除的項目。
過濾掉 content 只是 logger/error message 中包含 method name 的 false positive。）

═��═════════════════════════════════���═══════════════════
③ 前端���叫（共 N 筆）
═════════════════���═════════════════════════════════════

（從 frontend-callers 的 projects 陣列格式化：
[project-name]  <file>:<line> — <content 摘要>
若 hasMethod=false → generated client 中無此 method，已跳過）

════���══════════════════════════════��═══════════════════
④ 三方回調觸��鏈（共 N 條命中路徑）
════════════════���══════════════════════════════════════

（從 reverse-bfs-to-entries 的 matchedPaths 格式化：
🎯 命中：<entryMethod>
  鏈路：
    [Entry] <chain[0].file>:<chain[0].line> — <chain[0].className>.<chain[0].methodName>
       ↓
    ... 中間節點 ...
       ↓
    <chain[-1].file>:<chain[-1].line> — target method
  類型：<entryType>）

═══════════════════════════════���═══════════════════════
統計
═══════════════════════════════════════════════════════
- 同 server 直接 caller：X，transitive caller：Y
- 跨 server gRPC caller：Z
- 前端使用點：W
- 三方回調入口：V
- 無法靜態解析 case：U
```

**最後，結束。不需要額外的解釋或建議。**

---

# ��式二：Table CRUD 模���

## Step T0: 定位 Db* Class（Script 執行）

```bash
bun /Users/user/aladdin/.claude/skills/method-call-graph/call-graph-scanner.ts table-locate "<server>" "<tableName>"
```

輸出 JSON：`{ tableName, dbClasses: [{name, file, line, tableName}], server }`

若 `dbClasses` 為空 → 回報找不到表，並停止。
若有多個候選表 → 列出讓使用者選擇。

## Step T1: 掃描 CRUD 操作點（Script 執��）

```bash
bun /Users/user/aladdin/.claude/skills/method-call-graph/call-graph-scanner.ts table-crud "<server>" "<tableName>" '<dbClassNamesJsonArray>'
```

其中 `<dbClassNamesJsonArray>` 例如 `'["DbPaymentDiscountRecord"]'`。

輸出 JSON：`{ crud: { C: [...], R: [...], U: [...], D: [...] }, allRefs, stats, bfsTargets }`

## Step T2: BFS Caller 追蹤（Script 執行）

```bash
bun /Users/user/aladdin/.claude/skills/method-call-graph/call-graph-scanner.ts table-bfs "<server>" '<bfsTargetsJsonArray>'
```

其中 `<bfsTargetsJsonArray>` = Step T1 輸出的 `bfsTargets` JSON 陣列。

輸出 JSON：`{ results: [{ target, callers, stats }] }`

## Step T3: 審核 + 整合輸出

**審核**：同模式一 Step 3，對 `needsVerification` 項目做型別驗證。

**輸出格��**：

```
# Table CRUD 追蹤：<tableName>

對應 ORM Class：<dbClass1>, <dbClass2>, ...
所屬 Server：<server>
掃描範圍：servers/<server>/ + managers/

═════════════════════════════════════════���═════════════
🟢 CREATE（共 N 筆）
═══════��═══════════════════════════════════════════════

（從 crud.C 格式化，每個 method 一個 ▸ 區塊：
▸ <className>.<methodName> (<file>:<line>)
  操作：<operation>
  callers:
    （從 table-bfs results 中找到對應 target 的 callers，格式化為：
    [���接] <file>:<line> — <className>.<methodName>
    [L2]   <file>:<line> — <className>.<methodName>
      └─ 被 <calledBy> 呼叫）

════════════════════════════════════��══════════════════
🔵 READ（共 N 筆）
══���═══════════════════════════════��════════════════════
（同上格式）

═══════════��════════════════════════��══════════════════
🟡 UPDATE（共 N 筆）
════��════════════════��═════════════════════════��═══════
（同上格式。若同一 method 有多處 UPDATE SQL，列出每處的行號與 SQL 摘要）

═══════════════════════════════════════════════════════
🔴 DELETE（�� N 筆）
════════════════════════���══════════════════════════════
（若無：「無 DELETE 操作。」）

═════════════════════════════════���═════════════════════
統計
════���═════════════════════════��════════════════════════
- ORM Class 數：X（<列出 class 名>）
- CRUD 操作點：🟢C(a) 🔵R(b) 🟡U(c) 🔴D(d)，共 N 個 method
- BFS 追蹤 caller 總數：M
- 無法靜態解析 case：U

💡 可使用 /method-call-graph <ClassName>.<methodName> 對感興趣的方法做完整四維度分析（跨 server / 前端 / 三方回調）
```

**最後，結��。不需要額外的解釋或建議。**
