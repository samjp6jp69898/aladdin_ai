#!/bin/bash
# Usage: ./kibana-logs.sh <cqa|dev> list
#        ./kibana-logs.sh <cqa|dev> <application> [--tail N]
#
# 依 application（K8s pod 的 `app` label，跟 conn/portainer-logs.sh 同一套）快速切換看 log，
# 資料來源是 Kibana 後面的 Elasticsearch（走 Kibana 的 /api/console/proxy 轉發 _search）。
# 唯讀：只列 index-pattern、只 _search 拉文件，不寫入/不刪除任何資料。
# 帳密一律從 /Users/user/aladdin/.env 讀取，不寫死、不印出。
# USER/PASS 是可選的：dev 環境目前完全不需要登入即可查（已實測 /api/saved_objects、_search 都直接 200），
# 若某環境的 Kibana 需要 Basic Auth，補上 {ENV}_KIBANA_USER/PASS 即可自動帶上。
#
# Index 命名（如 aladdin_dev-core-*、aladdin_dev-core-back-office-*）互相有前綴重疊，
# 純用 index wildcard 查會誤命中（查 core 會連 core-back-office 都撈進來）。
# 這支改用 k8s.kubernetes.labels.app.keyword 做精準 term 過濾，不依賴 index 名稱邊界。

set -e

ENV_FILE="/Users/user/aladdin/.env"

usage() {
  echo "Usage: $0 <cqa|dev> list   |   $0 <cqa|dev> <application> [--tail N]"
  exit 1
}

TARGET="$1"
case "$TARGET" in
  cqa|dev) ;;
  *) usage ;;
esac
shift

SUB="$1"
[ -z "$SUB" ] && usage
shift

TAIL=100
while [ $# -gt 0 ]; do
  case "$1" in
    --tail) TAIL="$2"; shift 2 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

if [ ! -f "$ENV_FILE" ]; then
  echo "Error: $ENV_FILE not found (帳密來源)."
  exit 1
fi

# 只挑出需要的 key，不 `source` 整份 .env（見 conn/README.md 的 .env source 陷阱說明）。
get_env() {
  local val
  val=$(sed -n "s/^[[:space:]]*$1[[:space:]]*=//p" "$ENV_FILE" | head -1)
  val="${val%$'\r'}"
  val="${val%\"}"; val="${val#\"}"
  val="${val%\'}"; val="${val#\'}"
  printf '%s' "$val"
}

PREFIX_UPPER=$(printf '%s' "$TARGET" | tr '[:lower:]' '[:upper:]')
KEY_PREFIX="${PREFIX_UPPER}_KIBANA"

URL="$(get_env "${KEY_PREFIX}_URL")"
USER_VAL="$(get_env "${KEY_PREFIX}_USER")"
PASS_VAL="$(get_env "${KEY_PREFIX}_PASS")"

if [ -z "$URL" ]; then
  echo "Error: .env 缺少 ${KEY_PREFIX}_URL"
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
const [url, user, pass, sub, tailStr] = process.argv.slice(1);
const tail = parseInt(tailStr, 10) || 100;
const headers = { "kbn-xsrf": "true", "Content-Type": "application/json" };
if (user) headers.Authorization = "Basic " + Buffer.from(user + ":" + pass).toString("base64");

async function main() {
  const ipRes = await fetch(url + "/api/saved_objects/_find?type=index-pattern&per_page=1000", { headers });
  if (ipRes.status !== 200) {
    console.log("RESULT: FAIL (無法列出 index pattern，HTTP " + ipRes.status + ")");
    process.exit(1);
  }
  const ipData = await ipRes.json();
  const titles = (ipData.saved_objects || []).map((o) => o.attributes.title).filter(Boolean);
  if (!titles.length) {
    console.log("RESULT: FAIL (沒有找到任何 index pattern)");
    process.exit(1);
  }

  // 算所有 index-pattern title 的最長共同前綴（如 "aladdin_dev-"），
  // 不寫死環境專屬字串，讓這支在不同環境下自動適應。
  let prefix = titles[0];
  for (const t of titles.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < t.length && prefix[i] === t[i]) i++;
    prefix = prefix.slice(0, i);
  }
  const appOf = (title) => title.slice(prefix.length).replace(/-?\*$/, "");
  const apps = [...new Set(titles.map(appOf).filter(Boolean))].sort();

  if (sub === "list") {
    console.log("RESULT: SUCCESS");
    console.log("index prefix: " + prefix + "* | applications: " + apps.length);
    console.log(apps.join("\n"));
    return;
  }

  let matchKey = null;
  if (apps.includes(sub)) {
    matchKey = sub;
  } else {
    const lower = sub.toLowerCase();
    const subMatches = apps.filter((a) => a.toLowerCase().includes(lower));
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

  const searchPath = encodeURIComponent(prefix + "*/_search");
  const body = JSON.stringify({
    size: tail,
    sort: [{ "@timestamp": "desc" }],
    query: { term: { "k8s.kubernetes.labels.app.keyword": matchKey } },
    _source: ["@timestamp", "log_level", "app_log", "k8s.kubernetes.pod_name"],
  });
  const searchRes = await fetch(url + "/api/console/proxy?path=" + searchPath + "&method=POST", {
    method: "POST",
    headers,
    body,
  });
  if (searchRes.status !== 200) {
    const t = await searchRes.text();
    console.log("RESULT: FAIL (查詢失敗，HTTP " + searchRes.status + ": " + t.slice(0, 200) + ")");
    process.exit(1);
  }
  const data = await searchRes.json();
  const hits = (data.hits && data.hits.hits) || [];
  const total = data.hits && data.hits.total && data.hits.total.value;
  console.log("RESULT: SUCCESS");
  console.log("application: " + matchKey + " | index: " + prefix + "* | hits: " + hits.length + (total ? " (共 " + total + "+ 筆符合)" : ""));
  console.log("");
  for (const h of hits.slice().reverse()) {
    const s = h._source || {};
    const pod = s.k8s && s.k8s.kubernetes && s.k8s.kubernetes.pod_name;
    console.log(
      "[" + (s["@timestamp"] || "-") + "]" +
      (s.log_level ? " " + s.log_level : "") +
      (pod ? " (" + pod + ")" : "") +
      " " + (s.app_log || "")
    );
  }
}

main().catch((err) => {
  console.log("RESULT: FAIL (" + err.message + ")");
  process.exit(1);
});
' "$URL" "$USER_VAL" "$PASS_VAL" "$SUB" "$TAIL"
