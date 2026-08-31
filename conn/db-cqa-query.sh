#!/bin/bash
# Usage: ./db-cqa-query.sh <database> "<SQL>"
# Example: ./db-cqa-query.sh payment "SELECT * FROM deposit_orders LIMIT 5"
# READ-ONLY: Only SELECT, SHOW, DESCRIBE, EXPLAIN are allowed.
# Connection info is read from aladdin_ai/.env.cqa (CQA_DB_*). NOT hardcoded.
# 刻意「不」整檔 source .env：.env.cqa 內含反引號等 shell metacharacter（見
# CQA_ARCHERY_PASS），整份 source 會被 shell 當語法解析而炸掉（unexpected EOF）。
# 只精準抓取需要的四個 key，比照 conn/redis-dev-query.sh 的做法。

set -e

ENV_FILE="/Users/user/aladdin/aladdin_ai/.env.cqa"
if [ ! -f "$ENV_FILE" ]; then
  echo "Error: $ENV_FILE not found (CQA connection comes from there)."
  exit 1
fi
get_env() {
  grep -E "^(export[[:space:]]+)?$1=" "$ENV_FILE" \
    | tail -1 \
    | sed -E "s/^(export[[:space:]]+)?$1=//" \
    | tr -d '\r' \
    | sed -E "s/^'(.*)'\$/\1/; s/^\"(.*)\"\$/\1/"
}
CQA_DB_HOST=$(get_env CQA_DB_HOST)
CQA_DB_PORT=$(get_env CQA_DB_PORT)
CQA_DB_USER=$(get_env CQA_DB_USER)
CQA_DB_PASS=$(get_env CQA_DB_PASS)

DB="$1"
SQL="$2"

if [ -z "$DB" ] || [ -z "$SQL" ]; then
  echo "Usage: $0 <database> \"<SQL>\""
  echo "Example: $0 payment \"SELECT * FROM deposit_orders LIMIT 5\""
  exit 1
fi

# 只允許 SELECT / SHOW / DESCRIBE / DESC / EXPLAIN（DB 帳號本身亦唯讀，這是第二層防護）
FIRST_WORD=$(echo "$SQL" | awk '{print toupper($1)}')
if [[ "$FIRST_WORD" != "SELECT" && "$FIRST_WORD" != "SHOW" && "$FIRST_WORD" != "DESCRIBE" && "$FIRST_WORD" != "EXPLAIN" && "$FIRST_WORD" != "DESC" ]]; then
  echo "Error: Only SELECT, SHOW, DESCRIBE, EXPLAIN are allowed on CQA DB."
  exit 1
fi

MYSQL_PWD="$CQA_DB_PASS" mysql \
  -h "$CQA_DB_HOST" \
  -P "$CQA_DB_PORT" \
  -u "$CQA_DB_USER" \
  --connect-timeout=10 \
  --table \
  "$DB" \
  -e "$SQL"
