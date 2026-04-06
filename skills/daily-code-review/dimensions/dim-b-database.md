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

> 以上為重點檢查項，不限於此。基於你的專業判斷，覆蓋該維度的其他潛在問題。
