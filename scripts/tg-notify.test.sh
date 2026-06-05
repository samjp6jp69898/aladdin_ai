#!/usr/bin/env bash
# tg-notify.sh 離線測試（不打網路；happy path 用 --dry-run）
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$HERE/tg-notify.sh"
TMP="$(mktemp -d)"
CSV="$TMP/tech-users.csv"
cat > "$CSV" <<'EOF'
notion_user_name,notion_user_id,email,pushed_repos,tg_chat_id
Alice,id-alice,alice@x.com,abu;rajah,111
Bob,id-bob,bob@x.com,agrabah,
EOF

fail=0
assert_eq() { # $1 expected  $2 actual  $3 name
  if [ "$1" = "$2" ]; then echo "PASS: $3"; else echo "FAIL: $3 — expected [$1] got [$2]"; fail=1; fi
}

out="$(TG_NOTIFY_CSV="$CSV" bash "$SCRIPT" --email alice@x.com --text hi --dry-run)"
assert_eq "TG_SENT(dry-run): alice@x.com chat_id=111" "$out" "email 命中 → dry-run sent"

out="$(TG_NOTIFY_CSV="$CSV" bash "$SCRIPT" --email bob@x.com --text hi --dry-run)"
assert_eq "TG_SKIP_NO_CHATID: bob@x.com" "$out" "email 命中但 chat_id 空"

out="$(TG_NOTIFY_CSV="$CSV" bash "$SCRIPT" --email ghost@x.com --text hi --dry-run)"
assert_eq "TG_SKIP_NOT_TECH: ghost@x.com" "$out" "email 不在名單"

out="$(TG_NOTIFY_CSV="$CSV" bash "$SCRIPT" --notion-user-ids "id-zzz id-alice" --text hi --dry-run)"
assert_eq "TG_SENT(dry-run): alice@x.com chat_id=111" "$out" "notion-id 命中（取第 2 個）"

out="$(TG_NOTIFY_CSV="$CSV" bash "$SCRIPT" --notion-user-ids "id-bob" --text hi --dry-run)"
assert_eq "TG_SKIP_NO_CHATID: bob@x.com" "$out" "notion-id 命中但 chat_id 空"

out="$(TG_NOTIFY_CSV="$CSV" bash "$SCRIPT" --notion-user-ids "id-none" --text hi --dry-run)"
assert_eq "TG_SKIP_NOT_TECH: id-none" "$out" "notion-id 非技術"

out="$(TG_NOTIFY_CSV="$CSV" bash "$SCRIPT" --chat-id 5022865804 --text hi --dry-run)"
assert_eq "TG_SENT(dry-run): (direct) chat_id=5022865804" "$out" "直送模式繞過 CSV"

# C1 回歸：末尾旗標無值不得 abort（stdout 單行 + exit 0）
out="$(TG_NOTIFY_CSV="$CSV" bash "$SCRIPT" --email alice@x.com --text)"; rc=$?
assert_eq "TG_FAIL: missing --text" "$out" "末尾 --text 無值 → 不 abort（stdout）"
assert_eq "0" "$rc" "末尾 --text 無值 → exit 0"

# 完全缺 --text
out="$(TG_NOTIFY_CSV="$CSV" bash "$SCRIPT" --email alice@x.com)"
assert_eq "TG_FAIL: missing --text" "$out" "缺 --text → TG_FAIL"

# 缺 selector
out="$(TG_NOTIFY_CSV="$CSV" bash "$SCRIPT" --text hi)"
assert_eq "TG_FAIL: missing selector (--email/--notion-user-ids/--chat-id)" "$out" "缺 selector → TG_FAIL"

# 略過路徑 exit 0
TG_NOTIFY_CSV="$CSV" bash "$SCRIPT" --email ghost@x.com --text hi --dry-run >/dev/null; rc=$?
assert_eq "0" "$rc" "skip 路徑 exit 0"

rm -rf "$TMP"
[ "$fail" = "0" ] && echo "ALL PASS" || { echo "SOME FAILED"; exit 1; }
