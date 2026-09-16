#!/usr/bin/env bash
# claude-p-rate-watch.sh — 透明包裝 claude -p 呼叫，額外監控 5hr/weekly rate limit。
#
# 背景：claude -p（非互動 print 模式）不會觸發 statusLine，所以
# rate-limit-notify.sh 平常掛的那條路徑（interactive session 專用）對 pipeline
# 呼叫完全無效（2026-09-14 實測驗證：加 debug log 到 statusline-command.sh 後
# 跑 claude -p，log 完全沒被寫入）。
#
# 但 `claude -p --output-format json` 與 `--output-format stream-json` 的輸出裡
# 都含 `type: "rate_limit_event"` 事件（帶 rate_limit_info.unifiedWindows.
# {five_hour,seven_day}.{utilization,resetsAt}），本腳本從這裡截取資料、轉成跟
# statusLine 一樣的 schema，餵給共用的 rate-limit-notify.sh。
#
# 用法：跟 claude -p 完全一樣的參數，原封不動轉呼叫真正的 claude binary——
# stdout/stderr/exit code 對呼叫端完全透通，呼叫端不需要知道多了這層包裝。
#   claude-p-rate-watch.sh -p --output-format json "..."
#
# 只有 --output-format text（無 JSON 事件流）時抓不到 rate_limit_event，
# 這種情況本腳本仍會透通執行 claude，只是監控不到，不影響原本行為。
#
# 訊號轉送（重要）：呼叫端（如 Node execFile 的 timeout、或外層 `timeout` 指令）
# 逾時會對本腳本這個行程送 SIGTERM/SIGINT。不能用簡單的 `A | tee file` 寫法——
# 那樣訊號只會殺到本腳本本身，真正在跑的 claude 行程會變孤兒繼續跑，讓上層的
# 逾時保證失效。改用背景執行＋明確 trap 轉送，$CHILD 直接是 claude 的 PID。
set -uo pipefail

CLAUDE_BIN="${CLAUDE_BIN_REAL:-/Users/user/.local/bin/claude}"
NOTIFY_SCRIPT="${RATE_LIMIT_NOTIFY_SCRIPT:-/Users/user/aladdin/scripts/rate-limit-notify.sh}"

TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT

# stdout 原封不動經 process substitution 的 tee 轉給真正呼叫端，同時留一份供事後
# 解析；stderr 直接繼承、不經手。$CHILD 是 claude 本身的 PID（不是 tee 的），
# 收到 TERM/INT 時明確轉送給它，wait 拿到的就是 claude 本身的真實 exit code。
"$CLAUDE_BIN" "$@" <&0 > >(tee "$TMP") &
CHILD=$!
trap "kill -TERM $CHILD 2>/dev/null" TERM INT
wait "$CHILD"
EC=$?
# process substitution 是非同步子行程，稍微等一下讓 tee 把最後幾行寫完，
# 避免 $TMP 被讀取時內容還沒落地（下面的 jq 解析才會拿到完整輸出）
wait 2>/dev/null

if command -v jq >/dev/null 2>&1 && [ -f "$NOTIFY_SCRIPT" ]; then
  # `..` 遞迴掃描：json 格式（整包一個陣列）與 stream-json 格式（多個獨立 JSON
  # 物件接續輸出）都吃得下，取最後一筆事件即可（同一次 -p 呼叫內用量只會愈來愈高）
  LAST_EVENT=$(jq -c '.. | objects | select(.type == "rate_limit_event")' "$TMP" 2>/dev/null | tail -1)
  if [ -n "$LAST_EVENT" ]; then
    SYNTH=$(printf '%s' "$LAST_EVENT" | jq -c '{
      rate_limits: {
        five_hour: {
          used_percentage: ((.rate_limit_info.unifiedWindows.five_hour.utilization // 0) * 100),
          resets_at: .rate_limit_info.unifiedWindows.five_hour.resetsAt
        },
        seven_day: {
          used_percentage: ((.rate_limit_info.unifiedWindows.seven_day.utilization // 0) * 100),
          resets_at: .rate_limit_info.unifiedWindows.seven_day.resetsAt
        }
      }
    }' 2>/dev/null)
    [ -n "$SYNTH" ] && sh "$NOTIFY_SCRIPT" "$SYNTH" >/dev/null 2>&1 &
  fi
fi

exit "$EC"
