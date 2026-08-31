#!/bin/bash
# sync-mirrors.sh — 鏡像同步 + 單一來源健檢
#
# 實況（2026-07-21 以 inode 實測確認）：
#   - .claude/commands → symlink → aladdin_ai/commands   ┐
#   - .claude/agents   → symlink → aladdin_ai/agents     ├ 同一份檔案，天然不會漂移
#   - .claude/skills   → symlink → aladdin_ai/skills     │（但 symlink 若被誤換成真目錄，漂移風險立刻回來）
#   - .claude/doctrine → symlink → aladdin_ai/doctrine   │
#   - scripts          → symlink → aladdin_ai/scripts    │
#   - conn             → symlink → aladdin_ai/conn       ┘
#   - CLAUDE.md（專案根）↔ obsidian/CLAUDE.md：**唯一真正的雙實體複本**，需要本腳本同步
#
# 2026-08-31：這組 symlink 目標從 obsidian/ 整批遷到獨立的 aladdin_ai repo（含完整
# git 歷史，用 git filter-repo 遷移）；obsidian 本身停止追蹤這些路徑，只保留純知識庫
# 內容。CLAUDE.md 雙實體本身沒動，鏡像仍留在 obsidian（供 Obsidian vault 瀏覽）。
#
# 用法：
#   bash scripts/sync-mirrors.sh          # 同步 CLAUDE.md（root → obsidian）+ 檢查所有 symlink 完好
#   bash scripts/sync-mirrors.sh --check  # 只報告，不寫入
#
# 給未來維護者：
#   - 新增「雙實體」配對前先想清楚能不能用 symlink（單一來源永遠優於同步兩份）。
#   - 環境陷阱：BSD find / harness 的 bfs 包裝，對「本身是 symlink 的目錄」當參數時會**靜默回空**。
#     腳本內要遍歷這些目錄請用實體路徑（aladdin_ai/...）或先 cd 進去用相對路徑。
set -u
ROOT=/Users/user/aladdin
MODE="${1:-sync}"
FAIL=0

echo "== 1. CLAUDE.md（唯一雙實體配對；canonical = 專案根）=="
if cmp -s "$ROOT/CLAUDE.md" "$ROOT/obsidian/CLAUDE.md"; then
  echo "OK: obsidian/CLAUDE.md 與專案根一致"
elif [ "$MODE" = "--check" ]; then
  echo "DRIFT: obsidian/CLAUDE.md 與專案根不一致（跑 sync 修復）"
  FAIL=1
elif [ "$ROOT/obsidian/CLAUDE.md" -nt "$ROOT/CLAUDE.md" ]; then
  # 鏡像比 canonical 新 = 有人直接改了鏡像；覆蓋會丟失修改，拒絕並要求人工合併
  echo "CONFLICT: obsidian/CLAUDE.md 比專案根新。請把鏡像上的修改手動合併回 /Users/user/aladdin/CLAUDE.md 再跑 sync（本腳本不覆蓋較新的鏡像）。"
  FAIL=1
else
  cp -p "$ROOT/CLAUDE.md" "$ROOT/obsidian/CLAUDE.md" && echo "SYNCED: obsidian/CLAUDE.md"
fi

echo "== 2. 單一來源 symlink 健檢 =="
check_link() { # $1=link path, $2=expected target
  local t
  if [ -L "$1" ]; then
    t=$(readlink "$1")
    if [ "$t" = "$2" ]; then echo "SYMLINK_OK: $1 -> $2"; return; fi
    echo "SYMLINK_WRONG: $1 -> $t （預期 $2 ）"; FAIL=1
  elif [ -d "$1" ]; then
    echo "SYMLINK_REPLACED_BY_DIR: $1 已變成真目錄——漂移風險回來了，請人工檢查是否要恢復 symlink"; FAIL=1
  else
    echo "SYMLINK_MISSING: $1 不存在"; FAIL=1
  fi
}
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

echo "DONE ($MODE)"
exit $FAIL
