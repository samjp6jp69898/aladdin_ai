---
name: codebase-sync
description: "根據 git 歷史紀錄增量更新 Obsidian Codebase 知識庫筆記。Use when: 更新 Codebase 知識庫、sync-from-git、git 同步筆記、增量更新筆記、codebase sync、更新知識庫索引、程式碼變更同步到 Obsidian。"
---

# Codebase Sync — 根據 Git 歷史增量更新知識庫

根據 agrabah / rajah 的 git commit 歷史，增量更新 `obsidian/Codebase/` 下的知識庫筆記。

## 前置條件

- `obsidian/Codebase/` 目錄已存在（由初始建構 pipeline 產生）
- `aladdin_ai/scripts/codebase-index/` 下的腳本已安裝依賴（`bun install`）
- **agrabah、rajah 兩個 repo 都必須 checkout 在 `dev` 分支**：`sync-from-git.ts`（`--finalize` 以外的模式）執行前會自動檢查，若非 `dev` 會直接中止並印出 `git checkout dev` 提示，不會自動切換分支。這是為了避免把 `feature/*` 等尚未合併進 `dev` 的 commit 內容當成「當前事實」寫進知識庫（2026-07-01 踩坑：agrabah 誤留在 `uat` 分支，同步把尚未上 dev 的 commit 也寫進了筆記）。

## 快速參考

| 指令 | 用途 |
|------|------|
| `bun run sync-from-git.ts --dry-run` | 預覽：列出會產生哪些 action，不實際修改 |
| `bun run sync-from-git.ts` | 正式執行 Stage 1：收集 diff → 過濾噪音 → 分類 action → 輸出 `pending-actions.json` |
| `bun run sync-from-git.ts --finalize` | 執行 Stage 3 + Stage 4：跑自動化腳本 + 完整性檢查 + 產出報告 + 寫回 JSDoc |
| `bun run sync-from-git.ts --finalize --skip-writeback` | 跑 Stage 3 但跳過 Stage 4 寫回 |
| `bun run writeback-jsdoc.ts --dry-run` | 獨立執行 Stage 4 預覽（不寫檔） |
| `bun run sync-from-git.ts --since="2026-04-24" --until="2026-04-25"` | 指定時間範圍 |
| `bun run sync-from-git.ts --commits=abc1234,def5678` | 指定特定 commit |

所有指令的工作目錄：`aladdin_ai/scripts/codebase-index/`

## 完整工作流程（四階段）

```
Stage 1: sync-from-git.ts          Stage 2: AI Agent 處理          Stage 3: --finalize              Stage 4: writeback-jsdoc
┌─────────────────────┐     ┌──────────────────────┐     ┌─────────────────────┐     ┌─────────────────────────┐
│ 收集 git diff       │     │ 讀 pending-actions   │     │ build-backlinks     │     │ 讀 status=processed     │
│ 過濾噪音 commit     │ ──► │ 按 action type 分派  │ ──► │ generate-indexes    │ ──► │ rpc-method/service 筆記 │
│ 解析 rajah 影響     │     │ 更新/新增筆記        │     │ generate-call-chain │     │ merge 回 source JSDoc   │
│ 輸出 pending-actions│     │ 更新 last_scanned    │     │ 完整性檢查          │     │ source 優先、不 commit  │
└─────────────────────┘     └──────────────────────┘     │ 產出 daily report   │     │ 寫 writeback-report.json│
                                                          │ 更新 sync-state     │     │ 由 --finalize 自動觸發  │
                                                          └─────────────────────┘     └─────────────────────────┘
```

### Stage 1：收集變更並分類

```bash
cd /Users/user/aladdin/aladdin_ai/scripts/codebase-index
bun run sync-from-git.ts --dry-run  # 先預覽
bun run sync-from-git.ts            # 正式執行
```

**輸入**：讀取 `sync-state.json` 中的 `last_sync_date`，從該時間點開始收集 agrabah + rajah 的 git commit。

**處理流程**：
1. **git-diff-collector** — 收集指定時間範圍的所有 commit 與 diff
2. **noise-filter** — 根據 `noise-rules.json` 過濾版號變更、純格式修改等噪音 commit
3. **rajah-change-resolver** — 解析 rajah 檔案變更對下游 agrabah 的影響
4. **file-to-note-mapper** — 將原始碼檔案路徑映射到對應的 Codebase 筆記
5. **change-classifier** — 將變更分類為 action type

**輸出**：`pending-actions.json`，內含所有待處理的 action。

**Action Types**：

