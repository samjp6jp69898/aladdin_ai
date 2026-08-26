#!/bin/bash
# mcp-tasks.sh — tool-gap-tasks.json 的行級（task 級）操作
#
# tasks.json 由 mcp-tool-gap-scan.ts 產生/累加，記錄「rajah method → 待補 MCP tool」的
# 補齊進度，供跨 session、多 agent 的 workflow 認領/回報用。所有讀寫一律走本腳本（用 jq
# 做 read-modify-write），不要用 Edit tool 直改 JSON——多 agent 併發寫入需要下面的檔級
# 自旋鎖，直接改檔案繞不過這層保護。
#
# 合法狀態：pending in_progress review done failed needs_clarification
#
# 用法：
#   bash scripts/mcp-tasks.sh next                       # 印第一筆 pending task 的 id（找不到印 NO_CLAIMABLE, exit 1）
#   bash scripts/mcp-tasks.sh next "id1,id2"              # 同上，排除清單內的 id（給 batch 跳過已處理/已鎖用）
#   bash scripts/mcp-tasks.sh claim <id> <agent_label>    # 原子性地把 pending -> in_progress + 記錄 claimed_by/claimed_at；
#                                                          #   task 不是 pending 狀態則失敗（防雙重認領）
#   bash scripts/mcp-tasks.sh row <id>                    # 印該 task 完整 JSON
#   bash scripts/mcp-tasks.sh set <id> <狀態> [notes]      # 更新狀態（+ 選填 notes，取代舊值）
#   bash scripts/mcp-tasks.sh set-category <id> <分類>     # 記錄 method-category-checklist.md 判定出的分類
#   bash scripts/mcp-tasks.sh retry <id>                  # failed/needs_clarification -> pending（人工決定重跑）
#   bash scripts/mcp-tasks.sh counts                      # 各狀態統計
set -u
TASKS="${TASKS_FILE:-/Users/user/aladdin/obsidian/mcps/tool-gap-tasks.json}"
LOCKDIR="/tmp/mcp-tasks-locks"
LOCK="$LOCKDIR/.tasks-set-lock"
ACTION="${1:-}"

[ -f "$TASKS" ] || { echo "ERROR: tasks.json 不存在: ${TASKS} (先跑 bun obsidian/scripts/mcp-tool-gap-scan.ts)"; exit 1; }
command -v jq >/dev/null || { echo "ERROR: 需要 jq"; exit 1; }

# 檔級自旋鎖：mkdir 的原子性保證同時只有一個 process 能進臨界區，跟 tracker.sh 同款做法。
with_lock() {
    mkdir -p "$LOCKDIR"
    n=0
    until mkdir "$LOCK" 2>/dev/null; do
        n=$((n+1)); [ "$n" -gt 50 ] && { echo "ERROR: mcp-tasks 鎖等待逾時（$LOCK 疑似殘留，確認無人在寫後可 rmdir）"; exit 1; }
        sleep 0.1
    done
    trap 'rmdir "$LOCK" 2>/dev/null' EXIT
}

