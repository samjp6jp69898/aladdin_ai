# conn — 連線腳本統一入口

本目錄集中**所有連線腳本**（DB / Redis / CQA 測試站登入），**扁平不分子目錄**，方便查找。
連線資訊一律在執行期讀取，**不寫死、不印出**。

> 2026-08-06 整併：原本散在 `tmp-sql/`、`conn/redis/`、`cqa-e2e/conn/`、`cqa-e2e/verify/`
> 四處的 9 支連線腳本全部搬到本目錄，撞名者加類別前綴（`db-` / `redis-`）。
>
> 2026-08-31：連線資訊來源從單一根目錄 `/Users/user/aladdin/.env` 拆成 6 份依「後台
> 環境」分開的檔案，全部在 `aladdin_ai/` 底下、都不進 git：
>
> | 檔案 | 內容 |
> |------|------|
> | `.env.local` | 跟後台環境無關的本機值（Notion token、Telegram bot token、本機 platform 帳密…） |
> | `.env.cqa` | CQA 測試站（`*.ald777.com`，企劃口中的「pre」） |
> | `.env.dev` | DEV 環境（`*.alddev.com`） |
> | `.env.evi` | EVI 環境（`*.godev2.com`） |
> | `.env.uat` | UAT 環境（jxpre） |
> | `.env.prod` | 正式環境監控/後台帳密（⚠️ 目前沒有任何腳本讀這份，CQA grounding 嚴禁 production） |
>
> 各檔案裡的 KEY 名稱維持拆分前的前綴（`CQA_ADMIN_URL`、`DEV_ADMIN_URL` 這種），只是物理位置
> 依環境分開，腳本邏輯不需要因此改變 KEY 名稱。走 `cqa-e2e/lib/env.cjs` 的腳本（`admin-login.sh`／
> `platform-login.sh`／`archery-login.sh`／`archery-evi-login.sh`）由 `loadEnv()` 自動合併讀取全部
> 6 份；其餘腳本各自列出自己需要的 1～2 份（見下表與各節）。

## 工具列表

| 工具 | 用途 | 用法 | `.env` key |
|------|------|------|-----------|
| `db-dev-query.sh` | 查詢 Dev DB（**唯讀**，僅 SELECT/SHOW/DESCRIBE/DESC/EXPLAIN） | `bash db-dev-query.sh <database> "<SQL>"` | `DEV_DB_HOST/PORT/USER/PASS` |
| `db-dev-write.sh` | 寫入 Dev DB（**緊急用**，僅 DELETE/UPDATE/SELECT/SHOW/DESCRIBE） | `bash db-dev-write.sh <database> "<SQL>"` | `DEV_DB_HOST/PORT/USER/PASS` |
| `db-dev-dump.sh` | 從 Dev DB 匯出整張表為 SQL 檔 | `bash db-dev-dump.sh <database> <table>` → 輸出 `conn/<db>__<table>.sql` | `DEV_DB_HOST/PORT/USER/PASS` |
| `db-cqa-query.sh` | 查詢 CQA DB（**唯讀**，僅 SELECT/SHOW/DESCRIBE/DESC/EXPLAIN） | `bash db-cqa-query.sh <database> "<SQL>"` | `CQA_DB_HOST/PORT/USER/PASS` |
| `redis-dev-query.sh` | 查詢 Dev Redis（**唯讀**，白名單見下） | `bash redis-dev-query.sh "<REDIS_COMMAND>"` | `DEV_REDIS_HOST/PORT/PASS` |
| `platform-login.sh` | platform 後台登入取證 | `bash platform-login.sh <pk\|6t> [--env cqa\|dev]` | `{CQA,DEV}_{PK,6T}_PLATFORM_URL/USER/PASS` |
| `admin-login.sh` | abu 共用後台 admin 登入取證 | `bash admin-login.sh [cqa\|dev]` | `{CQA,DEV}_ADMIN_URL/USER/PASS` |
| `app-login.sh` | 前台 app 登入取證（CQA 含人機驗證；dev pk 無驗證碼） | `bash app-login.sh <pk\|6t> [--env cqa\|dev] [--account 2\|3\|4]` | `CQA_{PK,6T}_APP_URL/USER/PASS`、`DEV_PK_APP_URL/USER[2-4]/PASS` |
| `archery-login.sh` | CQA Archery（SQL 審核平台）登入探測 | `bash archery-login.sh` | `CQA_ARCHERY_URL/USER/PASS` |
| `portainer-login.sh` | Portainer 連線確認（**唯讀**，登入＋列 endpoints） | `bash portainer-login.sh <cqa\|dev>` | `{CQA,DEV}_PORTAINER_URL/USER/PASS` |
| `portainer-logs.sh` | 依 application（K8s pod `app` label）快速切換看 log（**唯讀**） | `bash portainer-logs.sh <cqa\|dev> <application\|list> [--tail N]` | `{CQA,DEV}_PORTAINER_URL/USER/PASS` |

