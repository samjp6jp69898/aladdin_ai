#!/bin/bash
# claim-ticket.sh — /create-mr Step 0.1：認領一張工單（tracker 狀態檢查 + bug-lock + set in_progress）
# 從 create-mr.md 抽出（該檔案這幾行是純機械式判斷，manager 不需要語意理解）。
#
# 用法：bash scripts/claim-ticket.sh <ticket_id>
#
# 判定順序（跟原 create-mr.md Step 0.1 一致）：
#   1. ticket_id 空 → SKIPPED
#   2. tracker.sh row 找不到該行、或狀態不是 pending/rerun → SKIPPED
#   3. bug-lock.sh claim 失敗（已被鎖） → SKIPPED
#   4. tracker.sh set in_progress
#
# 輸出契約：
#   成功（固定 3 行，exit 0）：
#     CLAIMED: <ticket_id>
#     NOTION_URL: <url>
#     PAGE_ID: <uuid>
#   不可認領（單行，exit 1）：
#     SKIPPED: ticket_id required（本版本不支援無參數自動挑單，呼叫端須先用 tracker.sh next 決定單號)
#     SKIPPED: <ticket_id> not claimable
#     SKIPPED: already locked
#
# 呼叫端鐵律：本腳本只做「認領」，不做「釋放」；不論輸出 CLAIMED 或 SKIPPED，
# manager 都要照 create-mr.md Step 8 走完整流程（bug-lock release + tracker 終態 + 完成報告）
# —— 只有 SKIPPED: ticket_id required 這一種例外（連 row 都沒查，尚未進入任何狀態，
# 呼叫端可直接結束，不需要 Step 8）。
set -u
ROOT=/Users/user/aladdin
TRACKER_SH="$ROOT/aladdin_ai/scripts/tracker.sh"
LOCK_SH="$ROOT/aladdin_ai/scripts/bug-lock.sh"

# page_id 正規化，與 notion.sh extract_page_id / resolve-reviewer.sh 同邏輯：
# 已是 UUID 格式就原樣回傳；否則抓 URL 內最後一段 32 位 hex 轉成帶 dash 格式；
# 兩者都不成立就把原始輸入原樣回傳，讓下游 API 自行處理錯誤（不在這裡新增失敗分支）。
extract_page_id() {
  local input="$1"
  if echo "$input" | grep -qE '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'; then
    echo "$input"; return
  fi
  local raw
  raw=$(echo "$input" | grep -oE '[0-9a-f]{32}' | tail -1)
  if [ -n "$raw" ]; then
    echo "${raw:0:8}-${raw:8:4}-${raw:12:4}-${raw:16:4}-${raw:20:12}"
    return
  fi
  echo "$input"
}

TICKET="${1:-}"
if [ -z "$TICKET" ]; then
  echo "SKIPPED: ticket_id required（本版本不支援無參數自動挑單，呼叫端須先用 tracker.sh next 決定單號)"
  exit 1
fi

ROW=$(bash "$TRACKER_SH" row "$TICKET" 2>/dev/null) || { echo "SKIPPED: $TICKET not claimable"; exit 1; }

STATUS=$(printf '%s' "$ROW" | awk -F'|' '{gsub(/^[ \t]+|[ \t]+$/,"",$5); print $5}')
case "$STATUS" in
  pending|rerun) ;;
  *) echo "SKIPPED: $TICKET not claimable"; exit 1;;
esac

NOTION_URL=$(printf '%s' "$ROW" | awk -F'|' '{gsub(/^[ \t]+|[ \t]+$/,"",$3); print $3}')
PAGE_ID=$(extract_page_id "$NOTION_URL")

bash "$LOCK_SH" claim "$TICKET" >/dev/null 2>&1 || { echo "SKIPPED: already locked"; exit 1; }

bash "$TRACKER_SH" set "$TICKET" in_progress >/dev/null 2>&1

echo "CLAIMED: $TICKET"
echo "NOTION_URL: $NOTION_URL"
echo "PAGE_ID: $PAGE_ID"
exit 0
