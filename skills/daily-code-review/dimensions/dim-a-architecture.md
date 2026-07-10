# Dimension A: 架構與設計

> 適用於：agrabah, abu, lago, rajah

## 核心檢查方向

1. **Service 繼承與註冊**：正確 extends `InternalServer`，`addService` 正確註冊
2. **Manager 層分離**：業務邏輯在 manager 層，service 層只做轉發；server-to-server RPC (`context.remote.xxx`) 放在 manager 層，不可直接放 service 層
3. **Cache 設計**：cache key 必含 `platformId`；cache 失效透過 Message pub/sub 跨 server 同步；`cache_manager.ts` 中的項目在相關資料變更時正確失效
4. **併發安全**：高併發下無 Race Condition；鎖機制正確
5. **Job 冪等性**：Job handler 設計為冪等，重複執行不產生副作用（雙重扣款、重複通知）；RabbitMQ at-least-once 語義可能導致重新投遞
6. **Adapter 模式**：第三方整合遵循 Adapter pattern（extends Base Adapter、實作所有 abstract methods、Factory 管理實例）
7. **Message/Job 註冊**：新的 Message/Job 正確註冊於 server 的 `_onAddMessageHandlers()` / `_onAddJobConsumers()`；需要該 cache 的所有 server 都監聽清除訊息
8. **Consumer Server 分離**：Consumer server 只含 Job 消費和 Message 處理，不含前端 RPC 服務；主 server 不含長時間批次邏輯
9. **狀態機設計**：多步驟業務流程有明確的狀態 enum 和合法轉換定義
10. **Configuration 正確性**：新 server 的 `configurations/<server_name>.json` 有正確的 `parents`、`engines.relationalDatabases.main.link` 資料庫名稱、`defaultLanguageCode`

## 專案特有規則

- 非同步函式故意不 await（background fire-and-forget）須以 `.then()` 標記，讓讀者知道是刻意的
- Cache key 必須透過 `Keys`（`common/keys.ts`）定義，不可在 service/manager 中字串拼接；使用 `cache_helper.ts` 的 helper（`getDataWithCache` / `getDatabaseDataWithCache` / `getArrayWithCache`）
- 無狀態 service 強制：Service/Manager class 不可有 instance-level mutable state

## 重構正確性（必查）

- **邏輯搬遷後語義偏移**：將查詢邏輯從 service/manager 搬至 model 層時，JOIN 對象、SELECT 欄位、WHERE 條件是否與原始碼完全一致。常見錯誤：JOIN 的表改變了（如原本 JOIN 下級使用者表改為 JOIN 上級代理表）、欄位映射到了錯誤的來源欄位
- **多條件查詢衝突**：同一欄位在不同 if 分支中被設定為不同值（如先設 `mode = A` 再設 `mode = B`），導致 `AND` 條件下結果永遠為空
- **分層違反**：model 層應為純資料存取，不可引入 Logger、不可包含業務邏輯判斷

## 其他必查項

- **DRY 原則**：是否有重複代碼可抽取為共用方法（composable、helper、base class）
- **過度設計**：是否有不必要的抽象、過度封裝
- **ErrorCode 傳播**：ErrorCode 是否正確向上傳遞，transaction 失敗是否 rollback
- **跨服務資料一致性**：涉及多個服務的複合操作（如送禮 = 扣款 + 扣道具 + 記錄）是否有最終一致性策略（先建 pending 記錄，由 Job 處理後續），失敗時是否有補償機制
- **Job 失敗處理**：Job handler 是否有明確的失敗處理策略（最大重試次數、失敗狀態標記、補償機制如退款），是否使用 globalLock 防止 Job 併發處理同一批資料

- **新增 enum / 業務類型的窮盡性（跨 repo）**：新增一個 enum 值或業務類型時，grep 該 enum 找出所有必須處理它的地點——後端結算 / job processor 註冊表、`_onAddMessageHandlers()` / `_onAddJobConsumers()`、狀態機連帶的狀態紀錄表，以及前端（abu / lago）的 `switch` / `Record` 映射 / dispatch——逐一確認新值都有對應分支。缺分支＝靜默漏處理（不報錯），典型後果為結算漏派彩、狀態表未更新、前端該類型無反應。enum 定義在 rajah 時，該 rajah commit 的 diff 看不到前端 map 缺漏，務必跨進消費端 repo 檢查

> 以上為重點檢查項，不限於此。基於你的專業判斷，覆蓋該維度的其他潛在問題。
