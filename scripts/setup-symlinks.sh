#!/bin/bash
# setup-symlinks.sh — 一鍵(重)建 aladdin/ 根目錄下指向 aladdin_ai/ 的單一來源 symlink
#
# 換機器 clone/pull aladdin_ai 之後跑一次即可；ln -sf 具冪等性，重複執行安全。
# 跑完建議接著跑 bash scripts/sync-mirrors.sh --check 驗證全部 symlink 健康。
#
# 用法：bash /Users/user/aladdin/aladdin_ai/scripts/setup-symlinks.sh
set -euo pipefail
ROOT=/Users/user/aladdin

# -n：目的地若已是「指向目錄的 symlink」，ln -sf（無 -n）會沿著它解析到目錄本身，
# 變成在該目錄內建立一個自我參照的巢狀 symlink，而不是取代原本那個 symlink
# （2026-09-01 實測踩過：commands/agents/skills/doctrine/scripts/conn 六個目的地
# 平時就是符合這個踩坑條件的 symlink，一定要加 -n）。
ln -sfn "$ROOT/aladdin_ai/commands" "$ROOT/.claude/commands"
ln -sfn "$ROOT/aladdin_ai/agents"   "$ROOT/.claude/agents"
ln -sfn "$ROOT/aladdin_ai/skills"   "$ROOT/.claude/skills"
ln -sfn "$ROOT/aladdin_ai/doctrine" "$ROOT/.claude/doctrine"
ln -sfn "$ROOT/aladdin_ai/scripts"  "$ROOT/scripts"
ln -sfn "$ROOT/aladdin_ai/conn"     "$ROOT/conn"

echo "symlink 重建完成，健檢："
bash "$ROOT/aladdin_ai/scripts/sync-mirrors.sh" --check
