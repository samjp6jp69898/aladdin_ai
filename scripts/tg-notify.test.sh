#!/usr/bin/env bash
# tg-notify.sh 離線測試（不打網路；happy path 用 --dry-run）
#
# 2026-09-16（Phase 6：tech-users.csv 刪檔退役）：名冊與 chat_id 都改向
# telegram-dispatcher 的 registry CLI 問，所以測試改用 TG_REGISTRY_CLI 注入一支
# 假 CLI（本檔生成），完全不碰真實 DB、不碰網路。假 CLI 只實作本腳本會用到的
# 兩個子指令：--list-roster 與 --resolve-chat-id。
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$HERE/tg-notify.sh"
TMP="$(mktemp -d)"

FAKE_CLI="$TMP/fake-registry.sh"
cat > "$FAKE_CLI" <<'EOF'
#!/usr/bin/env bash
# 假名冊：Alice 已連接（chat_id 111）、Bob 在名冊但沒連接。
case "${1:-}" in
  --list-roster)
    printf '%s\n' \
      'notion_user_name,notion_user_id,email,pushed_repos' \
      'Alice,id-alice,alice@x.com,abu;rajah' \
      'Bob,id-bob,bob@x.com,agrabah'
    ;;
  --resolve-chat-id)
    case "${2:-}" in
      alice@x.com) echo 'RESOLVE_OK: 111' ;;
      bob@x.com)   echo 'RESOLVE_ERR_NO_CHATID: bob@x.com' ;;
      *)           echo "RESOLVE_ERR_NOT_TECH: ${2:-}" ;;
    esac
    ;;
  *) echo "fake-registry: unsupported ${1:-}" >&2; exit 2 ;;
esac
EOF
chmod +x "$FAKE_CLI"
export TG_REGISTRY_CLI="bash $FAKE_CLI"
export TG_REGISTRY_CLI_CWD="$TMP"

fail=0
assert_eq() { # $1 expected  $2 actual  $3 name
  if [ "$1" = "$2" ]; then echo "PASS: $3"; else echo "FAIL: $3 — expected [$1] got [$2]"; fail=1; fi
}

out="$(bash "$SCRIPT" --email alice@x.com --text hi --dry-run)"
assert_eq "TG_SENT(dry-run): alice@x.com chat_id=111" "$out" "email 命中 → dry-run sent"

out="$(bash "$SCRIPT" --email bob@x.com --text hi --dry-run)"
assert_eq "TG_SKIP_NO_CHATID: bob@x.com" "$out" "email 命中但未連接 chat_id"

out="$(bash "$SCRIPT" --email ghost@x.com --text hi --dry-run)"
assert_eq "TG_SKIP_NOT_TECH: ghost@x.com" "$out" "email 不在名單"

out="$(bash "$SCRIPT" --notion-user-ids "id-zzz id-alice" --text hi --dry-run)"
assert_eq "TG_SENT(dry-run): alice@x.com chat_id=111" "$out" "notion-id 命中（取第 2 個）"

out="$(bash "$SCRIPT" --notion-user-ids "id-bob" --text hi --dry-run)"
assert_eq "TG_SKIP_NO_CHATID: bob@x.com" "$out" "notion-id 命中但未連接 chat_id"

out="$(bash "$SCRIPT" --notion-user-ids "id-none" --text hi --dry-run)"
assert_eq "TG_SKIP_NOT_TECH: id-none" "$out" "notion-id 非技術"

out="$(bash "$SCRIPT" --chat-id 5022865804 --text hi --dry-run)"
assert_eq "TG_SENT(dry-run): (direct) chat_id=5022865804" "$out" "直送模式繞過名冊"

# 名冊查不到（registry CLI 掛掉／回空）→ TG_FAIL，不靜默當成「不是技術」
out="$(TG_REGISTRY_CLI="bash $TMP/no-such-cli.sh" bash "$SCRIPT" --email alice@x.com --text hi --dry-run)"
assert_eq "TG_FAIL: roster unavailable (tech-users-sync.ts --list-roster)" "$out" "名冊取不到 → TG_FAIL"

# C1 回歸：末尾旗標無值不得 abort（stdout 單行 + exit 0）
out="$(bash "$SCRIPT" --email alice@x.com --text)"; rc=$?
assert_eq "TG_FAIL: missing --text or --file" "$out" "末尾 --text 無值 → 不 abort（stdout）"
assert_eq "0" "$rc" "末尾 --text 無值 → exit 0"

# 完全缺 --text 與 --file
out="$(bash "$SCRIPT" --email alice@x.com)"
assert_eq "TG_FAIL: missing --text or --file" "$out" "缺 --text 與 --file → TG_FAIL"

# 缺 selector
out="$(bash "$SCRIPT" --text hi)"
assert_eq "TG_FAIL: missing selector (--email/--notion-user-ids/--chat-id)" "$out" "缺 selector → TG_FAIL"

# --file：dry-run 帶檔名
TESTFILE="$TMP/doc.txt"; echo hi > "$TESTFILE"
out="$(bash "$SCRIPT" --email alice@x.com --file "$TESTFILE" --dry-run)"
assert_eq "TG_SENT(dry-run): alice@x.com chat_id=111 file=$TESTFILE" "$out" "--file dry-run → 帶檔名"

# --file：檔案不存在 → TG_FAIL
out="$(bash "$SCRIPT" --email alice@x.com --file "$TMP/no-such-file.txt" --dry-run)"
assert_eq "TG_FAIL: file not found ($TMP/no-such-file.txt)" "$out" "--file 檔案不存在 → TG_FAIL"

# 略過路徑 exit 0
bash "$SCRIPT" --email ghost@x.com --text hi --dry-run >/dev/null; rc=$?
assert_eq "0" "$rc" "skip 路徑 exit 0"

rm -rf "$TMP"
[ "$fail" = "0" ] && echo "ALL PASS" || { echo "SOME FAILED"; exit 1; }
