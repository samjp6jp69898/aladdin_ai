---
name: agrabah-local-dev
description: 在本機啟動 agrabah 後端全服務 + abu 前端，並在 MySQL / StarRocks 之間切換某個 DB 連線做本機 E2E / RPC 測試。Use when 需要在本機起 agrabah server 測試改動、需要本機瀏覽器或腳本打真實 RPC 驗證、需要把某個資料庫連線在 MySQL 與 StarRocks 之間切換測試相容性、或想知道本機基礎設施（MySQL/Redis/RabbitMQ/StarRocks）現況。
---

# agrabah-local-dev — 本機啟動服務 + DB 連線切換 + RPC 驗證

本檔案內容全部經實際跑過驗證（非僅程式碼推導）。連線帳密、路徑皆為本機開發環境設定，不含機密資訊。

## 0. 本機基礎設施現況速查

```bash
docker ps -a
```

| Container | 用途 | 連線資訊 |
|---|---|---|
| `db-mysql` (mysql:8) | agrabah 主 DB，含 `control_center`／各 server schema | `root:iamroot@localhost:3306` |
| `db-redis` | Redis（cache/globalLock/message） | `redis://:photons@localhost:6379` |
| `mq-rabbit` | RabbitMQ（job engine） | `amqp://photons:photons@localhost` |
| `starrocks-local` (starrocks/allin1-ubuntu) | 本機 StarRocks（**預設常態是 Exited，需手動 `docker start`**） | FE MySQL 協議 `9030`、FE HTTP `8030`、BE HTTP `8040`，root 密碼為空 |

`db-mysql`／`db-redis`／`mq-rabbit` 通常本來就在跑，agrabah 啟動不需要額外處理；`starrocks-local` 常態是關的，需要時才 `docker start starrocks-local`（見第 3 節）。

**系統 mysql client 連 StarRocks 會出現 `Authentication plugin 'mysql_native_password' cannot be loaded`**（本機 Homebrew mysql client 沒裝這個舊版 plugin）。改用 agrabah 專案已有的 `mysql2`（純 JS driver，不受影響）：

```bash
cd /Users/user/aladdin/agrabah
bun -e "
import mysql from 'mysql2/promise';
const conn = await mysql.createConnection({ host: '127.0.0.1', port: 9030, user: 'root', password: '', database: 'game_record' });
const [rows] = await conn.query('SELECT COUNT(*) c FROM game_records');
console.log(rows);
await conn.end();
"
```

## 1. 啟動 agrabah 後端

**沒有 npm dev script**，直接用 Bun 跑 entry：

```bash
cd /Users/user/aladdin/agrabah
bun src/index.ts
```

會在同一個 process 裡啟動 ControlCenter + 全部 ~90 個 server（含 9 個 Gate），實測約 30~50 秒完成，正常應該 0 error。判斷啟動完成：

```bash
grep -c "started at port" <log 檔>       # 應接近 104（含各 Gate 的 external port）
grep -ic "error" <log 檔>                # 應為 0
grep "started at port \[5020\]" <log 檔>  # PlatformGate（abu/platform 前端要打的目標）就緒
```

**只想啟動子集**（加速迭代）理論上可行但有風險：`game_back_office` 等任何 server 都強制依賴 `ControlCenter`／`Core`／`Encryption`（rajah base_server.json 預設繼承）才能通過 `_onInit()`。子集依賴清單要讀 `rajah/server_<name>.json` 的 `rajahClientServiceGroups` + 實際 `grep context.remote.` 用量才能精準列出，容易漏掉隱性依賴（如 audit log、export 等其他 service），**沒有實測驗證過完整性，建議預設用全起（方案 A）**，除非明確知道自己在測什麼、依賴清單抓得夠準。

### 已知坑：`entries/all.gen.ts` 引用不存在的 server 導致啟動報錯

症狀：
```
error: Cannot find module '../servers/activity_external' from '/Users/user/aladdin/agrabah/src/entries/all.gen.ts'
```
這是 `src/entries/*.gen.ts`（由 `generate_entries.ts` 產生）跟目前 `src/servers/` 實際內容不同步造成的既有 repo 狀態（曾經有的 server 被移除但 entries 沒重新生成）。**不要手動改 `entries/*.gen.ts`**（generated 檔案），修法是重新生成：

```bash
cd /Users/user/aladdin/agrabah
bun run generate-entries
```

跑完再重新 `bun src/index.ts`。

## 2. 啟動 abu/platform 前端

```bash
cd /Users/user/aladdin/abu/platform
bun run dev
```

跑在 `http://localhost:8002`。API base URL 邏輯在 `vite.config.ts`：`process.env.ABU_API_URL || 'http://localhost:5020'`——`.env.local` 若 `ABU_API_URL` 是空字串，會 fallback 打 `localhost:5020`（本機 PlatformGate），**通常不用改任何設定檔**，只要照第 1 節把 agrabah 起起來即可。

