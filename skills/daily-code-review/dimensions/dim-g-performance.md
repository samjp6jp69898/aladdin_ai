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

## 專案特有規則

- `Promise.all()` 對大量平行操作必須加 concurrency limit（如 `p-limit`），避免瞬間耗盡 connection pool
- 穩定資料（設定、權限、平台設定）每次 request 都從 DB 查詢而非使用 cache 是效能問題
- CSV/Excel export 載入全部資料再寫入應改為 streaming row-by-row

> 以上為重點檢查項，不限於此。基於你的專業判斷，覆蓋該維度的其他潛在問題。
