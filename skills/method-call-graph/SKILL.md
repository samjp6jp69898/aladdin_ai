---
name: method-call-graph
description: "分析指定 service method 的完整呼叫鏈：同 server caller、跨 server gRPC caller、前端 caller、三方回調觸發路徑。Use when: 分析方法呼叫鏈、列出 caller、找 method 被誰呼叫、呼叫鏈分析、method-call-graph、who calls this method、find callers。"
---

# Method Call Graph

分析 agrabah 中指定 service method 的完整呼叫鏈，涵蓋四個維度：

1. **同 server 呼叫**（含 transitive caller，BFS 無深度限制）
2. **跨 server gRPC 呼叫**（透過 `context.remote.<group>.<service>.<Method>`）
3. **前端呼叫**（abu / lago / cassim）
4. **三方回調呼叫鏈**（entry 清單由 skill 自動偵測）

## Input Format

使用者提供以下其中一種格式：

| 形式 | 範例 |
|------|------|
| `<ServiceClass>.<methodName>` | `WithdrawService.vendorCallback` |
| `<file path>:<methodName>` | `agrabah/src/servers/payment/services/withdraw_service.ts:vendorCallback` |

解析規則：
- 若為 `Class.method` 格式 → grep `class <Class>` 定位檔案
- 若為 `path:method` 格式 → 直接使用路徑

---

## Execution Flow

### Step 0: Reconnaissance

**目的**：定位 target method 的精確位置、所屬 server、繼承鏈。

1. **定位 target 檔案**

   若輸入為 `ServiceClass.methodName`：
   ```bash
   grep -rn "class <ServiceClass>" /Users/user/aladdin/agrabah/src/servers/*/services/ --include="*.ts" -l
   ```
   若輸入為 `filePath:methodName`：直接使用該路徑。

2. **確認 method 存在**

   用 Read 工具讀取目標檔案，找到 `async <methodName>(` 或 `<methodName>(` 的行號。
   若找不到 → 回報錯誤「method 不存在於該 ServiceClass 中」並停止。

3. **檢查繼承鏈**

   在目標檔案中找 `extends <BaseName>`。記錄：
   - `targetServiceClass`：目標 class 名稱
   - `baseServiceClass`：base class 名稱（若有）
   - `targetMethodName`：目標 method 名稱
   - `baseMethodName`：在 base class 中的對應 method 名稱（通常相同）

4. **推導 target server name**

   從檔案路徑 `agrabah/src/servers/<serverName>/` 提取 `<serverName>`。

5. **推導 rajah service contract name**

   讀取目標檔案中的 `extends <ServiceName>BaseService`，提取 `<ServiceName>`。
   此名稱 = rajah `.rajah` 檔案中的 service 定義名稱。

6. **記錄 reconnaissance 結果**

   將以下資訊記在腦中（不寫檔案），供後續 sub-agent dispatch 使用：
   ```
   targetFile: agrabah/src/servers/payment/services/withdraw_service.ts
   targetLine: 142
   targetClass: WithdrawService
   baseClass: WithdrawBaseService
   targetMethod: vendorCallback
   targetServer: payment
   rajahServiceName: Withdraw（或 PaymentWithdraw 等，從 BaseService 名推導）
   ```

### Step 1: 三方 Entry 自動偵測

**目的**：建立三方回調入口清單，供 Agent 4 使用。不依賴人工維護。

執行以下兩條 grep，收集所有三方入口：

**Pattern A — HTTP Callback / Webhook 入口（`handleRaw*` 方法）**

```bash
grep -rn "async handleRaw" /Users/user/aladdin/agrabah/src/servers/ --include="*.ts"
```

解析每一行的 `handleRaw<Name>` 方法名與所在檔案路徑，整理為 entry 清單。
每個 `handleRaw*` 方法 = 外部 HTTP 進入點（agrabah 框架強制慣例）。

**Pattern B — 向外部廠商拉資料的 Job**

```bash
find /Users/user/aladdin/agrabah/src/servers -path "*/jobs/*.ts" -exec grep -l "adapter\|vendor\|Vendor\|external\|External\|Adapter" {} \;
```

對命中的每個 Job 檔案，找出其 `handleJob` 方法作為 entry。

**整理 entry 清單**