### 登入帳密

本機 DB 已有帳號資料（不需要、也不能用 `create-default-admin-user`，那個工具只在 `admin.users` 全空時能用），密碼是雜湊過的查不到明碼。

**本機 platform 後台（platform 1 / localhost:8002）的測試帳密存在 `/Users/user/aladdin/aladdin_ai/.env.local`**（2026-08-11 使用者授權寫入）：`LOCAL_PLATFORM_USER` / `LOCAL_PLATFORM_PASS`。腳本用 `bun --env-file=/Users/user/aladdin/aladdin_ai/.env.local <script.ts>` 載入後讀 `process.env`，**不要**把明碼寫死進任何會留存的檔案。（`.env` 對 agent 是直接讀取 deny 的，走 `--env-file` 由腳本 process 載入即可。）其他帳號的密碼仍需向使用者確認，不要自己猜或重設密碼（重設密碼是會動到既有帳號狀態的操作，需先問過）。

## 3. game record DB：MySQL ↔ StarRocks 切換（其他 DB 連線同理）

### 3.1 運作原理（切換前必懂，否則會以為改了設定沒生效）

`configurations/**/*.json` 只是**來源檔**，agrabah 啟動時**不是**直接讀這些檔案，而是打 RPC 去 ControlCenter，ControlCenter 查 `control_center` DB 的 `configurations` table。改完 json 檔要跑：

```bash
cd /Users/user/aladdin/agrabah
bun run sync-configurations
```

才會真的寫進 `control_center` DB。而且**設定只在 server 啟動 `_onInit()` 時讀一次，沒有熱重載**，改完設定後**一定要重啟該 server**（或全部重啟，方案 A 下就是整個重啟 `bun src/index.ts`）才會生效。

### 3.2 game_record 連線設定位置

`agrabah/configurations/database/GameRecord.json`：
```json
{
    "engines": {
        "relationalDatabases": {
            "gameRecord": { "connectionString": "mysql://..." },
            "gameRecordReadonly": { "connectionString": "mysql://..." }
        }
    }
}
```
StarRocks 走 MySQL wire protocol，所以連線字串格式跟 MySQL 完全一樣（`mysql://user:pass@host:port/db`），差別只在 host/port/帳密——這也是為什麼 driver factory（`src/engines/relational_database/factory.ts`）不需要、也沒有區分兩者：只看 `mysql://` 開頭就一律用同一顆 `MysqlRelationalDatabaseEngine`。

### 3.3 本機兩種 game_record 資料源

| 連線字串 | 說明 |
|---|---|
| `mysql://root:root@127.0.0.1:33061/game_record`（`gr-mysql` container） | EVI dump 回來的 MySQL 資料，規模較大（實測曾有 3400 萬筆），需要先 `docker start gr-mysql` 並等 mysqld 完全啟動（`docker exec gr-mysql mysqladmin ping -uroot -proot` 直到回 alive，通常幾秒內） |
| `mysql://root:@127.0.0.1:9030/game_record`（`starrocks-local` container） | 本機 StarRocks，需要先 `docker start starrocks-local`（首次啟動 FE 約需 30~40 秒才能接受連線） |

切換流程（以切到 StarRocks 為例）：
```bash
docker start starrocks-local
# 確認 FE 就緒（重試直到成功，勿用固定 sleep）：
bun -e "import mysql from 'mysql2/promise'; await (await mysql.createConnection({host:'127.0.0.1',port:9030,user:'root',password:''})).query('SELECT 1');"

# 編輯 agrabah/configurations/database/GameRecord.json 改連線字串

cd /Users/user/aladdin/agrabah
bun run sync-configurations

# 重啟 agrabah（方案 A：整個 kill 重開）
```

### 3.4 ⚠️ 切到 StarRocks 後絕對不要跑 migrate

`bun run migrate GameRecord` 或帶預設參數的 `bun run sync-all`（`sync_all.ts` 預設 `migrateDatabase=true`）都會嘗試對**目前連線指到的目標**執行 migration。Migration 版本號記錄在 `control_center.versions` table，是**跟目標 DB 是誰無關的全域紀錄**——只要 `target='GameRecord'` 已經記錄到最新版，migrate 工具就會直接跳過；但如果版本紀錄跟 StarRocks 實際 schema 對不上，貿然重跑會對已有資料的 StarRocks 下 `CREATE TABLE`／`ALTER TABLE`，可能報錯或造成非預期異動。**切庫時只做「改連線字串 + sync-configurations」，不要碰 migrate。**

## 4. RPC 層級測試（不開瀏覽器，直接打後端驗證邏輯）

比瀏覽器 E2E 快、穩定，且能直接看到 `errorCode`／耗時／資料內容，用於驗證某支 method 的邏輯改動很有效。

