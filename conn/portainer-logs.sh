#!/bin/bash
# Usage: ./portainer-logs.sh <cqa|dev> list
#        ./portainer-logs.sh <cqa|dev> <application> [--tail N] [--namespace NS] [--container NAME] [--endpoint ID]
#
# 依 application（K8s pod 的 `app` label，如 core / payment / wallet / activity…）快速切換看 log。
# 唯讀：只查 pods / 拉 log，不建立、不刪除、不改任何資源。
# 帳密一律從 aladdin_ai/.env.cqa 或 .env.dev 讀取，不寫死、不印出。
#
# <application> 支援精準比對；沒有精準命中時退而求其次做 substring 比對——
# 唯一命中就直接用，命中多筆會列出候選要求你打精確一點（不會自己猜哪個）。

set -e

ENV_FILES=("/Users/user/aladdin/aladdin_ai/.env.cqa" "/Users/user/aladdin/aladdin_ai/.env.dev")
TARGET="$1"

case "$TARGET" in
  cqa|dev) ;;
  *)
    echo "Usage: $0 <cqa|dev> list   |   $0 <cqa|dev> <application> [--tail N] [--namespace NS] [--container NAME] [--endpoint ID]"
    exit 1
    ;;
esac
shift

SUB="$1"
if [ -z "$SUB" ]; then
  echo "Usage: $0 <cqa|dev> list   |   $0 <cqa|dev> <application> [--tail N] [--namespace NS] [--container NAME] [--endpoint ID]"
  exit 1
fi
shift

TAIL=100
NAMESPACE="default"
CONTAINER=""
ENDPOINT_ID=""
while [ $# -gt 0 ]; do
  case "$1" in
    --tail) TAIL="$2"; shift 2 ;;
    --namespace) NAMESPACE="$2"; shift 2 ;;
    --container) CONTAINER="$2"; shift 2 ;;
    --endpoint) ENDPOINT_ID="$2"; shift 2 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
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
const [url, user, pass, sub, tailStr, namespace, container, endpointIdArg] = process.argv.slice(1);
const tail = parseInt(tailStr, 10) || 100;

async function main() {
  const authRes = await fetch(url + "/api/auth", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: user, password: pass }),
  });
  const authBody = await authRes.text();
  let jwt = null;
  try { jwt = JSON.parse(authBody).jwt; } catch (e) {}
  if (!jwt) {
    console.log("RESULT: FAIL (auth, HTTP " + authRes.status + ")");
    process.exit(1);
  }
  const auth = { Authorization: "Bearer " + jwt };

  let endpointId = endpointIdArg;
  if (!endpointId) {
    const epRes = await fetch(url + "/api/endpoints", { headers: auth });
    const eps = await epRes.json();
    if (!Array.isArray(eps) || !eps.length) {
      console.log("RESULT: FAIL (沒有可見的 endpoint)");
      process.exit(1);
    }
    endpointId = eps[0].Id;
    if (eps.length > 1) {
      console.log("NOTE: 有 " + eps.length + " 個 endpoint，預設用第一個 id=" + endpointId + " name=" + eps[0].Name + "（可用 --endpoint 指定其他）");
    }
  }

  const base = url + "/api/endpoints/" + endpointId + "/kubernetes/api/v1/namespaces/" + namespace;
  const podsRes = await fetch(base + "/pods", { headers: auth });
  if (podsRes.status !== 200) {
    const t = await podsRes.text();
    console.log("RESULT: FAIL (無法列出 namespace=" + namespace + " 的 pods，HTTP " + podsRes.status + ": " + t.slice(0, 200) + ")");
    process.exit(1);
  }
  const podsData = await podsRes.json();
  const items = podsData.items || [];
  const byApp = {};
  for (const p of items) {
    const app = p.metadata.labels && p.metadata.labels.app;
    if (!app) continue;
    (byApp[app] = byApp[app] || []).push(p);
  }

  if (sub === "list") {
    const names = Object.keys(byApp).sort();
    console.log("RESULT: SUCCESS");
    console.log("namespace: " + namespace + " | applications: " + names.length);
    console.log(names.join("\n"));
    return;
  }

  let matchKey = null;
  if (byApp[sub]) {
    matchKey = sub;
  } else {
    const lower = sub.toLowerCase();
    const subMatches = Object.keys(byApp).filter((k) => k.toLowerCase().includes(lower));
    if (subMatches.length === 1) {
      matchKey = subMatches[0];
    } else if (subMatches.length > 1) {
      console.log("RESULT: AMBIGUOUS (" + subMatches.length + " 個符合 \"" + sub + "\"，請打精確一點)");
      console.log(subMatches.sort().join("\n"));
      process.exit(1);
    } else {
      console.log("RESULT: FAIL (找不到 application \"" + sub + "\"，用 list 看全部可用名稱)");
      process.exit(1);
    }
  }

  const pods = byApp[matchKey];
  console.log("RESULT: SUCCESS");
  console.log("application: " + matchKey + " | pods: " + pods.length);
  for (const p of pods) {
    const name = p.metadata.name;
    const phase = (p.status && p.status.phase) || "Unknown";
    const containers = (p.spec && p.spec.containers || []).map((c) => c.name);
    const useContainer = container || containers[0] || "";
    console.log("");
    console.log("== " + name + " (" + phase + (useContainer ? ", container=" + useContainer : "") + ") ==");
    if (phase !== "Running") {
      console.log("(skip: pod 不是 Running 狀態)");
      continue;
    }
    let logUrl = base + "/pods/" + name + "/log?tailLines=" + tail;
    if (useContainer) logUrl += "&container=" + encodeURIComponent(useContainer);
    const logRes = await fetch(logUrl, { headers: auth });
    if (logRes.status !== 200) {
      const t = await logRes.text();
      console.log("(log fetch failed, HTTP " + logRes.status + ": " + t.slice(0, 200) + ")");
      continue;
    }
    console.log(await logRes.text());
  }
}

main().catch((err) => {
  console.log("RESULT: FAIL (" + err.message + ")");
  process.exit(1);
});
' "$URL" "$USER_VAL" "$PASS_VAL" "$SUB" "$TAIL" "$NAMESPACE" "$CONTAINER" "$ENDPOINT_ID"
