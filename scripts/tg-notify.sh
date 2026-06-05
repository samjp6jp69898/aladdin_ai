#!/usr/bin/env bash
# tg-notify.sh — 向「該處理技術」發 Telegram 私訊（pipeline 收尾通知）
# 用法：
#   tg-notify.sh --email "<tech_email>"            --text "<msg>" [--dry-run]
#   tg-notify.sh --notion-user-ids "<id1 id2 ...>" --text "<msg>" [--dry-run]
#   tg-notify.sh --chat-id "<chat_id>"             --text "<msg>" [--dry-run]   # 直送，繞過 CSV，供獨立測試
# 紀律：一律 exit 0、永不阻斷 pipeline；結果印一行供呼叫端記 log。
set -uo pipefail

CSV="${TG_NOTIFY_CSV:-/Users/user/aladdin/obsidian/commands/create-mr/references/tech-users.csv}"
ENV_FILE="${TG_ENV_FILE:-/Users/user/.claude/channels/telegram/.env}"
API_BASE="${TG_API_BASE:-https://api.telegram.org}"

EMAIL=""; IDS=""; TEXT=""; DRY=0; CHAT_DIRECT=""
while [ $# -gt 0 ]; do
  case "$1" in
    # 各兩參數旗標：先取值（缺值則空字串，避免 set -u abort），再安全 shift（先移除旗標，值存在才再 shift）
    --email)            EMAIL="${2:-}";       shift; [ $# -gt 0 ] && shift;;
    --notion-user-ids)  IDS="${2:-}";         shift; [ $# -gt 0 ] && shift;;
    --chat-id)          CHAT_DIRECT="${2:-}"; shift; [ $# -gt 0 ] && shift;;
    --text)             TEXT="${2:-}";        shift; [ $# -gt 0 ] && shift;;
    --dry-run)          DRY=1; shift;;
    *)                  shift;;   # 未知旗標刻意略過（永不阻斷）；email 優先於 notion-user-ids
  esac
done

[ -z "$TEXT" ] && { echo "TG_FAIL: missing --text"; exit 0; }
# 至少要有一種 selector
[ -z "$CHAT_DIRECT" ] && [ -z "$EMAIL" ] && [ -z "$IDS" ] && { echo "TG_FAIL: missing selector (--email/--notion-user-ids/--chat-id)"; exit 0; }

MATCH_EMAIL=""; MATCH_CHAT=""
if [ -n "$CHAT_DIRECT" ]; then
  # 直送模式：繞過 CSV，供使用者獨立測試真實送出
  MATCH_EMAIL="(direct)"; MATCH_CHAT="$CHAT_DIRECT"
else
  [ ! -f "$CSV" ] && { echo "TG_FAIL: csv not found ($CSV)"; exit 0; }
  # header-aware 欄位索引（去除可能的 CR）
  header="$(head -n1 "$CSV" | tr -d '\r')"
  IFS=',' read -r -a COLS <<< "$header"
  # 注意：本 CSV 採純逗號切分（非 RFC-4180），欄位值不得含逗號（pushed_repos 用 ; 分隔）
  idx() { local name="$1" i=0 c; for c in "${COLS[@]}"; do [ "$c" = "$name" ] && { echo "$i"; return; }; i=$((i+1)); done; echo "-1"; }
  EMAIL_IDX="$(idx email)"; NID_IDX="$(idx notion_user_id)"; CHAT_IDX="$(idx tg_chat_id)"
  [ "$CHAT_IDX" = "-1" ] && { echo "TG_FAIL: tech-users.csv 缺 tg_chat_id 欄"; exit 0; }

  FOUND_TECH=0
  while IFS=',' read -r -a F; do
    row_email="${F[$EMAIL_IDX]:-}"; row_nid="${F[$NID_IDX]:-}"; row_chat="${F[$CHAT_IDX]:-}"
    [ "$row_email" = "email" ] && continue   # 跳過表頭
    if [ -n "$EMAIL" ]; then
      if [ "$row_email" = "$EMAIL" ]; then FOUND_TECH=1; MATCH_EMAIL="$row_email"; MATCH_CHAT="$row_chat"; break; fi
    elif [ -n "$IDS" ]; then
      for id in $IDS; do
        if [ "$row_nid" = "$id" ]; then FOUND_TECH=1; MATCH_EMAIL="$row_email"; MATCH_CHAT="$row_chat"; break 2; fi
      done
    fi
  done < <(tr -d '\r' < "$CSV")

  TARGET="${EMAIL:-$IDS}"
  [ "$FOUND_TECH" = "0" ] && { echo "TG_SKIP_NOT_TECH: $TARGET"; exit 0; }
  MATCH_CHAT="$(printf '%s' "$MATCH_CHAT" | tr -d '[:space:]')"
  [ -z "$MATCH_CHAT" ] && { echo "TG_SKIP_NO_CHATID: $MATCH_EMAIL"; exit 0; }
fi

if [ "$DRY" = "1" ]; then echo "TG_SENT(dry-run): $MATCH_EMAIL chat_id=$MATCH_CHAT"; exit 0; fi

TOKEN=""
[ -f "$ENV_FILE" ] && TOKEN="$(grep -E '^TELEGRAM_BOT_TOKEN=' "$ENV_FILE" | head -n1 | cut -d= -f2- | tr -d '[:space:]')"
[ -z "$TOKEN" ] && { echo "TG_FAIL: $MATCH_EMAIL (no bot token)"; exit 0; }

HTTP="$(curl -s -o /dev/null -w '%{http_code}' \
  -X POST "$API_BASE/bot$TOKEN/sendMessage" \
  --data-urlencode "chat_id=$MATCH_CHAT" \
  --data-urlencode "text=$TEXT")"
[ "$HTTP" = "200" ] && echo "TG_SENT: $MATCH_EMAIL" || echo "TG_FAIL: $MATCH_EMAIL (http $HTTP)"
exit 0
