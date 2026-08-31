#!/usr/bin/env bash
# tg-notify.sh — 向「該處理技術」發 Telegram 私訊（pipeline 收尾通知）
# 用法：
#   tg-notify.sh --email "<tech_email>"            --text "<msg>" [--dry-run]
#   tg-notify.sh --notion-user-ids "<id1 id2 ...>" --text "<msg>" [--dry-run]
#   tg-notify.sh --chat-id "<chat_id>"             --text "<msg>" [--dry-run]   # 直送，繞過 CSV，供獨立測試
#   加 --file "<path>" 改發檔案（sendDocument）：--text 選填，帶了就當 caption（上限 1024 字，超過由 Telegram 回錯）
# 紀律：一律 exit 0、永不阻斷 pipeline；結果印一行供呼叫端記 log。
# Bot token 來源：根目錄 /Users/user/aladdin/.env 的 TG_BOT_TOKEN 或 TELEGRAM_BOT_TOKEN（檔內先出現者勝）；查無即 TG_FAIL，不再後備讀 channel .env
set -uo pipefail

CSV="${TG_NOTIFY_CSV:-/Users/user/aladdin/aladdin_ai/commands/create-mr/references/tech-users.csv}"
ROOT_ENV_FILE="${TG_ROOT_ENV_FILE:-/Users/user/aladdin/.env}"   # 根目錄 .env，唯一 token 來源（鍵名 TG_BOT_TOKEN 或 TELEGRAM_BOT_TOKEN）
API_BASE="${TG_API_BASE:-https://api.telegram.org}"

EMAIL=""; IDS=""; TEXT=""; DRY=0; CHAT_DIRECT=""; FILE=""
while [ $# -gt 0 ]; do
  case "$1" in
    # 各兩參數旗標：先取值（缺值則空字串，避免 set -u abort），再安全 shift（先移除旗標，值存在才再 shift）
    --email)            EMAIL="${2:-}";       shift; [ $# -gt 0 ] && shift;;
    --notion-user-ids)  IDS="${2:-}";         shift; [ $# -gt 0 ] && shift;;
    --chat-id)          CHAT_DIRECT="${2:-}"; shift; [ $# -gt 0 ] && shift;;
    --text)             TEXT="${2:-}";        shift; [ $# -gt 0 ] && shift;;
    --file)             FILE="${2:-}";        shift; [ $# -gt 0 ] && shift;;
    --dry-run)          DRY=1; shift;;
    *)                  shift;;   # 未知旗標刻意略過（永不阻斷）；email 優先於 notion-user-ids
  esac
done

[ -z "$TEXT" ] && [ -z "$FILE" ] && { echo "TG_FAIL: missing --text or --file"; exit 0; }
# 至少要有一種 selector
[ -z "$CHAT_DIRECT" ] && [ -z "$EMAIL" ] && [ -z "$IDS" ] && { echo "TG_FAIL: missing selector (--email/--notion-user-ids/--chat-id)"; exit 0; }
[ -n "$FILE" ] && [ ! -f "$FILE" ] && { echo "TG_FAIL: file not found ($FILE)"; exit 0; }

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

if [ "$DRY" = "1" ]; then
  if [ -n "$FILE" ]; then echo "TG_SENT(dry-run): $MATCH_EMAIL chat_id=$MATCH_CHAT file=$FILE"
  else echo "TG_SENT(dry-run): $MATCH_EMAIL chat_id=$MATCH_CHAT"; fi
  exit 0
fi

TOKEN=""
# 只讀根目錄 .env 的 TG_BOT_TOKEN 或 TELEGRAM_BOT_TOKEN（檔內先出現者勝）；查無即 TG_FAIL，不再後備讀 channel .env
[ -f "$ROOT_ENV_FILE" ] && TOKEN="$(grep -E '^(TG_BOT_TOKEN|TELEGRAM_BOT_TOKEN)=' "$ROOT_ENV_FILE" | head -n1 | cut -d= -f2- | tr -d '[:space:]')"
[ -z "$TOKEN" ] && { echo "TG_FAIL: $MATCH_EMAIL (no bot token in $ROOT_ENV_FILE)"; exit 0; }

# 同時取回應 body 與 HTTP code（body 在前、最後一行為 code），失敗時帶出 Telegram 的 description
if [ -n "$FILE" ]; then
  # sendDocument：檔案當附件，--text（若有）當 caption；用陣列組 curl 參數避免 caption 含空白被字詞分割
  CURL_ARGS=(-s -w $'\n%{http_code}' -X POST "$API_BASE/bot$TOKEN/sendDocument" -F "chat_id=$MATCH_CHAT" -F "document=@${FILE}")
  [ -n "$TEXT" ] && CURL_ARGS+=(-F "caption=$TEXT")
  RESP="$(curl "${CURL_ARGS[@]}")"
else
  RESP="$(curl -s -w $'\n%{http_code}' \
    -X POST "$API_BASE/bot$TOKEN/sendMessage" \
    --data-urlencode "chat_id=$MATCH_CHAT" \
    --data-urlencode "text=$TEXT")"
fi
HTTP="${RESP##*$'\n'}"   # 最後一行＝HTTP code
BODY="${RESP%$'\n'*}"    # 其餘＝回應 body
if [ "$HTTP" = "200" ]; then
  echo "TG_SENT: $MATCH_EMAIL"
else
  DESC="$(printf '%s' "$BODY" | sed -n 's/.*"description":"\([^"]*\)".*/\1/p')"
  [ -n "$DESC" ] && echo "TG_FAIL: $MATCH_EMAIL (http $HTTP: $DESC)" || echo "TG_FAIL: $MATCH_EMAIL (http $HTTP)"
fi
exit 0