以下絕對路徑可直接複製使用：

```bash
bash /Users/user/aladdin/conn/db-dev-query.sh photons_member "DESCRIBE member"
bash /Users/user/aladdin/conn/db-cqa-query.sh payment "SELECT * FROM deposit_orders LIMIT 5"
bash /Users/user/aladdin/conn/redis-dev-query.sh "PING"
bash /Users/user/aladdin/conn/platform-login.sh pk
```

---

## DB 四支

### 唯讀防護

`db-dev-query.sh` / `db-cqa-query.sh` 只放行 `SELECT` / `SHOW` / `DESCRIBE` / `DESC` / `EXPLAIN`
（比對第一個單字，不分大小寫），其餘一律拒絕並退出。CQA DB 帳號本身亦為唯讀，腳本檢查是第二層防護。

`db-cqa-query.sh` 的 `ai` 是**帳號不是庫名**；庫名要用各服務 schema（`core`、`payment`…），
用 `bash db-cqa-query.sh information_schema "SHOW DATABASES"` 可列出。

### `db-dev-write.sh` 的紀律

**緊急用途專用**，只在 dev DB 做資料清理。放行 `DELETE` / `UPDATE`（外加唯讀那幾個）。
**未經實測不可濫用**——本次整併只做了 `bash -n` 語法檢查，刻意**沒有**實跑（避免對 dev DB 造成寫入）。
用它之前先用 `db-dev-query.sh` 把要動的資料 SELECT 出來確認範圍。

### `db-dev-dump.sh` 的輸出位置

輸出目錄是 `$(dirname "$0")`，也就是**本目錄** `conn/`，檔名 `<db>__<table>.sql`。
搬家後輸出位置由 `tmp-sql/` 改為 `conn/`，這是預期行為。

搭配本機匯入（`local-import.sh` 留在 `tmp-sql/`，未搬）：

```bash
bash /Users/user/aladdin/conn/db-dev-dump.sh payment deposit_orders
bash /Users/user/aladdin/tmp-sql/local-import.sh /Users/user/aladdin/conn/payment__deposit_orders.sql payment
```

### 連線資訊讀取方式

2026-08-31 前 DB 四支是**整檔 `source .env`**（`set -a; . "$ENV_FILE"; set +a`）。拆檔當天實測
`db-cqa-query.sh` source `.env.cqa` 直接因 `CQA_ARCHERY_PASS` 含反引號而語法錯誤（`unexpected EOF`）
——這正是下方「CQA 登入四支」那段警告過的地雷，只是 DB 四支當時還沒踩到。四支已全部改成跟
`redis-dev-query.sh` 一樣的精準 `get_env()` 抓取（不整檔 source），`db-cqa-query.sh` 讀 `.env.cqa`，
其餘三支讀 `.env.dev`，各自只抓自己要的四個 key，不受同檔其他行語法問題影響。

---

## `redis-dev-query.sh`

### 唯讀白名單

只放行以下指令（比對第一個單字，不分大小寫），其餘一律拒絕並退出：

```
GET MGET HGET HGETALL HMGET HKEYS HVALS HLEN HEXISTS
LRANGE LLEN LINDEX SMEMBERS SISMEMBER SCARD
ZRANGE ZSCORE ZRANK ZCARD TTL PTTL EXISTS TYPE
KEYS SCAN STRLEN DBSIZE INFO PING GETRANGE
```

