#!/bin/bash
# Usage: ./app-login.sh <pk|6t|main> [--env cqa|dev] [--account 2|3|4] [--answer <驗證碼數字>] [--dragx <像素>]
#
# App 前台登入（唯讀取證：只登入、截圖、存 storageState）。
# 帳密一律從 aladdin_ai/.env.cqa 或 .env.dev 讀取後 export 給 .cjs，不寫死、不印出。
# --env 預設 cqa（*.ald777.com 測試站）；--env dev 對應 dev 環境（pk/6t 皆有帳密，分別讀 DEV_PK_APP_*／DEV_6T_APP_*）。
# --account 只在 --env dev 且該環境有多組帳號（如 DEV_PK_APP_USER2/3/4）時使用，
#   不帶則用預設帳號（DEV_PK_APP_USER / CQA_PK_APP_USER）。
#
# pk 是兩段式（圖形驗證碼要靠模型視覺讀碼）：
#   1) ./app-login.sh pk [--env dev]           → 背景啟動登入流程，印出 CAPTCHA_AT 裁切圖路徑
#   2) 用 Read 工具看那張圖，讀出數字
#   3) ./app-login.sh pk [--env dev] --answer 510   → 交答案並印出登入結果摘要
# 6t 多數情況單擊 radar 即可過（全自動）；但 geetest 會依風險評分偶爾升級成滑塊拼圖，
#   這種情況也是兩段式（拼圖缺口位置要靠模型視覺讀碼估算）：
#   1) ./app-login.sh 6t [--env dev]                → 全自動嘗試；若被升級成拼圖，印出 PUZZLE_AT 裁切圖路徑
#   2) 用 Read 工具看那張圖，目測「缺口中心」與「拼圖塊目前位置」的水平像素差
#   3) ./app-login.sh 6t [--env dev] --dragx 87      → 交出要拖曳的像素距離，印出登入結果摘要

set -e

ENV_FILES=("/Users/user/aladdin/aladdin_ai/.env.cqa" "/Users/user/aladdin/aladdin_ai/.env.dev")
E2E_DIR="/Users/user/aladdin/cqa-e2e"
VERIFY_DIR="$E2E_DIR/verify"
OUT_DIR="$E2E_DIR/conn/artifacts"

usage() {
  echo "Usage: $0 <pk|6t|main> [--env cqa|dev] [--account 2|3|4] [--answer <digits>] [--dragx <pixels>]"
  exit 1
}

TARGET="$1"
case "$TARGET" in
  pk|6t|main) ;;
  *) usage ;;
esac
shift

ENV_NAME="cqa"
ACCOUNT=""
ANSWER=""
DRAGX=""
URL_OVERRIDE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --env) ENV_NAME="$2"; shift 2 ;;
    --account) ACCOUNT="$2"; shift 2 ;;
    --answer) ANSWER="$2"; shift 2 ;;
    --dragx) DRAGX="$2"; shift 2 ;;
    --url) URL_OVERRIDE="$2"; shift 2 ;;
    *) echo "Unknown option: $1"; usage ;;
  esac
done

EXISTING_ENV_FILES=()
for f in "${ENV_FILES[@]}"; do
  [ -f "$f" ] && EXISTING_ENV_FILES+=("$f")
done
if [ "${#EXISTING_ENV_FILES[@]}" -eq 0 ]; then
  echo "Error: 找不到 ${ENV_FILES[*]} 任何一份（帳密來源）。"
  exit 1
fi

