#!/bin/bash
# Usage: ./platform-login.sh <pk|6t> [--env cqa|dev]
# platform 後台登入（唯讀取證：只登入、截圖、存 storageState）。
# 帳密一律從 aladdin_ai/.env.cqa 或 .env.dev 讀取（見 lib/env.cjs），不寫死、不印出。
# 預設 cqa（*.ald777.com）；dev（*.alddev.com）需 .env.dev 有 DEV_{PK,6T}_PLATFORM_*。嚴禁 production。

set -e

E2E_DIR="/Users/user/aladdin/cqa-e2e"
OUT_DIR="$E2E_DIR/conn/artifacts"

usage() {
  echo "Usage: $0 <pk|6t> [--env cqa|dev]"
  exit 1
}

TARGET="$1"
case "$TARGET" in
  pk|6t) ;;
  *) usage ;;
esac
shift

ENV_NAME="cqa"
while [ $# -gt 0 ]; do
  case "$1" in
    --env) ENV_NAME="$2"; shift 2 ;;
    *) echo "Unknown option: $1"; usage ;;
  esac
done

case "$TARGET" in
  pk) SITE_KEY="pk-platform"; BASE="PK_PLATFORM" ;;
  6t) SITE_KEY="6t-platform"; BASE="6T_PLATFORM" ;;
esac

case "$ENV_NAME" in
  cqa) KEY_PREFIX="CQA_${BASE}" ;;
  dev) KEY_PREFIX="DEV_${BASE}" ;;
  *)
    echo "Error: --env 只支援 cqa 或 dev（拿到: ${ENV_NAME}）"
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

URL="$(read_env_key "${KEY_PREFIX}_URL")"
USERNAME="$(read_env_key "${KEY_PREFIX}_USER")"
PASSWORD="$(read_env_key "${KEY_PREFIX}_PASS")"

MISSING=""
[ -z "$URL" ]      && MISSING="$MISSING ${KEY_PREFIX}_URL"
[ -z "$USERNAME" ] && MISSING="$MISSING ${KEY_PREFIX}_USER"
[ -z "$PASSWORD" ] && MISSING="$MISSING ${KEY_PREFIX}_PASS"
if [ -n "$MISSING" ]; then
  echo "Error: .env 缺少欄位:$MISSING"
  exit 2
fi

# 網域白名單：精準比對，不開放式放行
case "$ENV_NAME" in
  cqa)
    case "$URL" in
      *.ald777.com|*.ald777.com/*) ;;
      *)
        echo "Error: 只允許 *.ald777.com CQA 測試站，拿到的 URL 不符（已擋下）。"
        exit 1
        ;;
    esac
    ;;
  dev)
    case "$URL" in
      *.alddev.com|*.alddev.com/*) ;;
      *)
        echo "Error: 只允許 *.alddev.com dev 環境，拿到的 URL 不符（已擋下）。"
        exit 1
        ;;
    esac
    ;;
esac

mkdir -p "$OUT_DIR"

set +e
VERIFY_OUT_DIR="$OUT_DIR" node "$E2E_DIR/verify/verify-login.cjs" \
  "$SITE_KEY" "$URL" "$USERNAME" "$PASSWORD" >"$OUT_DIR/$SITE_KEY-run.log" 2>&1
RC=$?
set -e

# 從 ===RESULT_JSON=== 之後解析結果並輸出摘要（不含帳密）
node -e '
const fs = require("fs");
const log = fs.readFileSync(process.argv[1], "utf8");
const i = log.indexOf("===RESULT_JSON===");
if (i < 0) {
  console.log("RESULT: FAIL (腳本未產出結果 JSON，詳見 " + process.argv[1] + ")");
  process.exit(1);
}
const r = JSON.parse(log.slice(i + "===RESULT_JSON===".length));
console.log("SITE:         " + r.siteKey);
console.log("RESULT:       " + r.result);
console.log("postLoginUrl: " + (r.postLoginUrl || "-"));
console.log("signal:       " + (r.successSignal || r.error || "-"));
console.log("artifacts:    " + process.argv[2] + "/" + r.siteKey + "-{login,after}.png, -state.json, -debug.json");
process.exit(r.result === "SUCCESS" ? 0 : 1);
' "$OUT_DIR/$SITE_KEY-run.log" "$OUT_DIR"
SUMMARY_RC=$?

if [ "$RC" -ne 0 ] && [ "$SUMMARY_RC" -eq 0 ]; then
  exit "$RC"
fi
exit "$SUMMARY_RC"
