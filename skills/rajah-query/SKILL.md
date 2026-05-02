---
name: rajah-query
description: 透過 .rajah source 與 server_*.json 即時查 service / method / model / enum / message / job 定義與所屬 server。Use when 需要定位後端 RPC 方法、enum 值、model 欄位、訊息結構、cron job 結構、或想知道一個 method 真正 host 在哪台 server、被哪些 server 透過 gRPC 呼叫。
---

# rajah-query — 從 source 即時查 Rajah 定義

## 何時使用

- 「`Enter` 這個 method 在哪？」「`AppConfig` 有哪些欄位？」「`ShellDeviceEnum` 有哪些值？」
- 「`Game` service 是哪台 server host 的？」「哪些 server 會透過 gRPC 呼叫 `Game`？」
- 「`app` server 載了哪些 service？提供哪些 method？」
- **任何需要定位後端定義的場景，禁止 grep `agrabah/src/generated/`**（那裡是生成檔，會誤導），一律先用此 skill 從 .rajah source 查。

## Source paths

| 路徑 | 內容 |
|------|------|
| `/Users/user/aladdin/rajah/services/*.rajah` | service / method / raw / model / enum |
| `/Users/user/aladdin/rajah/messages/*.rajah` | RabbitMQ messages（`@Reflection model …`） |
| `/Users/user/aladdin/rajah/jobs/*.rajah` | Cron jobs（`@Reflection model …`） |
| `/Users/user/aladdin/agrabah/rajah/server_*.json` | 每台 server 載入哪些 .rajah |
| `/Users/user/aladdin/agrabah/rajah/base_server.json` | 所有 server 共用基底（自動 merge 進子 server） |

## 使用方式

```bash
bun /Users/user/aladdin/obsidian/skills/rajah-query/rajah-lookup.ts <subcommand> <args>
```

輸出永遠是 JSON 到 stdout。每個結果都附 `file:line`，agent 必須直接讀 source 確認，不可只信腳本摘要。

## Subcommand 速查表

| 場景 | 命令 |
|------|------|
| 找 method 定義 | `find-method <MethodName>` |
| 找 enum 定義（含所有值） | `find-enum <EnumName>` |
| 找 model 定義（含所有欄位） | `find-model <ModelName>` |
| 找 service 定義（含所有 method 列表） | `find-service <ServiceName>` |
| 列出 server 載入的所有 rajah / service | `list-server <serverName>` |
| 列出 server 提供的所有 method | `list-server-methods <serverName>` |
| 找哪些 server 透過 gRPC 呼叫 service | `who-calls-service <ServiceName>` |
| 找 RabbitMQ message 定義 | `find-message <MessageName>` |
| 找 cron job 定義 | `find-job <JobName>` |

## 關鍵欄位語意

`find-method` / `find-service` 的回傳：

- `hostedBy`：透過 grep `extends <ServiceName>BaseService` 找出**真正實作**該 service 的 server（authoritative）。
- `serverRefs.hostsOrDefines`：rajah 設定中 `rajahServiceFilenames` 包含此檔的 server。**包含實作 host + 純粹匯入 enum/model 的 server**，僅供參考。
- `serverRefs.clientImports`：在 `rajahClientFilenames` 中宣告為 client 的 server（會透過 gRPC 呼叫）。

判斷 「method X 在哪個 server？」 → 只看 `hostedBy`。
判斷 「哪些 server 會呼叫 X？」 → 用 `who-calls-service` 配合 `find-method` 找出 service，再交叉 `clientImports`。

## 範例：典型查詢流程

### 場景 1：給定 method 名稱「GetDownloadLinks」，找定義 + host server

```bash
bun rajah-lookup.ts find-method GetDownloadLinks
```

預期輸出（節錄）：
```json
{
  "method": "GetDownloadLinks",
  "count": 1,
  "results": [{
    "file": "/Users/user/aladdin/rajah/services/app.rajah",
    "line": 183,
    "signature": "method GetDownloadLinks() (links [AppDownloadLink] 1)",
    "service": "Hub",
    "hostedBy": [{ "server": "app", "file": ".../app/services/hub.ts", "line": 139 }]
  }]
}
```

