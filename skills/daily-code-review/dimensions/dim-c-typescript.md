# Dimension C: TypeScript / 程式碼品質

> 適用於：agrabah, abu, lago

## 核心檢查方向

1. **Import 風格**：必須使用單引號；本地模組含 `.ts` 副檔名；禁止雙引號 `"`
2. **型別安全**：`any` 允許但不鼓勵，使用時須註解原因；null/undefined 必須有 guard（`|| ''`、`?.` 等）；**回傳 `null` 但型別宣告不含 `null` 的方法為 P1 級問題**（如 `Promise<ServiceResult<T>>` 卻 `return null`，上層存取 `.failed` 會 TypeError）
3. **金額計算**：必須使用 `RateHelper.normalToStored` / `storedToNormal`
4. **語言/幣別**：必須使用 `context.language` / `context.defaultCurrencyCode`
5. **硬編碼**：不可有 hardcoded ID、URL 等
6. **Debug 殘留（P1 級）**：生產代碼中不可有 `console.log`、`console.error`、`console.warn`、`console.debug`、`debugger`、`//for test` 標記的測試代碼殘留。這些殘留在生產環境會產生大量無用日誌、洩漏內部狀態、或干擾錯誤監控，一律列為 **P1**
7. **錯誤碼範圍**：必須使用正確的 `AgrabahErrorCodeEnum` 範圍（按模組區段）；新錯誤碼必須在模組範圍內依序遞增；禁止用 `ErrorCode.unknown` 替代模組特定碼
8. **ServiceResult / ProviderResult 錯誤傳播**：錯誤必須用 `result.errorTo()` 轉型為上游的 `ServiceResult`；`result.errorToGenie()` 轉換為前端回應的 `GenieResult`；存取 `.data` 前必須先檢查 `.failed`。**特別注意**：`providerResult.failed` 檢查同樣必要 — 若 provider 回傳失敗但未檢查 `.failed` 就直接存取 `.data`，會導致 undefined access。此為 P1 級問題
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

## 業務語意正確性（必查）

- **傳值取自正確實體與層級**：對 create / update / RPC / 餘額變動傳入的每個 ID 或欄位值，逐一確認取自**正確的實體與正確的層級**——不是姊妹欄位（`name` 誤填 `bankCode`）、不是扁平化漏了巢狀（`row.userId` 應為 `row.userBaseDetail.userId`）、不是另一個實體的 ID（打賞情境用 `postUserDetail.userId` 而非 `userDetail.userId`）、不是恆為預設值的欄位（`item.rewardRecordId` 恆為 0 應用 `rawId`）。同一欄位被重複賦值兩次＝複製貼上漏改屬性名
- **邊界比較運算子**：凡「達標 / 區間 / 索引 / 天數」的比較，逐一確認 `>` vs `>=`、`<` vs `<=` 與 index 起點（0 或 1）。**明寫出臨界輸入與預期業務結果再判定**，勿以「看起來合理」帶過（「達到 N 即完成」通常是 `>=`）。壞：`if (streakDays <= stepIndex)`；好：`if (streakDays < stepIndex)`（並註明 stepIndex=0 / streakDays=1 的預期）
- **匯出 / 回傳層金額費率換算**：金額 / 費率欄位在 CSV / Excel 匯出、RPC 回傳、篩選送出前必須以**對應** helper 換算（金額用 `RateHelper.storedToNormal`，費率用其專屬 scale，勿用幣別 `Exchange`）；禁止直接送 stored 值
- **回傳路徑正確性**：逐條走查每個回傳路徑——成功路徑須顯式回傳成功值（漏 `return` 會落到後續錯誤分支）；合法空結果（空陣列 / 0 筆）不可回傳 error；回傳的 response / DTO 的衍生 / 動態欄位須在回傳前填充；勿以單一 `boolean` 化約多態結果致呼叫端誤判
- **組裝寫入物件的 NOT NULL 欄位齊備**：組裝 insert / update 物件（含反射 `create()`、繼承 base class、批量編輯 model）時，對照目標表 NOT NULL / 業務必填欄位逐一確認皆賦值；繼承欄位不會自動帶入時須顯式設定，否則觸發非空違反或 SQL 寫入失敗

> 以上為重點檢查項，不限於此。基於你的專業判斷，覆蓋該維度的其他潛在問題。
