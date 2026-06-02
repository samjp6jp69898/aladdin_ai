---
name: cqa-site-usage
description: CQA 測試站（PK/6T app、admin、PK/6T platform）的 Playwright 登入與取證使用方式，給 cqa-grounder / tracer 每次操作前讀。含精確選擇器、登入態判定、lib 介面、唯讀紀律。
---

# CQA 站台使用方式

供 `cqa-grounder`（及授權的 tracer）對 CQA 測試站做**唯讀登入取證**。所有連線資訊來自 `/Users/user/aladdin/.env`，**禁止寫死**。僅對 `*.ald777.com` CQA 測試站，**嚴禁 production**。

## 共通事實
- Playwright：`/Users/user/aladdin/cqa-e2e/node_modules/playwright`（chromium 已裝）
- lib：`/Users/user/aladdin/cqa-e2e/lib/{env,login-backend,login-app,capture}.cjs`
- 登入態 storageState：`/Users/user/aladdin/cqa-e2e/sessions/<site>-state.json`（可被 capture 重用）
- **登入態判定一律看 localStorage key `lt`（JWT）非空**（不是 cookie；abu `common/api/auth.ts` 的 LOGIN_TOKEN_KEY='lt'）
- DB grounding（非瀏覽器）：`bash /Users/user/aladdin/tmp-sql/cqa-query.sh <db> "<SELECT/SHOW/DESC/EXPLAIN>"`

## 5 站速查

| site key | URL（.env） | kind | 帳號 selector | 密碼 selector | 送出 | 登入後落地 | 特例 |
|---|---|---|---|---|---|---|---|
| admin | CQA_ADMIN_URL | backend | `input[aria-label="帳號"]` | `input[aria-label="密碼"]` | `button[type=submit]` | /platform-management/welcome | 深連結 /schedulers/ 會被導回 welcome，需站內側欄導航（排程管理>工作列表）。input id 是隨機 UUID 禁用；2FA `input[aria-label="驗證器"]` 留空 |
| pk-platform | CQA_PK_PLATFORM_URL | backend | 同上 | 同上 | 同上 | /home/welcome | 同 admin 的 Quasar 規則 |
| 6t-platform | CQA_6T_PLATFORM_URL | backend | 同上 | 同上 | 同上 | /home/welcome | 同上 |
| pk-app | CQA_PK_APP_URL | app | iframe 內 `input[placeholder="请输入账号"]` | `input[placeholder="请输入登录密码"]` | 文字「登录账号」（驗證碼填妥前 disabled） | /home/slot | **整站在 iframe；數字圖形驗證碼需視覺讀碼**（見下）；驗證碼每次 page load 重生 |
| 6t-app | CQA_6T_APP_URL | app | iframe 內 `input[placeholder="请输入用户名"]` | `input[placeholder="请输入密码"]` | 文字「登录」 | /home/sport | iframe；Geetest radar，低風險單擊放行；升級成滑塊則需第三方代解 |

## lib 介面

### 後台站（無驗證碼，純腳本）
```bash
node /Users/user/aladdin/cqa-e2e/lib/login-backend.cjs <admin|pk-platform|6t-platform>
# → sessions/<site>-state.json；末行 LOGIN: SUCCESS|FAIL
```

### app 站
- **PK app（數字圖形驗證碼，agent 視覺讀碼 + 檔案 handshake）**：驗證碼每次 load 重生，故 capture 進程須保活：
  ```bash
  # 1. 背景啟動 capture（保活、印 CAPTCHA_AT、等 answer 檔，最長 5 分鐘）
  node /Users/user/aladdin/cqa-e2e/lib/login-app.cjs pk-app --phase=capture &
  # 2. 用 Read 工具讀 CAPTCHA_AT 指向的 png，看出那串數字（tesseract 無效，靠多模態視覺）
  # 3. 交答案（thin client；保活的 capture 進程會用同一張驗證碼提交）
  node /Users/user/aladdin/cqa-e2e/lib/login-app.cjs pk-app --phase=submit --captcha=<讀到的數字>
  # → sessions/pk-app-state.json；LOGIN: SUCCESS|FAIL；讀錯重試（capture 會刷新驗證碼）
  ```
- **6T app（Geetest radar）**：
  ```bash
  node /Users/user/aladdin/cqa-e2e/lib/login-app.cjs 6t-app --phase=capture
  # → radar 過則 sessions/6t-app-state.json + LOGIN: SUCCESS；偵測滑塊則印 GEETEST_ESCALATED（降級，不硬刷）
  ```

### 導頁取證（需先有 state.json）
```bash
node /Users/user/aladdin/cqa-e2e/lib/capture.cjs <site> <route> <outPrefix>
# → <outPrefix>.png + <outPrefix>-console.json + <outPrefix>-network.json；末行 CAPTURE: OK
```

## 紀律
- 唯讀取證：登入 + 導頁 + 截圖 + 讀 console/network；**不送出任何破壞性表單操作**。
- 只對 CQA 測試站與 landon_ai 唯讀 DB；嚴禁 production。
- 連線資訊一律從 .env 讀，不寫死。
