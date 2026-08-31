#!/bin/bash
# Usage: ./portainer-login.sh <cqa|dev>
#
# Portainer 連線確認（唯讀）：登入拿 JWT，列出可見的 endpoints（環境）與名稱/狀態。
# 不列容器、不拉 log 內容——要看特定容器/log 內容時再擴充（先確認連線方式堪用）。
# 帳密一律從 aladdin_ai/.env.cqa 或 .env.dev 讀取，不寫死、不印出。
# 純 REST API（Portainer 2.x /api/auth /api/endpoints），不需要 Playwright。

set -e

ENV_FILES=("/Users/user/aladdin/aladdin_ai/.env.cqa" "/Users/user/aladdin/aladdin_ai/.env.dev")
TARGET="$1"

case "$TARGET" in
  cqa|dev) ;;
  *)
    echo "Usage: $0 <cqa|dev>"
    exit 1
    ;;
esac

EXISTING_ENV_FILES=()
for f in "${ENV_FILES[@]}"; do
  [ -f "$f" ] && EXISTING_ENV_FILES+=("$f")
done
if [ "${#EXISTING_ENV_FILES[@]}" -eq 0 ]; then
  echo "Error: 找不到 ${ENV_FILES[*]} 任何一份（帳密來源）。"
  exit 1
fi

# 只挑出需要的 key，不 `source` 整份 .env（見 conn/README.md 的 .env source 陷阱說明）。
get_env() {
  local val
  val=$(sed -n "s/^[[:space:]]*$1[[:space:]]*=//p" "${EXISTING_ENV_FILES[@]}" | head -1)
  val="${val%$'\r'}"
  val="${val%\"}"; val="${val#\"}"
  val="${val%\'}"; val="${val#\'}"
  printf '%s' "$val"
}

PREFIX_UPPER=$(printf '%s' "$TARGET" | tr '[:lower:]' '[:upper:]')
PREFIX="${PREFIX_UPPER}_PORTAINER"

URL="$(get_env "${PREFIX}_URL")"
USER_VAL="$(get_env "${PREFIX}_USER")"
PASS_VAL="$(get_env "${PREFIX}_PASS")"

MISSING=""
[ -z "$URL" ] && MISSING="$MISSING ${PREFIX}_URL"
[ -z "$USER_VAL" ] && MISSING="$MISSING ${PREFIX}_USER"
[ -z "$PASS_VAL" ] && MISSING="$MISSING ${PREFIX}_PASS"
if [ -n "$MISSING" ]; then
  echo "Error: .env 缺少 ${TARGET} portainer 的欄位:$MISSING"
  exit 2
fi

# 網域白名單：精準比對，不開放式放行
case "$TARGET" in
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

URL="${URL%/}"

node -e '
const [url, user, pass] = process.argv.slice(1);
fetch(url + "/api/auth", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ username: user, password: pass }),
}).then(async (r) => {
  const body = await r.text();
  let jwt = null;
  try { jwt = JSON.parse(body).jwt; } catch (e) {}
  if (!jwt) {
    console.log("RESULT: FAIL (HTTP " + r.status + ", auth 沒拿到 jwt)");
    process.exit(1);
  }
  const epRes = await fetch(url + "/api/endpoints", { headers: { Authorization: "Bearer " + jwt } });
  const eps = await epRes.json().catch(() => []);
  console.log("RESULT: SUCCESS");
  console.log("jwt:       len " + jwt.length + " (not printed)");
  console.log("endpoints: " + (Array.isArray(eps) ? eps.length : 0));
  if (Array.isArray(eps)) {
    for (const ep of eps) {
      console.log("  - id=" + ep.Id + " name=" + ep.Name + " status=" + (ep.Status === 1 ? "up" : "down/" + ep.Status));
    }
  }
}).catch((err) => {
  console.log("RESULT: FAIL (" + err.message + ")");
  process.exit(1);
});
' "$URL" "$USER_VAL" "$PASS_VAL"
