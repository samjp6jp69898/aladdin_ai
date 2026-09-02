#!/bin/bash
# pipeline-status.sh — 一條指令看懂 /create-mr(s)、/analyze-bugs 目前跑到哪
#
# 動機（2026-07-03）：pipeline 單張 20–40 分鐘，manager 同步等重型 agent（tracer=opus）時
# 畫面長時間無輸出，使用者會誤以為「卡住」。本腳本從檔案系統唯讀還原真實進度：
#   /tmp/bug-analysis-locks/ = 誰在跑、跑多久
#   obsidian/Debug/{ticket}/ 產物 mtime = 走到哪個 stage
#   worktrees/{ticket}/     = 是否已進 fixer 階段
#
# 用法：bash /Users/user/aladdin/scripts/pipeline-status.sh
# 唯讀，不動任何鎖與狀態。
set -u
LOCK_DIR=/tmp/bug-analysis-locks
DEBUG_DIR=/Users/user/aladdin/obsidian/Debug
WT_DIR=/Users/user/aladdin/worktrees
NOW=$(date +%s)

mins_since() { # $1 = epoch
  echo $(( (NOW - $1) / 60 ))
}
mt() { stat -f '%m' "$1" 2>/dev/null || echo 0; }
hm() { date -r "$1" '+%H:%M' 2>/dev/null; }

echo "== Pipeline Status $(date '+%m-%d %H:%M') =="

TICKETS=""
if [ -d "$LOCK_DIR" ]; then
  for d in "$LOCK_DIR"/FAQ-*; do
    [ -d "$d" ] || continue
    t=$(basename "$d")
    TICKETS="$TICKETS $t"
    lm=$(mt "$d")
    echo "[LOCK] ${t}  claimed $(hm "$lm")（$(mins_since "$lm") 分鐘前）"
  done
fi
[ -z "$TICKETS" ] && echo "[LOCK] 無進行中的鎖（沒有 pipeline 在跑，或剛好在兩張之間）"

for t in $TICKETS; do
  echo ""
  echo "── ${t} ──"
  row=$(bash /Users/user/aladdin/scripts/tracker.sh row "$t" 2>/dev/null) && echo "  tracker: $row"
  D="$DEBUG_DIR/$t"
  if [ ! -d "$D" ]; then echo "  Debug 目錄尚未建立（Step 1 analyst 進行中或剛開始）"; continue; fi

  # 依 create-mr 的 stage 順序檢查產物；latest_* 記錄最後完成的 stage
  latest_name="(尚無產物)"; latest_ts=0
  for spec in "analytics:Step1 analyst" "spec:Step2 spec" "grounding:Step2.5 grounding" "analysis-notes:Step3 tracer" "solution:Step6 之後（solution 彙整）"; do
    key="${spec%%:*}"; label="${spec#*:}"
    f="$D/${t}-${key}.md"
    if [ -f "$f" ]; then
      ts=$(mt "$f")
      echo "  $(hm "$ts")  ${label} ✓  (${t}-${key}.md)"
      latest_name="$label"; latest_ts=$ts
    fi
  done
  rev=$(ls "$D" 2>/dev/null | grep -i "reviewer" | head -1)
  [ -n "$rev" ] && { ts=$(mt "$D/$rev"); echo "  $(hm "$ts")  Step6 reviewer ✓  ($rev)"; latest_name="Step6 reviewer"; latest_ts=$ts; }

  # 推論目前 stage（最後產物的下一步）＋elapsed＋正常時長提示
  if [ "$latest_ts" -gt 0 ]; then
    el=$(mins_since "$latest_ts")
    case "$latest_name" in
      "Step2.5 grounding") nxt="Step3 tracer（opus 重型，正常 15–40 分鐘）";;
      "Step3 tracer")      nxt="Step4 worktree ＋ Step5 fixer（正常 10–30 分鐘）";;
      "Step1 analyst")     nxt="Step2 spec（數分鐘）";;
      "Step2 spec")        nxt="Step2.5 grounding（5–15 分鐘）";;
      *)                   nxt="下一步";;
    esac
    echo "  ▶ 目前：${nxt} — 自上個產物起已 ${el} 分鐘"
    [ "$el" -gt 45 ] && echo "  ⚠ 超過 45 分鐘無新產物 — 若對應視窗也無輸出，才需要懷疑真的卡住"
  fi

  # worktree / MR 線索
  if [ -d "$WT_DIR/$t" ]; then
    brs=$(ls "$WT_DIR/$t" 2>/dev/null | tr '\n' ' ')
    echo "  worktree: 已建立（${brs}）→ 已進 Step4+ "
  else
    echo "  worktree: 未建立（tracer 完成後才會建）"
  fi
done

echo ""
echo "[TRACKER] $(bash /Users/user/aladdin/scripts/tracker.sh counts 2>/dev/null | tr '\n' ' ')"
echo "[NOTE] 本腳本唯讀。單張全程 20–40 分鐘屬正常；「畫面停住」多半是 manager 在同步等重型 agent，不是卡死。"
