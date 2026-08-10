#!/bin/bash
# Usage: ./redis-dev-query.sh "<REDIS_COMMAND>"
# Example: ./redis-dev-query.sh "GET some_key"
# READ-ONLY: Only whitelisted read commands are allowed (see READ_ONLY_CMDS below).
# Connection info is read from /Users/user/aladdin/.env (DEV_REDIS_*). NOT hardcoded.
# 刻意「不」整檔 source .env：只精準抓取需要的三個 key，
# 這樣 .env 其他行有語法錯誤（如未跳脫的反引號）也不會連坐弄掛這支腳本。

set -e

ENV_FILE="/Users/user/aladdin/.env"

CMD="$1"

if [ -z "$CMD" ]; then
  echo "Usage: $0 \"<REDIS_COMMAND>\""
  echo "Example: $0 \"GET some_key\""
  exit 1
fi

# 唯讀白名單（Redis 帳號本身可能有寫權限，這是唯一一層防護，只放行讀取類指令）
# 先於讀取 .env 檢查，寫入類指令在任何情況下都會被擋，不依賴 .env 是否可用
READ_ONLY_CMDS=" GET MGET HGET HGETALL HMGET HKEYS HVALS HLEN HEXISTS LRANGE LLEN LINDEX SMEMBERS SISMEMBER SCARD ZRANGE ZSCORE ZRANK ZCARD TTL PTTL EXISTS TYPE KEYS SCAN STRLEN DBSIZE INFO PING GETRANGE "
FIRST_WORD=$(echo "$CMD" | awk '{print toupper($1)}')
if [[ "$READ_ONLY_CMDS" != *" $FIRST_WORD "* ]]; then
  echo "Error: '$FIRST_WORD' is not allowed. Only read-only Redis commands are permitted:"
  echo "      $READ_ONLY_CMDS"
  exit 1
fi

if [ ! -f "$ENV_FILE" ]; then
  echo "Error: $ENV_FILE not found (Dev Redis connection comes from there)."
  exit 1
fi
# 只取單一 key 的值：取最後一次出現、允許 export 前綴、去掉行尾 CR 與頭尾一組成對引號。
# 不做 shell 展開，因此密碼中的 ` $ " 等字元都以字面值取出。
get_env() {
  grep -E "^(export[[:space:]]+)?$1=" "$ENV_FILE" \
    | tail -1 \
    | sed -E "s/^(export[[:space:]]+)?$1=//" \
    | tr -d '\r' \
    | sed -E "s/^'(.*)'\$/\1/; s/^\"(.*)\"\$/\1/"
}

DEV_REDIS_HOST=$(get_env DEV_REDIS_HOST)
DEV_REDIS_PORT=$(get_env DEV_REDIS_PORT)
DEV_REDIS_PASS=$(get_env DEV_REDIS_PASS)

if [ -z "$DEV_REDIS_HOST" ] || [ -z "$DEV_REDIS_PORT" ] || [ -z "$DEV_REDIS_PASS" ]; then
  echo "Error: DEV_REDIS_HOST / DEV_REDIS_PORT / DEV_REDIS_PASS not found in $ENV_FILE."
  exit 1
fi

# 拆成獨立參數傳給 redis-cli（xargs 會處理引號，且不做 shell 展開／command substitution）
REDIS_ARGS=()
while IFS= read -r arg; do
  REDIS_ARGS+=("$arg")
done < <(printf '%s' "$CMD" | xargs -n1 printf '%s\n')

redis-cli \
  -h "$DEV_REDIS_HOST" \
  -p "$DEV_REDIS_PORT" \
  -a "$DEV_REDIS_PASS" \
  --no-auth-warning \
  "${REDIS_ARGS[@]}"