`SET` / `DEL` / `FLUSHALL` / `EXPIRE` / `CONFIG` / `EVAL` 等會在送到 Redis 之前就被擋下。
白名單檢查排在讀取 `.env` **之前**，因此即使 `.env` 壞掉或連線資訊缺漏，寫入類指令一樣進不去。
本目錄**不提供** Redis write/del 類腳本。

指令是拆成獨立參數傳給 `redis-cli`（`xargs` 處理引號，不做 shell 展開／command substitution）。

### 為什麼不整檔 `source .env`

`redis-dev-query.sh` 刻意**不**整檔 `source .env`，只精準抓取
`DEV_REDIS_HOST` / `DEV_REDIS_PORT` / `DEV_REDIS_PASS` 三個 key。

原因：`.env` 任何一行有 shell 語法錯誤（例如密碼含未跳脫的反引號），整檔 `source` 就會失敗，
連帶弄掛所有讀 `.env` 的腳本。精準抓取讓這支腳本只在乎自己要的三個 key，其餘行寫錯也不受影響。

解析規則：取最後一次出現的該 key、允許 `export` 前綴、去掉行尾 CR 與頭尾一組成對引號，
且不做 shell 展開（密碼中的 `` ` ``、`$`、`"` 都以字面值取出）。

### 待辦

- CQA Redis 目前 `.env` 尚無對應帳密（`CQA_REDIS_*`），待補齊後再建 `redis-cqa-query.sh`（唯讀，比照 dev）。

---

## CQA 測試站登入四支

帳密一律在執行期從 `.env.cqa` / `.env.dev` **精準取出所需的幾個 key**，不寫死、不印出。
底層 Playwright 實作仍在 `/Users/user/aladdin/cqa-e2e/verify/` 與 `lib/`（絕對路徑引用，未搬動）。

> ⚠️ `.env.*` 各檔**不能整份 `source`**：檔內含 backtick 等字元（如 `.env.cqa` 的
> `CQA_ARCHERY_PASS`），`. "$ENV_FILE"` 會被 shell 當語法解析而炸掉
> （`unexpected EOF while looking for matching \``），而且等同執行檔案裡的 command substitution。
> **實例：2026-08-06 的 `CQA_ARCHERY_PASS`；2026-08-31 拆檔當天 `db-cqa-query.sh` 又踩了一次同一顆雷。**
> 這四支都**不整份 source**：`platform-login.sh` / `admin-login.sh` / `archery-login.sh` /
> `archery-evi-login.sh` 走 `cqa-e2e/lib/env.cjs` 的 `loadEnv()`（合併讀取全部 6 份 `.env.*`），
> `app-login.sh` 用 `sed` 挑 key 再 export。DB 四支自 2026-08-31 起也改用同一套精準抓取，
> 全目錄已無任何腳本整份 source `.env.*`。

### `platform-login.sh`

```bash
bash /Users/user/aladdin/conn/platform-login.sh pk                # PK Platform（CQA，預設）
bash /Users/user/aladdin/conn/platform-login.sh 6t                # 6T Platform（CQA，預設）
bash /Users/user/aladdin/conn/platform-login.sh pk --env dev      # PK Platform（dev）
bash /Users/user/aladdin/conn/platform-login.sh 6t --env dev      # 6T Platform（dev）
```

- `--env` 預設 `cqa`，可選 `dev`（2026-08-06 補齊，`.env` 有 `DEV_{PK,6T}_PLATFORM_*` 後兩邊都測過 SUCCESS）
- 讀 `{CQA,DEV}_PK_PLATFORM_URL/USER/PASS`、`{CQA,DEV}_6T_PLATFORM_URL/USER/PASS`
- 底層呼叫 `cqa-e2e/verify/verify-login.cjs <siteKey> <url> <user> <pass>`，siteKey 為 `pk-platform` / `6t-platform`
  （URL/user/pass 用純參數傳入，這支底層腳本本來就跟網域無關，不用另外改）
- 網域白名單依 `--env` 精準比對：`cqa` 限 `*.ald777.com`，`dev` 限 `*.alddev.com`
- 成功判定：URL 由 `/login` 導到 `/home/welcome`，且 `localStorage.lt`（JWT）非空
- stdout 印 `RESULT` / `postLoginUrl` / `signal` 摘要；exit code 0 = SUCCESS
- 產物在 `cqa-e2e/conn/artifacts/`：`<siteKey>-login.png`、`-after.png`、`-state.json`（可重用的 storageState）、`-debug.json`、`-run.log`
  （cqa 和 dev 共用同一組檔名，會互相覆蓋——手動 on-demand 工具，一次只測一邊）
