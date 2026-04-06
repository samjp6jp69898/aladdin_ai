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

> 以上為重點檢查項，不限於此。基於你的專業判斷，覆蓋該維度的其他潛在問題。
