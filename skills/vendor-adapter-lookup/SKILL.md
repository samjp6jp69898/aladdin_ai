---
name: vendor-adapter-lookup
description: 從 source 即時查 3rd-party vendor adapter 位置、entry points（handleRaw 回調 + pull job）、與 adapter 內公開方法。Use when 需要定位三方廠商串接（payment / game / customer service / verification code / location）、找 callback 入口、找 pull job、查某 vendor 的 adapter 方法清單。
---

# vendor-adapter-lookup — 即時查三方廠商串接

## 何時使用

- 「`cq9` 這個遊戲商的 adapter 在哪？實作了哪些方法？」
- 「我們有哪些支付廠商？deposit 與 withdraw 各多少？」
- 「三方 callback 入口（`handleRaw*`）有哪些？分布在哪些 server？」
- 「哪些 pull job 跟 vendor 相關？」
- 「`ab` 這個 keyword 對應哪個 vendor adapter？」

## 與 method-call-graph 的分工

- **vendor-adapter-lookup**（本 skill）：定位 adapter 結構與 entry point 清單
- **method-call-graph**：給定一個 method，分析誰呼叫它（含 entry point 反向 BFS）

兩者通常配合使用：先用本 skill 找到 adapter 的某個方法 → 再用 method-call-graph 追呼叫鏈。

## Source paths

| 類別 | 路徑慣例 | 命名規則 |
|------|---------|---------|
| **payment-deposit** | `src/servers/payment/adapters/deposit/<vendor>_deposit_adapter.ts` | class `<Vendor>DepositAdapter extends BaseDepositAdapter` |
| **payment-withdraw** | `src/servers/payment/adapters/withdraw/<vendor>_withdraw_adapter.ts` | class `<Vendor>WithdrawAdapter extends BaseWithdrawAdapter` |
| **game** | `src/servers/game/game_vendor_adapters/<vendor>.ts` | class `<Vendor> extends GameVendorAdapterBase` |
| **customer-service** | `src/servers/customer_service/adapters/<vendor>_adapter.ts` | class `<Vendor>Adapter extends BaseAdapter` |
| **verification-code** | `src/servers/verification_code/adapters/<vendor>_adapter.ts` | class `<Vendor>Adapter extends BaseAdapter` |
| **location** | `src/servers/location/adapters/<vendor>_adapter.ts` | class `<Vendor>Adapter extends BaseLocationAdapter` |

**Entry points**：
- 三方 HTTP callback：`async handleRaw\w+(` 方法在 service 檔案內（37 處，分散在 7 個 server）
- Pull job：`src/servers/<server>/jobs/*.ts`（62 個，6 個與 vendor/adapter/external 相關）

**Standardized vendor API**（base class 定義）：
- payment-deposit: `vendorCreate / vendorCallback / vendorQueryOrder / vendorNotify / vendorCreateAddress / vendorSyncRate / vendorGetRate / vendorUploadCertification / vendorCancelOrder`
- payment-withdraw: 類似結構
- game: `createUser / getBalance / deposit / withdraw / getDepositStatus / getWithdrawStatus / getGameRecords / getGameLink / getGameList`

## 使用方式

```bash
bun /Users/user/aladdin/obsidian/skills/vendor-adapter-lookup/vendor-lookup.ts <subcommand> <args>
```

輸出永遠是 JSON 到 stdout。

## Subcommand 速查表

| 場景 | 命令 |
|------|------|
| 列出全部 adapter（按 category 分組） | `list` |
| 列出全部 handleRaw* callback（按 server 分組） | `list-callbacks` |
| 列出全部 pull job（標註是否 vendor-related） | `list-jobs` |
| 模糊找 vendor（按 keyword 在 vendor slug） | `locate <keyword>` |
| 列出指定 adapter 檔案的所有方法 | `adapter-methods <file>` |
| 給 vendor 名稱列出全部相關 adapter + 方法 | `vendor-methods <vendor>` |

## 範例：典型查詢流程

### 場景 1：「我們有哪些支付廠商？」

```bash
bun vendor-lookup.ts list
```

→ 看 `payment-deposit` / `payment-withdraw` 兩個 category 的 vendor 清單。

### 場景 2：「`cq9` 遊戲商的 adapter 在哪？實作了哪些方法？」

```bash
bun vendor-lookup.ts vendor-methods cq9
```

→ 直接給出 file、class（含 extends）、所有方法簽名（含 `isStandard` 旗標：是否符合 base class 標準命名）。

### 場景 3：「三方 callback 入口分布？」

```bash
bun vendor-lookup.ts list-callbacks
```

→ 按 server 分組列出每個 `handleRaw*` 方法的 file:line + 簽名。可進一步用 method-call-graph 追每個 entry 的內部呼叫鏈。

### 場景 4：「哪些 pull job 跟 vendor 相關？」

```bash
bun vendor-lookup.ts list-jobs
```

→ 每個 job 標註 `vendorRelated: true/false`（是否含 `vendor|adapter|external` 字眼），可快速篩選真正的三方拉單作業。

### 場景 5：「`ab` 這個 keyword 是什麼？」

```bash
bun vendor-lookup.ts locate ab
```

→ 列出所有 vendor slug 含 `ab` 的 adapter（含 class declaration）。注意 slug 是 substring 匹配，可能命中多個（如 `ab` 會命中 `ab_deposit_adapter` 也命中 `dabai`），用戶需自行判斷。

## 找不到時怎麼辦

1. **vendor 名拼字不確定**：先 `list` 列出全部 vendor slug，或用 `locate <部分名>`
2. **某 callback 找不到**：用 `list-callbacks` 看完整清單，可能在意外的 server（如 `agent_back_office`、`sport_back_office`）
3. **pull job 不在預期 server**：用 `list-jobs` 看完整清單；注意有些非 vendor 的 job（如 `record_user_login`）也住在 `*/jobs/`

## 給子代理的提示

子代理可直接執行：
```bash
bun /Users/user/aladdin/obsidian/skills/vendor-adapter-lookup/vendor-lookup.ts <subcommand>
```
不需要 Skill tool。

## 紀律

- **禁止**從 Codebase/_index 下舊筆記回答 vendor 列表；那是離線快照，新增 vendor 時可能落後
- 引用 vendor adapter 時必須附 `file:line`（如 `src/servers/game/game_vendor_adapters/cq9.ts:149`）
- 確認某廠商「是否串接」時，直接看 source（adapter 檔案是否存在），不要憑記憶
- `vendorRelated` 旗標只是 keyword 篩選，最終仍需 Read 檔案確認
