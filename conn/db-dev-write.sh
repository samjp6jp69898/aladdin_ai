#!/bin/bash
# Usage: ./db-dev-write.sh <database> "<SQL>"
# EMERGENCY USE ONLY: Allows DELETE/UPDATE on dev DB for data cleanup.
# Connection info is read from aladdin_ai/.env.dev (DEV_DB_*). NOT hardcoded.
# 刻意「不」整檔 source .env：其他環境的 .env.* 檔含反引號等 shell metacharacter
# （見 .env.cqa 的 CQA_ARCHERY_PASS），整份 source 遇到那種值會被 shell 當語法
# 解析而炸掉，只精準抓取需要的四個 key 比較安全。

set -e

ENV_FILE="/Users/user/aladdin/aladdin_ai/.env.dev"
if [ ! -f "$ENV_FILE" ]; then
  echo "Error: $ENV_FILE not found (dev connection comes from there)."
  exit 1
fi
get_env() {
  grep -E "^(export[[:space:]]+)?$1=" "$ENV_FILE" \
    | tail -1 \
    | sed -E "s/^(export[[:space:]]+)?$1=//" \
    | tr -d '\r' \
    | sed -E "s/^'(.*)'\$/\1/; s/^\"(.*)\"\$/\1/"
}
DEV_DB_HOST=$(get_env DEV_DB_HOST)
DEV_DB_PORT=$(get_env DEV_DB_PORT)
DEV_DB_USER=$(get_env DEV_DB_USER)
DEV_DB_PASS=$(get_env DEV_DB_PASS)

DB="$1"
SQL="$2"

if [ -z "$DB" ] || [ -z "$SQL" ]; then
  echo "Usage: $0 <database> \"<SQL>\""
  exit 1
fi

FIRST_WORD=$(echo "$SQL" | awk '{print toupper($1)}')
if [[ "$FIRST_WORD" != "DELETE" && "$FIRST_WORD" != "UPDATE" && "$FIRST_WORD" != "SELECT" && "$FIRST_WORD" != "SHOW" && "$FIRST_WORD" != "DESCRIBE" ]]; then
  echo "Error: Only DELETE, UPDATE, SELECT, SHOW, DESCRIBE are allowed."
  exit 1
fi

MYSQL_PWD="$DEV_DB_PASS" mysql \
  -h "$DEV_DB_HOST" \
  -P "$DEV_DB_PORT" \
  -u "$DEV_DB_USER" \
  --table \
  "$DB" \
  -e "$SQL"
