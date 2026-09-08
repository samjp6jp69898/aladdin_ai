#!/usr/bin/env bash
# notion-ai-analysis-options.sh 離線測試：用 NOTION_SH_OVERRIDE 指向本檔動態產生的 stub，
# stub 對 get-datasource 回固定 JSON、對 update-datasource 把收到的 properties_json 寫到暫存檔。
# 不打真實 Notion API。
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$HERE/notion-ai-analysis-options.sh"
TMP="$(mktemp -d)"
DS_ID="21c87d78-618a-817f-ae71-000baa9ab11b"
fail=0

has() { # $1 output  $2 expected line  $3 name
  if printf '%s\n' "$1" | grep -qxF "$2"; then echo "PASS: $3"; else echo "FAIL: $3 — expected line [$2] in:"; printf '%s\n' "$1" | sed 's/^/    /'; fail=1; fi
}
hasre() { # $1 output  $2 expected regex (anchored per-line)  $3 name
  if printf '%s\n' "$1" | grep -qE "$2"; then echo "PASS: $3"; else echo "FAIL: $3 — expected /$2/ in:"; printf '%s\n' "$1" | sed 's/^/    /'; fail=1; fi
}

# ---- stub notion.sh：只實作 get-datasource / update-datasource 兩個子命令 ----
STUB="$TMP/notion-stub.sh"
cat > "$STUB" <<'STUBEOF'
#!/bin/bash
case "$1" in
  get-datasource)
    if [ -n "${STUB_GET_AFTER_FILE:-}" ] && [ -s "${STUB_UPDATE_OUT:-/nonexistent-marker}" ]; then
      cat "$STUB_GET_AFTER_FILE"
    else
      cat "$STUB_GET_FILE"
    fi
    ;;
  update-datasource)
    printf '%s' "$3" > "$STUB_UPDATE_OUT"
    echo '{"object":"data_source","id":"stub-ds"}'
    ;;
  *)
    echo "stub: unknown subcommand $1" >&2
    exit 1
    ;;
esac
STUBEOF
chmod +x "$STUB"
export NOTION_SH_OVERRIDE="$STUB"

# ---- fixture: 改動前（9 個既有選項：7 個原樣保留 + 2 個待改名）----
BEFORE="$TMP/before.json"
cat > "$BEFORE" <<EOF
{
  "object": "data_source",
  "properties": {
    "AI分析": {
      "type": "select",
      "select": {
        "options": [
          {"id":"id-notneed","name":"不需分析","color":"gray"},
          {"id":"id-retest","name":"回測完成","color":"purple"},
          {"id":"id-analyzing","name":"分析中","color":"blue"},
          {"id":"id-success","name":"分析成功","color":"green"},
          {"id":"id-failed","name":"分析失敗","color":"red"},
          {"id":"id-plan","name":"待規劃","color":"default"},
          {"id":"id-clarify","name":"待釐清","color":"yellow"},
          {"id":"id-old1","name":"待分析","color":"orange"},
          {"id":"id-old2","name":"需要重跑","color":"pink"}
        ]
      }
    }
  }
}
EOF

# ---- fixture: 改動後（13 個選項：7 保留 id 不變 + 2 改名 id 不變 + 4 新增）----
AFTER="$TMP/after.json"
cat > "$AFTER" <<EOF
{
  "object": "data_source",
  "properties": {
    "AI分析": {
      "type": "select",
      "select": {
        "options": [
          {"id":"id-notneed","name":"不需分析","color":"gray"},
          {"id":"id-retest","name":"回測完成","color":"purple"},
          {"id":"id-analyzing","name":"分析中","color":"blue"},
          {"id":"id-success","name":"分析成功","color":"green"},
          {"id":"id-failed","name":"分析失敗","color":"red"},
          {"id":"id-plan","name":"待規劃","color":"default"},
          {"id":"id-clarify","name":"待釐清","color":"yellow"},
          {"id":"id-old1","name":"一鍵分析＋修復＋開 MR","color":"orange"},
          {"id":"id-old2","name":"全部重跑","color":"pink"},
          {"id":"id-new1","name":"只做問題分析（不改程式）","color":"blue"},
          {"id":"id-new2","name":"問題分析完成，待確認","color":"yellow"},
          {"id":"id-new3","name":"產出修復程式碼並開 MR","color":"green"},
          {"id":"id-new4","name":"依補充留言重新分析（仍不改程式）","color":"orange"}
        ]
      }
    }
  }
}
EOF

# ---- fixture: AI分析 非 select 型 ----
NOTSELECT="$TMP/notselect.json"
cat > "$NOTSELECT" <<EOF
{
  "object": "data_source",
  "properties": {
    "AI分析": {
      "type": "status",
      "status": {"options": []}
    }
  }
}
EOF