### 4.1 關鍵坑：platform 解析是靠 `Host` header，不是自訂 header

Gate 判斷請求屬於哪個 platform，是用 HTTP 標準 `Host` header 去查 `core.domains` table（`getPlatformCodeByHost`），**不是**讀什麼 `platform-code`/`aladdin-platform-id` 自訂 header（那些是 Gate 內部組給下游 server 用的，外部帶了也會被忽略/覆蓋）。查本機對應的 domain：

```bash
docker exec db-mysql mysql -uroot -piamroot core -e "SELECT * FROM domains;"
```
`platform_id=1` 對應的本機 domain 通常就是 `abu/platform` 前端自己的 dev port（如 `localhost:8002`）。腳本裡要這樣設：

```ts
remote.setHeaderHandlerToAllGroup(() => {
    const h: Record<string, string> = { 'Host': 'localhost:8002' };  // 對應 core.domains 的 domain 欄位
    if (loginToken) h['Authorization'] = `Bearer ${ loginToken }`;
    return h;
});
```

### 4.2 關鍵坑：`Login` 的 `providerName` 参数

`remote.<group>.auth.Login(identifier, token, totpCode, providerName, extraData)`，`providerName` 傳空字串 `''` 是合法值（對應 `LoginProviderId['']` = password），**不是**要傳 provider 的顯示名稱。若遇到 `errorCode=201`（`loginProviderNotSupported`），先確認：
1. `Host` header 有沒有正確對到 `core.domains` 的某個 domain（否則 platformId 解析成 0）
2. 目標 platform 的 `login_providers` table 是否真的有 `provider_id=1`（password）、`status=1` 的啟用列

### 4.3 關鍵坑：`PlatformGameRecordEssentialSearch`（以及很多 search model）用 `-1` 代表「不篩選」

`displayTag`、`isJackpot`、**`status`** 這幾個 int 欄位的「不篩選」語意是 `-1`，**不是 protobuf 預設值 `0`**（0 通常剛好是一個有意義的真實 enum 值）。沒設就會被當成篩選條件塞進 SQL，導致查詢「成功但回傳 0 筆」——查很快、`errorCode=0`、但 `rows.length=0`，很容易誤判成 DB 沒資料或程式碼有 bug。**每次新增一個 search 欄位測試前，先讀對應的 `buildXxxConditions`/service 程式碼，確認每個欄位各自的『不篩選』sentinel 值是什麼**，不要假設都是 0 或都是不設定即可。

### 4.4 最小可執行範例

```ts
// cwd = abu/platform，用 bun 直接跑，跑完記得刪
import { Client } from 'genie/client';
import { Remote } from './src/generated/remote.gen.ts';

const remote = new Remote();
Client.encoded = true;
remote.setBaseUrlToAllGroup('http://localhost:5020');
let loginToken = '';
remote.setHeaderHandlerToAllGroup(() => {
    const h: Record<string, string> = { 'Host': 'localhost:8002' };
    if (loginToken) h['Authorization'] = `Bearer ${ loginToken }`;
    return h;
});

const r = await remote.platform.auth.Login(USER, PASS, '', '', '');
if (r.failed) throw `登入失敗 errorCode=${r.errorCode}`;
loginToken = r.data.loginToken;

// 之後就可以呼叫任何 remote.<group>.<service>.<Method>(...) 驗證邏輯
```

帳密（USER/PASS）從 `/Users/user/aladdin/aladdin_ai/.env.local` 的 `LOCAL_PLATFORM_USER` / `LOCAL_PLATFORM_PASS` 讀（跑法：`bun --env-file=/Users/user/aladdin/aladdin_ai/.env.local <script.ts>`），不要寫死進任何會留存的檔案。

## 5. 瀏覽器 E2E（Playwright）已知限制

`cqa-e2e/lib/login-backend.cjs` 是遠端 CQA 測試站的登入模式（可參考選擇器寫法：Quasar SPA 用 `input[aria-label="帳號"]`/`input[aria-label="密碼"]`，成功判定看 `localStorage.getItem('lt')`），可以借用其 Playwright 安裝（`require('/Users/user/aladdin/cqa-e2e/node_modules/playwright')`）改指到 `http://localhost:8002` 測本機。

**已知限制**：直接 `page.goto()` 到深層路由（如 `/betting-data/record`）即使登入成功，也可能被導回 `/home/welcome`——這不一定是 StarRocks/後端問題，很可能是本機測試帳號在前端權限樹/選單資料的來源跟後端 `is_super` bypass 不是同一套判斷邏輯（本機測試帳號的角色設定可能不完整）。**如果只是要驗證某支後端 method 的邏輯/效能，優先用第 4 節的 RPC 層級測試**，比排查前端權限資料快且更直接命中要驗證的東西；真的需要完整瀏覽器 E2E（畫面渲染、互動流程）才值得花時間排查前端選單/權限問題。
