#!/bin/bash
# Usage: ./db-dev-query.sh <database> "<SQL>"
# Example: ./db-dev-query.sh my_db "SELECT * FROM users LIMIT 10"
# READ-ONLY: Only SELECT, SHOW, DESCRIBE, EXPLAIN are allowed.
# Connection info is read from /Users/user/aladdin/.env (DEV_DB_*). NOT hardcoded.

set -e

ENV_FILE="/Users/user/aladdin/.env"
if [ ! -f "$ENV_FILE" ]; then
  echo "Error: $ENV_FILE not found (dev connection comes from there)."
  exit 1
fi
set -a
. "$ENV_FILE"
set +a

DB="$1"
SQL="$2"

if [ -z "$DB" ] || [ -z "$SQL" ]; then
  echo "Usage: $0 <database> \"<SQL>\""
  echo "Example: $0 my_db \"SELECT * FROM users LIMIT 10\""
  exit 1
fi

# 只允許 SELECT / SHOW / DESCRIBE / EXPLAIN
FIRST_WORD=$(echo "$SQL" | awk '{print toupper($1)}')
if [[ "$FIRST_WORD" != "SELECT" && "$FIRST_WORD" != "SHOW" && "$FIRST_WORD" != "DESCRIBE" && "$FIRST_WORD" != "EXPLAIN" && "$FIRST_WORD" != "DESC" ]]; then
  echo "Error: Only SELECT, SHOW, DESCRIBE, EXPLAIN are allowed on dev DB."
  exit 1
fi

MYSQL_PWD="$DEV_DB_PASS" mysql \
  -h "$DEV_DB_HOST" \
  -P "$DEV_DB_PORT" \
  -u "$DEV_DB_USER" \
  --table \
  "$DB" \
  -e "$SQL"
