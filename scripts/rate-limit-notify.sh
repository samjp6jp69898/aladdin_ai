#!/bin/sh
# rate-limit-notify.sh — 5hr / weekly usage limit 門檻通知（80/90/95/99%）
#
# 兩種呼叫來源共用同一份邏輯（餵進來的 $1 都是同一種正規化 JSON schema，
# 差別只在誰負責把原始資料轉成這個 schema）：
#   1. 互動式 session：~/.claude/statusline-command.sh 每次 render 時，
#      直接把 statusLine 收到的 stdin JSON（已內建 rate_limits.*）轉呼叫進來。
#   2. claude -p（非互動）：claude-p-rate-watch.sh 從 -p 輸出裡的
#      rate_limit_event 轉換成同一種 schema 後轉呼叫進來。
# 去重規則（2026-09-16 改版，修中午 90% 門檻炸出 300+ 則重複通知的併發 race）：
# statusline-command.sh 每次 render 都背景（&）呼叫本腳本一次，render 頻率極高，
# 短時間內會有大量併發呼叫同時執行。舊版用「讀 JSON state → 判斷 → 送 → 寫回 JSON
# state」，讀取與寫回之間沒有原子性保證，併發呼叫全部在彼此寫回前讀到「還沒發過」，
# 於是全部各自送出，才會炸出遠超 4 個門檻的重複訊息。
# 新版不用可變的 JSON state，改用「claim 目錄」本身當唯一且永久的發送紀錄：
# 目錄名 = <key>.<resets_at>.<threshold>，resets_at 是該 window 的識別碼、threshold
# 是門檻百分比，兩者組合即「這個 window 的這個門檻」的唯一鍵。`mkdir` 是原子操作，
# 併發呼叫對同名目錄只有一個會成功——成功的那個才有資格送 Telegram；送成功就讓
# 目錄留著當永久標記（之後任何呼叫 mkdir 都會失敗、自然跳過，不用輪詢或重試）；
# 送失敗（tg-notify.sh 回報非 TG_SENT）就 rmdir 讓出 claim，下次呼叫自然重試。
# resets_at 改變（window 重置）即產生全新的目錄名，等同新 window 重新可發。
# 這份腳本放在 aladdin_ai/scripts（single source，經 setup-symlinks.sh 連到
# 各機器 /Users/user/aladdin/scripts/），worker 機透過既有的 sync-workers.sh
# git pull 自動取得，不需要另外手動同步。
set -u

input="${1:-}"
[ -z "$input" ] && exit 0

STATE_DIR="${RATE_LIMIT_NOTIFY_STATE_DIR:-$HOME/.claude/rate-limit-notify-state}"
CHAT_ID="${RATE_LIMIT_NOTIFY_CHAT_ID:-5022865804}"
TG_NOTIFY="${RATE_LIMIT_NOTIFY_TG_SCRIPT:-/Users/user/aladdin/aladdin_ai/scripts/tg-notify.sh}"
CLAUDE_JSON="${RATE_LIMIT_NOTIFY_CLAUDE_JSON:-$HOME/.claude.json}"
THRESHOLDS="80 90 95 99"

command -v jq >/dev/null 2>&1 || exit 0
[ -x "$TG_NOTIFY" ] || [ -f "$TG_NOTIFY" ] || exit 0

# 帳號代稱：動態讀取目前登入的 Claude 帳號 email 前綴，不寫死，換帳號/換機器自動跟著變
ACCOUNT_LABEL=$(jq -r '.oauthAccount.emailAddress // empty' "$CLAUDE_JSON" 2>/dev/null | cut -d@ -f1)
[ -z "$ACCOUNT_LABEL" ] && ACCOUNT_LABEL="claude"

mkdir -p "$STATE_DIR" 2>/dev/null
# 清掉過期 window 的 claim 目錄，避免無限累積（找不到就當作 0 個，不影響主流程）
find "$STATE_DIR" -mindepth 1 -maxdepth 1 -type d -mtime +2 -exec rmdir {} + 2>/dev/null || true

