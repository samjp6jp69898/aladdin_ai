#!/bin/bash
# Usage: ./db-dev-dump.sh <database> <table>
# Example: ./db-dev-dump.sh my_db my_table
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

OUTPUT_DIR="$(dirname "$0")"

DB="$1"
TABLE="$2"

if [ -z "$DB" ] || [ -z "$TABLE" ]; then
  echo "Usage: $0 <database> <table>"
  exit 1
fi

OUTPUT_FILE="$OUTPUT_DIR/${DB}__${TABLE}.sql"

echo "Dumping $DB.$TABLE ..."
MYSQL_PWD="$DEV_DB_PASS" mysqldump \
  -h "$DEV_DB_HOST" \
  -P "$DEV_DB_PORT" \
  -u "$DEV_DB_USER" \
  --no-tablespaces \
  --single-transaction \
  --skip-add-drop-table \
  --complete-insert \
  "$DB" "$TABLE" > "$OUTPUT_FILE"

echo "Saved to: $OUTPUT_FILE"
