# Dimension D: 安全性

> 適用於：agrabah, abu, lago, rajah

## 核心檢查方向

1. **跨平台資料隔離**：所有查詢必須包含 `platform_id` 條件
2. **權限驗證**：敏感操作必須有權限檢查
3. **資料外洩**：回應不可意外回傳內部欄位、密碼、token
4. **IDOR / BOLA**：API 接受使用者可控的 ID 參數時，查詢必須同時驗證資源擁有權（如 `user_id = context.userId`）
5. **金額邊界驗證**：金額參數必須驗證為正數、合理範圍內、防止整數溢位（`Number.MAX_SAFE_INTEGER`）
6. **操作冪等性**：關鍵寫入操作（建立訂單、發放獎勵、餘額變動）必須設計為冪等（如 unique orderId）
7. **第三方 callback 簽名驗證**：支付/遊戲 callback endpoint 必須驗證請求來源簽名
8. **敏感資訊記錄**：Log 中不可包含完整 userInfo、銀行帳號、密碼或 token

## 前端安全（abu / lago）

- **XSS**：前端不可輸出未轉義的使用者輸入；`v-html` 必須使用 `HtmlHelper.purifyHtml()` 或 `v-safe-html` directive（lago）
- **window.open 安全**：所有 `window.open` 呼叫必須包含 `'noopener,noreferrer'`

> 以上為重點檢查項，不限於此。基於你的專業判斷，覆蓋該維度的其他潛在問題。