# 立即回報請求（旗標檔存在時，不論門檻，回報目前用量一次後清掉旗標；
# 若當下 rate_limits 尚未出現在輸入 JSON 中，就保留旗標等下一次呼叫自然重試，不用 sleep 硬等）
REPORT_FLAG="${RATE_LIMIT_NOTIFY_REPORT_FLAG:-$HOME/.claude/rate-limit-notify-report-request}"
if [ -f "$REPORT_FLAG" ]; then
  five_pct=$(printf '%s' "$input" | jq -r '.rate_limits.five_hour.used_percentage // empty' 2>/dev/null)
  five_resets=$(printf '%s' "$input" | jq -r '.rate_limits.five_hour.resets_at // empty' 2>/dev/null)
  week_pct=$(printf '%s' "$input" | jq -r '.rate_limits.seven_day.used_percentage // empty' 2>/dev/null)
  week_resets=$(printf '%s' "$input" | jq -r '.rate_limits.seven_day.resets_at // empty' 2>/dev/null)

  if [ -n "$five_pct" ] || [ -n "$week_pct" ]; then
    five_line="N/A"
    [ -n "$five_pct" ] && five_line="$(awk -v p="$five_pct" 'BEGIN{printf "%d", p}')%（重置 $(date -r "$five_resets" '+%m/%d %H:%M' 2>/dev/null || echo "$five_resets")）"
    week_line="N/A"
    [ -n "$week_pct" ] && week_line="$(awk -v p="$week_pct" 'BEGIN{printf "%d", p}')%（重置 $(date -r "$week_resets" '+%m/%d %H:%M' 2>/dev/null || echo "$week_resets")）"
    text="📊 [$ACCOUNT_LABEL] 目前用量 — 5-hour: ${five_line} ｜ Weekly: ${week_line}"
    "$TG_NOTIFY" --chat-id "$CHAT_ID" --text "$text" >/dev/null 2>&1
    rm -f "$REPORT_FLAG"
  fi
fi

check_limit() {
  key="$1"     # five_hour | seven_day
  label="$2"   # 顯示用文字

  pct=$(printf '%s' "$input" | jq -r ".rate_limits.${key}.used_percentage // empty" 2>/dev/null)
  resets_at=$(printf '%s' "$input" | jq -r ".rate_limits.${key}.resets_at // empty" 2>/dev/null)
  [ -z "$pct" ] && return
  [ -z "$resets_at" ] && return

  # 無條件捨去小數（避免 79.6% 被四捨五入成 80% 提前誤發）
  pct_int=$(awk -v p="$pct" 'BEGIN{printf "%d", p}')

  for th in $THRESHOLDS; do
    [ "$pct_int" -ge "$th" ] || continue

    claim_dir="$STATE_DIR/${key}.${resets_at}.${th}"
    # mkdir 是原子操作：同名目錄併發呼叫只有一個會成功，成功的那個才有資格送
    # Telegram，其餘全部在這裡自然跳過（不是等待重試，是這次直接不送）
    mkdir "$claim_dir" 2>/dev/null || continue

    reset_human=$(date -r "$resets_at" '+%m/%d %H:%M' 2>/dev/null || echo "$resets_at")
    text="⚠️ [$ACCOUNT_LABEL] ${label} 使用率已達 ${th}%（目前 ${pct_int}%，重置時間 ${reset_human}）"
    tg_out=$("$TG_NOTIFY" --chat-id "$CHAT_ID" --text "$text" 2>/dev/null)
    case "$tg_out" in
      TG_SENT*) : ;;  # 成功：claim_dir 留著當永久「已發送」標記
      *) rmdir "$claim_dir" 2>/dev/null ;;  # 失敗：讓出 claim，下次呼叫自然重試
    esac
  done
}

check_limit "five_hour" "5-hour limit"
check_limit "seven_day" "Weekly limit"

exit 0
