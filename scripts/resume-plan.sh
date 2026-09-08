#!/bin/bash
# resume-plan.sh — /create-mr Step 0.2 的續跑盤點（resume-inventory.sh 的超集）
#
# 用法：bash scripts/resume-plan.sh <ticket_id> [base_branch] [mode]
#   base_branch 預設 main（同 resume-inventory.sh 第二參數）
#   mode ∈ '' | full | analysis | fix | reanalyze（缺省 full；值域外一律當 full）
#
# 輸出契約＝`resume-inventory.sh` 的全部行（**原樣轉印**）再加三行：
#   STAGE_SOURCE:   db|files       這三行的結論是查監控 DB 得到的，還是退回本機檔案系統
#   ARTIFACT_HOST:  <host>|local|unknown   既有分析產物在哪台執行機
#   PRIOR_ANALYSIS: yes|no         可直接餵 create-mr Step 1 的 prior_analysis
#
# 三行各自的判定：
#   STAGE_SOURCE   監控 DB 可讀且這張票有 ticket_stages 紀錄 → db；DB 關閉／連不上／
#                  查無紀錄 → files（此時三行全部退回本機檔案系統的事實）。
#   ARTIFACT_HOST  本機已有 analysis-notes.md → local（產物就在這台，最高優先，
#                  對應 plan §4.3 的 A1）；否則取 DB 的 ticket_artifact_sync.source_host，
#                  再否則取 ticket_stages 裡最新一列的 host；都沒有 → unknown。
#   PRIOR_ANALYSIS mode ∈ {fix, reanalyze} 且既有分析產物存在（本機檔案，或 DB 說
#                  某台機器上 analysis-notes 已 done）→ yes，否則 no。
#
# **RESUME_POINT 一律以本機檔案為準**（原樣沿用 resume-inventory.sh 的判定）：
# DB 知道別台機器做過哪些階段，但那些產物不在這台機器上，照著跳步會跳進空目錄。
# 跨機器把產物搬過來是 Phase 4（親和派工 + rsync）的職責，不是本腳本的。
# 唯一的例外是模式上限：mode ∈ {analysis, reanalyze} 不進 Step 4 之後，
# RESUME_POINT 最深只認到 step2（呼應 create-mr.md Step 0.2）。
#
# DB 連線設定從哪來：查詢 CLI（bun）讀的是 `process.env` 的 MON_DB_*，那份值由
# telegram-dispatcher 的 `.env` 在 **dispatcher server 啟動時**載入，再沿
# spawnDetachedProcess 的 `{...process.env, ...}` 一路繼承到 wrapper → claude -p
# → 本腳本。也就是說：dispatcher 觸發的 run 讀得到 DB；人工在終端機直接跑
# /create-mr 讀不到（環境沒有那些變數）→ 三行退回 files/unknown/no。這是刻意的
# 降級，不是缺陷——人工跑的那台機器本來就是產物所在機。
#
# 退化保證：監控 DB 關閉／不可達，或 mode 沒有觸發上限時，本腳本前段輸出與
# `resume-inventory.sh` **逐位元組相同**，只多出尾端三行。任何 DB 面的失敗都不
# 得讓本腳本非零退出——退回 files/unknown/no 就是正確答案（plan §3：讀取屬決策
# 用，DB 不可達時行為與今日相同）。
set -u
ROOT=/Users/user/aladdin
TICKET="${1:-}"
BASE="${2:-main}"
MODE="${3:-}"
INVENTORY_SH="${RESUME_INVENTORY_SH:-$ROOT/scripts/resume-inventory.sh}"
QUERY_CMD="${RESUME_PLAN_QUERY_CMD:-bun $ROOT/telegram-dispatcher/lib/pipeline-runner/resume-plan-query.ts}"

INV="$(bash "$INVENTORY_SH" "$TICKET" "$BASE" 2>/dev/null)"

# 模式上限：analysis / reanalyze 的 RESUME_POINT 最深降為 step2。
case "$MODE" in
  analysis|reanalyze)
    INV="$(printf '%s\n' "$INV" | sed -E 's/^RESUME_POINT: step[4-7]$/RESUME_POINT: step2/')"
    ;;
esac
printf '%s\n' "$INV"

notes_present() { printf '%s\n' "$INV" | grep -qx 'ANALYSIS_NOTES: present'; }

# ── 監控 DB 查詢（全程 best-effort，任何失敗都退回 files/unknown/no）──
JSON=''
if command -v jq >/dev/null 2>&1; then
  JSON="$($QUERY_CMD "$TICKET" 2>/dev/null | tail -1)"
fi
jqr() { printf '%s' "$JSON" | jq -r "$1" 2>/dev/null; }

STAGE_SOURCE=files
DB_HOST=''
DB_NOTES_DONE=0
if [ -n "$JSON" ] && [ "$(jqr '.available // false')" = true ]; then
  if [ "$(jqr '(.stages // []) | length')" != 0 ]; then
    STAGE_SOURCE=db
    DB_HOST="$(jqr '.artifact_sync.source_host // empty')"
    [ -n "$DB_HOST" ] || DB_HOST="$(jqr '[.stages[]? | select(.finished_at != null)] | sort_by(.finished_at) | map(.host) | last // empty')"
    [ -n "$DB_HOST" ] || DB_HOST="$(jqr '(.stages // []) | map(.host) | last // empty')"
    DB_NOTES_DONE="$(jqr '[.stages[]? | select(.stage == "analysis-notes" and .status == "done")] | length')"
  fi
fi
echo "STAGE_SOURCE: $STAGE_SOURCE"

if notes_present; then
  echo "ARTIFACT_HOST: local"
elif [ -n "$DB_HOST" ]; then
  echo "ARTIFACT_HOST: $DB_HOST"
else
  echo "ARTIFACT_HOST: unknown"
fi

PRIOR=no
case "$MODE" in
  fix|reanalyze)
    if notes_present || [ "${DB_NOTES_DONE:-0}" != 0 ]; then PRIOR=yes; fi
    ;;
esac
echo "PRIOR_ANALYSIS: $PRIOR"
