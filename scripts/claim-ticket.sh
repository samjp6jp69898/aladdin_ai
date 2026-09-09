#!/bin/bash
# claim-ticket.sh — /create-mr Step 0.1：認領一張工單（Notion AI分析候選檢查 + bug-lock）
# 從 create-mr.md 抽出（該檔案這幾行是純機械式判斷，manager 不需要語意理解）。
#
# 2026-09-09 改版（使用者核准，紅區：pipeline claim 語意變更）：不再依賴
# bug_analysis_tracker.md 判斷候選、也不再寫 in_progress——候選判斷與
# NOTION_URL/PAGE_ID 一律即時查 Notion。候選值域與判斷邏輯必須跟
# telegram-dispatcher/lib/notion-integration/candidate-tickets.ts 的
# `WANTED_AI_ANALYSIS`（+ `analysis_done` 對應的「問題分析完成，待確認」）保持
# 同步——兩個 repo 各自獨立、無法共用常數，**改一邊要記得改另一邊**。
#
# 用法：
#   bash scripts/claim-ticket.sh <ticket_id>            — 一般新認領，走候選值域檢查
#   bash scripts/claim-ticket.sh <ticket_id> --resume   — resume 續跑（tg-monitor 重試
#                                                          按鈕／timeout 自動重試觸發），
#                                                          跳過候選值域檢查，但仍查 Notion
#                                                          拿 URL/PAGE_ID、仍要 bug-lock 互斥
#
# 判定順序：
#   1. ticket_id 空 → SKIPPED
#   2. Notion 查無此票（單號查不到、或缺 url/id） → SKIPPED
#   3. 非 --resume 且「AI分析」不在候選值域 → SKIPPED
#   4. bug-lock.sh claim 失敗（已被鎖） → SKIPPED
#
# 輸出契約：
#   成功（固定 3 行，exit 0）：
#     CLAIMED: <ticket_id>
#     NOTION_URL: <url>
#     PAGE_ID: <uuid>
#   不可認領（單行，exit 1）：
#     SKIPPED: ticket_id required（本版本不支援無參數自動挑單，呼叫端須先取得單號)
#     SKIPPED: <ticket_id> not claimable
#     SKIPPED: already locked
#
# 呼叫端鐵律：本腳本只做「認領」，不做「釋放」；不論輸出 CLAIMED 或 SKIPPED，
# manager 都要照 create-mr.md Step 8 走完整流程（bug-lock release + 完成報告）
# —— 只有 SKIPPED: ticket_id required 這一種例外（連查詢都沒做，尚未進入任何狀態，
# 呼叫端可直接結束，不需要 Step 8）。
set -u
ROOT=/Users/user/aladdin
LOCK_SH="$ROOT/aladdin_ai/scripts/bug-lock.sh"
NOTION_SH="$ROOT/scripts/notion.sh"
DATA_SOURCE_ID="21c87d78-618a-817f-ae71-000baa9ab11b"

# 候選值域：與 candidate-tickets.ts 的 WANTED_AI_ANALYSIS 五個值 + analysis_done
# 對應的「問題分析完成，待確認」保持同步。
CANDIDATE_VALUES=(
  "一鍵分析＋修復＋開 MR"
  "全部重跑"
  "只做問題分析（不改程式）"
  "產出修復程式碼並開 MR"
  "依留言重新分析（不改程式）"
  "問題分析完成，待確認"
)

TICKET="${1:-}"
RESUME=0
[ "${2:-}" = "--resume" ] && RESUME=1

if [ -z "$TICKET" ]; then
  echo "SKIPPED: ticket_id required（本版本不支援無參數自動挑單，呼叫端須先取得單號)"
  exit 1
fi

command -v jq >/dev/null 2>&1 || { echo "SKIPPED: $TICKET not claimable"; exit 1; }

NUM=$(printf '%s' "$TICKET" | grep -oE '[0-9]+$')
if [ -z "$NUM" ]; then
  echo "SKIPPED: $TICKET not claimable"
  exit 1
fi

FILTER=$(printf '{"property":"單號","unique_id":{"equals":%s}}' "$NUM")
RESP=$(bash "$NOTION_SH" query-datasource "$DATA_SOURCE_ID" "$FILTER" 2>/dev/null)
if [ -z "$RESP" ]; then
  echo "SKIPPED: $TICKET not claimable"
  exit 1
fi

PAGE=$(printf '%s' "$RESP" | jq -c '.results[0] // empty' 2>/dev/null)
if [ -z "$PAGE" ]; then
  echo "SKIPPED: $TICKET not claimable"
  exit 1
fi

NOTION_URL=$(printf '%s' "$PAGE" | jq -r '.url // empty')
PAGE_ID=$(printf '%s' "$PAGE" | jq -r '.id // empty')
AI_ANALYSIS=$(printf '%s' "$PAGE" | jq -r '.properties["AI分析"].select.name // empty')

if [ -z "$NOTION_URL" ] || [ -z "$PAGE_ID" ]; then
  echo "SKIPPED: $TICKET not claimable"
  exit 1
fi

if [ "$RESUME" -ne 1 ]; then
  MATCH=0
  for v in "${CANDIDATE_VALUES[@]}"; do
    if [ "$AI_ANALYSIS" = "$v" ]; then MATCH=1; break; fi
  done
  if [ "$MATCH" -ne 1 ]; then
    echo "SKIPPED: $TICKET not claimable"
    exit 1
  fi
fi

bash "$LOCK_SH" claim "$TICKET" >/dev/null 2>&1 || { echo "SKIPPED: already locked"; exit 1; }

echo "CLAIMED: $TICKET"
echo "NOTION_URL: $NOTION_URL"
echo "PAGE_ID: $PAGE_ID"
exit 0
