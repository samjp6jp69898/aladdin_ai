#!/bin/bash
# Usage: ./db-dev-write.sh <database> "<SQL>"
# EMERGENCY USE ONLY: Allows DELETE/UPDATE on dev DB for data cleanup.
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