將兩條 pattern 的結果合併為 entry 清單（在記憶體中維持，不寫檔案），格式如下：

```
三方入口清單（自動偵測）：
[callback] <file_path> — <handleRaw方法名1>, <handleRaw方法名2>, ...
[pull_job] <file_path> — handleJob
... (以實際 grep 結果為準)
```

將此清單作為 Agent 4 的 prompt 輸入之一。

### Step 2: 並行派遣 4 個 Sub-agent

使用 Agent tool 並行派遣以下 4 個 sub-agent（在同一個 message 中發出 4 個 Agent tool call）。

每個 sub-agent 為 `Explore` type（subagent_type: "Explore"），thoroughness 為 "very thorough"。

**重要**：4 個 Agent tool call 必須在同一個 message 中發出，確保並行執行。

---

#### Agent 1 — 同 server caller（BFS 無深度限制）

**Agent description**: "同 server caller BFS 分析"

**Agent prompt** (以下 `<variables>` 用 Step 0 的實際值替換):

~~~
你的任務是找出 agrabah 中某個 method 在「同 server」範圍內的所有 caller（含 transitive，BFS 無深度限制）。

## Target
- 檔案：<targetFile>
- Class：<targetClass>（繼承自 <baseClass>）
- Method：<targetMethod>
- 所屬 server：<targetServer>

## Scope
- `<ALADDIN_ROOT>/agrabah/src/servers/<targetServer>/**/*.ts`
- `<ALADDIN_ROOT>/agrabah/src/managers/**/*.ts`

其中 `<ALADDIN_ROOT>` = `/Users/user/aladdin`

## 方法

### 第一層：找直接 caller

1. 執行 grep 找出所有呼叫點（含 base method name）：
   ```bash
   grep -rn "\.<targetMethod>\s*(" <scope> --include="*.ts"
   grep -rn "\.<baseMethodName>\s*(" <scope> --include="*.ts"  # 若 baseMethodName != targetMethod
   ```

2. 額外掃反射呼叫：
   ```bash
   grep -rn "\[['\"]\?<targetMethod>['\"]\?\]\s*(" <scope> --include="*.ts"
   ```

3. 排除：
   - 目標方法自身的定義行
   - 註解行（以 `//` 或 `*` 開頭的行）
   - import 語句
   - 字串內容（`'...<targetMethod>...'` 或 `"...<targetMethod>..."` 或 template literal 內）

### 型別驗證（每個 grep 命中都必做）

對每個命中行，Read 該檔案的命中行上下文（±30 行），判斷 receiver 變數的型別：

| 呼叫形式 | 驗證方式 | 判定 |
|---------|---------|------|
| `this.<method>()` | 看當前 class 的 `extends` / `implements`，確認繼承鏈包含 <targetClass> 或 <baseClass> | 繼承鏈匹配 = 真命中 |
| `this._someField.<method>()` | 往上找 `_someField: TypeName` 或 constructor 中 `this._someField = xxx` 的型別 | TypeName = <targetClass> 或 <baseClass> = 真命中 |
| `obj.<method>()` | 往上找 `const/let obj: TypeName`、`obj: TypeName`（參數）、`obj = new TypeName()` | TypeName = <targetClass> 或 <baseClass> = 真命中 |
| `context.remote.*.<method>()` | 這是跨 server gRPC 呼叫，**排除**（Agent 2 負責） | 排除 |
| receiver type 不匹配 target | 排除 | 排除 |
| 無法判定 receiver type（`any`、複雜解構） | 標註「無法靜態解析」 | 回報但標記 |

### BFS 展開

4. 對每個「真命中」的 caller，記錄其 `CallerClass.callerMethod`（連同 file:line）
5. 將每個 caller 作為新的 target，重複步驟 1-3 找其 caller（下一層）
6. 維護 visited set（key = `file:className.methodName`），防止循環
7. 持續直到無新 caller

### 輸出格式

嚴格按以下格式回報，不要加多餘說明：