| Type | 含義 | 需要 AI | 說明 |
|------|------|---------|------|
| `new_file` | 新增的程式碼檔案，需建立新筆記 | 是 | 需 AI 讀原始碼產生筆記 |
| `update_existing` | 既有檔案修改，需更新對應筆記 | 是 | 需 AI 比對 diff 更新內容 |
| `rajah_new_method` | rajah 新增了 RPC method | 是 | 需 AI 建立新 method 筆記 |
| `rajah_signature` | rajah 修改了方法簽名 | 是 | 需 AI 更新參數/回傳描述 |
| `delete_file` | 程式碼檔案被刪除 | 否 | 自動標記筆記為 deprecated |
| `rename_file` | 程式碼檔案被重命名 | 否 | 自動更新筆記路徑 |
| `uncovered` | 變更的檔案尚無對應筆記 | 否 | 記錄但不處理（可能是未索引的範圍） |

### Stage 2：AI Agent 處理 pending actions

讀取 `pending-actions.json`，對需要 AI 處理的 action（`new_file`、`update_existing`、`rajah_new_method`、`rajah_signature`）進行筆記更新。

**處理原則**：
- 每個 action 包含 `commitHash`、`filePath`、`affectedNotes`（受影響筆記清單）
- **`newMethodHints`**：若 action 含有此欄位，表示 diff 中偵測到新增的 method（`async methodXxx`），AI agent **必須**為每個 hint 建立新筆記（參考同目錄下既有筆記格式）
- 讀取原始碼的對應 diff，更新筆記中的描述、參數、呼叫關係等
- 更新筆記 frontmatter 的 `last_scanned` 為今天日期
- **不得覆寫 `human_edited: true` 的筆記**（除非使用者明確授權）
- **不得猜測**：不懂的留 `[TBD: 需開發者補充]`

**可並行分派子代理**：將 action 按 server 分組，每組派一個子代理處理。

### Stage 3：Finalize

```bash
bun run sync-from-git.ts --finalize
```

