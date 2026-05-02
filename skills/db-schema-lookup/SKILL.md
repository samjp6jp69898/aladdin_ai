---
name: db-schema-lookup
description: 從 migrations SQL 與 src/database_types ORM class 即時查 DB table schema、變更歷史、ORM 欄位定義。Use when 需要知道 table 當前 schema、欄位定義、CREATE / ALTER 變更歷史、index 變動、ORM class 對應、給 ORM class 反查 table 名。
---

# db-schema-lookup — 從 source 即時查 DB schema 與 ORM 對應

## 何時使用

- 「`app_user_wallets` 現在有哪些欄位？」
- 「`balance` 這個欄位是什麼時候從 INT 改成 BIGINT 的？」
- 「這個 table 有哪些 index？最近改過什麼？」
- 「給我 `DbAppUserTransaction` 對應的 table 與所有欄位」
- 「有哪些 table 名稱裡含 `wallet`？」

## 與 method-call-graph 的分工

**不要混淆**這兩個 skill：

| Skill | 焦點 | 關鍵問題 |
|-------|------|---------|
| **db-schema-lookup**（本 skill） | table 自身的 **schema 結構 + 變更歷史 + ORM 對應** | 「這張表長什麼樣？欄位、index、變更歷史？」「ORM class 有哪些欄位？」 |
| **method-call-graph** 的 `table-locate / table-crud / table-bfs` | **誰** 操作這張表（C/R/U/D）+ caller 鏈 | 「哪些方法 SELECT 這張表？」「哪些方法 UPDATE balance 欄位？」 |

簡單原則：問「**結構**」用 db-schema-lookup；問「**呼叫鏈**」用 method-call-graph。

## Source paths

| 路徑 | 內容 |
|------|------|
| `/Users/user/aladdin/agrabah/migrations/<domain>/<YYYYMMDDhhmm>_*.sql` | 1235+ 個 SQL migration，按 timestamp 排序就是時間順序 |
| `/Users/user/aladdin/agrabah/src/database_types/*.ts` | 47 個 ORM class 檔，每 class 含 `static readonly tableName = '...'` 與欄位宣告 |

**migration 檔名規則**：`YYYYMMDDhhmm_<verb>_<table>.sql`，常見 verb：`create` / `add` / `alter` / `drop` / `change` / `refine` / `recreate`。

**ORM 繼承**（來自 `database_types/base.ts`）：
- `DbObject` — 基類
- `WithCreateTimestamp` — 加 `createdAt`
- `WithTimestamp` — 加 `createdAt + updatedAt`
- `WithPlatformAndTimestamp` — 加 `platformId + createdAt + updatedAt`
- `WithSignAndTimestamp` — 加 sign 欄位（防竄改）+ timestamp

## 使用方式

```bash
bun /Users/user/aladdin/obsidian/skills/db-schema-lookup/db-lookup.ts <subcommand> <args>
```

輸出永遠是 JSON 到 stdout。每個結果都附 `file:line`，agent 必須直接讀 source 確認，不要只信摘要。

## Subcommand 速查表

| 場景 | 命令 |
|------|------|
| 找最新 CREATE TABLE 區塊 | `latest-create <tableName>` |
| 列出觸及該表的所有 migration（時序） | `list-migrations <tableName>` |
| 完整時間軸（含每個 ALTER / INDEX / DROP 的具體 line） | `table-history <tableName>` |
| 找 table 對應的 ORM class（含繼承 + 欄位） | `table-orm <tableName>` |
| 模糊找 table 名 | `find-table <keyword>` |
| 給 ORM class 名反查 | `find-orm <ClassName>` |

## 範例：典型查詢流程

### 場景 1：問「這張表現在長什麼樣？」

兩步：
1. `latest-create app_user_wallets` → 取得原始 CREATE TABLE 區塊（含預設值、PK、UNIQUE 等）
2. `table-history app_user_wallets` → 看後續所有 ALTER / INDEX 變更，自行心算當前狀態

**不要只看 latest-create**，因為 ALTER 可能改過欄位（如 `currency_id` → `currency_code`）。輸出會帶 warning 提示「N 個後續 migration」。

### 場景 2：問「balance 欄位是什麼時候改的？」

```bash
bun db-lookup.ts table-history app_user_wallets
```

→ `timeline[].matchedLines` 含每個 migration 中 grep 到 `app_user_wallets` 的具體行；對 balance 變更可進一步 Read 該 SQL 檔案確認。

### 場景 3：問「DbAppUserTransaction 對應哪張表？」

```bash
bun db-lookup.ts find-orm DbAppUserTransaction
```

→ 直接回傳 tableName + file:line + 所有欄位 + 繼承類別。

### 場景 4：模糊找

```bash
bun db-lookup.ts find-table user_wallet
```

→ tableName 含 `user_wallet` 的所有 table 與 ORM class 列表。

## 找不到時怎麼辦

1. **table 沒有 ORM**：可能該 table 純粹由 raw SQL 操作；用 `list-migrations` 確認 table 是否存在於 migration
2. **找不到 CREATE TABLE**：可能 table 已被 drop，或在更舊的 migration（不在當前 codebase）
3. **ORM 名拼錯**：用 `find-orm` 找近似類名，或 grep `class Db\w*<關鍵字>` 在 `agrabah/src/database_types/`

## 給子代理的提示

子代理可直接執行：
```bash
bun /Users/user/aladdin/obsidian/skills/db-schema-lookup/db-lookup.ts <subcommand>
```
不需要 Skill tool。

## 紀律

- **禁止**從 Codebase/_index 下的 `db-tables-index.md` 回答 schema 查詢；那是離線快照，可能落後 source
- **禁止**只看 ORM class 推斷 schema 結構：ORM 欄位可能與實際 DB 欄位不一致（被 ALTER 改過但 ORM 沒同步），必須交叉驗證 migration
- 引用 schema 時必須附 `file:line`，且該行真的讀過
- 涉及「當前真實 schema」的問題，最終以最新 migration 的累積結果為準（不是 latest-create 單一檔案）
