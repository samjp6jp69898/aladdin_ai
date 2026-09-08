#!/usr/bin/env bash
# create-mr-finalize.sh 離線測試：tracker 用暫存副本（TRACKER_FILE），bug-lock 用不存在的高號 ticket。
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$HERE/create-mr-finalize.sh"
LOCK_SH="$HERE/bug-lock.sh"
TMP="$(mktemp -d)"
export TRACKER_FILE="$TMP/tracker.md"
T=FAQ-999901
cat > "$TRACKER_FILE" <<EOF
| 單號 | Notion | 嚴重性 | 狀態 | 加入 | 完成 |
|---|---|---|---|---|---|
| $T | https://www.notion.so/x | P2 | in_progress | 2026-09-08 |  |
EOF

fail=0
has() { # $1 output  $2 expected line  $3 name
  if printf '%s\n' "$1" | grep -qxF "$2"; then echo "PASS: $3"; else echo "FAIL: $3 — expected line [$2] in:"; printf '%s\n' "$1" | sed 's/^/    /'; fail=1; fi
}
status_of() { bash "$HERE/tracker.sh" row "$T" | awk -F'|' '{gsub(/ /,"",$5); print $5}'; }

# 1. success：有鎖 → RELEASED、tracker done 帶時間
bash "$LOCK_SH" claim "$T" >/dev/null
out="$(bash "$SCRIPT" success "$T")"
has "$out" "LOCK: RELEASED" "success 釋放既有鎖"
has "$out" "TRACKER: SET(done)" "success → done"
has "$out" "FAIL_LOG: SKIPPED" "success 不記 fail log"
[ "$(status_of)" = done ] && echo "PASS: tracker 實際為 done" || { echo "FAIL: tracker 狀態 $(status_of)"; fail=1; }
bash "$HERE/tracker.sh" row "$T" | grep -qE '\| [0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{4} \|$' && echo "PASS: done 帶完成時間" || { echo "FAIL: 完成時間缺"; fail=1; }
bash "$LOCK_SH" status "$T" | grep -q '^FREE' && echo "PASS: 鎖已不存在" || { echo "FAIL: 鎖殘留"; fail=1; }

# 2. failed：無鎖 → NOT_LOCKED、tracker failed、log-fail 寫入
out="$(bash "$SCRIPT" failed "$T" --fail-reason "step5 fixer 超過重試上限")"
has "$out" "LOCK: NOT_LOCKED" "failed 無鎖 no-op"
has "$out" "TRACKER: SET(failed)" "failed → failed"
has "$out" "FAIL_LOG: LOGGED" "failed 記 fail log"
grep -q "$T | step5 fixer 超過重試上限" "$TMP/pipeline-failures.md" && echo "PASS: fail log 內容" || { echo "FAIL: fail log 內容"; fail=1; }

# 3. needs_qa_clarification
out="$(bash "$SCRIPT" needs_qa_clarification "$T")"
has "$out" "TRACKER: SET(needs_qa)" "needs_qa_clarification → needs_qa"
has "$out" "FAIL_LOG: SKIPPED" "needs_qa 不記 fail log"

# 3b. analysis_done（pipeline-modes Phase 2）：暫停態，帶完成時間，不記 fail log
out="$(bash "$SCRIPT" analysis_done "$T")"
has "$out" "TRACKER: SET(analysis_done)" "analysis_done → analysis_done"
has "$out" "FAIL_LOG: SKIPPED" "analysis_done 不記 fail log"
[ "$(status_of)" = analysis_done ] && echo "PASS: tracker 實際為 analysis_done" || { echo "FAIL: tracker 狀態 $(status_of)"; fail=1; }

# 4. NOT_TECH：回 pending，不填完成時間（沿用上一步的時間欄不變）
before="$(bash "$HERE/tracker.sh" row "$T" | awk -F'|' '{print $7}')"
out="$(bash "$SCRIPT" NOT_TECH "$T")"
has "$out" "TRACKER: SET(pending)" "NOT_TECH → pending"
after="$(bash "$HERE/tracker.sh" row "$T" | awk -F'|' '{print $7}')"
[ "$before" = "$after" ] && echo "PASS: NOT_TECH 不動完成時間" || { echo "FAIL: NOT_TECH 改了完成時間 [$before]→[$after]"; fail=1; }

# 5. SKIPPED：tracker 不動
out="$(bash "$SCRIPT" SKIPPED "$T")"
has "$out" "TRACKER: UNCHANGED" "SKIPPED 不動 tracker"
[ "$(status_of)" = pending ] && echo "PASS: SKIPPED 後狀態仍 pending" || { echo "FAIL: SKIPPED 改了狀態"; fail=1; }

# 6. 非法輸入一律 exit 0 且三行契約齊全
out="$(bash "$SCRIPT" bogus "$T")"; rc=$?
[ $rc -eq 0 ] && echo "PASS: 非法 status exit 0" || { echo "FAIL: exit $rc"; fail=1; }
has "$out" "TRACKER: ERROR(pipeline_status 非法)" "非法 status 契約行"
out="$(bash "$SCRIPT" success "not-a-ticket")"
has "$out" "TRACKER: ERROR(ticket 格式錯誤)" "非法 ticket 契約行"
out="$(bash "$SCRIPT" success "$T" --what)"
has "$out" "TRACKER: ERROR(未知選項 --what)" "未知選項契約行"

# 7. tracker 查無此單 → TRACKER: ERROR，其餘照常
out="$(bash "$SCRIPT" success FAQ-999902)"
has "$out" "LOCK: NOT_LOCKED" "查無此單仍解鎖 no-op"
printf '%s\n' "$out" | grep -q '^TRACKER: ERROR(NOT_FOUND' && echo "PASS: 查無此單 TRACKER ERROR" || { echo "FAIL: 查無此單未回 ERROR"; fail=1; }

rm -rf "$TMP"
[ $fail -eq 0 ] && echo "ALL PASS" || { echo "SOME FAILED"; exit 1; }
