#!/usr/bin/env bash
# create-mr-prelude.sh 離線測試：三支子腳本全部用 stub 取代，不打網路、不動 git、不動 CSV。
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$HERE/create-mr-prelude.sh"
TMP="$(mktemp -d)"
fail=0
has() { if printf '%s\n' "$1" | grep -qxF "$2"; then echo "PASS: $3"; else echo "FAIL: $3 — expected [$2] in:"; printf '%s\n' "$1" | sed 's/^/    /'; fail=1; fi; }

# stubs
cat > "$TMP/fresh-ok.sh" <<'EOF'
echo "some noise"; echo "FRESH_PULL_OK"
EOF
cat > "$TMP/fresh-fail.sh" <<'EOF'
echo "FRESH_PULL_FAIL:update.sh 非零結束，log：/x"
EOF
cat > "$TMP/map.sh" <<'EOF'
LOG="${MAP_LOG:?}"
case "$1" in
  --list)
    printf '111\twebhook\tAlice\talice_tg\tHIGH\talice@x.com\tAlice\t\n'
    printf '222\twebhook\tBob\tbob_tg\tASK\t\t\tb1@x.com,b2@x.com\n'
    printf '333\twebhook\tCarl\tcarl_tg\tHIGH\tcarl@x.com\tCarl\t\n'
    printf '444\twebhook\tDan\tdan_tg\tHIGH\tdan@x.com\tDan\t\n'
    ;;
  --set)
    echo "set $2 $3" >> "$LOG"
    case "$2" in
      carl@x.com) echo "SET_ERR_REGISTRY: boom";;
      *) echo "SET_OK: $2 -> $3"; echo "RESTART_OK: com.aladdin.tg-dispatch-server";;
    esac;;
esac
EOF
cat > "$TMP/notify.sh" <<'EOF'
LOG="${MAP_LOG:?}"
echo "notify $*" >> "$LOG"
case "$*" in *dan@x.com*) echo "TG_SKIP_NO_CHATID: dan@x.com";; *) echo "TG_SENT(dry-run): ok";; esac
EOF
cat > "$TMP/map-empty.sh" <<'EOF'
[ "$1" = --list ] && exit 0
EOF
cat > "$TMP/map-err.sh" <<'EOF'
echo "boom" >&2; exit 1
EOF

# 1. 正常路徑：2 HIGH 成功（1 通知成功、1 通知失敗）、1 HIGH set 失敗、1 ASK
: > "$TMP/log"
out="$(MAP_LOG="$TMP/log" PRELUDE_FRESH_PULL_SH="$TMP/fresh-ok.sh" PRELUDE_TG_MAP_SH="$TMP/map.sh" PRELUDE_TG_NOTIFY_SH="$TMP/notify.sh" bash "$SCRIPT")"
has "$out" "FRESH_PULL: FRESH_PULL_OK" "fresh pull ok 取最後一行"
has "$out" "TG_CHATID_SYNC: 自動對映 2 / ASK 待處理 1 / 確認訊息 1 SENT, 1 FAIL" "彙總計數"
grep -q "set alice@x.com 111" "$TMP/log" && echo "PASS: HIGH 有 --set" || { echo "FAIL: alice 未 set"; fail=1; }
grep -q "notify --email alice@x.com --text Alice 連結成功" "$TMP/log" && echo "PASS: SET_OK 後通知文字" || { echo "FAIL: alice 通知"; fail=1; }
grep -q "notify --email carl@x.com" "$TMP/log" && { echo "FAIL: SET 失敗者不該通知"; fail=1; } || echo "PASS: SET 失敗不通知"
grep -q "set .*b1@x.com\|set .*222" "$TMP/log" && { echo "FAIL: ASK 不該 set"; fail=1; } || echo "PASS: ASK 不寫"

# 2. fresh pull 失敗只反映在該行，0-b 照常
out="$(MAP_LOG="$TMP/log" PRELUDE_FRESH_PULL_SH="$TMP/fresh-fail.sh" PRELUDE_TG_MAP_SH="$TMP/map-empty.sh" PRELUDE_TG_NOTIFY_SH="$TMP/notify.sh" bash "$SCRIPT")"
has "$out" "FRESH_PULL: FRESH_PULL_FAIL:update.sh 非零結束，log：/x" "fresh pull fail 原文透傳"
has "$out" "TG_CHATID_SYNC: SKIPPED" "--list 無輸出 → SKIPPED"

# 3. --list 失敗 → SKIPPED；fresh-pull 腳本不存在 → FAIL 行
out="$(MAP_LOG="$TMP/log" PRELUDE_FRESH_PULL_SH="$TMP/nope.sh" PRELUDE_TG_MAP_SH="$TMP/map-err.sh" PRELUDE_TG_NOTIFY_SH="$TMP/notify.sh" bash "$SCRIPT")"; rc=$?
has "$out" "FRESH_PULL: FRESH_PULL_FAIL:查無 fresh-pull.sh" "缺 fresh-pull.sh"
has "$out" "TG_CHATID_SYNC: SKIPPED" "--list 非零 → SKIPPED"
[ $rc -eq 0 ] && echo "PASS: 一律 exit 0" || { echo "FAIL: exit $rc"; fail=1; }

rm -rf "$TMP"
[ $fail -eq 0 ] && echo "ALL PASS" || { echo "SOME FAILED"; exit 1; }
