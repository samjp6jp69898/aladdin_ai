#!/bin/bash
# create-mr-finalize.sh — /create-mr Step 8 的機械部分：釋放 bug-lock + tracker 終態 + 失敗流水帳
# （2026-09-08 從 create-mr.md 抽出，因該檔超過 400 行上限；行為逐字沿用原 Step 8 表格，
#   見 pipeline-modes-project-docs/plan-pipeline-modes-v1.md §5 / Phase 0。完成報告模板仍留在
#   create-mr.md，由 manager 輸出——classify-result.ts 靠報告內的 `- Pipeline status:` 行分類。）
#
# 用法：
#   bash scripts/create-mr-finalize.sh <pipeline_status> <ticket_id> [--fail-reason "<一句失敗原因，含死在哪一步>"]
#   pipeline_status ∈ success | already_fixed | i18n_manual_handoff | failed | needs_qa_clarification
#                   | NOT_TECH（Step 0.5 非技術人員早退）| SKIPPED（Step 0.1 認領失敗早退）
#
# 對應動作（與原 create-mr.md Step 8 表格一致）：
#   一律：bug-lock.sh release <ticket>
#   success / already_fixed / i18n_manual_handoff → tracker.sh set <ticket> done "<now>"
#   failed                                        → tracker.sh set <ticket> failed "<now>" ＋ tracker.sh log-fail <ticket> "<reason>"
#   needs_qa_clarification                        → tracker.sh set <ticket> needs_qa "<now>"
#   NOT_TECH                                      → tracker.sh set <ticket> pending（不填完成時間）
#   SKIPPED                                       → tracker 不動（認領本來就沒成功，該行不是本 run 設的）
#
# 輸出契約（呼叫端行首 grep，不假設順序）：
#   LOCK: RELEASED|NOT_LOCKED|ERROR(<摘要>)
#   TRACKER: SET(<狀態>)|UNCHANGED|ERROR(<摘要>)
#   FAIL_LOG: LOGGED|SKIPPED|ERROR(<摘要>)
# 紀律：一律 exit 0（收尾動作不得再讓 pipeline 失敗）；tracker 寫入失敗不影響已完成的解鎖。
# 環境變數：TRACKER_FILE 原樣透傳給 tracker.sh（測試用暫存副本時設定）。
set -u
ROOT=/Users/user/aladdin
TRACKER_SH="$ROOT/aladdin_ai/scripts/tracker.sh"
LOCK_SH="$ROOT/aladdin_ai/scripts/bug-lock.sh"

STATUS="${1:-}"; TICKET="${2:-}"; shift 2 2>/dev/null || true
REASON=""
while [ $# -gt 0 ]; do
  case "$1" in
    --fail-reason) REASON="${2:-}"; shift 2;;
    *) echo "LOCK: ERROR(未知選項 $1)"; echo "TRACKER: ERROR(未知選項 $1)"; echo "FAIL_LOG: ERROR(未知選項 $1)"; exit 0;;
  esac
done

if [ -z "$TICKET" ] || ! echo "$TICKET" | grep -qE '^FAQ-[0-9]+$'; then
  echo "LOCK: ERROR(ticket 格式錯誤：${TICKET:-空})"; echo "TRACKER: ERROR(ticket 格式錯誤)"; echo "FAIL_LOG: SKIPPED"; exit 0
fi

case "$STATUS" in
  success|already_fixed|i18n_manual_handoff) TR_STATE=done; TR_TIME=1;;
  failed)                                    TR_STATE=failed; TR_TIME=1;;
  needs_qa_clarification)                    TR_STATE=needs_qa; TR_TIME=1;;
  NOT_TECH)                                  TR_STATE=pending; TR_TIME=0;;
  SKIPPED)                                   TR_STATE=""; TR_TIME=0;;
  *) echo "LOCK: ERROR(pipeline_status 非法：${STATUS:-空})"; echo "TRACKER: ERROR(pipeline_status 非法)"; echo "FAIL_LOG: SKIPPED"; exit 0;;
esac

# ---- 1. 解鎖（bug-lock.sh 對未上鎖的票是 no-op，exit 0）----
if OUT=$(bash "$LOCK_SH" release "$TICKET" 2>&1); then
  case "$OUT" in
    RELEASED:*) echo "LOCK: RELEASED";;
    NOT_LOCKED:*) echo "LOCK: NOT_LOCKED";;
    *) echo "LOCK: ERROR($(printf '%s' "$OUT" | head -1 | cut -c1-120))";;
  esac
else
  echo "LOCK: ERROR($(printf '%s' "$OUT" | head -1 | cut -c1-120))"
fi

# ---- 2. tracker 終態 ----
if [ -z "$TR_STATE" ]; then
  echo "TRACKER: UNCHANGED"
else
  if [ "$TR_TIME" = 1 ]; then
    OUT=$(bash "$TRACKER_SH" set "$TICKET" "$TR_STATE" "$(date '+%Y-%m-%d %H%M')" 2>&1)
  else
    OUT=$(bash "$TRACKER_SH" set "$TICKET" "$TR_STATE" 2>&1)
  fi
  if [ $? -eq 0 ] && printf '%s' "$OUT" | grep -q '^SET:'; then
    echo "TRACKER: SET($TR_STATE)"
  else
    echo "TRACKER: ERROR($(printf '%s' "$OUT" | head -1 | cut -c1-120))"
  fi
fi

# ---- 3. 失敗流水帳（僅 failed）----
if [ "$STATUS" = failed ]; then
  if OUT=$(bash "$TRACKER_SH" log-fail "$TICKET" "${REASON:-（未填原因）}" 2>&1) && printf '%s' "$OUT" | grep -q '^LOGGED:'; then
    echo "FAIL_LOG: LOGGED"
  else
    echo "FAIL_LOG: ERROR($(printf '%s' "$OUT" | head -1 | cut -c1-120))"
  fi
else
  echo "FAIL_LOG: SKIPPED"
fi
exit 0