```
SAME_SERVER_CALLERS:
[直接] <file_relative_to_agrabah>:<line> — <CallerClass>.<callerMethod>
[L2]   <file>:<line> — <CallerClass2>.<callerMethod2>
  └─ 被 <CallerClass>.<callerMethod> 呼叫
[L3]   <file>:<line> — <CallerClass3>.<callerMethod3>
  └─ 被 <CallerClass2>.<callerMethod2> 呼叫
...

REFLECTION_HITS:
（若有反射呼叫命中，列出；若無，寫「無」）

UNRESOLVABLE:
（若有無法靜態解析的 case，列出 file:line + 原因；若無，寫「無」）

STATS:
直接 caller: N
transitive caller: M
BFS 最深層數: K
visited 總數: V
```
~~~

---

#### Agent 2 — 跨 server gRPC caller

**Agent description**: "跨 server gRPC caller 分析"

**Agent prompt** (以下 `<variables>` 用 Step 0 的實際值替換):

~~~
你的任務是找出 agrabah 中某個 method 被哪些「其他 server」透過 gRPC（context.remote）呼叫。

## Target
- Class：<targetClass>
- Method：<targetMethod>
- 所屬 server：<targetServer>
- Rajah service contract name：<rajahServiceName>（從 `extends <ServiceName>BaseService` 推導）

## 步驟

### 1. 找出哪些 server 依賴了 target service

```bash
grep -rn "<rajahServiceName>\|<targetMethod>" /Users/user/aladdin/agrabah/rajah/server_*.json
```

此外也讀取 `/Users/user/aladdin/agrabah/rajah/base_server.json` 確認 target service 是否已在 base 依賴中（如 Core、ControlCenter 等）。

記錄所有 `rajahClientServiceGroups` 中包含 target service 的 server 清單，以及它們使用的 group name。

### 2. 在依賴方 server 中 grep

對每個依賴方 server：

```bash
grep -rn "\.<targetMethod>\s*(" /Users/user/aladdin/agrabah/src/servers/<dependentServer>/ --include="*.ts"
grep -rn "\.<targetMethod>\s*(" /Users/user/aladdin/agrabah/src/managers/ --include="*.ts"
```

### 3. 型別驗證（每個命中必做）

| 呼叫形式 | 驗證方式 |
|---------|---------|
| `context.remote.<group>.<service>.<MethodName>()` | 從 `<group>` + `<service>` 確認是否指向 target。具體：讀取該 server 的 `server_*.json` 中 `rajahClientServiceGroups`，找 `<group>` key 下是否包含 target service name |
| `this._someManager.<method>()` | 追蹤 manager 的型別，Read manager 檔案看內部是否透過 `context.remote` 呼叫 target service。若是 → 算 transitive gRPC caller |
| `result = await context.remote.<group>.<service>.<Method>()` | 同第一種 |
| receiver type 不是 target service 的 remote client | 排除 |

### 4. 排除同 server 的命中

若命中的檔案位於 `servers/<targetServer>/` 下 → 排除（Agent 1 已處理）。

### 輸出格式

```
CROSS_SERVER_GRPC_CALLERS:
- server: <callerServer>
  <file_relative_to_agrabah>:<line> — <CallerClass>.<callerMethod>
  gRPC path: context.remote.<group>.<service>.<MethodName>

- server: <callerServer2>
  <file>:<line> — <CallerClass2>.<callerMethod2>
  gRPC path: context.remote.<group2>.<service2>.<MethodName>
...

UNRESOLVABLE:
（若有無法靜態解析的 case，列出 file:line + 原因；若無，寫「無」）

STATS:
跨 server gRPC caller 總數: N
涉及 server 數: M
```
~~~

---

#### Agent 3 — 前端 caller

**Agent description**: "前端 caller 分析"

**Agent prompt** (以下 `<variables>` 用 Step 0 的實際值替換):

~~~
你的任務是找出 agrabah 中某個 method 在前端（abu / lago / cassim）的所有呼叫點。

## Target
- Method：<targetMethod>（這是 rajah 生成的 RPC method name，前端 generated client 中的 async method 名稱相同）

## 前端子專案清單

