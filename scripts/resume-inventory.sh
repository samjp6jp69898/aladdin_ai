#!/bin/bash
# resume-inventory.sh — /create-mr resume 模式的確定性盤點（2026-08-26 使用者核准的續跑語意）
#
# 用法：bash scripts/resume-inventory.sh <ticket_id> [base_branch]
#   base_branch 預設 main（2026-09-01 起可帶技術人員指定的分支，如 feature/20260815——
#   BRANCH_COMMITS 的計數基準必須跟 worktree 分支點一致，否則 feature 分支領先 main 的
#   commit 會被誤算成「fixer 已 commit」，RESUME_POINT 錯跳到 step5/6/7）
#
# 依三類既有事實算出建議的續跑起點（本腳本**唯讀**，不改任何狀態）：
#   1. obsidian/Debug/{ticket}/ 的分析產物存在與否（跨 run 持久，不會被 cleanup 清掉）
#   2. 三份 review 報告檔尾的 `REVIEW_RESULT:` 結論（reviewer 定義檔規定的固定契約行）
#   3. 各主 repo `mr/{ticket}` 分支是否存在、是否有領先 origin/<base_branch> 的 commit
#      （worktree 每輪結束會被 cleanup-worktree.ts 清掉，但分支保留——fixer 的
#      commit 都在分支上，這是「fixer 是否已完成過」唯一可靠的旁證）
#
# 輸出契約（呼叫端行首 grep，不假設順序）：
#   ANALYTICS: present|missing          SPEC: present|missing
#   GROUNDING: present|missing          ANALYSIS_NOTES: present|missing
#   REVIEW_A: PASSED|FAILED|missing     （A=reviewer-report，B=adversarial-review，C=tdd-fidelity-review）
#   REVIEW_B: ...                       REVIEW_C: ...
#   BRANCH_COMMITS: <repo>=<n> ...|none （只列分支存在的 repo；n = origin/<base_branch>..mr/{ticket} commit 數）
#   RESUME_POINT: step1|step2|step4|step5|step6|step7
#
# RESUME_POINT 判定（由淺入深，第一個命中即定；矛盾時保守回退——寧可多跑一步，不可錯跳）：
#   step1  analytics 缺 → 整張全跑
#   step2  grounding 或 analysis-notes 缺 → 跳過 Step 1，只補派缺的那位
#   step4  沒有任何 repo 的 mr/ 分支帶 commit → 照常重建環境 + fixer
#   step5  分支有 commit，但有任一 review 結論 FAILED → keep-branch 重建環境，fixer 帶回饋重做
#   step6  分支有 commit，review 報告不全（無 FAILED）→ keep-branch 重建環境，直接三重審查
#   step7  分支有 commit，三份 review 皆 PASSED → keep-branch 重建環境，直接出口動作（Solution 彙整起）
set -u
ROOT=/Users/user/aladdin
TICKET="${1:-}"
BASE="${2:-main}"
echo "$TICKET" | grep -qE '^(FAQ|ALDREQ)-[0-9]+$' || { echo "ERROR: ticket 格式錯誤（收到 ${TICKET} ）"; echo "RESUME_POINT: step1"; exit 1; }
echo "$BASE" | grep -qE '^[A-Za-z0-9][A-Za-z0-9._/-]*$' || { echo "ERROR: base_branch 不合法（收到 ${BASE} ）"; echo "RESUME_POINT: step1"; exit 1; }
DIR=$ROOT/obsidian/Debug/$TICKET

have() { [ -s "$DIR/$TICKET-$1" ] && echo present || echo missing; }
ANALYTICS=$(have analytics.md)
SPEC=$(have spec.md)
GROUNDING=$(have grounding.md)
NOTES=$(have analysis-notes.md)
echo "ANALYTICS: $ANALYTICS"
echo "SPEC: $SPEC"
echo "GROUNDING: $GROUNDING"
echo "ANALYSIS_NOTES: $NOTES"

# 取報告檔最後一個行首 REVIEW_RESULT:（報告每輪重寫，最後一個即最新一輪結論）；
# 檔案缺、或值不在 {PASSED, FAILED} → missing（保守當作「沒審過」）。
verdict() {
  local f="$DIR/$TICKET-$1" v
  [ -s "$f" ] || { echo missing; return; }
  v=$(grep -E '^REVIEW_RESULT:' "$f" | tail -1 | awk '{print $2}')
  case "$v" in PASSED|FAILED) echo "$v";; *) echo missing;; esac
}
RA=$(verdict reviewer-report.md)
RB=$(verdict adversarial-review.md)
RC=$(verdict tdd-fidelity-review.md)
echo "REVIEW_A: $RA"
echo "REVIEW_B: $RB"
echo "REVIEW_C: $RC"

BRANCHES=""
HAS_COMMITS=0
for repo in agrabah abu lago rajah; do
  git -C "$ROOT/$repo" show-ref --verify --quiet "refs/heads/mr/$TICKET" 2>/dev/null || continue
  n=$(git -C "$ROOT/$repo" rev-list --count "origin/$BASE..mr/$TICKET" 2>/dev/null || echo 0)
  BRANCHES="$BRANCHES $repo=$n"
  [ "$n" -gt 0 ] 2>/dev/null && HAS_COMMITS=1
done
echo "BRANCH_COMMITS:${BRANCHES:- none}"

if [ "$ANALYTICS" = missing ]; then POINT=step1
elif [ "$GROUNDING" = missing ] || [ "$NOTES" = missing ]; then POINT=step2
elif [ "$HAS_COMMITS" = 0 ]; then POINT=step4
elif [ "$RA" = FAILED ] || [ "$RB" = FAILED ] || [ "$RC" = FAILED ]; then POINT=step5
elif [ "$RA" = PASSED ] && [ "$RB" = PASSED ] && [ "$RC" = PASSED ]; then POINT=step7
else POINT=step6
fi
echo "RESUME_POINT: $POINT"