- 輸出目錄透過 `VERIFY_OUT_DIR` 覆寫，所以重跑**不會蓋掉** `verify/` 的探測紀錄

### `admin-login.sh`

```bash
bash /Users/user/aladdin/conn/admin-login.sh          # abu 共用後台（CQA，預設）
bash /Users/user/aladdin/conn/admin-login.sh cqa      # 同上，顯式指定
bash /Users/user/aladdin/conn/admin-login.sh dev      # abu 共用後台（dev）
```

- `[cqa|dev]` 預設 `cqa`（2026-08-06 補齊 dev，`.env` 有 `DEV_ADMIN_*` 後兩邊都測過 SUCCESS：
  CQA 落地 `abu-admin.ald777.com`、dev 落地 `admin.alddev.com`）
- 讀 `{CQA,DEV}_ADMIN_URL/USER/PASS`，export 成通用的 `ADMIN_URL/USER/PASS` 後呼叫 `cqa-e2e/verify/verify-admin.cjs`
  （該腳本改吃 `process.env` 的通用名字，自己不碰 `.env`，缺 env 直接 exit 2、無寫死 fallback；
  網域檢查也從只認 `.ald777.com` 放寬成精準認 `.ald777.com` 或 `.alddev.com` 兩個，不開放式放行）
- 成功判定：`localStorage.lt`（JWT，長度約 243）非空，URL 導到 `/platform-management/welcome`
- 額外驗證 `/schedulers/` 可達：深連結整頁載入會被 SPA 退回 welcome（非權限問題），
  故失敗時改走側欄「排程管理 > 工作列表」client-side 導航。**只導航、不點任何執行按鈕**
- stdout 多印一行 `schedulersReachable`；exit code 0 = SUCCESS
- 產物：`cqa-e2e/conn/artifacts/admin-run.log`；截圖與 `admin-state.json` 仍寫在 `cqa-e2e/verify/`
  （`verify-admin.cjs` 的輸出目錄寫死在該檔，cqa/dev 共用同一組檔名會互相覆蓋，未改動）

### `app-login.sh`

前台 app（lago，整站跑在 iframe 內）。CQA 兩站都有人機驗證；**dev PK app 沒有驗證碼**（畫面上就只有帳號/密碼欄位），
所以同一支 `pk-visual-login.cjs` 內建兩條路徑：偵測到驗證碼輸入框才走視覺讀碼，沒有就直接送出。

```bash
bash /Users/user/aladdin/conn/app-login.sh 6t                        # 6T app（CQA），全自動
bash /Users/user/aladdin/conn/app-login.sh pk                        # PK app（CQA，預設），第 1 段
bash /Users/user/aladdin/conn/app-login.sh pk --answer 066           # PK app（CQA），第 2 段
bash /Users/user/aladdin/conn/app-login.sh pk --env dev              # PK app（dev），無驗證碼，一次到位
bash /Users/user/aladdin/conn/app-login.sh pk --env dev --account 3  # PK app（dev），指定第 3 組帳號
```

- `--env`：`cqa`（預設）或 `dev`。目前只有 PK 建了 dev 帳密（`6t --env dev` 會因缺 `.env` key 直接報錯，不會誤打未知網域）
- `--account`：只在 `--env dev` 且該環境有多組帳號時用（`2`/`3`/`4`，對應 `DEV_PK_APP_USER2/3/4`）；不帶就用 `DEV_PK_APP_USER`（shin01）
- 讀 `CQA_PK_APP_URL/USER/PASS`、`CQA_6T_APP_URL/USER/PASS`、`DEV_PK_APP_URL/USER[2-4]/PASS`，export 後呼叫
  `cqa-e2e/verify/pk-visual-login.cjs`、`cqa-e2e/verify/6t-geetest-login.cjs`
  （兩支已改吃 `process.env`，自己不碰 `.env`，缺 env 直接 exit 2、無寫死 fallback；`pk-visual-login.cjs` 讀的是
  env-agnostic 的 `PK_APP_URL/USER/PASS`，`app-login.sh` 負責把 CQA_ 或 DEV_ 來源映射過去）