# 只挑出需要的 key，不 `source` 整份 .env：.env 內含 backtick 等字元，
# 整份 source 會被 shell 當語法解析而炸掉（unexpected EOF）。
get_env() {
  local val
  val=$(sed -n "s/^[[:space:]]*$1[[:space:]]*=//p" "${EXISTING_ENV_FILES[@]}" | head -1)
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
    GEETEST_SITE_KEY="6T"
    SCRIPT="$VERIFY_DIR/6t-geetest-login.cjs"
    RESULT_JSON="$VERIFY_DIR/6t-geetest-login-result.json"
    BASE="6T_APP"
    EXPORT_PREFIX="APP_6T"          # 通用名（不能用 6T_APP，bash 變數不可數字開頭），6t-geetest-login.cjs 直接讀這組，不管來源是 cqa 還是 dev
    ;;
  main)
    # main（實際網域 ny.alddev.com，NY 平台）跟 6t 共用同一套 ny-gaming 前端
    # （同登入 UI/geetest 文字驗證碼），沿用同一支腳本，只是 SITE_KEY/env prefix
    # 換成 MAIN，靠腳本的 argv[2] 區分輸出檔名。帳密 key 名稱從使用者指定為 DEV_MAIN_APP_*。
    SITE_KEY="main-app"
    GEETEST_SITE_KEY="MAIN"
    SCRIPT="$VERIFY_DIR/6t-geetest-login.cjs"
    RESULT_JSON="$VERIFY_DIR/main-geetest-login-result.json"
    BASE="MAIN_APP"
    EXPORT_PREFIX="APP_MAIN"
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
# --url 只用來覆蓋要打的網址（例如本機起的 dev server），帳密仍照常從 .env 讀對應帳號。
if [ -n "$URL_OVERRIDE" ]; then
  URL="$URL_OVERRIDE"
fi

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

# 網域白名單：依 target+env 精準比對，不開放式放行，未知組合一律擋下。
# 唯一例外：--url 明確指向本機（localhost/127.0.0.1），視為「測本機起的 dev server」，
# 不受遠端網域白名單限制——帳密仍是真的，只是打的網址換成本機。
if [ -n "$URL_OVERRIDE" ]; then
  case "$URL_OVERRIDE" in
    http://localhost:*|http://127.0.0.1:*) ;;
    *)
      echo "Error: --url 只允許 http://localhost:<port> 或 http://127.0.0.1:<port>（本機 dev server），拿到: $URL_OVERRIDE"
      exit 1
      ;;
  esac