| 子專案 | Generated Client 路徑 | 業務碼路徑 |
|--------|----------------------|-----------|
| abu/admin | /Users/user/aladdin/abu/admin/src/generated/remote.gen.ts | /Users/user/aladdin/abu/admin/src/ |
| abu/platform | /Users/user/aladdin/abu/platform/src/generated/remote.gen.ts | /Users/user/aladdin/abu/platform/src/ |
| abu/common | /Users/user/aladdin/abu/common/generated/remote.gen.ts | /Users/user/aladdin/abu/common/ |
| lago/n8-gaming | /Users/user/aladdin/lago/n8-gaming/src/generated/remote.gen.ts | /Users/user/aladdin/lago/n8-gaming/src/ |
| lago/ny-gaming | /Users/user/aladdin/lago/ny-gaming/src/generated/remote.gen.ts | /Users/user/aladdin/lago/ny-gaming/src/ |
| lago/pk-gaming | /Users/user/aladdin/lago/pk-gaming/src/generated/remote.gen.ts | /Users/user/aladdin/lago/pk-gaming/src/ |
| lago/agent-backend | /Users/user/aladdin/lago/agent-backend/src/generated/remote.gen.ts | /Users/user/aladdin/lago/agent-backend/src/ |
| lago/common | /Users/user/aladdin/lago/common/generated/remote.gen.ts | /Users/user/aladdin/lago/common/ |

## 步驟

### 1. 確認 generated client 是否包含 target method

對每個子專案，grep generated client：
```bash
grep -n "async <targetMethod>\b" <generatedClientPath>
```

- 命中 → 該子專案有此 method 的 client，繼續步驟 2
- 未命中 → 該子專案無此 method，記錄「generated client 中無此 method」並跳過

### 2. 找業務碼中的使用點

```bash
grep -rn "\.<targetMethod>\s*(" <businessCodePath> --include="*.ts" --include="*.vue" | grep -v "/generated/"
```

### 3. 驗證命中

對每個 grep 命中：
- 排除在註解行（`//`、`*`、`<!--` 開頭）
- 排除在字串內
- 若在 `.vue` 檔：Read 命中行 ±10 行，確認在 `<script>` 或 `<script setup>` 區塊內（而非 `<template>` 或 `<style>`）。判斷方式：往上找最近的 `<script` 或 `<template` 或 `<style` 標籤，若最近的是 `<script` → 有效命中
- 前端 generated client method 名在整個子專案中唯一（rajah 保證），所以不需要做 receiver 型別驗證

### 4. 額外處理：common 中的命中

若 `abu/common` 或 `lago/common` 中命中 → 需標明該 common 方法可能被多個子專案共用

### 輸出格式

```
FRONTEND_CALLERS:
[abu-admin]        src/views/withdraw/manual_callback.vue:78 — 在 manualTriggerCallback() 中呼叫
[abu-admin]        src/views/withdraw/detail.vue:142 — 在 retryCallback handler 中呼叫
[abu-platform]     generated client 中無此 method，已跳過
[abu-common]       generated client 中無此 method，已跳過
[lago-n8]          generated client 中無此 method，已跳過
[lago-ny]          generated client 中無此 method，已跳過
[lago-pk]          generated client 中無此 method，已跳過
[lago-agent]       generated client 中無此 method，已跳過
[lago-common]      generated client 中無此 method，已跳過

STATS:
有此 method 的子專案: N
前端使用點總數: M
子專案分布: abu-admin(X), lago-n8(Y), ...
```
~~~

---

#### Agent 4 — 三方回調觸發鏈（反向 BFS 無深度限制）

**Agent description**: "三方回調觸發鏈分析"

**Agent prompt** (以下 `<variables>` 用 Step 0 的實際值替換，`<entryList>` 用 Step 1 的完整 entry 清單替換):

~~~
你的任務是判斷 agrabah 中某個 method 是否最終被三方回調入口觸發。

## Target
- 檔案：<targetFile>
- Class：<targetClass>（繼承自 <baseClass>）
- Method：<targetMethod>
- 所屬 server：<targetServer>

## 三方入口清單（由主 agent 自動偵測）

<entryList>

## 步驟

### 0. 檢查 target 本身是否為 entry

比對 target 的 file path + method name 是否在 entry 清單中。
若是 → 直接回報「目標方法自身即為三方入口」+ entry 資訊，結束。

### 1. 反向 BFS

從 target method 出發，做反向 caller 追蹤（與 Agent 1 的 BFS 邏輯相同）：

```bash
grep -rn "\.<targetMethod>\s*(" /Users/user/aladdin/agrabah/src/ --include="*.ts"
```

