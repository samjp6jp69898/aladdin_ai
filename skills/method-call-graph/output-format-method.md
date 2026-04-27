# Service Method 模式 — 輸出格式

將 4 個 script 的結果整合為以下格式，直接輸出到對話中（不寫檔案）：

```
# 方法呼叫鏈分析：<targetClass>.<targetMethod>

目標檔案：<relPath(targetFile)>:<targetLine>
所屬 server：<targetServer>
繼承鏈：<targetClass> extends <baseClass>（若無繼承則省略此行）

═══════════════════════════════════════════════════════
① 同 server 呼叫（共 N 筆，BFS 完整追蹤）
═══════════════════════════════════════════════════════

（從 same-server-callers 的 callers 陣列格式化：
  [直接] <file>:<line> — <className>.<methodName>
  [L2]   <file>:<line> — <className>.<methodName>
    └─ 被 <calledBy> 呼叫
按 level 排列，同 level 按 file:line 排列）

═══════════════════════════════════════════════════════
② 跨 server gRPC 呼叫（共 N 筆）
═══════════════════════════════════════════════════════

（從 cross-server-callers 的 callers 陣列格式化，按 server 分組：
- server: <serverName>
  <file>:<line> — <className>.<methodName>
  gRPC path: <gRpcPath>

過濾掉 gRpcPath 為 null 且 needsVerification 被排除的項目。
過濾掉 content 只是 logger/error message 中包含 method name 的 false positive。）

═══════════════════════════════════════════════════════
③ 前端呼叫（共 N 筆）
═══════════════════════════════════════════════════════

（從 frontend-callers 的 projects 陣列格式化：
[project-name]  <file>:<line> — <content 摘要>
若 hasMethod=false → generated client 中無此 method，已跳過）

═══════════════════════════════════════════════════════
④ 三方回調觸發鏈（共 N 條命中路徑）
═══════════════════════════════════════════════════════

（從 reverse-bfs-to-entries 的 matchedPaths 格式化：
🎯 命中：<entryMethod>
  鏈路：
    [Entry] <chain[0].file>:<chain[0].line> — <chain[0].className>.<chain[0].methodName>
       ↓
    ... 中間節點 ...
       ↓
    <chain[-1].file>:<chain[-1].line> — target method
  類型：<entryType>）

═══════════════════════════════════════════════════════
統計
═══════════════════════════════════════════════════════
- 同 server 直接 caller：X，transitive caller：Y
- 跨 server gRPC caller：Z
- 前端使用點：W
- 三方回調入口：V
- 無法靜態解析 case：U
```

**最後，結束。不需要額外的解釋或建議。**
