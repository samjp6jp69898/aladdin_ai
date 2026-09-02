#!/usr/bin/env bash
# tg-map-chatids.test.sh — 全離線測試（不打 Telegram API、不碰真實 CSV）
# 跑法：bash scripts/tg-map-chatids.test.sh
# 紀律：用 TG_GETUPDATES_CMD stub 掉 getUpdates、用 TG_NOTIFY_CSV 餵 fixture。
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$HERE/tg-map-chatids.sh"

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

# ───────────────────────── --set ─────────────────────────
echo "## --set"

# TG_RESTART_CMD 一律 stub 掉——測試絕不能真的打 launchctl 去重啟正式服務。
# 1) 寫空列 → SET_OK，CSV 該列被填，且嘗試重啟（stub 成功 → RESTART_OK）
mkcsv
out="$(TG_NOTIFY_CSV="$CSV" TG_RESTART_CMD="true" bash "$SCRIPT" --set pkh_farus@photons.com.tw 111)"
assert_has "set empty prints SET_OK" "$out" "SET_OK"
assert_eq  "set empty fills cell"    "$(cell_of pkh_farus@photons.com.tw)" "111"
assert_has "set empty triggers RESTART_OK (stub)" "$out" "RESTART_OK"

# 1b) 重啟 stub 失敗 → SET_OK 仍算成功，但印 RESTART_WARN 不印 RESTART_OK
mkcsv
out="$(TG_NOTIFY_CSV="$CSV" TG_RESTART_CMD="false" bash "$SCRIPT" --set pkh_farus@photons.com.tw 111)"
assert_has "set with failing restart still prints SET_OK" "$out" "SET_OK"
assert_has "set with failing restart prints RESTART_WARN" "$out" "RESTART_WARN"
assert_no  "set with failing restart does not print RESTART_OK" "$out" "RESTART_OK"

# 2) 已填相同 → SET_NOOP（不觸發重啟）
mkcsv
out="$(TG_NOTIFY_CSV="$CSV" TG_RESTART_CMD="true" bash "$SCRIPT" --set pkh_mapped@photons.com.tw 777)"
assert_has "set same prints SET_NOOP" "$out" "SET_NOOP"
assert_eq  "set same keeps cell"      "$(cell_of pkh_mapped@photons.com.tw)" "777"
assert_no  "set same does not restart" "$out" "RESTART"

# 3) 已填不同 + 無 --force → SET_CONFLICT，CSV 不變（不觸發重啟）
mkcsv
out="$(TG_NOTIFY_CSV="$CSV" TG_RESTART_CMD="true" bash "$SCRIPT" --set pkh_mapped@photons.com.tw 888)"
assert_has "set diff no-force prints SET_CONFLICT" "$out" "SET_CONFLICT"
assert_eq  "set diff no-force keeps cell"          "$(cell_of pkh_mapped@photons.com.tw)" "777"
assert_no  "set diff no-force does not restart" "$out" "RESTART"

# 4) 已填不同 + --force → SET_OK 覆蓋，且觸發重啟
mkcsv
out="$(TG_NOTIFY_CSV="$CSV" TG_RESTART_CMD="true" bash "$SCRIPT" --set pkh_mapped@photons.com.tw 888 --force)"
assert_has "set force prints SET_OK"  "$out" "SET_OK"
assert_eq  "set force overwrites cell" "$(cell_of pkh_mapped@photons.com.tw)" "888"
assert_has "set force triggers RESTART_OK (stub)" "$out" "RESTART_OK"

# 5) email 不存在 → SET_ERR_NO_EMAIL（不觸發重啟）
mkcsv
out="$(TG_NOTIFY_CSV="$CSV" TG_RESTART_CMD="true" bash "$SCRIPT" --set nobody@photons.com.tw 999)"
assert_has "set unknown email prints SET_ERR_NO_EMAIL" "$out" "SET_ERR_NO_EMAIL"
assert_no  "set unknown email does not restart" "$out" "RESTART"

# ───────────────────────── --unset ─────────────────────────
echo "## --unset"

# 1) 已有 chat_id → UNSET_OK，欄位清空（不刪除整列）
mkcsv
out="$(TG_NOTIFY_CSV="$CSV" bash "$SCRIPT" --unset pkh_mapped@photons.com.tw)"
assert_has "unset existing prints UNSET_OK" "$out" "UNSET_OK"
assert_eq  "unset existing clears cell"     "$(cell_of pkh_mapped@photons.com.tw)" ""
assert_eq  "unset 不刪列，其他欄位還在"      "$(awk -F',' -v e=pkh_mapped@photons.com.tw 'NR>1 && $3==e{print $1}' "$CSV")" "Mapped Guy"

# 2) 本來就沒有 chat_id → UNSET_NOOP
mkcsv
out="$(TG_NOTIFY_CSV="$CSV" bash "$SCRIPT" --unset pkh_farus@photons.com.tw)"
assert_has "unset empty prints UNSET_NOOP" "$out" "UNSET_NOOP"

# 3) email 不存在 → UNSET_ERR_NO_EMAIL
mkcsv
out="$(TG_NOTIFY_CSV="$CSV" bash "$SCRIPT" --unset nobody@photons.com.tw)"
assert_has "unset unknown email prints UNSET_ERR_NO_EMAIL" "$out" "UNSET_ERR_NO_EMAIL"

# ───────────────────────── registry CLI fail-loud（2026-09-02 委派後新增）─────────────────────────
echo "## registry CLI fail-loud"

