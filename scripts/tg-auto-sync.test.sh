#!/usr/bin/env bash
# tg-auto-sync.test.sh — 全離線測試（不打 Telegram API、不碰真實 CSV/log）
# 跑法：bash scripts/tg-auto-sync.test.sh
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$HERE/tg-auto-sync.sh"
MAP_SCRIPT="$HERE/tg-map-chatids.sh"

PASS=0; FAIL=0
ok(){ PASS=$((PASS+1)); echo "ok   - $1"; }
no(){ FAIL=$((FAIL+1)); echo "FAIL - $1"; [ -n "${2:-}" ] && echo "        $2"; }
assert_eq(){ if [ "$2" = "$3" ]; then ok "$1"; else no "$1" "expected[$3] got[$2]"; fi; }
assert_has(){ if printf '%s' "$2" | grep -q "$3"; then ok "$1"; else no "$1" "[$2] missing [$3]"; fi; }
assert_no(){ if printf '%s' "$2" | grep -q "$3"; then no "$1" "[$2] should NOT contain [$3]"; else ok "$1"; fi; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

CSV="$TMP/users.csv"
mkcsv(){ cat > "$CSV" <<'CSVEOF'
notion_user_name,notion_user_id,email,pushed_repos,tg_chat_id
洋蔥,id1,pkh_farus@photons.com.tw,abu,
Dup One,id2,pkh_dup@photons.com.tw,abu,
Dup Two,id3,pkh_dup2@photons.com.tw,abu,
Mapped Guy,id4,pkh_mapped@photons.com.tw,abu,777
CSVEOF
}
cell_of(){ awk -F',' -v e="$1" 'NR>1 && $3==e{print $5}' "$CSV" | tr -d '[:space:]'; }

LOG_JSONL="$TMP/unknown-senders.jsonl"
mklog(){ cat > "$LOG_JSONL" <<'JSONL'
{"ts":"2026-08-21T01:00:00.000Z","chat_id":"111","first_name":"洋蔥","last_name":"","username":"farus422"}
{"ts":"2026-08-21T01:05:00.000Z","chat_id":"222","first_name":"Dup","last_name":"","username":"dupuser"}
{"ts":"2026-08-21T01:06:00.000Z","chat_id":"333","first_name":"Zzz","last_name":"","username":"zzz999"}
JSONL
}

# getUpdates 409 stub：模擬 webhook 掛著時的正常故障
cat > "$TMP/upd409.sh" <<'STUBEOF'
#!/usr/bin/env bash
echo "HTTP Error 409: Conflict" >&2
exit 1
STUBEOF
chmod +x "$TMP/upd409.sh"

# tg-notify.sh stub：不打真實 Telegram API，只把呼叫參數記錄下來
NOTIFY_CALLS="$TMP/notify-calls.txt"
cat > "$TMP/notify-stub.sh" <<STUBEOF
#!/usr/bin/env bash
echo "\$@" >> "$NOTIFY_CALLS"
echo "TG_SENT: stub"
STUBEOF
chmod +x "$TMP/notify-stub.sh"

run_auto_sync(){
  TG_NOTIFY_CSV="$CSV" \
  TG_UNKNOWN_SENDERS_LOG="$LOG_JSONL" \
  TG_GETUPDATES_CMD="$TMP/upd409.sh" \
  TG_MAP_SCRIPT="$MAP_SCRIPT" \
  TG_NOTIFY_SCRIPT="$TMP/notify-stub.sh" \
  TG_AUTO_SYNC_LOG="$TMP/auto-sync.log" \
  TG_AUTO_SYNC_ALERTED_FILE="$TMP/alerted.txt" \
  TG_AUTO_SYNC_LOCK_DIR="$TMP/lock" \
  TG_AUTO_SYNC_OPERATOR_CHAT_ID="999888" \
  bash "$SCRIPT"
}

# ───────────────────────── 第一次跑：HIGH 自動寫入 + ASK 通知維運者 ─────────────────────────
echo "## 第一次跑"
mkcsv; mklog
run_auto_sync

assert_eq  "HIGH（111/洋蔥）自動寫入 CSV"        "$(cell_of pkh_farus@photons.com.tw)" "111"
assert_has "HIGH 有發確認訊息給本人"              "$(cat "$TMP/notify-calls.txt")" "\-\-email pkh_farus@photons.com.tw"
assert_has "確認訊息內容含『連結成功』"            "$(cat "$TMP/notify-calls.txt")" "連結成功"

assert_has "ASK（222）有通知維運者"                "$(cat "$TMP/notify-calls.txt")" "\-\-chat-id 999888"
assert_has "ASK（333）也有通知維運者"              "$(cat "$TMP/notify-calls.txt")" "chat_id=333"
assert_has "operator 通知內容含候選 email"          "$(cat "$TMP/notify-calls.txt")" "pkh_dup@photons.com.tw"
assert_has "alerted 檔案記錄 222"                  "$(cat "$TMP/alerted.txt")" "^222$"
assert_has "alerted 檔案記錄 333"                  "$(cat "$TMP/alerted.txt")" "^333$"

CALLS_AFTER_1ST="$(wc -l < "$TMP/notify-calls.txt" | tr -d '[:space:]')"

# ───────────────────────── 第二次跑：冪等，不重複通知/不重複寫入 ─────────────────────────
echo "## 第二次跑（冪等）"
run_auto_sync

CALLS_AFTER_2ND="$(wc -l < "$TMP/notify-calls.txt" | tr -d '[:space:]')"
assert_eq "已對映（111）不再觸發任何 notify"        "$CALLS_AFTER_2ND" "$CALLS_AFTER_1ST"
assert_eq "第二次跑 CSV 不再變動"                   "$(cell_of pkh_farus@photons.com.tw)" "111"

# ───────────────────────── 鎖：搶不到鎖時直接放棄，不動 CSV ─────────────────────────
echo "## 鎖"
mkcsv; mklog
mkdir -p "$TMP/lock2"
TG_NOTIFY_CSV="$CSV" TG_UNKNOWN_SENDERS_LOG="$LOG_JSONL" TG_GETUPDATES_CMD="$TMP/upd409.sh" \
  TG_MAP_SCRIPT="$MAP_SCRIPT" TG_NOTIFY_SCRIPT="$TMP/notify-stub.sh" \
  TG_AUTO_SYNC_LOG="$TMP/auto-sync2.log" TG_AUTO_SYNC_ALERTED_FILE="$TMP/alerted2.txt" \
  TG_AUTO_SYNC_LOCK_DIR="$TMP/lock2" TG_AUTO_SYNC_OPERATOR_CHAT_ID="999888" \
  bash "$SCRIPT"
assert_has "搶不到鎖時記 SKIP_LOCKED"  "$(cat "$TMP/auto-sync2.log")" "SKIP_LOCKED"
assert_eq  "搶不到鎖時 CSV 不變"        "$(cell_of pkh_farus@photons.com.tw)" ""
rmdir "$TMP/lock2"

# ───────────────────────── summary ─────────────────────────
echo "-----"
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
