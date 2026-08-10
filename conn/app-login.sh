#!/bin/bash
# Usage: ./app-login.sh <pk|6t> [--env cqa|dev] [--account 2|3|4] [--answer <驗證碼數字>]
#
# App 前台登入（唯讀取證：只登入、截圖、存 storageState）。
# 帳密一律從 /Users/user/aladdin/.env 讀取後 export 給 .cjs，不寫死、不印出。
# --env 預設 cqa（*.ald777.com 測試站）；--env dev 對應 dev 環境（目前僅 pk 有帳密）。
# --account 只在 --env dev 且該環境有多組帳號（如 DEV_PK_APP_USER2/3/4）時使用，
#   不帶則用預設帳號（DEV_PK_APP_USER / CQA_PK_APP_USER）。
#
# pk 是兩段式（圖形驗證碼要靠模型視覺讀碼）：
#   1) ./app-login.sh pk [--env dev]           → 背景啟動登入流程，印出 CAPTCHA_AT 裁切圖路徑
#   2) 用 Read 工具看那張圖，讀出數字
#   3) ./app-login.sh pk [--env dev] --answer 510   → 交答案並印出登入結果摘要
# 6t 是全自動（Geetest radar 單擊）：./app-login.sh 6t

set -e

ENV_FILE="/Users/user/aladdin/.env"
E2E_DIR="/Users/user/aladdin/cqa-e2e"
VERIFY_DIR="$E2E_DIR/verify"
OUT_DIR="$E2E_DIR/conn/artifacts"

usage() {
  echo "Usage: $0 <pk|6t> [--env cqa|dev] [--account 2|3|4] [--answer <digits>]"
  exit 1
}

TARGET="$1"
case "$TARGET" in
  pk|6t) ;;
  *) usage ;;
esac
shift

ENV_NAME="cqa"
ACCOUNT=""
ANSWER=""
while [ $# -gt 0 ]; do
  case "$1" in
    --env) ENV_NAME="$2"; shift 2 ;;
    --account) ACCOUNT="$2"; shift 2 ;;
    --answer) ANSWER="$2"; shift 2 ;;
    *) echo "Unknown option: $1"; usage ;;
  esac
done

if [ ! -f "$ENV_FILE" ]; then
  echo "Error: $ENV_FILE not found (帳密來源)."
  exit 1
fi

# 只挑出需要的 key，不 `source` 整份 .env：.env 內含 backtick 等字元，
# 整份 source 會被 shell 當語法解析而炸掉（unexpected EOF）。
get_env() {
  local val
  val=$(sed -n "s/^[[:space:]]*$1[[:space:]]*=//p" "$ENV_FILE" | head -1)
  val="${val%$'\r'}"
  val="${val%\"}"; val="${val#\"}"
  val="${val%\'}"; val="${val#\'}"
  printf '%s' "$val"
}

case "$TARGET" in
  pk)
    SITE_KEY="pk-app"
    SCRIPT="$VERIFY_DIR/pk-visual-login.cjs"
    RESULT_JSON="$VERIFY_DIR/pk-visual-result.json"
    BASE="PK_APP"
    EXPORT_PREFIX="PK_APP"          # 通用名，pk-visual-login.cjs 直接讀這組，不管來源是 cqa 還是 dev
    ;;
  6t)
    SITE_KEY="6t-app"
    SCRIPT="$VERIFY_DIR/6t-geetest-login.cjs"
    RESULT_JSON="$VERIFY_DIR/6t-geetest-login-result.json"
    BASE="6T_APP"
    EXPORT_PREFIX="CQA_6T_APP"      # 沿用舊名，6t-geetest-login.cjs 未改動、仍讀這個固定名字
    ;;
esac

case "$ENV_NAME" in
  cqa) SRC_PREFIX="CQA_${BASE}" ;;
  dev) SRC_PREFIX="DEV_${BASE}" ;;
  *) echo "Error: --env 只支援 cqa 或 dev（拿到: ${ENV_NAME}）"; exit 1 ;;
