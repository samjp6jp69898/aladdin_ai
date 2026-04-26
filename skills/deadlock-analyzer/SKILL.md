---
name: deadlock-analyzer
description: 分析指定 server 中哪些 transaction 持有指定 table 的鎖，並交叉比對 deadlock 風險。Use when: deadlock 分析、死鎖排查、transaction 鎖分析、找 deadlock、哪些 transaction 鎖了這張表、lock order、deadlock-analyzer。
---

# Deadlock Analyzer

靜態分析 agrabah codebase 中所有 `doTransaction` 區塊，找出持有指定 table 鎖的 transaction，並交叉比對潛在 deadlock 風險。

**Scanner script 位置**：`/Users/user/aladdin/.claude/skills/deadlock-analyzer/deadlock-scanner.ts`

**指令格式**：`/deadlock-analyzer <server> <table_name>`

---

## Step 0: table-locate（定位 Db* class）

```bash
bun /Users/user/aladdin/.claude/skills/deadlock-analyzer/deadlock-scanner.ts table-locate "<server>" "<tableName>"
```

輸出 JSON：`{ tableName, dbClasses: [{name, file, line, tableName}], server }`

若 `dbClasses` 為空 → 回報找不到表，並停止。
若有多個候選表 → 列出讓使用者選擇。

記錄 `dbClasses` 的 name 清單（如 `["DbAppUserWallet"]`）供 Step 1 使用。

## Step 1: scan-transactions（掃描 transaction scope）

```bash
bun /Users/user/aladdin/.claude/skills/deadlock-analyzer/deadlock-scanner.ts scan-transactions "<server>" "<tableName>" '<dbClassNamesJsonArray>'
```

其中 `<dbClassNamesJsonArray>` 為 Step 0 取得的 dbClass 名稱 JSON 陣列，例如 `'["DbAppUserWallet"]'`。

輸出 JSON 包含：
- `transactions[]`：每個命中的 transaction scope，含 operations 清單（table、lockType、condition、行號等）
- `needsVerification[]`：無法靜態解析的 case

將完整輸出寫入暫存檔：`/tmp/deadlock-scan-result.json`

## Step 2: Agent 審核 needsVerification

對 `needsVerification` 陣列中每個項目：

1. Read 該 `file:line` 的上下文（±15 行）
2. 根據 reason 判斷：
   - `cannot resolve inserted DbClass`：找到插入的物件型別，確認對應表名
   - `cannot resolve table from raw SQL`：找到 SQL 語句，確認表名
   - `SQL in variable, cannot resolve statically`：找到 SQL 變數定義，確認表名與操作
3. 將審核結果**補入對應 transaction 的 operations 陣列**（更新 `/tmp/deadlock-scan-result.json`）
4. 也檢查 operations 為空但有 loadObject 的 scope（可能 scope 包含目標表但操作沒被提取到）

**若 `needsVerification` 為空 → 跳過此步驟。**

## Step 3: cross-compare（交叉比對 deadlock 風險）

```bash
bun /Users/user/aladdin/.claude/skills/deadlock-analyzer/deadlock-scanner.ts cross-compare /tmp/deadlock-scan-result.json
```

輸出 JSON：`{ riskPairs: [...], summary: { high, medium, low } }`

三種風險模式：
- **LOCK_ORDER_INVERSION**（HIGH）：兩個 transaction 對相同的表集合以相反順序取鎖
- **GAP_CONTENTION**（MEDIUM）：兩個 transaction 都對同一表取 range/gap lock
- **INSERT_VS_GAP**（MEDIUM）：一個 transaction INSERT，另一個對同表取 range lock

## Step 4: 格式化輸出

將結果整合為以下格式，直接輸出到對話中（不寫檔案）：

```
# Deadlock Analysis: <tableName>

Server: <server>
ORM Classes: <DbClass1>, <DbClass2>, ...
Transactions containing this table: N

===============================================================
Transaction Scopes
===============================================================

▸ TX-1: <ClassName>.<methodName> (<file>:<startLine>-<endLine>)
  DB Source: <dbSource>
  Tables & Locks (in execution order):
    1. [ROW_X]            <table>    — <operation> (line XX)
    2. [INSERT_INTENTION] <table>    — <operation> (line XX)

▸ TX-2: ...

===============================================================
Deadlock Risk Analysis
===============================================================

（若有風險 pair：）

🔴 HIGH: Lock Order Inversion
  TX-A (<method>) vs TX-B (<method>)
  TX-A locks: tableX → tableY
  TX-B locks: tableY → tableX

🟡 MEDIUM: Gap Lock Contention
  TX-A vs TX-B
  Both acquire range locks on <table>

（若無風險：）
✅ No deadlock risk patterns detected.

===============================================================
Summary
===============================================================
- Transactions analyzed: N
- Tables involved: M (listed)
- Risk pairs: 🔴 HIGH(X) 🟡 MEDIUM(Y)
- Unresolvable cases: U
```

### Lock Type 說明

| Lock Type | 說明 |
|-----------|------|
| `ROW_X` | FOR UPDATE + 單行 WHERE (id = ?)，排他行鎖 |
| `RANGE_X` | FOR UPDATE + 範圍 WHERE，gap lock + next-key lock |
| `INSERT_INTENTION` | INSERT / insertObject，插入意向鎖 |
| `ROW_X_UPDATE` | UPDATE + 單行 WHERE，排他行鎖 |
| `RANGE_X_UPDATE` | UPDATE + 範圍 WHERE，可能 gap lock |
| `ROW_X_DELETE` | DELETE + 單行 WHERE，排他行鎖 |
| `RANGE_X_DELETE` | DELETE + 範圍 WHERE，gap lock |
| `NO_LOCK` | 普通 SELECT / loadObject（無 FOR UPDATE），快照讀不加鎖 |
| `UNKNOWN` | 無法靜態判定 |

**最後，結束。不需要額外的解釋或建議。**
