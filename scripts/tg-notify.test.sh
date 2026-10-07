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
      'Bob,id-bob,bob@x.com,agrabah' \
      'Carol,id-carol,carol@x.com,abu'
    ;;
  --resolve-chat-id)
    case "${2:-}" in
      alice@x.com) echo 'RESOLVE_OK: 111' ;;
      bob@x.com)   echo 'RESOLVE_ERR_NO_CHATID: bob@x.com' ;;
      carol@x.com) echo 'RESOLVE_ERR_DECRYPT_FAILED: carol@x.com' ;;
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
# 測試封閉：不論在 head/worker 跑，都不讀真實 .env、不連真實 head
export TG_DISPATCHER_ENV_FILE="$TMP/none.env"
unset CLUSTER_HEAD_URL CLUSTER_SHARED_SECRET TG_NO_RELAY
TESTFILE="$TMP/doc.txt"; echo hi > "$TESTFILE"
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
case "$out" in
  "TG_FAIL_RESOLVE: alice@x.com (名冊取不到"*"escalated: TG_SENT(dry-run): (direct) chat_id=5022865804") echo "PASS: 名冊取不到 → TG_FAIL_RESOLVE 並轉維運者" ;;
  *) echo "FAIL: 名冊取不到 — got [$out]"; fail=1 ;;
esac

# 解析失敗（DECRYPT_FAILED，非未綁定）→ 不可偽裝成 NO_CHATID，且轉給維運者
out="$(bash "$SCRIPT" --email carol@x.com --text hi --dry-run)"
case "$out" in
  "TG_FAIL_RESOLVE: carol@x.com (chat_id 解析失敗：RESOLVE_ERR_DECRYPT_FAILED: carol@x.com"*"escalated: TG_SENT(dry-run): (direct) chat_id=5022865804") echo "PASS: DECRYPT_FAILED → TG_FAIL_RESOLVE 並轉維運者" ;;
  *) echo "FAIL: DECRYPT_FAILED — got [$out]"; fail=1 ;;
esac
out="$(TG_ESCALATION_CHAT_ID=999 bash "$SCRIPT" --email carol@x.com --text hi --dry-run)"
case "$out" in *"chat_id=999") echo "PASS: TG_ESCALATION_CHAT_ID 可覆寫" ;; *) echo "FAIL: 覆寫 — got [$out]"; fail=1 ;; esac

# worker 轉發：解析失敗時轉給 head 的 /cluster/notify（stub head 驗證請求內容與 header）
STUB="$TMP/stub-head.py"; STUBLOG="$TMP/stub.log"; PORTFILE="$TMP/port"
cat > "$STUB" <<'PYEOF'
import http.server, json, sys
log, portfile = sys.argv[1], sys.argv[2]
class H(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get('content-length', 0))).decode()
        open(log, 'a').write(self.path + '|' + str(self.headers.get('x-cluster-token')) + '|' + body + '\n')
        ok = self.headers.get('x-cluster-token') == 'secret-for-test'
        self.send_response(200 if ok else 401); self.end_headers()
        if ok: self.wfile.write(json.dumps({"ok": True, "result": "TG_SENT: relayed"}).encode())
    def log_message(self, *a): pass
srv = http.server.HTTPServer(('127.0.0.1', 0), H)
print(srv.server_address[1], flush=True)
srv.serve_forever()
PYEOF
# 阻塞式讀取 stub 印出的 port（stub listen 完才會印），不靠 sleep/輪詢
exec 3< <(python3 "$STUB" "$STUBLOG" "$PORTFILE")
read -r STUBPORT <&3
STUBPID="$(pgrep -f "stub-head.py $STUBLOG" | head -n1)"
HEAD="http://127.0.0.1:$STUBPORT"
NOENV="$TMP/none.env"
out="$(TG_DISPATCHER_ENV_FILE="$NOENV" CLUSTER_HEAD_URL="$HEAD" CLUSTER_SHARED_SECRET=secret-for-test bash "$SCRIPT" --email carol@x.com --text "你好 hi" --dry-run)"
assert_eq "TG_SENT: relayed" "$out" "DECRYPT_FAILED → 轉給 head 成功，輸出 head 結果行"
case "$(cat "$STUBLOG")" in
  "/cluster/notify|secret-for-test|"*'"email": "carol@x.com"'*'"dryRun": true'*) echo "PASS: 轉發請求帶 token/email/dryRun" ;;
  *) echo "FAIL: 轉發請求內容 — $(cat "$STUBLOG")"; fail=1 ;;
esac
out="$(TG_DISPATCHER_ENV_FILE="$NOENV" CLUSTER_HEAD_URL="$HEAD" CLUSTER_SHARED_SECRET=wrong bash "$SCRIPT" --email carol@x.com --text hi --dry-run)"
case "$out" in "TG_FAIL_RESOLVE: carol@x.com"*) echo "PASS: head 拒絕 → 退回轉維運者" ;; *) echo "FAIL: head 拒絕 — [$out]"; fail=1 ;; esac
out="$(TG_NO_RELAY=1 TG_DISPATCHER_ENV_FILE="$NOENV" CLUSTER_HEAD_URL="$HEAD" CLUSTER_SHARED_SECRET=secret-for-test bash "$SCRIPT" --email carol@x.com --text hi --dry-run)"
case "$out" in "TG_FAIL_RESOLVE: carol@x.com"*) echo "PASS: TG_NO_RELAY 不轉發（防迴圈）" ;; *) echo "FAIL: TG_NO_RELAY — [$out]"; fail=1 ;; esac
out="$(TG_DISPATCHER_ENV_FILE="$NOENV" CLUSTER_HEAD_URL="$HEAD" CLUSTER_SHARED_SECRET=secret-for-test bash "$SCRIPT" --email carol@x.com --file "$TESTFILE" --dry-run)"
case "$out" in "TG_FAIL_RESOLVE: carol@x.com"*) echo "PASS: --file 不轉發" ;; *) echo "FAIL: --file — [$out]"; fail=1 ;; esac
out="$(TG_DISPATCHER_ENV_FILE="$NOENV" bash "$SCRIPT" --email bob@x.com --text hi --dry-run)"
assert_eq "TG_SKIP_NO_CHATID: bob@x.com" "$out" "真正未綁不轉發"
kill "$STUBPID" 2>/dev/null

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