→ 結論：`Hub.GetDownloadLinks`，host 在 `app` server，實作在 `app/services/hub.ts:139`。

### 場景 2：查 enum 所有值

```bash
bun rajah-lookup.ts find-enum ShellDeviceEnum
```

→ `body` 欄位包含整個 enum block（含註解），可直接用於文件或翻譯查找。

### 場景 3：app server 提供哪些 RPC method？

```bash
bun rajah-lookup.ts list-server-methods app
```

→ 列出所有 service 與其 method 簽名。

### 場景 4：哪些 server 會呼叫 Wallet service？

```bash
bun rajah-lookup.ts who-calls-service Wallet
```

→ 列出 `rajahClientServiceGroups` 中包含 `Wallet` 的 server，並標出 groupKey。

**gRPC 呼叫路徑命名規則**（已用 `agrabah/src/servers/app/services/hub.ts` 等驗證）：

```
context.remote.<camelCaseGroupKey>.<camelCaseServiceAlias>.<PascalCaseMethod>(...)
```

- groupKey 與 service 都是 **lower-camelCase**（rajah 中是 PascalCase 的會自動轉首字小寫）
- service alias 中**「跟 group 同名」的 service** 會 alias 成 `main`，例如 group `Core` 中的 `Core` service → `context.remote.core.main.Xxx`，但 group `Core` 中的 `Currency` service → `context.remote.core.currency.Xxx`
- method 名保持 rajah 中的 PascalCase

**範例對照**（從實際 src code 抽出）：

| rajah 宣告 | 實際呼叫 |
|------------|---------|
| group `Core: ["Core", "Currency"]`, method `List` | `context.remote.core.currency.List(...)` |
| group `Core: ["Core"]`, method `GetWhiteListedIpsByPlatform` | `context.remote.core.main.GetWhiteListedIpsByPlatform(...)` |
| group `AppUserBackOffice: ["PlatformAppUserInternal"]`, method `GetAppUserDetailByIdentifiersOrUserId` | `context.remote.appUserBackOffice.platformAppUserInternal.GetAppUserDetailByIdentifiersOrUserId(...)` |

注意：`who-calls-service` 的結果只反映 **rajah 設定有 declare**，不保證 server 真的有寫呼叫程式碼（declare-but-unused 是常見現象）。要確認真實呼叫，配合 method-call-graph skill 的 `cross-server-callers` 子命令。

## 給子代理的提示

子代理無法呼叫 `Skill` tool，但可直接 `bun /Users/user/aladdin/obsidian/skills/rajah-query/rajah-lookup.ts <subcommand>`。父代理派遣子代理時，請複製此檔的 Subcommand 速查表給它。

## 找不到時怎麼辦

腳本是嚴格匹配（method/enum/model 名稱必須完全一致）。若 `count: 0`：

1. 先確認拼字（例如 `WithdrawApply` 不存在但 `CreateWithdraw` 存在）
2. 用 grep 找近似名稱：
   ```bash
   grep -rE "method\s+\w*<關鍵字>\w*" /Users/user/aladdin/rajah/services/
   grep -rE "(enum|model)\s+\w*<關鍵字>\w*" /Users/user/aladdin/rajah/services/
   ```
3. 找到正確名稱後再用 skill 取完整資訊

## 紀律

- **禁止**從 Codebase/_index 下的 `rpc-methods-index.md` / `services-index.md` 等索引檔回答查詢；那些是定期生成，可能落後 source。
- **禁止**只依賴 `agrabah/src/generated/services.gen.ts`（檔頭明確寫「PLEASE MODIFY SOURCE RAJAH FILE INSTEAD」）。
- 引用 method 簽名 / enum 值 / model 欄位時，必須附上 `file:line`，且該行真的讀過。
