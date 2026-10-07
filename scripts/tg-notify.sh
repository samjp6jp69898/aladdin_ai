#!/usr/bin/env bash
# tg-notify.sh — 向「該處理技術」發 Telegram 私訊（pipeline 收尾通知）
# 用法：
#   tg-notify.sh --email "<tech_email>"            --text "<msg>" [--dry-run]
#   tg-notify.sh --notion-user-ids "<id1 id2 ...>" --text "<msg>" [--dry-run]
#   tg-notify.sh --chat-id "<chat_id>"             --text "<msg>" [--dry-run]   # 直送，繞過名冊，供獨立測試
#   加 --file "<path>" 改發檔案（sendDocument）：--text 選填，帶了就當 caption（上限 1024 字，超過由 Telegram 回錯）
# 紀律：一律 exit 0、永不阻斷 pipeline；結果印一行供呼叫端記 log。
# Bot token 來源：根目錄 /Users/user/aladdin/aladdin_ai/.env.local 的 TG_BOT_TOKEN 或 TELEGRAM_BOT_TOKEN（檔內先出現者勝）；查無即 TG_FAIL，不再後備讀 channel .env
set -uo pipefail

ROOT_ENV_FILE="${TG_ROOT_ENV_FILE:-/Users/user/aladdin/aladdin_ai/.env.local}"   # 根目錄 .env，唯一 token 來源（鍵名 TG_BOT_TOKEN 或 TELEGRAM_BOT_TOKEN）
API_BASE="${TG_API_BASE:-https://api.telegram.org}"
# 2026-09-15（DB 為 tg_chat_id 唯一權威）：chat_id 明碼透過 registry CLI 的
# --resolve-chat-id 取得；見 tech-users-sync.ts 檔頭「唯一例外」說明。
# 2026-09-16（Phase 6：tech-users.csv 刪檔退役）：「這個 email／notion_user_id
# 是不是技術人員」也改問同一支 CLI 的 --list-roster，本檔不再讀任何檔案名冊。
REGISTRY_CLI="${TG_REGISTRY_CLI:-bun /Users/user/aladdin/telegram-dispatcher/lib/registry/tech-users-sync.ts}"
REGISTRY_CLI_CWD="${TG_REGISTRY_CLI_CWD:-/Users/user/aladdin/telegram-dispatcher}"

# 同 aladdin_ai/scripts/tg-map-chatids.sh 對這件事的註記：registry CLI 內部
# 以 'mon_head' 角色連監控 DB；呼叫端（本腳本可能被任何 pipeline 用任何
# cwd/環境呼叫）若繼承了別的角色的 MON_DB_* 環境變數，bun 的 .env 自動載入
# 不會覆蓋已存在的 key，角色就會判定錯誤——用子 shell 清掉並把 cwd 指到
# telegram-dispatcher，讓它自己的 .env 補上正確角色。
resolve_chat_id_via_registry() {
  local email="$1"
  (
    cd "$REGISTRY_CLI_CWD" || exit 1
    unset MON_DB_HOST MON_DB_PORT MON_DB_SCHEMA MON_DB_USER MON_DB_PASSWORD MON_FIELD_KEY_V1 MON_BIDX_KEY
    $REGISTRY_CLI --resolve-chat-id "$email"
  ) 2>/dev/null
}

# 名冊四欄（notion_user_name,notion_user_id,email,pushed_repos），header 在第一行。
list_roster_via_registry() {
  (
    cd "$REGISTRY_CLI_CWD" || exit 1
    unset MON_DB_HOST MON_DB_PORT MON_DB_SCHEMA MON_DB_USER MON_DB_PASSWORD MON_FIELD_KEY_V1 MON_BIDX_KEY
    $REGISTRY_CLI --list-roster
  ) 2>/dev/null
}

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

