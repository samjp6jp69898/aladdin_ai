#!/bin/bash
# Usage: bash archery-login.sh
# CQA 測試站 Archery（SQL 審核平台）登入探測：只登入、截圖、存 storageState。
# 不建立/送出任何 SQL 查詢工單。
# 帳密一律從 aladdin_ai/.env.cqa 讀取（見 lib/env.cjs），不寫死、不印出。
# 僅限 *.ald777.com 測試站，嚴禁 production（.env.prod 另有 ARCHERY_PROD_*，本腳本不碰）。

set -e

E2E_DIR="/Users/user/aladdin/cqa-e2e"
VERIFY_DIR="$E2E_DIR/verify"

# 用 lib/env.cjs 的 loadEnv() 合併解析 aladdin_ai/.env.* 各檔，只取這三個 key。
# 刻意不用 `source`：.env 的值可能含反引號 / 引號等 shell metacharacter，
# source 會因語法錯誤中止或靜默改寫值，而且等同執行 .env 裡的 command substitution。
read_env_key() {
  node -e '
    const { loadEnv } = require("/Users/user/aladdin/cqa-e2e/lib/env.cjs");
    process.stdout.write(loadEnv()[process.argv[1]] || "");
  ' "$1"
}

CQA_ARCHERY_URL="$(read_env_key CQA_ARCHERY_URL)"
CQA_ARCHERY_USER="$(read_env_key CQA_ARCHERY_USER)"
CQA_ARCHERY_PASS="$(read_env_key CQA_ARCHERY_PASS)"

MISSING=""
[ -z "$CQA_ARCHERY_URL" ]  && MISSING="$MISSING CQA_ARCHERY_URL"
[ -z "$CQA_ARCHERY_USER" ] && MISSING="$MISSING CQA_ARCHERY_USER"
[ -z "$CQA_ARCHERY_PASS" ] && MISSING="$MISSING CQA_ARCHERY_PASS"
if [ -n "$MISSING" ]; then
  echo "Error: .env 缺少欄位:$MISSING"
  exit 2
fi

# 只允許 CQA 測試站網域
case "$CQA_ARCHERY_URL" in
  *.ald777.com|*.ald777.com/*) ;;
  *)
    echo "Error: 只允許 *.ald777.com CQA 測試站，CQA_ARCHERY_URL 不符（已擋下）。"
    exit 1
    ;;
esac

LOG="$VERIFY_DIR/archery-run.log"

export CQA_ARCHERY_URL CQA_ARCHERY_USER CQA_ARCHERY_PASS

set +e
node "$VERIFY_DIR/archery-login.cjs" >"$LOG" 2>&1
RC=$?
set -e

# 從 ===RESULT_JSON_START/END=== 之間解析結果並輸出摘要（不含帳密）
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
console.log("signal:            " + (r.successSignal || r.error || "-"));
console.log("authApiStatus:     " + (r.authApiStatus || "-"));
console.log("twoFactorRequired: " + r.twoFactorRequired);
console.log("captchaPresent:    " + r.captchaPresent);
console.log("sessionCookie:     " + r.sessionCookie);
console.log("artifacts:         " + process.argv[2] + "/archery-{login,after}.png, archery-state.json, archery-debug.json");
process.exit(r.result === "SUCCESS" ? 0 : 1);
' "$LOG" "$VERIFY_DIR"
SUMMARY_RC=$?

if [ "$RC" -ne 0 ] && [ "$SUMMARY_RC" -eq 0 ]; then
  exit "$RC"
fi
exit "$SUMMARY_RC"
