# Incremental Codebase Sync — SOP

## 概述

每日從 agrabah + rajah 的 git commit 偵測變更，自動更新 Obsidian Codebase 知識庫筆記。

## 檔案結構

```
scripts/codebase-index/
├── sync-from-git.ts                    ← 主入口 CLI
├── sync-state.json                     ← 同步狀態（last_sync_date、歷史）
├── noise-rules.json                    ← 過濾規則設定
├── pending-actions.json                ← Stage 1 產出，Stage 2 消費（自動生成）
├── sync-partial-meta.json              ← Stage 1→finalize 傳遞用（自動生成）
├── agent-prompts/
│   ├── incremental-new-entity.md       ← 新增實體 agent prompt
│   ├── incremental-update-note.md      ← 更新筆記 agent prompt
│   └── incremental-fix-broken-links.md ← 修復 broken links agent prompt
└── lib/
    ├── note-parser.ts                  ← [既有] 不修改
    ├── git-diff-collector.ts           ← 掃 git commit + diff
    ├── noise-filter.ts                 ← 三層過濾
    ├── rajah-change-resolver.ts        ← rajah 變更 → agrabah 檔對應
    ├── file-to-note-mapper.ts          ← .ts 路徑 → 筆記路徑
    ├── change-classifier.ts            ← 分類為 action type
    ├── note-integrity-checker.ts       ← commit 前健全檢查
    └── daily-report-builder.ts         ← 產出日報
```

## 觸發方式

| 模式 | 指令 | 適用場景 |
|------|------|---------|
| 每日同步 | `bun run sync-from-git.ts --since=yesterday` | 自動化每日 |
| 區間補跑 | `bun run sync-from-git.ts --since=2026-04-20 --until=2026-04-23` | 漏跑時補上 |
| 指定 commit | `bun run sync-from-git.ts --commits=abc123,def456` | 精準重跑 |
| Dry run | 加 `--dry-run` 在任何指令後 | 預覽不執行 |
| 完成收尾 | `bun run sync-from-git.ts --finalize` | Agent 完成後跑 |

快捷指令（package.json）：
- `bun run sync` → 完整同步
- `bun run sync-dry` → dry-run
- `bun run sync-finalize` → 收尾

## 四階段流程

### Stage 1: 收集 + 分類（腳本自動）

```bash
bun run sync-from-git.ts --since="<date>"
```

1. 掃 agrabah + rajah 的 git commit（`git log` + `git diff-tree`）
2. 三層 noise 過濾（commit 訊息 → 檔案路徑 → diff 內容）
3. rajah 變更推導受影響的 agrabah 檔
4. 建立 source_file → 筆記索引（689+ source files）
5. 分類為 action（new_file / update_existing / delete_file / rename_file / rajah_*）
6. 去重（同 FQN + 同 type 只保留一次）
7. 輸出 `pending-actions.json` + `sync-partial-meta.json`

### Stage 2: 派 Agent 更新筆記（主代理協調）

主代理讀取 `pending-actions.json`，依 action type 派 agent：

| Action Type | Agent Prompt | 處理方式 |
|------------|-------------|---------|
| new_file | incremental-new-entity.md | 派 agent，≤6 並行 |
| update_existing | incremental-update-note.md | 派 agent，≤6 並行 |
| rajah_new_method | incremental-new-entity.md | 派 agent，≤6 並行 |
| rajah_signature | incremental-update-note.md | 派 agent，≤6 並行 |
| delete_file | — | 腳本直接處理（標 deprecated） |
| rename_file | — | 腳本直接處理（改名 + 更新連結） |
| uncovered | — | 寫入日報，不處理 |

分批策略：每批 ≤6 個 agent 並行，等全部完成再派下一批。

### Stage 3: 重跑冪等腳本（腳本自動）

```bash
bun run sync-from-git.ts --finalize
```

依序執行 6 支既有腳本：
1. `build-backlinks.ts` — 反向連結
2. `build-overview-aggregates.ts` — overview 聚合
3. `generate-call-chain.ts` — 完整呼叫鏈
4. `generate-cross-server-rpc-graph.ts` — 跨服務 RPC graph
5. `generate-indexes.ts` — 各類型索引
6. `check-orphan-notes.ts` — 孤立筆記

### Stage 4: 驗證 + 報告（腳本自動，在 --finalize 中）

1. 對所有被動筆記跑 integrity check
2. 讀取 broken-links-report.md 計數
3. 產出日報到 `Codebase/_index/daily-sync-reports/YYYY-MM-DD.md`
4. 更新 sync-state.json（last_sync_date + history）

### Stage 5: Broken Links 修復（每日必做）

Stage 3 的 `build-backlinks.ts` 會產出 `_index/broken-links-report.md`。Stage 5 讀取這份報告，對「嚴重」等級的 broken links 派修復 agent。

**觸發條件：** broken-links-report.md 中 `Total broken > 0`

**修復 agent 使用 prompt：** `agent-prompts/incremental-fix-broken-links.md`