# 2026-10-07：worker 沒有 MON_FIELD_KEY_V1（金鑰只放 head），解不開 chat_id。
# 解析失敗時先把「收件人＋文字」POST 給 head 的 /cluster/notify，由 head 本機
# （有金鑰）跑同一支 tg-notify.sh 代發；只有轉發也失敗才退回 escalate_to_operator。
# 條件：非 --file（代發只支援文字）、非 head 代跑自己（TG_NO_RELAY）、
# 讀得到 CLUSTER_HEAD_URL / CLUSTER_SHARED_SECRET（先看環境變數，再讀
# telegram-dispatcher/.env 的這兩個 key；只取這兩個，不 source 整檔）。
# 成功印出 head 回傳的結果行並回傳 0。
DISPATCHER_ENV_FILE="${TG_DISPATCHER_ENV_FILE:-/Users/user/aladdin/telegram-dispatcher/.env}"
relay_via_head() {
  [ -n "$FILE" ] && return 1
  [ -n "${TG_NO_RELAY:-}" ] && return 1
  local url="${CLUSTER_HEAD_URL:-}" secret="${CLUSTER_SHARED_SECRET:-}"
  if [ -f "$DISPATCHER_ENV_FILE" ]; then
    [ -z "$url" ] && url="$(grep -E '^CLUSTER_HEAD_URL=' "$DISPATCHER_ENV_FILE" | head -n1 | cut -d= -f2- | tr -d '[:space:]"'"'"'')"
    [ -z "$secret" ] && secret="$(grep -E '^CLUSTER_SHARED_SECRET=' "$DISPATCHER_ENV_FILE" | head -n1 | cut -d= -f2- | tr -d '[:space:]"'"'"'')"
  fi
  [ -z "$url" ] || [ -z "$secret" ] && return 1
  local payload resp http body result
  payload="$(TG_P_EMAIL="$EMAIL" TG_P_IDS="$IDS" TG_P_TEXT="$TEXT" TG_P_DRY="$DRY" python3 -c '
import json, os
d = {"text": os.environ["TG_P_TEXT"]}
if os.environ["TG_P_EMAIL"]: d["email"] = os.environ["TG_P_EMAIL"]
else: d["notionUserIds"] = os.environ["TG_P_IDS"]
if os.environ["TG_P_DRY"] == "1": d["dryRun"] = True
print(json.dumps(d))
')" || return 1
  # secret 經 --config - 從 stdin 餵給 curl，不出現在 argv（ps 看不到）。
  # --max-time 35 要大於 head 端 execFile 的 30 秒，避免 worker 先放棄、
  # head 其實送出了，造成同一則通知又被轉維運者而重複。
  resp="$(printf 'header = "x-cluster-token: %s"\n' "$secret" | curl -s --max-time 35 -w $'\n%{http_code}' -X POST "${url%/}/cluster/notify" \
    --config - -H 'content-type: application/json' --data "$payload")" || return 1
  http="${resp##*$'\n'}"; body="${resp%$'\n'*}"
  [ "$http" = "200" ] || return 1
  result="$(printf '%s' "$body" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("result",""))' 2>/dev/null)" || return 1
  [ -n "$result" ] || return 1
  echo "$result"
  return 0
}

# 2026-10-07：收件人 chat_id「解析失敗」（≠ 真的沒綁）時，原本全被印成
# TG_SKIP_NO_CHATID 且 stderr 被吞，通知就此無聲消失。典型情境：worker 沒有
# MON_FIELD_KEY_V1（金鑰只放 head），--resolve-chat-id 解不開密文
# （RESOLVE_ERR_DECRYPT_FAILED）。改為：基礎設施類失敗另用 TG_FAIL_RESOLVE 標示，
# 並把原文連同原因轉給維運者（TG_ESCALATION_CHAT_ID，預設同 health-monitor.ts
# 的維運對象）。真正沒綁（RESOLVE_ERR_NO_CHATID）維持 TG_SKIP_NO_CHATID 不轉發。
# 只走 --chat-id 直送，不會再進名冊查詢，不可能遞迴。
escalate_to_operator() {
  local who="$1" reason="$2" esc_chat esc_text esc_out
  esc_chat="${TG_ESCALATION_CHAT_ID:-5022865804}"
  esc_text="⚠️ [通知未送達本人] 收件人 ${who}：${reason}
以下為原訊息：
${TEXT:-（僅附件，未轉發檔案：${FILE}）}"
  esc_text="${esc_text:0:3500}"
  local args=(--chat-id "$esc_chat" --text "$esc_text")
  [ "$DRY" = "1" ] && args+=(--dry-run)
  esc_out="$(bash "${BASH_SOURCE[0]}" "${args[@]}")"
  echo "TG_FAIL_RESOLVE: ${who} (${reason}); escalated: ${esc_out}"
}

