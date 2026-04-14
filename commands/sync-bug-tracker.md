---
name: sync-bug-tracker
description: 將 /analyze-bugs-v3 的 tracker 狀態與 Notion AI分析 欄位重新同步（用於多機跨裝置執行後的狀態補正）。
user-invocable: true
---

# Sync Bug Analysis Tracker

用途：當 `/analyze-bugs-v3` 在**另一台機器**上跑過一批 bug 後，本機的
`bug_analysis_tracker.md` 並不會自動更新。此指令重新掃描 tracker，對每一筆
狀態非 `done` 的 ticket 做三步驟核對並改狀態：

1. **本地檔案** — 檢查 `obsidian/Debug/FAQ-{id}/FAQ-{id}-solution.md` 是否存在。
2. **Notion 狀態** — 呼叫 Notion API 讀取該頁的 `AI分析` select 欄位。
3. **更新 tracker** — 依下列規則改寫 `bug_analysis_tracker.md`：

   | Notion `AI分析` | 本地 solution.md | 新狀態 |
   |-----------------|------------------|--------|
   | 分析成功        | 存在             | `done`（完成時間 = Notion `last_edited_time`，Asia/Taipei） |
   | 分析成功        | 不存在           | 不改（列印警告） |
   | 分析失敗        | —                | `failed` |
   | 其他 / 待分析   | —                | 不改 |

## 執行

```bash
# 預設：只檢查本地 obsidian/Debug/FAQ-* 有資料夾的 ticket（省 API 配額）
python3 /Users/user/aladdin/obsidian/scripts/sync-bug-tracker.py --only-local

# 全量掃描：對 tracker 中所有非 done 的 ticket 都打 Notion API（慢，但最完整）
python3 /Users/user/aladdin/obsidian/scripts/sync-bug-tracker.py

# 預檢：只列差異不寫入
python3 /Users/user/aladdin/obsidian/scripts/sync-bug-tracker.py --dry-run --only-local
```

預設以 `--only-local` 執行即可（跨機同步情境下 obsidian repo 已將分析資料夾
推回來；若有 ticket 還停在 Notion 為 `分析成功` 但本機 folder 尚未同步，再跑
全量掃描）。

## 參數

| Flag | 說明 |
|------|------|
| `--only-local` | 僅檢查本機已有 `obsidian/Debug/FAQ-*` 資料夾的 ticket |
| `--dry-run`    | 不寫入 tracker，僅列印預計變更 |
| `--sleep N`    | Notion API 請求間隔（預設 0.2s） |

## 相關檔案

- Tracker：`/Users/user/.claude/projects/-Users-user-aladdin/memory/bug_analysis_tracker.md`
- 分析產物：`/Users/user/aladdin/obsidian/Debug/FAQ-{id}/`
- 腳本實作：`/Users/user/aladdin/obsidian/scripts/sync-bug-tracker.py`
