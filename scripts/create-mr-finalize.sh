#!/bin/bash
# create-mr-finalize.sh — /create-mr Step 8 的機械部分：釋放 bug-lock（+ 固定的 tracker 退役提示行）
# （2026-09-08 從 create-mr.md 抽出，因該檔超過 400 行上限；行為逐字沿用原 Step 8 表格，
#   見 pipeline-modes-project-docs/plan-pipeline-modes-v1.md §5 / Phase 0。完成報告模板仍留在
#   create-mr.md，由 manager 輸出——classify-result.ts 靠報告內的 `- Pipeline status:` 行分類。）
#
# 2026-09-09：tracker.md 退役（使用者核准，紅區：pipeline claim/終態語意變更）——本腳本
# 不再寫 bug_analysis_tracker.md。終態的權威記錄改成 Notion「AI分析」欄位，寫入點在
# Step 7c（create-mr-exit-comment.sh），跟本腳本分開、不受這次改動影響。`TRACKER:`/
# `FAIL_LOG:` 兩行契約保留固定輸出（不是 ERROR，也不再有任何實質動作），純粹是為了讓
# create-mr.md Step 8 的行首 grep 邏輯不用跟著改——這兩行從此永遠是 SKIPPED，manager
# 完成報告的「Finalize:」行看到這兩個固定字串屬於正常現象，不代表退化或錯誤。
# 失敗原因的流水帳（原本另外寫 pipeline-failures.md 的 tracker.sh log-fail）也一併砍掉：
# 失敗原因已經同時寫進 Notion 留言（Step 7c `failed` 出口既有行為），不再需要本機那份
# 重複記錄。
#
# 用法：
#   bash scripts/create-mr-finalize.sh <pipeline_status> <ticket_id> [--fail-reason "<一句失敗原因，含死在哪一步>"]
#   pipeline_status ∈ success | already_fixed | i18n_manual_handoff | failed | needs_qa_clarification | analysis_done
#                   | NOT_TECH（Step 0.5 非技術人員早退）| SKIPPED（Step 0.1 認領失敗早退）
#
# 對應動作：
#   一律：bug-lock.sh release <ticket>
#   TRACKER / FAIL_LOG：一律固定輸出 SKIPPED(tracker 已退役)，不做任何實質動作
#
# 輸出契約（呼叫端行首 grep，不假設順序）：
#   LOCK: RELEASED|NOT_LOCKED|ERROR(<摘要>)
#   TRACKER: SKIPPED(tracker 已退役)
#   FAIL_LOG: SKIPPED(tracker 已退役)
# 紀律：一律 exit 0（收尾動作不得再讓 pipeline 失敗）。
set -u
ROOT=/Users/user/aladdin
LOCK_SH="$ROOT/aladdin_ai/scripts/bug-lock.sh"

STATUS="${1:-}"; TICKET="${2:-}"; shift 2 2>/dev/null || true
while [ $# -gt 0 ]; do
  case "$1" in
    --fail-reason) shift 2;;
    *) echo "LOCK: ERROR(未知選項 $1)"; echo "TRACKER: ERROR(未知選項 $1)"; echo "FAIL_LOG: ERROR(未知選項 $1)"; exit 0;;
  esac
done

if [ -z "$TICKET" ] || ! echo "$TICKET" | grep -qE '^FAQ-[0-9]+$'; then
  echo "LOCK: ERROR(ticket 格式錯誤：${TICKET:-空})"; echo "TRACKER: ERROR(ticket 格式錯誤)"; echo "FAIL_LOG: ERROR(ticket 格式錯誤)"; exit 0
fi

case "$STATUS" in
  success|already_fixed|i18n_manual_handoff|failed|needs_qa_clarification|analysis_done|NOT_TECH|SKIPPED) ;;
  *) echo "LOCK: ERROR(pipeline_status 非法：${STATUS:-空})"; echo "TRACKER: ERROR(pipeline_status 非法)"; echo "FAIL_LOG: ERROR(pipeline_status 非法)"; exit 0;;
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

# ---- 2. tracker 已退役：固定輸出 ----
echo "TRACKER: SKIPPED(tracker 已退役)"

# ---- 3. 失敗流水帳已退役：固定輸出 ----
echo "FAIL_LOG: SKIPPED(tracker 已退役)"
exit 0