- 網域白名單依 `target:env` 精準比對：`pk:cqa`/`6t:cqa` 只放行 `*.ald777.com`，`pk:dev` 只放行 `pk.alddev.com`，
  其餘未知組合一律擋下（不開放式放行）
- 成功判定：iframe origin 的 `localStorage.lt`（JWT）非空；PK 落地 `/home/slot`、6T 落地 `/home/sport`
- stdout 印 `RESULT` / `lt token`（只印前 12 字元 + 長度）/ `postLoginUrl` / 最後一次 attempt；exit code 0 = SUCCESS
- 產物：`cqa-e2e/conn/artifacts/{pk,6t}-app-run.log`；截圖與 `{pk,6t}-state.json` 仍寫在 `cqa-e2e/verify/`
  （dev 與 cqa 共用同一組檔名，會互相覆蓋——這是手動 on-demand 工具，一次只測一邊，暫不分流）

**PK / CQA 是兩段式**：圖形驗證碼每次 page load 重生，所以第 1 段會把 `pk-visual-login.cjs` 丟到背景保活、
把驗證碼裁切成 `cqa-e2e/verify/pk-captcha-crop.png` 並印 `CAPTCHA_AT`。
接著要**用有視覺能力的模型 Read 那張 png 讀出數字**（tesseract / 一般 OCR 解不了），
再用 `--answer <digits>` 交答案。讀錯的話 exit 3 並提示重讀（腳本已自動換一張），重跑 `--answer` 即可，最多 3 輪。

**PK / dev 是一段式**：沒有驗證碼欄位，`app-login.sh pk --env dev` 一次就會印出完整 `RESULT` 摘要，
不會停在 `CAPTCHA_AT` 等答案（`pk-visual-login.cjs` 用是否找得到驗證碼輸入框自動判斷走哪條路徑）。

**6T 是 Geetest v3 radar**：低風控時單擊直接放行，腳本輪詢 hidden `geetest_validate` /
`geetest_seccode` 有值且送出鈕 enabled 才送出。風控升級成滑塊/拼圖時會 FAIL，
屬預期行為（見 `cqa-e2e/verify/6t-usage.md` 的風險說明），**不要硬刷**。

### `archery-login.sh`

```bash
bash /Users/user/aladdin/conn/archery-login.sh
```

- CQA Archery（SQL 審核平台）登入探測：**只登入、截圖、存 storageState，不建立/送出任何 SQL 工單**
- 讀 `CQA_ARCHERY_URL/USER/PASS`，export 後呼叫 `cqa-e2e/verify/archery-login.cjs`
- `.env` 另有 `ARCHERY_PROD_*`（production），**本腳本不碰**
- stdout 多印 `authApiStatus` / `twoFactorRequired` / `captchaPresent` / `sessionCookie`；exit code 0 = SUCCESS
- 產物寫在 `cqa-e2e/verify/`：`archery-{login,after}.png`、`archery-state.json`、`archery-debug.json`、`archery-run.log`

---

## Portainer 兩支

`.env` 早在 2026-06 規劃 CQA grounding 時就寫了 `CQA_PORTAINER_URL/USER/PASS`，但一直沒寫成腳本。
2026-08-06 補上，順便發現 CQA 這個 Portainer（2.33.5）後面接的是 K8s cluster（endpoint type=Kubernetes，
非裸 Docker），`docker/containers/json` proxy 打不通，要走 `kubernetes/api/v1/...` 這條路徑。

兩支都是純 REST API（`fetch`），**不需要 Playwright**，跟 CQA 登入四支的瀏覽器路線不同。

### `portainer-login.sh`

```bash
bash /Users/user/aladdin/conn/portainer-login.sh cqa
bash /Users/user/aladdin/conn/portainer-login.sh dev   # 待 .env 補 DEV_PORTAINER_* 才會過
```

- 讀 `{CQA,DEV}_PORTAINER_URL/USER/PASS`，`POST /api/auth` 拿 JWT，再 `GET /api/endpoints` 列出可見環境
- 只確認連線堪用，不列容器、不拉 log；exit code 0 = SUCCESS

### `portainer-logs.sh`

