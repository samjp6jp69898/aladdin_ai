#!/bin/bash
# check-retry-limit.sh — /create-mr 統一重試上限檢查
# 從 create-mr.md 抽出（同一組數字比較散落在 Step 2b/5/6/6.5 四處，改成單一來源）。
#
# 用法：bash scripts/check-retry-limit.sh <tracer_attempt> <fixer_attempt> <total_attempt>
#
# 上限（跟 create-mr.md「重試上限」一致；改上限只改這一份，不要回去改各 Step 的散落判斷）：
#   tracer_attempt ≤ 2 、 fixer_attempt ≤ 5 、 total_attempt ≤ 7
#
# 輸出契約（單行）：
#   OK                              — 全部未超限，exit 0
#   LIMIT_EXCEEDED:<a,b,...>         — 超限項目逗號分隔（tracer/fixer/total 任意組合），exit 1
set -u
TRACER_LIMIT=2
FIXER_LIMIT=5
TOTAL_LIMIT=7

TRACER="${1:?用法: check-retry-limit.sh <tracer_attempt> <fixer_attempt> <total_attempt>}"
FIXER="${2:?缺 fixer_attempt}"
TOTAL="${3:?缺 total_attempt}"

EXCEEDED=""
[ "$TRACER" -gt "$TRACER_LIMIT" ] 2>/dev/null && EXCEEDED="${EXCEEDED}tracer,"
[ "$FIXER" -gt "$FIXER_LIMIT" ] 2>/dev/null && EXCEEDED="${EXCEEDED}fixer,"
[ "$TOTAL" -gt "$TOTAL_LIMIT" ] 2>/dev/null && EXCEEDED="${EXCEEDED}total,"

if [ -n "$EXCEEDED" ]; then
  echo "LIMIT_EXCEEDED:${EXCEEDED%,}"
  exit 1
fi
echo "OK"
exit 0
