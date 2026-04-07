# Dimension G: 效能與高併發

> 適用於：agrabah（後端 Node.js / Bun 微服務）

此維度涵蓋可能在高流量、高併發條件下造成效能退化或服務崩潰的程式碼模式。

## 核心檢查方向

1. **Event Loop Blocking**：禁止在 request path 中使用同步 I/O（`fs.readFileSync`）、同步 crypto、O(n²)+ 巢狀迴圈；未知大小的 `JSON.parse()`/`JSON.stringify()` 必須有 size limit
2. **Memory Leaks**：module scope 的 Map/Set/Array 只有新增沒有移除或上限；手寫 cache 缺少 TTL/LRU/max-size；event listener 和 timer 未正確清理
3. **Connection Pool**：`getConnection()` 後必須在 `finally` 中 `release()`；transaction error path 必須保證 `ROLLBACK` + release；必須設定 `acquireTimeout` 和 `idleTimeout`
4. **併發控制與 Race Condition**：Redis `SETNX` 分散式鎖必須設 expiry；釋放鎖前必須驗證 ownership（random token）；取得鎖後必須重新讀取狀態
5. **Cache Stampede**：大量 cache key 同 TTL 同時過期需加 random jitter；cache miss 時多個並發請求同時打 DB 需 request coalescing
6. **Async/Await 效能陷阱**：無依賴的多個 `await` 應用 `Promise.all()`；迴圈中逐項 `await` 應改 batch query 或 `Promise.all()`；`Array.forEach(async ...)` 不會等待完成
7. **N+1 查詢與 Batch 處理**：迴圈中的 DB query 改 `WHERE id IN (?)`；迴圈中的 RPC 改 batch method；迴圈中的 Redis 改 `MGET`/`MSET` 或 pipeline
8. **MQ Consumer**：必須設定合理 `prefetchCount`（禁止 `prefetch = 0`）；critical message 必須處理完成後才 ACK；error path 必須有 explicit nack

## 重複 RPC/查詢檢查（必查）

- **同一 method 內重複呼叫相同 RPC**：如在 `Promise.all` 中呼叫了 `GetXxxByUserIds`，又在後續的 helper method 內部再次呼叫相同 RPC。應將第一次的結果作為參數傳入，避免重複網路往返
- **死碼浪費 RPC**：計算結果從未被使用（如 `const result = await expensiveRpc(...);` 但 `result` 之後無任何引用），應移除
- **存款/提現等統計口徑不一致**：同一報表系統中，不同方法使用不同資料源計算同一指標（如一處用充值訂單表、另一處用帳變記錄），會導致數據矛盾

## RPC 呼叫韌性

- **無 Timeout**：對外部服務或跨 server 的 RPC 呼叫是否有逾時設定，避免下游掛起時阻塞上游至資源耗盡
- **Timeout 級聯**：呼叫鏈中各層 timeout 是否合理（呼叫者 timeout 應大於被呼叫者），避免 N 層 × T 秒的級聯等待
- **非冪等操作重試**：`Create`、扣款等非冪等操作是否避免自動重試（會導致重複執行）
- **重試無退避策略**：重試是否使用指數退避 + 隨機 jitter，避免固定間隔重試加劇下游壓力
- **無 Circuit Breaker**：對頻繁失敗的外部服務是否有熔斷機制，避免所有請求都等待 timeout 才失敗
- **無 Bulkhead 隔離**：不同下游依賴是否共用同一資源池，一個慢依賴是否會拖垮對其他健康服務的呼叫

## Hot Path 與記憶體密集操作

- **迴圈內建立物件/陣列**：高頻路徑中是否在迴圈內反覆建立物件，應預先配置或複用
- **迴圈內 `new RegExp()`**：正則應在迴圈外編譯一次
- **Spread 大物件**：迴圈中 `{...largeObj, field: value}` 每次都全量複製，應考慮替代方案
- **全量載入結果集**：是否從 DB 一次載入大量資料到記憶體（應分頁或使用 streaming cursor）
- **重複查詢相同資料**：同一請求中不同 service 層是否重複查詢相同資料，應透過參數傳遞

## 連線池管理補充

- **查詢無 timeout**：長時間查詢是否有逾時設定，避免持有連線導致池耗盡
- **Redis 連線管理**：是否每次請求開關連線（應長期複用）、是否有 `retryStrategy` 和 `client.on('error')`
- **Redis Pub/Sub 隔離**：Pub/Sub 訂閱是否使用獨立連線，避免阻塞資料操作
- **RabbitMQ 連線/Channel 複用**：是否每次 publish 都開新連線或 channel（應長期複用），producer 與 consumer 是否分離連線
- **Graceful Shutdown**：服務關閉時是否正確清理連線池（`SIGTERM`/`SIGINT` 處理）

## Async/Await 補充

- **Fire-and-forget 無錯誤處理**：背景執行的 `.then()` 呼叫是否考慮 rejection 處理，如 `.then(() => {}, err => log(err))`
- **Promise.all 部分失敗**：是否需要 `Promise.allSettled()` 取代 `Promise.all()`，避免一個失敗導致全部丟棄
- **async finally 可能拋錯**：`finally` 中的 `await` 若拋出異常會覆蓋原始錯誤

## 其他必查項

- **ReDoS 風險**：正則表達式是否有巢狀量詞 `(a+)*`、重疊交替 `(a|a)*` 等指數回溯風險，尤其用於使用者輸入時
- **未消費的 Stream/Buffer**：`createReadStream()` 是否有 `pipeline()` 或 `destroy()`，`Buffer.alloc()` 是否長期持有參考
- **未解析的 Promise**：Promise 永不 resolve/reject，導致閉包中的物件無法被 GC
- **長操作無鎖續期**：處理時間可能超過鎖 TTL 時，是否有續期機制
- **SELECT FOR UPDATE 使用**：需要 read-then-write 原子操作時，是否正確使用 `SELECT FOR UPDATE` 在 transaction 內
- **熱點 key 過期策略**：高頻存取的 key 過期時是否考慮 stale-while-revalidate，或提前主動更新
- **快取更新非原子**：更新 DB 與更新/刪除快取之間是否有競態窗口，導致快取與 DB 不一致
- **迴圈內個別 INSERT**：應改為批次 INSERT（`INSERT INTO ... VALUES (...), (...), (...)`）
- **迴圈內 publish**：逐一發送 MQ 訊息應改為批次 publish
- **MQ 訊息持久性**：Queue 是否宣告為 `durable`、訊息是否設定 `deliveryMode: 2`（persistent）
- **Consumer 斷線重連**：連線中斷時是否有自動重連與重新訂閱機制

## 專案特有規則

- `Promise.all()` 對大量平行操作必須加 concurrency limit（如 `p-limit`），避免瞬間耗盡 connection pool
- 穩定資料（設定、權限、平台設定）每次 request 都從 DB 查詢而非使用 cache 是效能問題
- CSV/Excel export 載入全部資料再寫入應改為 streaming row-by-row

> 以上為重點檢查項，不限於此。基於你的專業判斷，覆蓋該維度的其他潛在問題。
