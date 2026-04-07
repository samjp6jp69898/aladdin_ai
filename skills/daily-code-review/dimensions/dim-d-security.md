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

## 日誌安全（必查）

- **`JSON.stringify` 整個物件**：日誌中對整個 Map、物件做 `JSON.stringify` 可能洩露所有使用者的 IP 地址、銀行帳號、手機號碼等 PII。應只記錄 `.size` 或 non-sensitive identifiers
- **日誌等級不當**：開發除錯用的 `JSON.stringify(fullData)` 應使用 `debug` 等級，不可用 `info`（會持久化到生產環境日誌）
- **日誌在 model 層**：model 層（`src/servers/*/models/`）為純資料存取層，原則上不應引入 Logger。除錯日誌應在 manager 層記錄

## 其他必查項

- **時序安全比較**：密碼比對、簽名驗證、token 驗證是否使用 `crypto.timingSafeEqual` 而非 `===`，防止 Timing Attack
- **檔案上傳安全**：上傳功能是否驗證檔案類型（MIME + 副檔名雙重檢查）、限制檔案大小、禁止可執行檔類型
- **錯誤資訊洩露**：錯誤回應是否將 stack trace、SQL 錯誤訊息、`err.message` 回傳給前端，應僅回傳 ErrorCode
- **速率限制**：敏感操作（登入、OTP 發送、充提建單、密碼重設）是否有速率限制防暴力破解
- **加密 IV 安全**：AES 加密是否使用隨機 IV 而非固定值；加密相關環境變數是否有不安全的 fallback 預設值
- **批量查詢防護**：批量查詢或匯出介面是否限制單次查詢的數量上限，避免大規模資料洩露或列舉攻擊

> 以上為重點檢查項，不限於此。基於你的專業判斷，覆蓋該維度的其他潛在問題。
