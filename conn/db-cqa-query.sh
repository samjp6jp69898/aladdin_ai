#!/bin/bash
# Usage: ./db-cqa-query.sh <database> "<SQL>"
# Example: ./db-cqa-query.sh payment "SELECT * FROM deposit_orders LIMIT 5"
# READ-ONLY: Only SELECT, SHOW, DESCRIBE, EXPLAIN are allowed.
# Connection info is read from /Users/user/aladdin/.env (CQA_DB_*). NOT hardcoded.

set -e

ENV_FILE="/Users/user/aladdin/.env"
if [ ! -f "$ENV_FILE" ]; then
  echo "Error: $ENV_FILE not found (CQA connection comes from there)."
  exit 1
fi
set -a
. "$ENV_FILE"
set +a

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