**執行內容**：
1. 跑所有自動化腳本（backlinks、indexes、call-chain、cross-server-rpc-graph）
2. **重建三層索引**：`bun run /Users/user/aladdin/obsidian/Codebase/_index/generate-index.ts`（重建 L0-router.md + L1/*.md）
3. 對本次修改的筆記做完整性檢查（frontmatter 完整度、連結正確性）
4. 產出 daily report（存入 `Codebase/_index/daily-reports/`）
5. 更新 `sync-state.json` 的 `last_sync_date`
6. **自動觸發 Stage 4 writeback**（除非帶 `--skip-writeback`）

### Stage 4：寫回 source JSDoc

```bash
bun run writeback-jsdoc.ts --dry-run   # 預覽
bun run writeback-jsdoc.ts             # 正式寫回
```

**自動觸發**：`sync-from-git.ts --finalize` 流程末尾會自動執行 Stage 4，可用 `--skip-writeback` 關閉。

**邏輯**：讀 `pending-actions.json` 中 `status === "processed"` 的 action，對涉及的 `rpc-method` / `service-overview` 筆記，把內容合併寫回對應 source 檔案的 JSDoc 區塊。

**合併策略**：
- 對 `業務場景` / `相關規則與踩坑` / `備註` 三段：以 bullet 為單位做集合聯集；衝突時 source 版本贏（保留同事直接在 source 加的細節）
- 對 `功能描述` 段：若 source 的每句都在 note 中 → 用 note（採用 Stage 2 改進）；若 source 含 note 沒有的句子 → 用 source（防止 trackEvent-style regression）
- `@param` / `@returns` / `@throws` 等 `@` 標籤：從 source 整段原樣保留，不參與 merge

**Section 對應表**：

| Obsidian h2 | JSDoc section |
|---|---|
| `## 功能描述` | 主描述（單行內聯 `1) ... ；2) ...` 編號列表） |
| `## 業務場景` | `**業務場景**` bullets |
| `## 相關規則與踩坑` | `**相關規則與踩坑**` bullets |
| `## 備註` | `**備註**` bullets |
| 其他（輸入參數 / 回傳 / 呼叫關係 / 完整呼叫鏈 等） | 不寫回 JSDoc |

**安全規則**：
- 只動 working tree，**絕不 commit**；自行 `git diff` 確認後再 commit
- `human_edited: true` 的筆記跳過
- 對應 source 檔案在 working tree 有 uncommitted 改動（含 staged）→ 跳過該 action
- source 上沒有 `/** */` JSDoc 區塊 → 跳過該 action（v1 不主動建立 JSDoc）
- 跳過率 > 30% → 印 warning（但仍寫出已處理的部分）
- 冪等：對相同 working tree 連跑兩次，第二次應全部 `unchanged`

**輸出**：`aladdin_ai/scripts/codebase-index/writeback-report.json`（git-ignored），包含 modified / unchanged / skipped 三個清單。

## 關鍵檔案

| 檔案 | 用途 |
|------|------|
| `sync-state.json` | 記錄上次同步時間，決定增量範圍 |
| `sync-partial-meta.json` | Stage 1 產生，供 `--finalize` 使用的中繼資料 |
| `pending-actions.json` | Stage 1 產生的待處理 action 清單 |
| `noise-rules.json` | 噪音過濾規則（版號 commit、格式化 commit 等） |
| `scan-progress.json` | 整體建構進度追蹤（milestone / batch 狀態） |
| `Codebase/_index/generate-index.ts` | 三層索引生成腳本，finalize 時自動執行。查詢指南見 `Codebase/_index/query-guide.md` |

## 維護機制

### last_scanned 時間戳

每篇筆記 frontmatter 有 `last_scanned` 欄位。比對 git log 確認檔案修改時間，若 `last_scanned < 檔案 mtime` 則標記為需更新。

### 更新觸發方式

| 方式 | 說明 |
|------|------|
| 手動 | 使用者呼叫本 skill |
| 半自動 | git hook 在 merge 時輸出受影響筆記清單 |
| 全量刷新 | 定期（每週）重跑腳本 + 抽樣檢查 |

### 人類編輯保護

- `human_edited: true` 的筆記 AI 不可覆寫
- 人類直接編輯筆記時 `last_scanned` 保留原值
- AI 下次掃描遇到 `human_edited: true` 需跳過或謹慎確認

## 冪等性保證

Pipeline 的所有階段都是冪等的，可安全重跑：

### Commit-based 去重

`sync-state.json` 的 `processed_commits` 記錄已處理過的 commit hash。Stage 1 收集 commit 後會自動過濾已處理的，確保不會產生重複的 action。

- `--dry-run` 不寫入 `processed_commits`（預覽無副作用）
- live mode 完成後立即寫入，不需等 finalize
- finalize 時自動清理超過 30 天的記錄

### Action Status 追蹤

`pending-actions.json` 每個 action 有 `status` 欄位：

| Status | 含義 |
|--------|------|
| `pending` | 待處理（Stage 1 產生時的初始狀態） |
| `processed` | 已由 AI 處理完成 |
| `skipped` | AI 判斷不需處理（diff 太小、純 comment 等） |

Stage 2 處理時只處理 `status === "pending"` 的 action，處理完逐條標記為 `processed` 並回寫 JSON。中斷後重啟只會繼續處理剩餘的 pending action。

**向後相容**：若 `pending-actions.json` 中的 action 沒有 `status` 欄位（舊格式），視為 `"pending"`。

### 重跑行為

| 場景 | 行為 |
|------|------|
| 同樣 `--since` 範圍重跑 Stage 1 | 去重後跳過已處理的 commit |
| Stage 2 中途中斷後重啟 | 只處理 `status=pending` 的 action |
| finalize 跑多次 | 腳本全量重建（天然冪等） |
| `--dry-run` 跑多次 | 無副作用 |

## 絕對規則

1. **不得猜測**：遇到不懂的程式碼留 `[TBD: 需開發者補充]`
2. **不得翻譯**：非 `[[中英對照辭典]]` 中已有的專有名詞不得擅自翻譯
3. **不得偽造連結**：`[[ ]]` 連結目標必須存在，或標記「待建立」
4. **不得覆寫人類編輯**：`human_edited: true` 不可覆寫
5. **不得跨 server 查 DB**：遵守微服務架構邊界
6. **不得手工把 obsidian 內容貼回 source 當 JSDoc**：必須走 Stage 4 的 `writeback-jsdoc.ts` merge 流程；手工複製貼上會洗掉同事在 source 後加的註解（見 2026-05-19 trackEvent regression 事件，spec：`references/2026-05-19-jsdoc-writeback-design.md`）。

## 常見操作場景

### 場景 1：每日例行同步

```bash
cd /Users/user/aladdin/aladdin_ai/scripts/codebase-index
bun run sync-from-git.ts --dry-run   # 看有多少變更
bun run sync-from-git.ts             # 產生 pending-actions.json
# → AI 處理 pending actions（Stage 2）
bun run sync-from-git.ts --finalize  # 跑腳本 + 報告
```

### 場景 2：只同步特定 commit

```bash
bun run sync-from-git.ts --commits=abc1234,def5678 --dry-run
bun run sync-from-git.ts --commits=abc1234,def5678
```

### 場景 3：同步特定時間範圍

```bash
bun run sync-from-git.ts --since="2026-04-20" --until="2026-04-25" --dry-run
```

### 場景 4：只跑 finalize（Agent 已手動處理完筆記）

```bash
bun run sync-from-git.ts --finalize
```
