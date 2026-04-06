# Dimension C: TypeScript / 程式碼品質

> 適用於：agrabah, abu, lago

## 核心檢查方向

1. **Import 風格**：必須使用單引號；本地模組含 `.ts` 副檔名；禁止雙引號 `"`
2. **型別安全**：`any` 允許但不鼓勵，使用時須註解原因；null/undefined 必須有 guard（`|| ''`、`?.` 等）
3. **金額計算**：必須使用 `RateHelper.normalToStored` / `storedToNormal`
4. **語言/幣別**：必須使用 `context.language` / `context.defaultCurrencyCode`
5. **硬編碼**：不可有 hardcoded ID、URL 等
6. **Debug 殘留**：不可有 `console.log`、`debugger` 等
7. **錯誤碼範圍**：必須使用正確的 `AgrabahErrorCodeEnum` 範圍（按模組區段）；新錯誤碼必須在模組範圍內依序遞增；禁止用 `ErrorCode.unknown` 替代模組特定碼
8. **ServiceResult 錯誤傳播**：錯誤必須用 `result.errorTo()` 轉型為上游的 `ServiceResult`；`result.errorToGenie()` 轉換為前端回應的 `GenieResult`；存取 `.data` 前必須先檢查 `.failed`
9. **方法長度**：單一方法不宜超過 ~80-100 行；職責過多的方法應拆分

## 專案特有規則（地雷）

- **rajah Model 建構**：rajah 生成的 model 必須使用 `Model.create()` 或 `Model.fromObject()`。**前端（abu/lago）完全禁止** `new Model()`；**後端（agrabah）不鼓勵**。注意：ORM database object（從 `database_types` import，class 名稱通常以 `Db` 開頭）使用 `new` 是正常的，不要與 rajah model 混淆
- **operatorId 設定**：資料建立/修改操作必須正確設定 `operatorId`（使用者操作 = `context.userId`；系統自動化 = `0`）
- **List 方法使用 getPageData**：列表相關 service 方法必須使用 `getPageData`（`common/database_helper.ts`）做分頁，不可手動拼接 LIMIT/OFFSET
- **Toggle 功能使用 StatusEnum**：開關功能統一使用 `StatusEnum.enabled` / `StatusEnum.disabled`，不用自定 boolean 或其他 enum

> 以上為重點檢查項，不限於此。基於你的專業判斷，覆蓋該維度的其他潛在問題。
