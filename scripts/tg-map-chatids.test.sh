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

# 1) 寫空列 → SET_OK，CSV 該列被填
mkcsv
out="$(TG_NOTIFY_CSV="$CSV" bash "$SCRIPT" --set pkh_farus@photons.com.tw 111)"
assert_has "set empty prints SET_OK" "$out" "SET_OK"
assert_eq  "set empty fills cell"    "$(cell_of pkh_farus@photons.com.tw)" "111"

# 2) 已填相同 → SET_NOOP
mkcsv
out="$(TG_NOTIFY_CSV="$CSV" bash "$SCRIPT" --set pkh_mapped@photons.com.tw 777)"
assert_has "set same prints SET_NOOP" "$out" "SET_NOOP"
assert_eq  "set same keeps cell"      "$(cell_of pkh_mapped@photons.com.tw)" "777"

# 3) 已填不同 + 無 --force → SET_CONFLICT，CSV 不變
mkcsv
out="$(TG_NOTIFY_CSV="$CSV" bash "$SCRIPT" --set pkh_mapped@photons.com.tw 888)"
assert_has "set diff no-force prints SET_CONFLICT" "$out" "SET_CONFLICT"
assert_eq  "set diff no-force keeps cell"          "$(cell_of pkh_mapped@photons.com.tw)" "777"

# 4) 已填不同 + --force → SET_OK 覆蓋
mkcsv
out="$(TG_NOTIFY_CSV="$CSV" bash "$SCRIPT" --set pkh_mapped@photons.com.tw 888 --force)"
assert_has "set force prints SET_OK"  "$out" "SET_OK"
assert_eq  "set force overwrites cell" "$(cell_of pkh_mapped@photons.com.tw)" "888"

# 5) email 不存在 → SET_ERR_NO_EMAIL
mkcsv
out="$(TG_NOTIFY_CSV="$CSV" bash "$SCRIPT" --set nobody@photons.com.tw 999)"
assert_has "set unknown email prints SET_ERR_NO_EMAIL" "$out" "SET_ERR_NO_EMAIL"

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
OUT="$(TG_NOTIFY_CSV="$CSV" TG_GETUPDATES_CMD="$TMP/upd.sh" bash "$SCRIPT" --list)"

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

# ───────────────────────── summary ─────────────────────────
echo "-----"
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
