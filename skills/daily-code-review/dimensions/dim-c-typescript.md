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

## JavaScript/TypeScript 常見陷阱（必查）

- **Falsy check 在 `0` 為合法值時失效**：`if (!value)` 或 `if (value)` 會把 `0` 視為 falsy。當 `0` 是合法的業務值（如 step index = 0、金額 = 0、計算結果 = 0）時，必須改用 `value === undefined || value === null` 或 `value == null` 做空值判斷。常見場景：
  - 快取判斷：`if (!this._cachedValue)` — 當 cached value 合法為 0 時，永遠重新計算
  - 條件分支：`if (result.data)` — 當 data 為 0 時跳過有效值
  - Fallback：`value || defaultValue` — 當 value 為 0 時意外使用 default
- **`JSON.stringify(Map/Set)` 永遠輸出 `{}`/`undefined`**：`Map` 和 `Set` 不是 plain object，`JSON.stringify` 無法正確序列化。必須先轉換：`JSON.stringify(Object.fromEntries(map))` 或 `JSON.stringify([...map.entries()])`。在日誌中尤其容易被忽略
- **`Number()` 大量散落暗示根源問題**：若程式碼中大量出現 `Number(d.userId)`、`Number(d.amount)` 等轉型，表示 rajah 生成的 model 型別定義（`i32` vs `i64`）與實際使用不一致。應從 rajah model 定義層面解決，而非在每個使用處手動轉型
- **錯誤碼與業務值混用**：方法回傳 `number` 時，error path 回傳 `errorCode`（正整數）會被呼叫方當作有效業務值（如 step index）。回傳型別為 number 的方法在錯誤時應回傳固定的 sentinel value（如 `0`、`-1`）或改用 `ServiceResult`
- **Error log 被移除但未替代**：重構時若移除了 `logger.error()` 呼叫但未加入替代的錯誤記錄，會導致錯誤靜默發生無法排查

## 專案特有規則（地雷）

- **rajah Model 建構**：rajah 生成的 model 必須使用 `Model.create()` 或 `Model.fromObject()`。**前端（abu/lago）完全禁止** `new Model()`；**後端（agrabah）不鼓勵**。注意：ORM database object（從 `database_types` import，class 名稱通常以 `Db` 開頭）使用 `new` 是正常的，不要與 rajah model 混淆
- **operatorId 設定**：資料建立/修改操作必須正確設定 `operatorId`（使用者操作 = `context.userId`；系統自動化 = `0`）
- **List 方法使用 getPageData**：列表相關 service 方法必須使用 `getPageData`（`common/database_helper.ts`）做分頁，不可手動拼接 LIMIT/OFFSET
- **Toggle 功能使用 StatusEnum**：開關功能統一使用 `StatusEnum.enabled` / `StatusEnum.disabled`，不用自定 boolean 或其他 enum

## 其他必查項

- **命名清晰**：變數/函式名是否語義清晰、是否有拼寫錯誤（DB 欄位拼寫錯誤尤其嚴重，會傳播到所有生成代碼）
- **型別斷言濫用**：是否有不必要的 `as any` 型別斷言，若必須使用是否有註解說明原因；`@ts-ignore` 是否可移除
- **註解掉的程式碼**：是否有大段被註解掉的程式碼殘留在正式提交中；`// TODO` 是否有對應的追蹤 ticket
- **日誌品質**：日誌是否包含足夠上下文（platformId、userId、orderId 等），格式是否遵循 `[ClassName.methodName]` tag 模式，敏感資訊是否被記錄
- **TODO 註解格式**：`// TODO` 註解是否遵循 `// TODO : 描述` 格式（冒號前後有空格），同樣適用 `HACK : ` 和 `WARN : `
- **內部 Header 不足時的處理**：RPC 呼叫缺少的 header 是否直接當 API 參數傳入，而非修改基底的 `TransferHeaders`（`genie/src/common/request_header.ts`）
- **空值處理**：是否有 `undefined`/`null` 防護（`|| ''`、`?.`、`?? defaultValue` 等）

> 以上為重點檢查項，不限於此。基於你的專業判斷，覆蓋該維度的其他潛在問題。
