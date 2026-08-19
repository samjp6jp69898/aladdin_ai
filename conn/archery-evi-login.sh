#!/bin/bash
# Usage: bash archery-evi-login.sh
# EVI Archery（SQL 審核平台，https://archery.godev2.com）登入探測：
# 登入 + 截圖 + 讀取 /sqlquery/ 頁面結構（select/textarea/button），不送出任何 SQL、不建立工單。
# 帳密一律從 /Users/user/aladdin/.env 讀取，不寫死、不印出。
# 僅限 *.godev2.com（EVI 環境），嚴禁 production。

set -e

ENV_FILE="/Users/user/aladdin/.env"
E2E_DIR="/Users/user/aladdin/cqa-e2e"
VERIFY_DIR="$E2E_DIR/verify"

if [ ! -f "$ENV_FILE" ]; then
  echo "Error: $ENV_FILE not found (帳密來源)."
  exit 1
fi

# 用 lib/env.cjs 的 loadEnv() 解析 .env，不用 source（見 archery-login.sh 的理由，同樣適用）。
read_env_key() {
  node -e '
    const { loadEnv } = require("/Users/user/aladdin/cqa-e2e/lib/env.cjs");
    process.stdout.write(loadEnv()[process.argv[1]] || "");
  ' "$1"
}

EVI_ARCHERY_URL="$(read_env_key EVI_ARCHERY_URL)"
EVI_ARCHERY_USER="$(read_env_key EVI_ARCHERY_USER)"
EVI_ARCHERY_PASS="$(read_env_key EVI_ARCHERY_PASS)"

MISSING=""
[ -z "$EVI_ARCHERY_URL" ]  && MISSING="$MISSING EVI_ARCHERY_URL"
[ -z "$EVI_ARCHERY_USER" ] && MISSING="$MISSING EVI_ARCHERY_USER"
[ -z "$EVI_ARCHERY_PASS" ] && MISSING="$MISSING EVI_ARCHERY_PASS"
if [ -n "$MISSING" ]; then
  echo "Error: .env 缺少欄位:$MISSING"
  exit 2
fi

# 只允許 EVI 測試站網域
case "$EVI_ARCHERY_URL" in
  *.godev2.com|*.godev2.com/*) ;;
  *)
    echo "Error: 只允許 *.godev2.com EVI 測試站，EVI_ARCHERY_URL 不符（已擋下）。"
    exit 1
    ;;
esac

LOG="$VERIFY_DIR/archery-evi-run.log"

export EVI_ARCHERY_URL EVI_ARCHERY_USER EVI_ARCHERY_PASS

set +e
node "$VERIFY_DIR/archery-evi-login.cjs" >"$LOG" 2>&1
RC=$?
set -e

node -e '
const fs = require("fs");
const log = fs.readFileSync(process.argv[1], "utf8");
const s = log.indexOf("===RESULT_JSON_START===");
const e = log.indexOf("===RESULT_JSON_END===");
if (s < 0 || e < 0) {
  console.log("RESULT: FAIL (腳本未產出結果 JSON，詳見 " + process.argv[1] + ")");
  process.exit(1);
}
const r = JSON.parse(log.slice(s + "===RESULT_JSON_START===".length, e));
console.log("SITE:              " + r.site);
console.log("RESULT:            " + r.result);
console.log("postLoginUrl:      " + (r.postLoginUrl || "-"));
console.log("twoFactorRequired: " + r.twoFactorRequired);
console.log("sessionCookie:     " + r.sessionCookie);
console.log("artifacts:         " + process.argv[2] + "/archery-evi-{login,after,sqlquery}.png, archery-evi-state.json, archery-evi-debug.json");
process.exit(r.result === "SUCCESS" ? 0 : 1);
' "$LOG" "$VERIFY_DIR"
SUMMARY_RC=$?

if [ "$RC" -ne 0 ] && [ "$SUMMARY_RC" -eq 0 ]; then
  exit "$RC"
fi
exit "$SUMMARY_RC"
