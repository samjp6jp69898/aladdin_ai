#!/bin/bash
# Usage: ./admin-login.sh [cqa|dev]
# abu 共用後台 admin 登入（唯讀取證：只登入、導頁、截圖、存 storageState）。
# 帳密一律從 aladdin_ai/.env.cqa 或 .env.dev 讀取（見 lib/env.cjs），不寫死、不印出。
# 預設 cqa（*.ald777.com）；dev（*.alddev.com）需 .env.dev 有 DEV_ADMIN_*。嚴禁 production。

set -e

E2E_DIR="/Users/user/aladdin/cqa-e2e"
OUT_DIR="$E2E_DIR/conn/artifacts"
# verify-admin.cjs 的產物固定寫在 verify/ 底下
VERIFY_DIR="$E2E_DIR/verify"

TARGET="${1:-cqa}"
case "$TARGET" in
  cqa|dev) ;;
  *)
    echo "Usage: $0 [cqa|dev]"
    exit 1
    ;;
esac

# 用 lib/env.cjs 的 loadEnv() 合併解析 aladdin_ai/.env.* 各檔，只取這三個 key。
# 刻意不用 `source`：.env 的值可能含反引號 / 引號等 shell metacharacter，
# source 會因語法錯誤中止（實例：2026-08-06 的 CQA_ARCHERY_PASS），
# 而且等同執行 .env 裡的 command substitution。
read_env_key() {
  node -e '
    const { loadEnv } = require("/Users/user/aladdin/cqa-e2e/lib/env.cjs");
    process.stdout.write(loadEnv()[process.argv[1]] || "");
  ' "$1"
}

PREFIX_UPPER=$(printf '%s' "$TARGET" | tr '[:lower:]' '[:upper:]')
KEY_PREFIX="${PREFIX_UPPER}_ADMIN"

ADMIN_URL="$(read_env_key "${KEY_PREFIX}_URL")"
ADMIN_USER="$(read_env_key "${KEY_PREFIX}_USER")"
ADMIN_PASS="$(read_env_key "${KEY_PREFIX}_PASS")"

MISSING=""
[ -z "$ADMIN_URL" ]  && MISSING="$MISSING ${KEY_PREFIX}_URL"
[ -z "$ADMIN_USER" ] && MISSING="$MISSING ${KEY_PREFIX}_USER"
[ -z "$ADMIN_PASS" ] && MISSING="$MISSING ${KEY_PREFIX}_PASS"
if [ -n "$MISSING" ]; then
  echo "Error: .env 缺少欄位:$MISSING"
  exit 2
fi

# 網域白名單：精準比對，不開放式放行
case "$TARGET" in
  cqa)
    case "$ADMIN_URL" in
      *.ald777.com|*.ald777.com/*) ;;
      *)
        echo "Error: 只允許 *.ald777.com CQA 測試站，${KEY_PREFIX}_URL 不符（已擋下）。"
        exit 1
        ;;
    esac
    ;;
  dev)
    case "$ADMIN_URL" in
      *.alddev.com|*.alddev.com/*) ;;
      *)
        echo "Error: 只允許 *.alddev.com dev 環境，${KEY_PREFIX}_URL 不符（已擋下）。"
        exit 1
        ;;
    esac
    ;;
esac

mkdir -p "$OUT_DIR"
LOG="$OUT_DIR/admin-run.log"

export ADMIN_URL ADMIN_USER ADMIN_PASS

set +e
node "$VERIFY_DIR/verify-admin.cjs" >"$LOG" 2>&1
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
console.log("SITE:                " + r.site);
console.log("RESULT:              " + r.result);
console.log("postLoginUrl:        " + (r.postLoginUrl || "-"));
console.log("signal:              " + (r.successSignal || r.error || "-"));
console.log("schedulersReachable: " + r.schedulersReachable);
console.log("artifacts:           " + process.argv[2] + "/admin-{login,after,schedulers}.png, admin-state.json");
process.exit(r.result === "SUCCESS" ? 0 : 1);
' "$LOG" "$VERIFY_DIR"
SUMMARY_RC=$?

if [ "$RC" -ne 0 ] && [ "$SUMMARY_RC" -eq 0 ]; then
  exit "$RC"
fi
exit "$SUMMARY_RC"
