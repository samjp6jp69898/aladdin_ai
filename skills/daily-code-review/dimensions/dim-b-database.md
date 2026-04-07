# Dimension B: 資料庫與 SQL

> 適用於：agrabah（含 migration 檔案）

## 核心檢查方向

1. **命名規範**：表名用複數 + 小寫 + 底線；欄位不用 camelCase；ID 欄位用 `xxxx_id`；排序欄位用 `sort_order`
2. **型別規範**：金額必用 `BIGINT`；ID 用 `BIGINT UNSIGNED`；狀態欄位用 `TINYINT`；禁用 `DECIMAL`。`TEXT` 型別原則上禁止，但 `ILocalizationString`（i18n）和 `ICurrencyLink`（幣別關聯）可用 JSON，其他 JSON 用法需有充分理由
3. **Index 設計**：每表不超過 7 個 index；複合 index 不超過 5 欄；高基數欄位在前；用 `CREATE INDEX` 不用 `KEY`；不指定 `USING BTREE`
4. **SQL 安全**：禁止 `SELECT *`；UPDATE/DELETE/SELECT 必須有 WHERE；必須使用 `?` placeholder，禁止字串拼接 SQL
5. **N+1 查詢**：迴圈內不可有不必要的 DB 查詢
6. **Migration 安全**：`ALTER TABLE` 必須提供 DEFAULT 值；`DROP COLUMN`/`DROP TABLE` 必須確認無程式碼引用

## 專案特有規則（地雷）

- 🔴 **DbObject 必須定義 tableName**：所有 `DbObject` 子類（在 `src/database_types/`）透過 `QueryObject` 連接的**必須**包含 `static readonly tableName = '<table_name>'`。自動命名已移除（Jasmine code size optimization），缺少會造成 runtime error
- 🔴 **SQL `IN ()` 空陣列檢查**：任何 `IN (?)` 查詢前**必須**檢查陣列是否為空；空陣列產生 `IN ()` 會造成 MySQL errno 1064 語法錯誤
- **禁止 ON DUPLICATE KEY**：禁止使用 `INSERT INTO ... ON DUPLICATE KEY UPDATE`，改用 `SELECT FOR UPDATE` 或 Redis Lock 判斷 INSERT vs UPDATE
- **禁止 Foreign Key**：不使用 FK，參照完整性由應用層強制
- **ORM base class 選擇**：`DbObject` 必須使用正確的 base class：`WithTimestamp`（含 createdAt/updatedAt）、`WithPlatformAndTimestamp`（額外含 platformId）
- **Migration 檔名格式**：`YYYYMMDDhhmm_<action>_<table_name>.sql`

## SQL 欄位驗證（必查）

- **引用不存在的欄位**：SQL 查詢中使用的欄位名（如 `user_id`）必須確實存在於目標表中。特別注意 1:1 關聯表（如 `user_login_details`）的 PK `id` 可能就是 user ID，不存在額外的 `user_id` 欄位
- **ORDER BY 與 GROUP BY 的多餘/缺失**：1:1 表查詢不需要 `ORDER BY`；分頁查詢必須有 `ORDER BY`
- **欄位映射與 JOIN 一致性**：SELECT 中的 alias（如 `ur.created_at as registerTime`）必須語義正確，特別是重構後 JOIN 對象改變時，原本從 A 表取的欄位可能被錯誤地從 B 表取得

## 其他必查項

- **審計欄位**：每表必須含 `created_at`、`updated_at`
- **隱式型別轉換**：WHERE 或 JOIN ON 中比較的兩側型別是否一致（如字串欄位禁用數字比較 `WHERE varchar_col = 123`），不同編碼欄位 JOIN 會導致索引失效
- **CHARACTER SET 一致性**：`currency_code` 是否使用 `latin1`，其餘是否使用 `utf8mb4`；JOIN 的兩側欄位編碼是否一致
- **Transaction 鎖定順序**：使用 `FOR UPDATE` 的交易中，多表/多行鎖定是否遵循一致的順序，避免 deadlock
- **Transaction 範圍最小化**：`doTransaction` 區塊內是否包含不必要的操作（如 RPC 外部呼叫、日誌寫入、快取操作），避免長時間持有鎖
- **大表 ALTER 安全**：ALTER TABLE 目標是否為高流量/大資料量表，是否可使用 `ALGORITHM=INSTANT`（加欄位到末尾）避免 metadata lock 阻塞 DML
- **禁止 VARCHAR 存多值**：禁止 VARCHAR 逗號分隔存多值（如 `"10,50,100"`），必須另開表做一對多（金額用 `amountLinkManager`，ID 對應用 remote 呼叫 `app_user` 的 `LinkManager`）
- **排序欄位命名**：排序欄位統一命名 `sort_order`（非 `sortId`），手動填的類型預設值為 `1000`，查詢排序 `ORDER BY sort_order, id ASC`
- **敏感資訊加密儲存**：密碼或敏感資訊（用戶個人資料）是否使用 `Security.encrypt` 加密儲存，而非明文存入資料庫
- **型別規範補充**：`INT`/`SMALLINT` 不定義長度；`VARBINARY` 欄位名以 `_binary` 結尾
- **Migration 補充**：新增 database 是否在 `migrations/database.sql` 中加入 `CREATE DATABASE IF NOT EXISTS`

> 以上為重點檢查項，不限於此。基於你的專業判斷，覆蓋該維度的其他潛在問題。
