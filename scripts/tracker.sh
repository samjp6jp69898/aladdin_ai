#!/bin/bash
# tracker.sh — bug_analysis_tracker.md 的行級操作
#
# 這個檔案 166KB+，**嚴禁**整檔 cat 進 LLM context、嚴禁用 Edit tool 直改（大檔比對易錯）。
# 所有讀寫一律走本腳本。行格式（6 個內容欄的 markdown table）：
#   | FAQ-3757 | https://... | P2較高 | pending | 2026-07-03 |  |
#
# 用法：
#   bash scripts/tracker.sh next                 # 印第一個可認領行（rerun 優先於 pending；各組內 FAQ 號降冪）
#   bash scripts/tracker.sh next "FAQ-1,FAQ-2"   # 同上，但排除清單內的單（給 batch 跳過被鎖單用）
#   bash scripts/tracker.sh row FAQ-1234         # 印該單整行（找不到印 NOT_FOUND，exit 1）
#   bash scripts/tracker.sh set FAQ-1234 in_progress
#   bash scripts/tracker.sh set FAQ-1234 done "2026-07-03 1530"   # 第三參數 = 完成時間（可省略）
#   bash scripts/tracker.sh counts               # 各狀態統計
#   bash scripts/tracker.sh log-fail FAQ-1234 "step5 fixer 超過重試上限"  # 失敗原因記到 pipeline-failures.md
#
# 合法狀態：pending rerun in_progress done failed needs_qa
set -u
TRACKER="${TRACKER_FILE:-/Users/user/.claude/projects/-Users-user-aladdin/memory/bug_analysis_tracker.md}"
FAILLOG="$(dirname "$TRACKER")/pipeline-failures.md"
ACTION="${1:-}"

[ -f "$TRACKER" ] || { echo "ERROR: tracker 不存在：$TRACKER"; exit 1; }

case "$ACTION" in
  next)
    EXCLUDE=",${2:-},"
    for want in rerun pending; do
      line=$(grep -E "^\| FAQ-[0-9]+ \|" "$TRACKER" | awk -F'|' -v w="$want" -v ex="$EXCLUDE" '
        BEGIN { gsub(/ /,"",ex) }   # 容忍「逗號+空格」的排除清單
        { s=$5; gsub(/ /,"",s); id=$2; gsub(/ /,"",id);
          if (s==w && index(ex, "," id ",")==0) print $0 }' | sort -t- -k2,2rn | head -1)
      if [ -n "$line" ]; then echo "$line"; exit 0; fi
    done
    echo "NO_CLAIMABLE"; exit 1
    ;;
  row)
    T="${2:?用法: tracker.sh row FAQ-1234}"
    line=$(grep -E "^\| ${T} \|" "$TRACKER" | head -1)
    [ -n "$line" ] && echo "$line" || { echo "NOT_FOUND: $T"; exit 1; }
    ;;
  set)
    T="${2:?用法: tracker.sh set FAQ-1234 <狀態> [完成時間]}"
    ST="${3:?缺狀態}"
    DONE_AT="${4:-}"
    case "$ST" in pending|rerun|in_progress|done|failed|needs_qa) ;; *) echo "ERROR: 非法狀態 $ST"; exit 1;; esac
    grep -qE "^\| ${T} \|" "$TRACKER" || { echo "NOT_FOUND: $T"; exit 1; }
    # 檔級自旋鎖：兩個 session 並行 set 不同單時避免整檔重寫互相覆蓋（bug-lock 是 per-ticket，保護不了這裡）
    SETLOCK="/tmp/bug-analysis-locks/.tracker-set-lock"
    mkdir -p "${SETLOCK%/*}"   # 父目錄可能尚不存在（/tmp 清空且未先跑 bug-lock.sh 時）
    n=0
    until mkdir "$SETLOCK" 2>/dev/null; do
      n=$((n+1)); [ "$n" -gt 50 ] && { echo "ERROR: tracker set 鎖等待逾時（$SETLOCK 疑似殘留，確認無人在寫後可 rmdir）"; exit 1; }
      sleep 0.1
    done
    trap 'rmdir "$SETLOCK" 2>/dev/null' EXIT
    tmp=$(mktemp)
    awk -F'|' -v OFS='|' -v t="$T" -v st="$ST" -v da="$DONE_AT" '
      $2 == " " t " " {
        $5 = " " st " "
        if (da != "") $7 = " " da " "
      }
      { print }
    ' "$TRACKER" > "$tmp" && mv "$tmp" "$TRACKER"
    echo "SET: $T -> $ST${DONE_AT:+ ($DONE_AT)}"
    bash "$(dirname "$0")/tracker.sh" row "$T"
    ;;
  counts)
    grep -E "^\| FAQ-[0-9]+ \|" "$TRACKER" | awk -F'|' '{ s=$5; gsub(/ /,"",s); c[s]++ } END { for (k in c) printf "%s %d\n", k, c[k] }' | sort
    ;;
  log-fail)
    T="${2:?用法: tracker.sh log-fail FAQ-1234 \"原因\"}"
    R="${3:-（未填原因）}"
    [ -f "$FAILLOG" ] || printf '# pipeline 失敗原因流水帳（tracker.sh log-fail 自動追加）\n\n' > "$FAILLOG"
    printf -- '- %s | %s | %s\n' "$(date '+%Y-%m-%d %H%M')" "$T" "$R" >> "$FAILLOG"
    echo "LOGGED: $T"
    ;;
  *)
    echo "用法：tracker.sh {next|row|set|counts|log-fail} [args]（詳見檔頭註解）"; exit 1
    ;;
esac
