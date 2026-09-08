#!/bin/bash
# Usage: ./platform-login.sh <pk|6t> [--env cqa|dev]
#        ./platform-login.sh jx --env uat
# platform 後台登入（唯讀取證：只登入、截圖、存 storageState）。
# 帳密一律從 aladdin_ai/.env.cqa / .env.dev / .env.uat 讀取（見 lib/env.cjs），不寫死、不印出。
# 預設 cqa（*.ald777.com）；dev（*.alddev.com）需 .env.dev 有 DEV_{PK,6T}_PLATFORM_*。
# uat（*.jxpre.com）目前只有一組站台，target 固定打 `jx`、只能配 `--env uat`
# （見下方 jx 分支註解：key 命名跟 pk/6t 不同組，是使用者已填值的既有 key，不可改名）。嚴禁 production。

set -e

E2E_DIR="/Users/user/aladdin/cqa-e2e"
OUT_DIR="$E2E_DIR/conn/artifacts"

usage() {
  echo "Usage: $0 <pk|6t> [--env cqa|dev]   |   $0 jx --env uat"
  exit 1
}

TARGET="$1"
case "$TARGET" in
  pk|6t|jx) ;;
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

# 用 lib/env.cjs 的 loadEnv() 合併解析 aladdin_ai/.env.* 各檔，只取需要的三個 key。
# 刻意不用 `source`：.env 的值可能含反引號 / 引號等 shell metacharacter，
# source 會因語法錯誤中止（實例：2026-08-06 的 CQA_ARCHERY_PASS），
# 而且等同執行 .env 裡的 command substitution。
read_env_key() {
  node -e '
    const { loadEnv } = require("/Users/user/aladdin/cqa-e2e/lib/env.cjs");
    process.stdout.write(loadEnv()[process.argv[1]] || "");
  ' "$1"
}

if [ "$TARGET" = "jx" ]; then
  # UAT 目前只有一組 platform 站台（使用者提供的範例網址是 jx-platform.jxpre.com，
  # "jx" 是這個特定站的簡稱，不是 pk 或 6t 的第三個變體），所以不套用 pk/6t 那種
  # `${ENV}_{PK,6T}_PLATFORM_*` 前綴公式去湊一個不存在的 site key。
  # .env.uat 裡這組 key 歷史上就叫 JX_PLATFORM_UAT_URL/USER/PASS（單一組、前綴是
  # JX_PLATFORM_UAT 而非 UAT_PLATFORM），已經是使用者填過實際值的既有命名，不在這次改動範圍內。
  if [ "$ENV_NAME" != "uat" ]; then
    echo "Error: target jx 目前只支援 --env uat（拿到: ${ENV_NAME}），因為 .env 只有 JX_PLATFORM_UAT_* 這一組 key。"
    exit 1
  fi
  SITE_KEY="jx-platform"
  URL_KEY="JX_PLATFORM_UAT_URL"
  USER_KEY="JX_PLATFORM_UAT_USER"
  PASS_KEY="JX_PLATFORM_UAT_PASS"
else
  case "$TARGET" in
    pk) BASE="PK_PLATFORM"; SITE_KEY="pk-platform" ;;
    6t) BASE="6T_PLATFORM"; SITE_KEY="6t-platform" ;;
  esac
  case "$ENV_NAME" in
    cqa) KEY_PREFIX="CQA_${BASE}" ;;
    dev) KEY_PREFIX="DEV_${BASE}" ;;
    *)
      echo "Error: --env 只支援 cqa 或 dev（拿到: ${ENV_NAME}）"
      exit 1
      ;;
  esac
  URL_KEY="${KEY_PREFIX}_URL"
  USER_KEY="${KEY_PREFIX}_USER"
  PASS_KEY="${KEY_PREFIX}_PASS"
fi

URL="$(read_env_key "$URL_KEY")"
USERNAME="$(read_env_key "$USER_KEY")"
PASSWORD="$(read_env_key "$PASS_KEY")"

MISSING=""
[ -z "$URL" ]      && MISSING="$MISSING $URL_KEY"
[ -z "$USERNAME" ] && MISSING="$MISSING $USER_KEY"
[ -z "$PASSWORD" ] && MISSING="$MISSING $PASS_KEY"
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
  uat)
    case "$URL" in
      *.jxpre.com|*.jxpre.com/*) ;;
      *)
        echo "Error: 只允許 *.jxpre.com UAT 環境，拿到的 URL 不符（已擋下）。"
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