else
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
  6t:dev)
    case "$URL" in
      *6t.alddev.com|*6t.alddev.com/*) ;;
      *)
        echo "Error: 只允許 6t.alddev.com dev 測試站，拿到的 URL 不符（已擋下）。"
        exit 1
        ;;
    esac
    ;;
  main:dev)
    case "$URL" in
      *ny.alddev.com|*ny.alddev.com/*) ;;
      *)
        echo "Error: 只允許 ny.alddev.com dev 測試站，拿到的 URL 不符（已擋下）。"
        exit 1
        ;;
    esac
    ;;
  *)
    echo "Error: env=$ENV_NAME target=$TARGET 尚未設定網域白名單，已擋下（避免誤打未知環境）。"
    exit 1
    ;;
esac
fi

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

# ---- geetest (6t/ny) phase 2: 交挑戰答案（拼圖拖曳像素 or 文字驗證碼皆可） ----
# pgrep 比對要帶 GEETEST_SITE_KEY 參數，同一支 6t-geetest-login.cjs 檔案被 6t/ny 共用，
# 不帶站別區分的話兩邊背景行程會互相誤判。
GEETEST_PROC_PATTERN="6t-geetest-login.cjs $GEETEST_SITE_KEY"
GEETEST_FILE_PREFIX="$(echo "$SITE_KEY" | sed 's/-app$//')"
CHALLENGE_REQUEST="$VERIFY_DIR/${GEETEST_FILE_PREFIX}-challenge-request.json"
CHALLENGE_ANSWER="$VERIFY_DIR/${GEETEST_FILE_PREFIX}-challenge-answer.txt"
CHALLENGE_CROP="$VERIFY_DIR/${GEETEST_FILE_PREFIX}-challenge-crop.png"
RUN_LOG="$OUT_DIR/${GEETEST_FILE_PREFIX}-app-run.log"

# --dragx（拼圖）與 --answer（文字驗證碼）在這裡等價，都是寫進同一個答案檔——
# 腳本自己知道當下等的是哪一種挑戰，用哪個 flag 交都行。
CHALLENGE_VALUE="$DRAGX"
[ -z "$CHALLENGE_VALUE" ] && CHALLENGE_VALUE="$ANSWER"

if [ -n "$CHALLENGE_VALUE" ]; then
  if ! pgrep -f "$GEETEST_PROC_PATTERN" >/dev/null 2>&1; then
    echo "Error: 沒有正在等待答案的 $GEETEST_PROC_PATTERN（請先跑 $0 $TARGET [--env $ENV_NAME] 觸發挑戰）"
    exit 1
  fi
  printf '%s' "$CHALLENGE_VALUE" > "$CHALLENGE_ANSWER"
  echo "ANSWER_SUBMITTED: $CHALLENGE_VALUE — 等待登入結果..."
  for _ in $(seq 1 60); do
    if ! pgrep -f "$GEETEST_PROC_PATTERN" >/dev/null 2>&1; then break; fi
    if [ -f "$CHALLENGE_REQUEST" ] && \
       grep -q '"done":true' "$CHALLENGE_REQUEST" 2>/dev/null; then break; fi
    sleep 2
  done
  if pgrep -f "$GEETEST_PROC_PATTERN" >/dev/null 2>&1; then
    echo "NOTE: 流程仍在跑（可能答錯後又要重試），稍候再看 $RESULT_JSON 或重跑本指令確認。"
    exit 3
  fi
  set +e
  print_summary
  exit $?
fi

# ---- geetest (6t/ny) phase 1: 全自動嘗試；被升級成挑戰就背景等待 ----
pkill -f "$GEETEST_PROC_PATTERN" >/dev/null 2>&1 || true
rm -f "$CHALLENGE_REQUEST" "$CHALLENGE_ANSWER" "$RESULT_JSON"
nohup node "$SCRIPT" "$GEETEST_SITE_KEY" >"$RUN_LOG" 2>&1 &
echo "STARTED: $GEETEST_PROC_PATTERN (env=$ENV_NAME, log: $RUN_LOG)"
for _ in $(seq 1 60); do
  if [ -f "$CHALLENGE_REQUEST" ] && \
     grep -q '"ready":true' "$CHALLENGE_REQUEST" 2>/dev/null; then
    CTYPE="$(grep -o '"type":"[a-z]*"' "$CHALLENGE_REQUEST" 2>/dev/null | head -1 | sed -E 's/.*:"([a-z]*)"/\1/')"
    echo "CHALLENGE_AT: $CHALLENGE_CROP (type=${CTYPE:-unknown})"
    if [ "$CTYPE" = "captcha" ]; then
      echo "NEXT: 用 Read 工具看圖讀出文字驗證碼，再跑 $0 $TARGET --env $ENV_NAME --answer <text>"
    else
      echo "NEXT: 用 Read 工具看圖，目測缺口中心與拼圖塊目前位置的水平像素差，再跑 $0 $TARGET --env $ENV_NAME --dragx <pixels>"
    fi
    exit 0
  fi
  if ! pgrep -f "$GEETEST_PROC_PATTERN" >/dev/null 2>&1; then
    # process 已結束但從未發出挑戰訊號：多數情況是單擊 radar 就過了，直接看 result JSON。
    if [ -f "$RESULT_JSON" ]; then
      set +e
      print_summary
      rc=$?
      set -e
      exit "$rc"
    fi
    echo "RESULT: FAIL (腳本提早結束且未產出結果 JSON，詳見 $RUN_LOG)"
    tail -5 "$RUN_LOG"
    exit 1
  fi
  sleep 1
done
echo "RESULT: FAIL (等不到結果或挑戰訊號，詳見 $RUN_LOG)"
exit 1