# CLI 呼叫本身失敗（bun 不在／腳本炸掉）→ exit 1、印 *_ERR_REGISTRY、CSV 不變、不重啟、不回退舊 awk 路徑
mkcsv
out="$(TG_NOTIFY_CSV="$CSV" TG_RESTART_CMD="true" TG_REGISTRY_CLI="/usr/bin/false" bash "$SCRIPT" --set pkh_farus@photons.com.tw 111 2>&1)"; rc=$?
assert_eq  "set with broken CLI exits 1" "$rc" "1"
assert_has "set with broken CLI prints SET_ERR_REGISTRY" "$out" "SET_ERR_REGISTRY"
assert_eq  "set with broken CLI leaves cell untouched" "$(cell_of pkh_farus@photons.com.tw)" ""
assert_no  "set with broken CLI does not restart" "$out" "RESTART"

mkcsv
out="$(TG_NOTIFY_CSV="$CSV" TG_REGISTRY_CLI="/usr/bin/false" bash "$SCRIPT" --unset pkh_mapped@photons.com.tw 2>&1)"; rc=$?
assert_eq  "unset with broken CLI exits 1" "$rc" "1"
assert_has "unset with broken CLI prints UNSET_ERR_REGISTRY" "$out" "UNSET_ERR_REGISTRY"
assert_eq  "unset with broken CLI keeps cell" "$(cell_of pkh_mapped@photons.com.tw)" "777"

# ───────────────────────── --list ─────────────────────────
echo "## --list"

# getUpdates stub：模擬 4 個私聊 DM（含一個已對映 777、一個非私聊應被忽略）
cat > "$TMP/upd.sh" <<'STUBEOF'
#!/usr/bin/env bash
cat <<'JSON'
{"ok":true,"result":[
 {"update_id":1,"message":{"chat":{"id":111,"type":"private","first_name":"洋蔥","username":"farus422"}}},
 {"update_id":2,"message":{"chat":{"id":222,"type":"private","first_name":"Dup","username":"dupuser"}}},
 {"update_id":3,"message":{"chat":{"id":333,"type":"private","first_name":"Zzz","username":"zzz999"}}},
 {"update_id":4,"message":{"chat":{"id":777,"type":"private","first_name":"Mapped","username":"mapped"}}},
 {"update_id":5,"message":{"chat":{"id":-1009,"type":"group","title":"some group"}}}
]}
JSON
STUBEOF
chmod +x "$TMP/upd.sh"

mkcsv
# TG_UNKNOWN_SENDERS_LOG 指到不存在的檔案：隔離測試，不誤讀真實 production log
OUT="$(TG_NOTIFY_CSV="$CSV" TG_GETUPDATES_CMD="$TMP/upd.sh" TG_UNKNOWN_SENDERS_LOG="$TMP/no-such.jsonl" bash "$SCRIPT" --list)"

line_of(){ printf '%s\n' "$OUT" | awk -F'\t' -v id="$1" '$1==id'; }
field(){ printf '%s' "$1" | awk -F'\t' -v n="$2" '{print $n}'; }

# first_name 完全相同且唯一 → HIGH + 正確 candidate_email
L111="$(line_of 111)"
assert_eq "111 confidence HIGH"      "$(field "$L111" 5)" "HIGH"
assert_eq "111 candidate_email"      "$(field "$L111" 6)" "pkh_farus@photons.com.tw"

# 對到兩列 → ASK
L222="$(line_of 222)"
assert_eq "222 confidence ASK"       "$(field "$L222" 5)" "ASK"
# 來源一律標記 getUpdates
assert_eq "222 source getUpdates"    "$(field "$L222" 2)" "getUpdates"

# 對不到 → ASK
L333="$(line_of 333)"
assert_eq "333 confidence ASK"       "$(field "$L333" 5)" "ASK"

# 已對映 chat_id（777）→ 不出現在輸出（被跳過）
assert_no "mapped 777 skipped"       "$OUT" "777"

# 非私聊（group -1009）→ 被忽略，不出現在輸出
assert_no "group chat ignored"       "$OUT" "1009"

# ── webhook-log 來源（telegram-dispatcher 的未知 sender log）──
echo "## --list（webhook-log 來源）"

# getUpdates 409 stub：模擬 webhook 掛著時的正常故障（不應中止，只警告）
cat > "$TMP/upd409.sh" <<'STUBEOF'
#!/usr/bin/env bash
echo "HTTP Error 409: Conflict" >&2
exit 1
STUBEOF
chmod +x "$TMP/upd409.sh"

cat > "$TMP/unknown-senders.jsonl" <<'JSONL'
{"ts":"2026-08-21T01:00:00.000Z","chat_id":"444","first_name":"洋蔥","last_name":"","username":"farus422"}
{"ts":"2026-08-21T01:05:00.000Z","chat_id":"555","first_name":"Zzz","last_name":"","username":"zzz999"}
JSONL

mkcsv
OUT2="$(TG_NOTIFY_CSV="$CSV" TG_GETUPDATES_CMD="$TMP/upd409.sh" TG_UNKNOWN_SENDERS_LOG="$TMP/unknown-senders.jsonl" bash "$SCRIPT" --list)"
line2_of(){ printf '%s\n' "$OUT2" | awk -F'\t' -v id="$1" '$1==id'; }

# getUpdates 409（webhook 掛著時的正常情況）：不中止，仍能從 webhook-log 拿到結果
L444="$(line2_of 444)"
assert_has "getUpdates 409 不中止，仍有 webhook-log 結果" "$OUT2" "444"
assert_eq  "444 source webhook-log"  "$(field "$L444" 2)" "webhook-log"
assert_eq  "444 confidence HIGH"     "$(field "$L444" 5)" "HIGH"
assert_eq  "444 candidate_email"     "$(field "$L444" 6)" "pkh_farus@photons.com.tw"

L555="$(line2_of 555)"
assert_eq  "555 confidence ASK"      "$(field "$L555" 5)" "ASK"

# ───────────────────────── summary ─────────────────────────
echo "-----"
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
