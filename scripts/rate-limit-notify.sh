#!/bin/sh
# rate-limit-notify.sh — 5hr / weekly usage limit 門檻通知（80/90/95/99%）
#
# 兩種呼叫來源共用同一份邏輯（餵進來的 $1 都是同一種正規化 JSON schema，
# 差別只在誰負責把原始資料轉成這個 schema）：
#   1. 互動式 session：~/.claude/statusline-command.sh 每次 render 時，
#      直接把 statusLine 收到的 stdin JSON（已內建 rate_limits.*）轉呼叫進來。
#   2. claude -p（非互動）：claude-p-rate-watch.sh 從 -p 輸出裡的
#      rate_limit_event 轉換成同一種 schema 後轉呼叫進來。
# 去重規則：以 rate_limits.<key>.resets_at 當作 window 識別碼，
# 同一個 window 內每個門檻只發一次；resets_at 改變（window 重置）即視為新 window，重新可發。
# 這份腳本放在 aladdin_ai/scripts（single source，經 setup-symlinks.sh 連到
# 各機器 /Users/user/aladdin/scripts/），worker 機透過既有的 sync-workers.sh
# git pull 自動取得，不需要另外手動同步。
set -u

input="${1:-}"
[ -z "$input" ] && exit 0

STATE_FILE="${RATE_LIMIT_NOTIFY_STATE:-$HOME/.claude/rate-limit-notify-state.json}"
CHAT_ID="${RATE_LIMIT_NOTIFY_CHAT_ID:-5022865804}"
TG_NOTIFY="${RATE_LIMIT_NOTIFY_TG_SCRIPT:-/Users/user/aladdin/aladdin_ai/scripts/tg-notify.sh}"
CLAUDE_JSON="${RATE_LIMIT_NOTIFY_CLAUDE_JSON:-$HOME/.claude.json}"
THRESHOLDS="80 90 95 99"

command -v jq >/dev/null 2>&1 || exit 0
[ -x "$TG_NOTIFY" ] || [ -f "$TG_NOTIFY" ] || exit 0

# 帳號代稱：動態讀取目前登入的 Claude 帳號 email 前綴，不寫死，換帳號/換機器自動跟著變
ACCOUNT_LABEL=$(jq -r '.oauthAccount.emailAddress // empty' "$CLAUDE_JSON" 2>/dev/null | cut -d@ -f1)
[ -z "$ACCOUNT_LABEL" ] && ACCOUNT_LABEL="claude"

[ -f "$STATE_FILE" ] || echo '{}' > "$STATE_FILE"

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

  state=$(jq -c --arg k "$key" '.[$k] // {"resets_at":null,"sent":[]}' "$STATE_FILE" 2>/dev/null) || return
  state_resets=$(printf '%s' "$state" | jq -r '.resets_at // empty')

  # window 已重置（resets_at 變了）：清空已發送紀錄
  if [ "$state_resets" != "$resets_at" ]; then
    state=$(jq -n --argjson r "$resets_at" '{"resets_at":$r,"sent":[]}')
  fi

  # 無條件捨去小數（避免 79.6% 被四捨五入成 80% 提前誤發）
  pct_int=$(awk -v p="$pct" 'BEGIN{printf "%d", p}')

  for th in $THRESHOLDS; do
    already=$(printf '%s' "$state" | jq --argjson t "$th" '.sent | index($t) != null')
    if [ "$pct_int" -ge "$th" ] && [ "$already" = "false" ]; then
      reset_human=$(date -r "$resets_at" '+%m/%d %H:%M' 2>/dev/null || echo "$resets_at")
      text="⚠️ [$ACCOUNT_LABEL] ${label} 使用率已達 ${th}%（目前 ${pct_int}%，重置時間 ${reset_human}）"
      "$TG_NOTIFY" --chat-id "$CHAT_ID" --text "$text" >/dev/null 2>&1
      state=$(printf '%s' "$state" | jq --argjson t "$th" '.sent += [$t]')
    fi
  done

  jq --arg k "$key" --argjson v "$state" '.[$k] = $v' "$STATE_FILE" > "${STATE_FILE}.tmp" 2>/dev/null \
    && mv "${STATE_FILE}.tmp" "$STATE_FILE"
}

check_limit "five_hour" "5-hour limit"
check_limit "seven_day" "Weekly limit"

exit 0
