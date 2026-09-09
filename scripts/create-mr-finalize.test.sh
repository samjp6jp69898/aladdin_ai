#!/usr/bin/env bash
# create-mr-finalize.sh 離線測試（2026-09-09 改版：tracker 退役後，只驗證 LOCK 行為
# 與三行輸出契約——TRACKER/FAIL_LOG 固定輸出，不再有 tracker.md 狀態可查）。
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$HERE/create-mr-finalize.sh"
LOCK_SH="$HERE/bug-lock.sh"
T=FAQ-999901

fail=0
has() { # $1 output  $2 expected line  $3 name
  if printf '%s\n' "$1" | grep -qxF "$2"; then echo "PASS: $3"; else echo "FAIL: $3 — expected line [$2] in:"; printf '%s\n' "$1" | sed 's/^/    /'; fail=1; fi
}

# 0. 測試前確保沒有殘留鎖
bash "$LOCK_SH" release "$T" >/dev/null 2>&1 || true

# 1. success：有鎖 → RELEASED；TRACKER/FAIL_LOG 固定輸出
bash "$LOCK_SH" claim "$T" >/dev/null
out="$(bash "$SCRIPT" success "$T")"
has "$out" "LOCK: RELEASED" "success 釋放既有鎖"
has "$out" "TRACKER: SKIPPED(tracker 已退役)" "success → tracker 固定輸出"
has "$out" "FAIL_LOG: SKIPPED(tracker 已退役)" "success → fail_log 固定輸出"
bash "$LOCK_SH" status "$T" | grep -q '^FREE' && echo "PASS: 鎖已不存在" || { echo "FAIL: 鎖殘留"; fail=1; }

# 2. failed：無鎖 → NOT_LOCKED；固定輸出不因 --fail-reason 而變
out="$(bash "$SCRIPT" failed "$T" --fail-reason "step5 fixer 超過重試上限")"
has "$out" "LOCK: NOT_LOCKED" "failed 無鎖 no-op"
has "$out" "TRACKER: SKIPPED(tracker 已退役)" "failed → tracker 固定輸出"
has "$out" "FAIL_LOG: SKIPPED(tracker 已退役)" "failed → fail_log 固定輸出（不再寫 pipeline-failures.md）"

# 3. needs_qa_clarification / analysis_done / NOT_TECH / SKIPPED：合法值都是固定輸出
for s in needs_qa_clarification analysis_done NOT_TECH SKIPPED; do
  out="$(bash "$SCRIPT" "$s" "$T")"
  has "$out" "TRACKER: SKIPPED(tracker 已退役)" "$s → tracker 固定輸出"
  has "$out" "FAIL_LOG: SKIPPED(tracker 已退役)" "$s → fail_log 固定輸出"
done

# 4. 非法輸入一律 exit 0 且三行契約齊全
out="$(bash "$SCRIPT" bogus "$T")"; rc=$?
[ $rc -eq 0 ] && echo "PASS: 非法 status exit 0" || { echo "FAIL: exit $rc"; fail=1; }
has "$out" "TRACKER: ERROR(pipeline_status 非法)" "非法 status 契約行"
out="$(bash "$SCRIPT" success "not-a-ticket")"
has "$out" "TRACKER: ERROR(ticket 格式錯誤)" "非法 ticket 契約行"
out="$(bash "$SCRIPT" success "$T" --what)"
has "$out" "TRACKER: ERROR(未知選項 --what)" "未知選項契約行"

[ $fail -eq 0 ] && echo "ALL PASS" || { echo "SOME FAILED"; exit 1; }