# ============================================================
# 1. 初次 dry-run：PLAN 計數 2 rename / 4 add / 7 keep
# ============================================================
export STUB_GET_FILE="$BEFORE"
export STUB_UPDATE_OUT="$TMP/update1.json"
unset STUB_GET_AFTER_FILE
rm -f "$STUB_UPDATE_OUT"
out="$(bash "$SCRIPT" --dry-run --data-source "$DS_ID")"
has "$out" "PLAN: 2 rename / 4 add / 7 keep" "初次 dry-run PLAN 計數"
has "$out" "RESULT: DRY_RUN" "初次 dry-run RESULT"
hasre "$out" '^RENAME id-old1 待分析 → 一鍵分析＋修復＋開 MR$' "diff 行含改名1"
hasre "$out" '^RENAME id-old2 需要重跑 → 全部重跑$' "diff 行含改名2"
hasre "$out" '^ADD 只做問題分析（不改程式）$' "diff 行含新增"
[ -s "$STUB_UPDATE_OUT" ] && { echo "FAIL: dry-run 不該呼叫 update-datasource"; fail=1; } || echo "PASS: dry-run 未送 PATCH"

# ============================================================
# 2. --apply：送出 options 數 = 13，保留項 id 不變，且 read-back OK
# ============================================================
export STUB_GET_FILE="$BEFORE"
export STUB_GET_AFTER_FILE="$AFTER"
export STUB_UPDATE_OUT="$TMP/update2.json"
rm -f "$STUB_UPDATE_OUT"
out="$(bash "$SCRIPT" --apply --data-source "$DS_ID")"
has "$out" "PLAN: 2 rename / 4 add / 7 keep" "apply PLAN 計數"
has "$out" "RESULT: APPLIED" "apply RESULT"
has "$out" "READBACK: OK" "apply read-back OK"
if [ -s "$STUB_UPDATE_OUT" ]; then
  echo "PASS: update-datasource 有被呼叫"
  n=$(python3 -c "import json; print(len(json.load(open('$STUB_UPDATE_OUT'))['AI分析']['select']['options']))")
  [ "$n" = "13" ] && echo "PASS: 送出 options 數 = 13" || { echo "FAIL: 送出 options 數 = $n（應為 13）"; fail=1; }
  keep_ids_ok=$(python3 -c "
import json
opts = json.load(open('$STUB_UPDATE_OUT'))['AI分析']['select']['options']
by_name = {o['name']: o.get('id') for o in opts}
expect = {
  '不需分析': 'id-notneed', '回測完成': 'id-retest', '分析中': 'id-analyzing',
  '分析成功': 'id-success', '分析失敗': 'id-failed', '待規劃': 'id-plan', '待釐清': 'id-clarify',
  '一鍵分析＋修復＋開 MR': 'id-old1', '全部重跑': 'id-old2',
}
ok = all(by_name.get(k) == v for k, v in expect.items())
print('OK' if ok else 'BAD')
")
  [ "$keep_ids_ok" = "OK" ] && echo "PASS: 保留項與改名項 id 皆不變" || { echo "FAIL: 保留項/改名項 id 有變動"; fail=1; }
else
  echo "FAIL: update-datasource 未被呼叫"; fail=1
fi

# ============================================================
# 3. 已改過的 schema 再跑一次 → NOOP（冪等）
# ============================================================
export STUB_GET_FILE="$AFTER"
unset STUB_GET_AFTER_FILE
export STUB_UPDATE_OUT="$TMP/update3.json"
rm -f "$STUB_UPDATE_OUT"
out="$(bash "$SCRIPT" --dry-run --data-source "$DS_ID")"
has "$out" "RESULT: NOOP" "已改過 schema 再跑 dry-run → NOOP"
out2="$(bash "$SCRIPT" --apply --data-source "$DS_ID")"
has "$out2" "RESULT: NOOP" "已改過 schema 再跑 apply → NOOP"
[ -s "$STUB_UPDATE_OUT" ] && { echo "FAIL: NOOP 情況下不該呼叫 update-datasource"; fail=1; } || echo "PASS: NOOP 未送 PATCH"

# ============================================================
# 4. 屬性非 select 型 → BLOCKED
# ============================================================
export STUB_GET_FILE="$NOTSELECT"
export STUB_UPDATE_OUT="$TMP/update4.json"
rm -f "$STUB_UPDATE_OUT"
out="$(bash "$SCRIPT" --dry-run --data-source "$DS_ID")"; rc=$?
hasre "$out" '^RESULT: BLOCKED\(AI分析 不是 select 型' "非 select 型 → BLOCKED"
[ $rc -eq 1 ] && echo "PASS: 非 select 型 exit 1" || { echo "FAIL: exit $rc（應為 1）"; fail=1; }

rm -rf "$TMP"
[ $fail -eq 0 ] && echo "ALL PASS" || { echo "SOME FAILED"; exit 1; }