**但 scope 是整個 agrabah/src/**（不限於同 server），因為三方回調可能跨 server 到達 target。

### 2. 每個 caller 做兩件事

**a) 型別驗證**（同 Agent 1 的驗證邏輯，包含 `this.*`、`obj.*`、`context.remote.*` 所有形式）

**b) 比對 entry 清單**：
- 取得 caller 的 file path 與 method name
- 對照 entry 清單：
  - callback entry：file path 完全匹配 + method name 在 entry methods 清單中 → **命中**
  - pull_job entry：file path 匹配（含 glob pattern）+ method name = `handleJob` → **命中**
- 命中 → 記錄完整 caller chain，**不再繼續往上追蹤此路徑**
- 未命中 → 將此 caller 作為新 target，繼續 BFS 往上

### 3. 終止條件

- 所有路徑都已命中 entry 或無更多 caller → 結束
- 維護 visited set 防循環

### 4. 多路徑處理

同一個 entry 可能有多條路徑到達 target → 全部列出。
不同 entry 各自獨立列出。

### 輸出格式

```
THIRD_PARTY_CALLBACK_PATHS:

🎯 命中：<EntryName>
  鏈路：
    [Entry] <entryFile>:<line>
            <EntryClass>.<entryMethod>
       ↓
    <intermediateFile>:<line>
            <IntermediateClass>.<intermediateMethod>
       ↓
    <targetFile>:<line>
            <targetClass>.<targetMethod>  ← 目標方法
  觸發來源：<entryTriggerDescription>
  類型：<callback | pull_job>

🎯 命中：<EntryName2>
  ...

NO_HIT_PATHS:
（若有 BFS 路徑未觸達任何 entry 就終止的，列出最深路徑供參考；若所有路徑都有命中或無 caller，寫「無」）

STATS:
命中 entry 數: N
命中路徑數: M
BFS 掃描層數: K
visited 總數: V
```
~~~

---

### Step 3: 整合輸出

等待 4 個 sub-agent 全部回報後，將結果整合為以下純文字格式，直接輸出到對話中（不寫檔案）：

```
# 方法呼叫鏈分析：<targetClass>.<targetMethod>

目標檔案：<targetFile>:<targetLine>
所屬 server：<targetServer>
繼承鏈：<targetClass> extends <baseClass>（若無繼承則省略此行）

═══════════════════════════════════════════════════════
① 同 server 呼叫（共 N 筆，BFS 完整追蹤）
═══════════════════════════════════════════════════════

（貼入 Agent 1 的 SAME_SERVER_CALLERS 區塊）

（若為 0 筆：「無命中。已在 <targetServer> server 與 managers/ 範圍內完整掃描。」）

═══════════════════════════════════════════════════════
② 跨 server gRPC 呼叫（共 N 筆）
═══════════════════════════════════════════════════════

（貼入 Agent 2 的 CROSS_SERVER_GRPC_CALLERS 區塊）

（若為 0 筆：「無命中。已掃描所有依賴 <rajahServiceName> 的 server。」）

═══════════════════════════════════════════════════════
③ 前端呼叫（共 N 筆，分布於 ...）
═══════════════════════════════════════════════════════

（貼入 Agent 3 的 FRONTEND_CALLERS 區塊）

═══════════════════════════════════════════════════════
④ 三方回調觸發鏈（共 N 條命中路徑）
═══════════════════════════════════════════════════════

（貼入 Agent 4 的 THIRD_PARTY_CALLBACK_PATHS 區塊）

（若為 0 筆：「無命中。已完成反向 BFS 追蹤，目標方法未被任何三方入口觸達。」）

═══════════════════════════════════════════════════════
統計
═══════════════════════════════════════════════════════
- 同 server 直接 caller：X，transitive caller：Y
- 跨 server gRPC caller：Z
- 前端使用點：W (子專案分布)
- 三方回調入口：V (命中路徑數)
- 反射呼叫命中：R
- 無法靜態解析 case：U
```

**若 U > 0**，在統計之後追加：

```
═══════════════════════════════════════════════════════
⚠️  無法靜態解析的 case（共 U 筆）
═══════════════════════════════════════════════════════
（合併 Agent 1-4 的 UNRESOLVABLE 區塊，去重）
- <file>:<line> — 原因：<reason>
```

**最後，結束。不需要額外的解釋或建議**，使用者看完就知道呼叫關係。
