#!/bin/bash
# sync-mirrors.sh — 單一來源 symlink 健檢
#
# 實況（2026-07-21 以 inode 實測確認；2026-09-01 更新）：
#   - .claude/commands → symlink → aladdin_ai/commands   ┐
#   - .claude/agents   → symlink → aladdin_ai/agents     ├ 同一份檔案，天然不會漂移
#   - .claude/skills   → symlink → aladdin_ai/skills     │（但 symlink 若被誤換成真目錄/真檔，漂移風險立刻回來）
#   - .claude/doctrine → symlink → aladdin_ai/doctrine   │
#   - scripts          → symlink → aladdin_ai/scripts    │
#   - conn             → symlink → aladdin_ai/conn       ┘
#   - CLAUDE.md（專案根）→ symlink → obsidian/CLAUDE.md（實體檔，單一來源）
#
# 2026-08-31：commands/agents/skills/doctrine/scripts/conn 這組 symlink 目標從 obsidian/
# 整批遷到獨立的 aladdin_ai repo（含完整 git 歷史，用 git filter-repo 遷移）；obsidian
# 本身停止追蹤這些路徑，只保留純知識庫內容。
# 2026-09-01：CLAUDE.md 原本是「專案根 canonical ↔ obsidian 鏡像」的雙實體，靠本腳本
# cmp/cp 手動同步——已改成單一來源 symlink（obsidian/CLAUDE.md 為實體檔），不再需要
# 同步邏輯，併入下面的 symlink 健檢群組。
#
# 換機器 clone/pull aladdin_ai 後用 aladdin_ai/scripts/setup-symlinks.sh 一鍵重建
# commands/agents/skills/doctrine/scripts/conn 這組 symlink。
#
# 用法：
#   bash scripts/sync-mirrors.sh          # 檢查所有 symlink 完好
#   bash scripts/sync-mirrors.sh --check  # 同上，保留參數相容舊用法
#
# 給未來維護者：
#   - 新增「雙實體」配對前先想清楚能不能用 symlink（單一來源永遠優於同步兩份）。
#   - 環境陷阱：BSD find / harness 的 bfs 包裝，對「本身是 symlink 的目錄」當參數時會**靜默回空**。
#     腳本內要遍歷這些目錄請用實體路徑（aladdin_ai/...）或先 cd 進去用相對路徑。
set -u
ROOT=/Users/user/aladdin
FAIL=0

echo "== 單一來源 symlink 健檢 =="
check_link() { # $1=link path, $2=expected target
  local t
  if [ -L "$1" ]; then
    t=$(readlink "$1")
    if [ "$t" = "$2" ]; then echo "SYMLINK_OK: $1 -> $2"; return; fi
    echo "SYMLINK_WRONG: $1 -> $t （預期 $2 ）"; FAIL=1
  elif [ -d "$1" ] || [ -f "$1" ]; then
    echo "SYMLINK_REPLACED: $1 已變成真檔/真目錄——漂移風險回來了，請人工檢查是否要恢復 symlink"; FAIL=1
  else
    echo "SYMLINK_MISSING: $1 不存在"; FAIL=1
  fi
}
check_link "$ROOT/CLAUDE.md"        "obsidian/CLAUDE.md"
check_link "$ROOT/.claude/commands" "$ROOT/aladdin_ai/commands"
check_link "$ROOT/.claude/agents"   "$ROOT/aladdin_ai/agents"
check_link "$ROOT/.claude/skills"   "$ROOT/aladdin_ai/skills"
check_link "$ROOT/.claude/doctrine" "$ROOT/aladdin_ai/doctrine"
check_link "$ROOT/scripts"          "$ROOT/aladdin_ai/scripts"
check_link "$ROOT/conn"             "$ROOT/aladdin_ai/conn"
# AGENTS.md（2026-08-25 新增，給 Codex CLI 等遵循 agents.md 標準的工具讀）：
# 兩份都指向同目錄的 CLAUDE.md，不是「指到 obsidian/」的單一來源 symlink，
# target 用相對路徑比對。
check_link "$ROOT/AGENTS.md"          "CLAUDE.md"
check_link "$ROOT/obsidian/AGENTS.md" "CLAUDE.md"

echo "DONE"
exit $FAIL