MATCH_EMAIL=""; MATCH_CHAT=""
if [ -n "$CHAT_DIRECT" ]; then
  # 直送模式：繞過名冊，供使用者獨立測試真實送出
  MATCH_EMAIL="(direct)"; MATCH_CHAT="$CHAT_DIRECT"
else
  ROSTER="$(list_roster_via_registry)"
  [ -z "$ROSTER" ] && { relay_via_head && exit 0; escalate_to_operator "${EMAIL:-$IDS}" "名冊取不到（tech-users-sync.ts --list-roster 失敗，多為監控 DB 連線/權限問題）"; exit 0; }
  # header-aware 欄位索引（去除可能的 CR）
  header="$(printf '%s\n' "$ROSTER" | head -n1 | tr -d '\r')"
  IFS=',' read -r -a COLS <<< "$header"
  # 名冊輸出採純逗號切分（非 RFC-4180）；欄位值不得含逗號，由寫入端
  # （tech-users-sync.ts --upsert-user）擋下，讀取端不做跳脫處理。
  idx() { local name="$1" i=0 c; for c in "${COLS[@]}"; do [ "$c" = "$name" ] && { echo "$i"; return; }; i=$((i+1)); done; echo "-1"; }
  EMAIL_IDX="$(idx email)"; NID_IDX="$(idx notion_user_id)"
  { [ "$EMAIL_IDX" = "-1" ] || [ "$NID_IDX" = "-1" ]; } && { echo "TG_FAIL: roster header unexpected ($header)"; exit 0; }

  FOUND_TECH=0
  while IFS=',' read -r -a F; do
    row_email="${F[$EMAIL_IDX]:-}"; row_nid="${F[$NID_IDX]:-}"
    [ "$row_email" = "email" ] && continue   # 跳過表頭
    if [ -n "$EMAIL" ]; then
      if [ "$row_email" = "$EMAIL" ]; then FOUND_TECH=1; MATCH_EMAIL="$row_email"; break; fi
    elif [ -n "$IDS" ]; then
      for id in $IDS; do
        if [ "$row_nid" = "$id" ]; then FOUND_TECH=1; MATCH_EMAIL="$row_email"; break 2; fi
      done
    fi
  done < <(printf '%s\n' "$ROSTER" | tr -d '\r')

  TARGET="${EMAIL:-$IDS}"
  [ "$FOUND_TECH" = "0" ] && { echo "TG_SKIP_NOT_TECH: $TARGET"; exit 0; }

  RESOLVE_OUT="$(resolve_chat_id_via_registry "$MATCH_EMAIL")"
  case "$RESOLVE_OUT" in
    RESOLVE_OK:*) MATCH_CHAT="${RESOLVE_OUT#RESOLVE_OK: }" ;;
    RESOLVE_ERR_NO_CHATID:*) echo "TG_SKIP_NO_CHATID: $MATCH_EMAIL"; exit 0 ;;
    *) relay_via_head && exit 0; escalate_to_operator "$MATCH_EMAIL" "chat_id 解析失敗：${RESOLVE_OUT:-（registry CLI 無輸出）}（非未綁定；worker 缺 MON_FIELD_KEY_V1 或 DB 異常）"; exit 0 ;;
  esac
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