```bash
bash /Users/user/aladdin/conn/portainer-logs.sh cqa list          # 列出全部 96 個 application 名稱
bash /Users/user/aladdin/conn/portainer-logs.sh cqa core          # 精準比對，抓 core 的 log（預設 tail 100）
bash /Users/user/aladdin/conn/portainer-logs.sh cqa wallet-back --tail 300   # substring 唯一命中也可以
bash /Users/user/aladdin/conn/portainer-logs.sh cqa pay           # substring 命中多筆 → 列候選，不會自己猜
```

- K8s pod 都有乾淨的 `app` label（`core`、`payment`、`wallet`、`activity`…，剛好對應 rajah 各 service），
  這支就是拿它做「application（server）快速切換」的依據，不是硬解析 deployment 名稱
- 比對順序：**精準命中**優先；沒有才退而求其次做 substring，唯一命中才用，命中多筆一律列出候選要求打精確一點
- 找到 application 後，對它底下**每個** Running 狀態的 pod 各拉一段 `tailLines`（K8s `pods/{name}/log` API），
  用 `== podName (phase, container=xxx) ==` 分段印出；非 Running 的 pod 會註記跳過，不強拉
- `--namespace`（預設 `default`，CQA 96 個 application 都在這裡）、`--container`（預設用 pod 的第一個 container，
  目前看到的都是單 container/pod）、`--endpoint`（預設用 `/api/endpoints` 回傳的第一個，CQA 目前只有一個）
- 唯讀：只查 pods 列表、只拉 log 文字，不建立/刪除/重啟任何資源
- exit code：`0` = SUCCESS、`1` = FAIL（含找不到/歧義/HTTP 失敗）、`2` = `.env` 缺欄位

兩支都已用 `DEV_PORTAINER_*`（2026-08-06 補齊）實測過：dev 的 Portainer endpoint 叫 `ald_dev`，
K8s pod `app` label 結構跟 CQA 幾乎一樣（95 個 application），登入與 `core` log 都拉得到。

### 待辦

- Kibana（`{CQA,DEV}_KIBANA_URL/USER/PASS`）目前完全空白，`.env` 沒有任何相關 key，等使用者提供後再建對應腳本
- ⚠️ `docs/superpowers/plans/2026-06-01-cqa-grounding-playwright.md` 這份規劃文件裡 `CQA_PORTAINER_PASS` 是明文寫死的，
  待使用者確認是否要清理（同名的 design 文件已遮成 `********`，這份沒遮）

---

## 紀律（硬性）

- CQA 登入四支只操作 `*.ald777.com` CQA 測試站，腳本內建網域檢查，非 ald777 直接擋下；**嚴禁 production**
- `app-login.sh pk --env dev` 只操作 `pk.alddev.com`（dev 測試環境，非 production），同樣是精準網域比對，非白名單組合一律擋下
- Portainer 兩支同樣網域白名單：`cqa` 限 `*.ald777.com`、`dev` 限 `*.alddev.com`，非白名單組合擋下
- 唯讀取證：只登入、導頁、截圖，不送出任何會改資料的表單
- 連線資訊只從 `aladdin_ai/.env.local` / `.env.cqa` / `.env.dev` / `.env.evi` / `.env.uat` / `.env.prod` 讀（皆不進 git）；任何檔案與輸出都不得出現密碼明文
- 唯二有寫入能力的是 `db-dev-write.sh`（僅 dev DB，緊急用）；Redis 與 CQA 一律唯讀

## 相關

- 本機 DB 工具（`local-query.sh` / `local-import.sh`）與 EVI 遷移測試（`evi-query.sh`）仍在 `/Users/user/aladdin/tmp-sql/`
- `cqa-e2e/lib/login-backend.cjs <admin|pk-platform|6t-platform>` — 另一條同樣吃 `.env` 的後台登入路徑，
  直接用 `aria-label` 選擇器並把 storageState 寫到 `cqa-e2e/sessions/`，供 `cqa-e2e/lib/capture.cjs` 導頁取證重用。
  要接續截圖取證用它；要一次性驗證登入是否還通用本目錄腳本。
- 站台 selector / 登入態判定的權威說明：`.claude/skills/cqa-site-usage/SKILL.md`
- worktree / grounding 的授權邊界：`.claude/doctrine/refs/permissions-worktree.md`