esac

case "$ACCOUNT" in
  ""|2|3|4) ;;
  *) echo "Error: --account 只支援 2/3/4（不帶則用預設帳號）"; exit 1 ;;
esac

URL="$(get_env "${SRC_PREFIX}_URL")"
USER_VAL="$(get_env "${SRC_PREFIX}_USER${ACCOUNT}")"
PASS_VAL="$(get_env "${SRC_PREFIX}_PASS")"

export "${EXPORT_PREFIX}_URL"="$URL"
export "${EXPORT_PREFIX}_USER"="$USER_VAL"
export "${EXPORT_PREFIX}_PASS"="$PASS_VAL"

MISSING=""
[ -z "$URL" ] && MISSING="$MISSING ${SRC_PREFIX}_URL"
[ -z "$USER_VAL" ] && MISSING="$MISSING ${SRC_PREFIX}_USER${ACCOUNT}"
[ -z "$PASS_VAL" ] && MISSING="$MISSING ${SRC_PREFIX}_PASS"
if [ -n "$MISSING" ]; then
  echo "Error: .env 缺少 $SITE_KEY (env=$ENV_NAME) 的欄位:$MISSING"
  exit 2
fi

# 網域白名單：依 target+env 精準比對，不開放式放行，未知組合一律擋下
case "${TARGET}:${ENV_NAME}" in
  pk:cqa|6t:cqa)
    case "$URL" in
      *.ald777.com|*.ald777.com/*) ;;
      *)
        echo "Error: 只允許 *.ald777.com CQA 測試站，拿到的 URL 不符（已擋下）。"
        exit 1
        ;;
    esac
    ;;
  pk:dev)
    case "$URL" in
      *pk.alddev.com|*pk.alddev.com/*) ;;
      *)
        echo "Error: 只允許 pk.alddev.com dev 測試站，拿到的 URL 不符（已擋下）。"
        exit 1
        ;;
    esac
    ;;
  *)
    echo "Error: env=$ENV_NAME target=$TARGET 尚未設定網域白名單，已擋下（避免誤打未知環境）。"
    exit 1
    ;;
esac

mkdir -p "$OUT_DIR"

# 印出結果摘要（不含帳密）；.cjs 產出的 token 欄位本身已是截斷後的長度資訊
print_summary() {
  node -e '
const fs = require("fs");
const [file, siteKey, verifyDir] = process.argv.slice(1);
if (!fs.existsSync(file)) {
  console.log("SITE:   " + siteKey);
  console.log("RESULT: FAIL (未產出結果 JSON: " + file + ")");
  process.exit(1);
}
const r = JSON.parse(fs.readFileSync(file, "utf8"));
console.log("SITE:         " + siteKey + " (" + r.site + ")");
console.log("RESULT:       " + (r.success ? "SUCCESS" : "FAIL"));
console.log("lt token:     " + (r.token ? "YES " + r.token : "NO"));
console.log("postLoginUrl: " + (r.postLoginUrl || "-"));
console.log("attempts:     " + (r.attempts || []).length +
  ((r.attempts || []).length ? " (last: " + JSON.stringify(r.attempts[r.attempts.length - 1]) + ")" : ""));
console.log("error:        " + (r.error || "-"));
console.log("artifacts:    " + verifyDir + "/" + siteKey.replace("-app", "") + "-{after}.png, -state.json");
process.exit(r.success ? 0 : 1);
' "$RESULT_JSON" "$SITE_KEY" "$VERIFY_DIR"
}

# ---- pk phase 2: 交驗證碼答案 ----
if [ "$TARGET" = "pk" ] && [ -n "$ANSWER" ]; then
  if ! pgrep -f "pk-visual-login.cjs" >/dev/null 2>&1; then
    echo "Error: 沒有正在等待答案的 pk-visual-login.cjs（驗證碼每次 page load 會重生，請先跑 $0 pk [--env dev]）"
    exit 1
  fi
  printf '%s' "$ANSWER" > "$VERIFY_DIR/pk-captcha-answer.txt"
  echo "ANSWER_SUBMITTED: $ANSWER — 等待登入結果..."
  # 等背景流程結束（送出 + 驗 lt 約需 5-10 秒；讀錯會換圖再等答案）
  for _ in $(seq 1 60); do
    if ! pgrep -f "pk-visual-login.cjs" >/dev/null 2>&1; then break; fi
    if [ -f "$VERIFY_DIR/pk-captcha-request.json" ] && \
       grep -q '"done":true' "$VERIFY_DIR/pk-captcha-request.json" 2>/dev/null; then break; fi
    sleep 2
  done
  if pgrep -f "pk-visual-login.cjs" >/dev/null 2>&1; then
    echo "NOTE: 驗證碼可能讀錯，腳本已換一張並在等下一個答案。"
    echo "CAPTCHA_AT: $VERIFY_DIR/pk-captcha-crop.png（重讀後再跑一次 $0 pk --answer <digits>，記得帶回原本的 --env）"
    exit 3
  fi
  set +e
  print_summary
  exit $?
fi

# ---- pk phase 1: 背景啟動、等驗證碼裁切圖 ----
if [ "$TARGET" = "pk" ]; then
  pkill -f "pk-visual-login.cjs" >/dev/null 2>&1 || true
  rm -f "$VERIFY_DIR/pk-captcha-request.json" "$VERIFY_DIR/pk-captcha-answer.txt" "$RESULT_JSON"
  nohup node "$SCRIPT" >"$OUT_DIR/pk-app-run.log" 2>&1 &
  echo "STARTED: pk-visual-login.cjs (env=$ENV_NAME, log: $OUT_DIR/pk-app-run.log)"
  for _ in $(seq 1 90); do
    if [ -f "$VERIFY_DIR/pk-captcha-request.json" ] && \
       grep -q '"ready":true' "$VERIFY_DIR/pk-captcha-request.json" 2>/dev/null; then
      echo "CAPTCHA_AT: $VERIFY_DIR/pk-captcha-crop.png"
      echo "NEXT: 用 Read 工具看圖讀出數字，再跑 $0 pk --env $ENV_NAME --answer <digits>"
      exit 0
    fi
    if ! pgrep -f "pk-visual-login.cjs" >/dev/null 2>&1; then
      # process 已結束但從沒發出「等驗證碼」訊號：可能是沒有驗證碼的環境（直接送出後就結束），
      # 也可能是真的提早失敗。兩種都看 result JSON 才知道，不能直接判 FAIL。
      if [ -f "$RESULT_JSON" ]; then
        set +e
        print_summary
        rc=$?
        set -e
        exit "$rc"
      fi
      echo "RESULT: FAIL (腳本提早結束且未產出結果 JSON，詳見 $OUT_DIR/pk-app-run.log)"
      tail -5 "$OUT_DIR/pk-app-run.log"
      exit 1
    fi
    sleep 2
  done
  echo "RESULT: FAIL (等不到驗證碼裁切圖，詳見 $OUT_DIR/pk-app-run.log)"
  exit 1
fi

# ---- 6t: 全自動 ----
rm -f "$RESULT_JSON"
set +e
node "$SCRIPT" >"$OUT_DIR/6t-app-run.log" 2>&1
RC=$?
print_summary
SUMMARY_RC=$?
set -e
if [ "$SUMMARY_RC" -ne 0 ]; then
  echo "log:          $OUT_DIR/6t-app-run.log"
fi
if [ "$RC" -ne 0 ] && [ "$SUMMARY_RC" -eq 0 ]; then
  exit "$RC"
fi
exit "$SUMMARY_RC"