case "$ACTION" in
  next)
    EXCLUDE="${2:-}"
    EXCLUDE_JSON=$(printf '%s\n' "$EXCLUDE" | tr ',' '\n' | jq -R . | jq -s '.')
    id=$(jq -r --argjson ex "$EXCLUDE_JSON" '
      [.tasks[] | select(.status == "pending") | select(([.id] | inside($ex)) | not)] | .[0].id // empty
    ' "$TASKS")
    [ -n "$id" ] && echo "$id" || { echo "NO_CLAIMABLE"; exit 1; }
    ;;
  row)
    ID="${2:?用法: mcp-tasks.sh row <id>}"
    row=$(jq -c --arg id "$ID" '.tasks[] | select(.id == $id)' "$TASKS")
    [ -n "$row" ] && echo "$row" | jq '.' || { echo "NOT_FOUND: $ID"; exit 1; }
    ;;
  claim)
    ID="${2:?用法: mcp-tasks.sh claim <id> <agent_label>}"
    LABEL="${3:?缺 agent_label}"
    with_lock
    exists=$(jq --arg id "$ID" '[.tasks[] | select(.id == $id)] | length' "$TASKS")
    [ "$exists" = "0" ] && { echo "NOT_FOUND: $ID"; exit 1; }
    status=$(jq -r --arg id "$ID" '.tasks[] | select(.id == $id) | .status' "$TASKS")
    [ "$status" != "pending" ] && { echo "ALREADY_CLAIMED: $ID (status=$status)"; exit 1; }
    NOW="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    tmp=$(mktemp)
    jq --arg id "$ID" --arg label "$LABEL" --arg now "$NOW" '
      .tasks |= map(if .id == $id then . + {status: "in_progress", claimed_by: $label, claimed_at: $now, updated_at: $now} else . end)
    ' "$TASKS" > "$tmp" && mv "$tmp" "$TASKS"
    echo "CLAIMED: $ID -> in_progress ($LABEL)"
    ;;
  set)
    ID="${2:?用法: mcp-tasks.sh set <id> <狀態> [notes]}"
    ST="${3:?缺狀態}"
    NOTES="${4:-}"
    case "$ST" in pending|in_progress|review|done|failed|needs_clarification) ;; *) echo "ERROR: 非法狀態 $ST"; exit 1;; esac
    with_lock
    exists=$(jq --arg id "$ID" '[.tasks[] | select(.id == $id)] | length' "$TASKS")
    [ "$exists" = "0" ] && { echo "NOT_FOUND: $ID"; exit 1; }
    NOW="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    tmp=$(mktemp)
    jq --arg id "$ID" --arg st "$ST" --arg notes "$NOTES" --arg now "$NOW" '
      .tasks |= map(if .id == $id then . + {status: $st, updated_at: $now} + (if $notes != "" then {notes: $notes} else {} end) else . end)
    ' "$TASKS" > "$tmp" && mv "$tmp" "$TASKS"
    echo "SET: $ID -> $ST"
    ;;
  set-category)
    ID="${2:?用法: mcp-tasks.sh set-category <id> <分類>}"
    CAT="${3:?缺分類}"
    with_lock
    exists=$(jq --arg id "$ID" '[.tasks[] | select(.id == $id)] | length' "$TASKS")
    [ "$exists" = "0" ] && { echo "NOT_FOUND: $ID"; exit 1; }
    NOW="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    tmp=$(mktemp)
    jq --arg id "$ID" --arg cat "$CAT" --arg now "$NOW" '
      .tasks |= map(if .id == $id then . + {category: $cat, updated_at: $now} else . end)
    ' "$TASKS" > "$tmp" && mv "$tmp" "$TASKS"
    echo "CATEGORY: $ID -> $CAT"
    ;;
  retry)
    ID="${2:?用法: mcp-tasks.sh retry <id>}"
    with_lock
    status=$(jq -r --arg id "$ID" '.tasks[] | select(.id == $id) | .status' "$TASKS")
    [ -z "$status" ] && { echo "NOT_FOUND: $ID"; exit 1; }
    case "$status" in failed|needs_clarification) ;; *) echo "ERROR: 只有 failed/needs_clarification 可以 retry (目前是 ${status})"; exit 1;; esac
    NOW="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    tmp=$(mktemp)
    jq --arg id "$ID" --arg now "$NOW" '
      .tasks |= map(if .id == $id then . + {status: "pending", claimed_by: null, claimed_at: null, updated_at: $now} else . end)
    ' "$TASKS" > "$tmp" && mv "$tmp" "$TASKS"
    echo "RETRY: $ID -> pending"
    ;;
  counts)
    jq -r '.tasks | group_by(.status) | map({status: .[0].status, count: length}) | .[] | "\(.status) \(.count)"' "$TASKS"
    ;;
  *)
    echo "用法：mcp-tasks.sh {next|claim|row|set|set-category|retry|counts} [args]（詳見檔頭註解）"; exit 1
    ;;
esac
