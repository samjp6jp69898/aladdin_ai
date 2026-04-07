# Dimension E: Rajah / Protobuf

> 適用於：rajah（及涉及 RPC 的 agrabah commits）

## 核心檢查方向

1. **Service 定義**：Method 參數型別和回傳型別正確
2. **Client 設定**：`rajahClientFilenames` 包含所有依賴；陣列中無重複項目
3. **Service 設定**：`rajahServiceFilenames` 完整
4. **Service Groups**：`rajahClientServiceGroups` 的 server/service 對應正確；key 必須用 PascalCase
5. **Generated code**：`src/generated/` 禁止手動修改
6. **Field number**：Model 中的 field number 必須遞增不跳號；已刪除的 field number 禁止重複使用（protobuf 序列化相容性）
7. **Enum number**：新 enum 值必須遵循模組 number range，依序遞增不跳號不重複

## 專案特有規則（地雷）

- **@Permission vs Internal RPC**：server-to-server 內部 RPC 呼叫（`context.remote.xxx`）**不受** `@Permission` 約束，不要誤判為權限問題。`@Permission` 僅適用於外部（前端）請求
- **前後台 model 分離**：後台專用 model 和 service 必須定義在 `{server}_back_office.rajah`；前端 service 回傳值必須使用前端定義的 model，不可直接用 back_office model
- **Access control attributes**：後台 service 必須有 `@Permission`；前端需登入的操作必須有 `@LoginRequired`；僅供內部 RPC 的 service 必須有 `@NoPublic`
- **共用定義位置**：跨多個 server 共用的 enum/model 定義在 `common.rajah`；僅單一 server 使用的不可放 common
- **命名長度限制**：Service name ≤ 30 字元；Method name ≤ 50；Permission name ≤ 50（含 `.` 分隔符）
- **service_common 引用限制**：`service_common.rajah` 僅供後端（agrabah）使用，**禁止**在 lago 專案中 import

## 其他必查項

- **@Reflection 完整性**：前端 DataTable/DataSearch/DataEditPopup 使用的 model 是否加上 `@Reflection`；純內部 model 不應多加 `@Reflection`
- **@Rules 驗證一致性**：需前端驗證的欄位是否加上適當的 `@Rules`（`Required`、`Range`、`MaxLength`），且規則是否與後端業務邏輯一致
- **@Type 正確性**：欄位的 `@Type` 是否正確對應資料用途（金額 = `Currency`、圖片 = `File:Image`、日期範圍 = `DateTimeRange:Start/End`），直接影響前端 Reflection UI 渲染
- **欄位型別規範**：金額必須用 `i64`（對應 BIGINT）不得用 `i32`；開關功能應使用 `StatusEnum` 而非 `bool`；可能擴展的狀態應使用 enum 而非 bool
- **page/pageSize 位置**：`page` 和 `pageSize` 參數是否放在函式末尾，而非包在 model 中
- **@Union model 正確性**：`@Union` model 的欄位是否互斥（同一時間只有一個有值），提交時是否建立全新 Union 物件（`UnionModel.create()`）而非修改既有物件，`valueType` 鑑別欄位是否正確使用

> 以上為重點檢查項，不限於此。基於你的專業判斷，覆蓋該維度的其他潛在問題。