**分類與處理策略：**

| Case | 判斷標準 | 處理方式 |
|------|---------|---------|
| 1: 應存在但缺失 | target FQN 的 server 已在 completed_packages 中 | 派 agent 建立筆記 |
| 2: 拼寫/大小寫錯誤 | 存在高度相似的筆記（Levenshtein ≤ 3） | 派 agent 修正連結 |
| 3: rename 後連結未更新 | source 有 `[[Old.Name]]` 但正確的新名稱已存在 | 派 agent 修正連結 |
| 4: 尚未建立的 server | target server 不在 completed_packages 中 | 不處理（預期行為） |

**常見缺失類型：**
- **Rajah model / enum 筆記**：初始建庫時 model 筆記未全面覆蓋，method 筆記引用了 `[[Xxx.Model.YYY]]` 但目標不存在。修復方式：讀 rajah 定義建立 model 筆記。
- **跨 server 方法連結**：某 server 筆記引用了尚未納入掃描的 server 方法。等對應 batch 完成後自然消除。

**並行限制：** ≤3 個 broken-link 修復 agent（留 quota 給隔天的同步）

**流程：**

```bash
# finalize 完成後，檢查 broken links
grep "Total broken:" /Users/user/aladdin/obsidian/Codebase/_index/broken-links-report.md

# 若 > 0，由主代理自動：
# 1. 讀取 broken-links-report.md
# 2. 過濾出 Case 1-3（可修復的）
# 3. 按 server 分組，每組派一個修復 agent
# 4. 修復完成後重跑 build-backlinks.ts 驗證
# 5. 更新日報的 broken links 計數
```

## Noise 過濾規則

規則檔：`scripts/codebase-index/noise-rules.json`

### 三層過濾

| 層 | 對象 | 效果 |
|----|------|------|
| Layer 1 | commit message 匹配 `skip_commit_message_patterns` | 整個 commit 跳過 |
| Layer 2 | 檔案路徑匹配 `skip_file_patterns` | 該檔變更跳過 |
| Layer 3 | commit message 含 `low_signal_keywords` | 進降權通道：檢查 diff 是否有實質變更 |

### 降權通道邏輯

```
message 含 low_signal_keywords?
├─ 對 diff 的 +/- 行 和 low_signal_diff_patterns 比對
│   ├─ 全是 noise（空白/import/註解）→ skip
│   └─ 有實質變更 → 保留（標 mixed_signal 寫入日報）
```

### 目前過濾效果（2026-04-21~24 測試）

- 232 agrabah commits → 185 kept, 47 skipped
- 過濾率 ~20%，版本號 commit 全部攔下

## 健全檢查項目

| 檢查 | 嚴重度 | 失敗動作 |
|------|--------|---------|
| frontmatter YAML 可解析 | error | 排除出 commit |
| fqn 欄位存在 | error | 排除出 commit |
| type 欄位存在 | error | 排除出 commit |
| source_file 欄位存在 | warning | 寫入日報 |
| AUTO-GENERATED 標記配對 | error | 排除出 commit |
| 內容成長/萎縮 > 300% | warning | 寫入日報 |
| TBD 數量增加 | warning | 寫入日報 |
| Phase 3/4 佔位殘留 | warning | 寫入日報 |

## Commit 策略

- 每日一個 commit：`chore(codebase): daily sync YYYY-MM-DD (N commits, M notes)`
- 若觸及筆記 > 30 篇，按 server 拆分 commit

## 日報指標

每日報告位置：`Codebase/_index/daily-sync-reports/YYYY-MM-DD.md`

每日必檢（看 Summary table 即可）：
- `broken links` — 理想值 0，上升代表有連結異常
- `rejected updates` — 理想值 0，>0 代表有 integrity error
- `notes created` — 新建筆記數
- `notes updated` — 更新筆記數
- `agent dispatches` — 派出 agent 數

## 完整操作流程（每日）

```bash
# 1. 跑 Stage 1（收集 + 分類）
cd /Users/user/aladdin/obsidian/scripts/codebase-index
bun run sync-from-git.ts --since=yesterday

# 2. 讀取 pending-actions.json，用 Claude Code 派 agent 處理
#    （主代理自動協調，無需人工介入）

# 3. Agent 全部完成後跑 finalize（Stage 3 + 4）
bun run sync-from-git.ts --finalize

# 4. Stage 5: 檢查 broken links，若 > 0 派修復 agent
grep "Total broken:" Codebase/_index/broken-links-report.md
#    主代理自動讀取 report → 分類 → 派修復 agent → 重跑 build-backlinks.ts

# 5. 檢查日報
cat /Users/user/aladdin/obsidian/Codebase/_index/daily-sync-reports/$(date +%Y-%m-%d).md | head -30

# 6. Commit
cd /Users/user/aladdin/obsidian
git add Codebase/ scripts/codebase-index/
git commit -m "chore(codebase): daily sync $(date +%Y-%m-%d)"
```
