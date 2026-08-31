---
name: i18n-lookup
description: 從 7 個前端專案 × 3 種語言的 localizations JSON 即時查 enum / error / model / menu / common / route / permission 的多語翻譯。Use when 需要查 error code 對應文字、enum 值翻譯、model 欄位多語顯示、知道某 i18n key 在哪些前端有翻譯、查 i18n key 對應 source。
---

# i18n-lookup — 即時查多語翻譯

## 何時使用

- 「`error 211` 顯示給用戶的中文是什麼？」
- 「`TransactionStatusEnum.success` 在前端顯示什麼？三種語言分別是？」
- 「`account-name` 這個 model 欄位在 admin 與 platform 顯示一致嗎？」
- 「這個 i18n key 在哪些前端專案有定義？」

## Source paths（不要讀 Codebase 索引筆記，那邊只是離線快照）

7 個前端專案 × 3 種語言：

| 專案 | 狀態 | 路徑 |
|------|------|------|
| abu-admin | ✅ plaintext | `/Users/user/aladdin/abu/admin/localizations/{zh-TW,zh-CN,en-US}.json` |
| abu-platform | ✅ plaintext | `/Users/user/aladdin/abu/platform/localizations/{zh-TW,zh-CN,en-US}.json` |
| lago-agent-backend | ⚠️ OBFUSCATED | `/Users/user/aladdin/lago/agent-backend/localizations/{zh-TW,zh-CN,en-US}.json` |
| lago-landing-page | ⚠️ OBFUSCATED | `/Users/user/aladdin/lago/landing-page/localizations/{zh-TW,zh-CN,en-US}.json` |
| lago-n8-gaming | ⚠️ OBFUSCATED | `/Users/user/aladdin/lago/n8-gaming/localizations/{zh-TW,zh-CN,en-US}.json` |
| lago-ny-gaming | ⚠️ OBFUSCATED | `/Users/user/aladdin/lago/ny-gaming/localizations/{zh-TW,zh-CN,en-US}.json` |
| lago-pk-gaming | ⚠️ OBFUSCATED | `/Users/user/aladdin/lago/pk-gaming/localizations/{zh-TW,zh-CN,en-US}.json` |

**重要限制**：5 個 lago 專案的 JSON 採用 base64-encoded 的 section/key 名稱 + 進一步混淆過的 value（如 `"MQ=="` → `"1"`，value `"6Y2t666h..."`）。本 skill **無法**解析這些 lago 專案的翻譯；error / enum / model / key 查詢只會在 abu-admin / abu-platform 命中。如果用戶問「lago 的 error 211 顯示什麼？」，要明確告知此限制。

## 翻譯來源規則

JSON 是 flat 結構（除少數例外），top-level section 通常包含：

| Section | key 命名規則 | 來源 |
|---------|--------------|------|
| `error` | 純數字 string，如 `"211"` | 1~25 來自 `genie/src/common/error_code.ts`、101+ 來自 `rajah/services/common.rajah` 的 `AgrabahErrorCodeEnum` |
| `enum` | `<enum-name-kebab>-<value-kebab>`，例如 `login-verification-type-enum-otp` | rajah `enum X { ... }` 中的 enum + value |
| `model` | kebab-case 欄位名，例如 `account-name` | rajah `model X { fieldName ... }` |
| `common` / `menu` / `permission` / `route` / `country` | kebab-case 業務名 | 開發者在前端定義 |

**重要規則**：
- 並非所有 rajah enum 都有翻譯（如 `ShellDeviceEnum` 完全無翻譯）
- 不同 enum 雖然 value 名相同（如 `success`），可能對應不同翻譯 key（`game-transaction-status-enum-success` vs `transaction-status-enum-success`），rajah 中通常會有對應的不同 enum 名（如 `GameTransactionStatusEnum` vs `TransactionStatusEnum`）
- 同一 key 可能出現在多個前端專案、可能值不同（不一致是 bug 線索）

## 使用方式

```bash
bun /Users/user/aladdin/aladdin_ai/skills/i18n-lookup/i18n-lookup.ts <subcommand> <args>
```

輸出永遠是 JSON 到 stdout，包含 `{ project, locale, value, file, jqPath }`。

## Subcommand 速查表

| 場景 | 命令 |
|------|------|
| 查 error code 翻譯 + 標註 source | `error <code>` |
| 列出 enum 所有 value 翻譯 | `enum <EnumName>` |
| 查 enum 特定 value 翻譯（含 suffix fallback） | `enum <EnumName> <valueName>` |
| 查 model 欄位翻譯 | `model <field-kebab>` |
| 通用 section.key 查詢 | `key <section>.<keyName>` |
| 列出所有前端專案 + locale + topSections | `list-projects` |

## 範例

### 場景 1：查 error code

```bash
bun i18n-lookup.ts error 211
```

輸出包含 `source: "AgrabahErrorCodeEnum (file: rajah/services/common.rajah)"` 與 6 筆翻譯（abu-admin × 3 locale + abu-platform × 3 locale）。

### 場景 2：列出 enum 所有 value

```bash
bun i18n-lookup.ts enum LoginVerificationTypeEnum
```

輸出 `kebabPrefix: "login-verification-type-enum-"`，再列出每個 value 在哪些前端有翻譯、值是什麼。

### 場景 3：查 enum 特定 value（含 fallback）

```bash
bun i18n-lookup.ts enum TransactionStatusEnum success
```

若直接 key (`transaction-status-enum-success`) 找不到，腳本會自動找 **suffix 結尾相同**的 key（如 `game-transaction-status-enum-success`），列在 `fallbackSuffixHits` 欄位 — 用戶可以據此判斷是否該 enum 在 rajah 中其實叫別的名字（business prefix）。

### 場景 4：查 model 欄位

```bash
bun i18n-lookup.ts model account-name
```

若不確定 kebab-case 拼寫，先用 grep：
```bash
grep -lE '"\w*-?account-?\w*"' /Users/user/aladdin/abu/admin/localizations/zh-TW.json
```

### 場景 5：通用 key 查詢

```bash
bun i18n-lookup.ts key common.all
bun i18n-lookup.ts key route.agent-back-office
bun i18n-lookup.ts key permission.activity
```

## 找不到時怎麼辦

腳本是嚴格 key 匹配。若 `translationsFound: 0`：

1. 確認 kebab 拼字（PascalCase → kebab，如 `AccountName` → `account-name`，`URLPath` → `url-path`）
2. 用 grep 在 JSON 內找近似 key：
   ```bash
   grep -E '"\w*<關鍵字>\w*"' /Users/user/aladdin/abu/admin/localizations/zh-TW.json | head
   ```
3. enum 場景：用 rajah-query skill 先確認 enum 真實名稱
4. 若 fallback suffix 有命中，多半是 rajah 中該 enum 帶 business prefix（如 `Game`、`Login` 開頭）

## 給子代理的提示

子代理可直接執行：
```bash
bun /Users/user/aladdin/aladdin_ai/skills/i18n-lookup/i18n-lookup.ts <subcommand>
```
不需要 Skill tool。

## 紀律

- **禁止編輯 localizations/*.json**（CLAUDE.md 明文規定）：value 由開發者透過 Google Sheets 匯入
- 程式碼新增文案時只寫 i18n key，不寫硬編字串
- 引用某個翻譯時必須附 `file:jqPath`（如 `abu/admin/localizations/zh-TW.json:.error["211"]`）
- 若同 key 在多個專案有不同翻譯，明確列出差異（不一致可能是 bug）
