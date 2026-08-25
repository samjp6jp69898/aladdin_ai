#!/bin/bash
# mcp-rajah-tasks.sh — obsidian/mcps/rajah-inventory/<rajah檔案 stem>.json（101 個檔案、跨全 rajah
# 表面的落差清單）的跨檔認領/操作工具，介面對齊 mcp-tasks.sh（單一 tool-gap-tasks.json 版），
# 但這裡的資料分散在 101 個檔案裡，操作前要先從 id 反推出該去哪個檔案。
#
# id 格式是 mcp-rajah-tasks-gen.ts 產生的 `<rajah檔案 stem>__<Service>__<Method>`（雙底線分隔，
# rajah 檔名只用單底線、service/method 是不含底線的 PascalCase，所以「取第一個 `__` 之前」
# 保證精確還原 stem，不會誤切）。所有讀寫一律走本腳本，不要用 Edit tool 直改 JSON——多 agent
# 併發寫入需要下面的檔級自旋鎖（鎖是「每個 rajah 檔案各自一把」，不同檔案的操作不會互相卡住，
# 同一個檔案的併發操作會排隊，跟 mcp-tasks.sh 同款做法）。
#
# 合法狀態：pending in_progress review done failed needs_clarification
#
# 用法：
#   bash scripts/mcp-rajah-tasks.sh next                          # 印第一筆 pending 的 id（跨全部 101 檔，按檔名排序）
#   bash scripts/mcp-rajah-tasks.sh next "id1,id2"                # 同上，排除清單內的 id
#   bash scripts/mcp-rajah-tasks.sh next --file=game_back_office  # 只在指定 rajah 檔案（stem，不含 .rajah）裡找
#   bash scripts/mcp-rajah-tasks.sh claim <id> <agent_label>      # pending -> in_progress（原子性，防雙重認領）
#   bash scripts/mcp-rajah-tasks.sh row <id>                      # 印該 task 完整 JSON
#   bash scripts/mcp-rajah-tasks.sh set <id> <狀態> [notes]        # 更新狀態（+ 選填 notes，取代舊值）
#   bash scripts/mcp-rajah-tasks.sh set-category <id> <分類>       # 記錄 method-category-checklist.md 判定出的分類
#   bash scripts/mcp-rajah-tasks.sh retry <id>                    # failed/needs_clarification -> pending
#   bash scripts/mcp-rajah-tasks.sh counts                        # 全部 101 檔彙總的各狀態統計（即時掃描，不吃快取）
#   bash scripts/mcp-rajah-tasks.sh files                         # 每個 rajah 檔案各自的任務數/狀態統計
#   bash scripts/mcp-rajah-tasks.sh reindex                       # 重建 mcps/rajah-inventory/_index.json（給人看全貌用，非操作必要）
set -u
DIR="${RAJAH_TASKS_DIR:-/Users/user/aladdin/obsidian/mcps/rajah-inventory}"
LOCKROOT="/tmp/mcp-rajah-tasks-locks"
ACTION="${1:-}"

[ -d "$DIR" ] || { echo "ERROR: $DIR 不存在（先跑 bun obsidian/scripts/mcp-rajah-tasks-gen.ts）"; exit 1; }
command -v jq >/dev/null || { echo "ERROR: 需要 jq"; exit 1; }

# 從 id 反推 stem（第一個 `__` 之前），回傳對應的檔案路徑；檔案不存在就直接報錯，
# 不要求呼叫端自己先猜檔名。
file_for_id() {
    local id="$1" stem file
    stem="${id%%__*}"
    file="$DIR/$stem.json"
    [ -f "$file" ] || { echo "ERROR: 從 id 反推出的檔案不存在：${file} (id 格式可能不對: ${id})" >&2; return 1; }
    echo "$file"
}

with_lock() {
    local stem="$1" lock
    lock="$LOCKROOT/.lock-$stem"
    mkdir -p "$LOCKROOT"
    local n=0
    until mkdir "$lock" 2>/dev/null; do
        n=$((n+1)); [ "$n" -gt 50 ] && { echo "ERROR: $stem 鎖等待逾時（$lock 疑似殘留，確認無人在寫後可 rmdir）" >&2; exit 1; }
        sleep 0.1
    done
    trap "rmdir '$lock' 2>/dev/null" EXIT
}

case "$ACTION" in
  next)
    EXCLUDE="" ; ONLY_FILE=""
    for arg in "${@:2}"; do
        case "$arg" in
            --file=*) ONLY_FILE="${arg#--file=}" ;;
            *) EXCLUDE="$arg" ;;
        esac
    done
    EXCLUDE_JSON=$(printf '%s\n' "$EXCLUDE" | tr ',' '\n' | jq -R . | jq -s '.')
    if [ -n "$ONLY_FILE" ]; then
        FILES="$DIR/$ONLY_FILE.json"
        [ -f "$FILES" ] || { echo "ERROR: $FILES 不存在"; exit 1; }
    else
        FILES=$(ls "$DIR"/*.json | grep -v '/_index.json$' | sort)
    fi
    id=""
    for f in $FILES; do
        id=$(jq -r --argjson ex "$EXCLUDE_JSON" '
          [.tasks[] | select(.status == "pending") | select(([.id] | inside($ex)) | not)] | .[0].id // empty
        ' "$f")
        [ -n "$id" ] && break
    done
    [ -n "$id" ] && echo "$id" || { echo "NO_CLAIMABLE"; exit 1; }
    ;;
  row)
    ID="${2:?用法: mcp-rajah-tasks.sh row <id>}"
    F=$(file_for_id "$ID") || exit 1
    row=$(jq -c --arg id "$ID" '.tasks[] | select(.id == $id)' "$F")
    [ -n "$row" ] && echo "$row" | jq '.' || { echo "NOT_FOUND: $ID"; exit 1; }
    ;;
  claim)
    ID="${2:?用法: mcp-rajah-tasks.sh claim <id> <agent_label>}"
    LABEL="${3:?缺 agent_label}"
    F=$(file_for_id "$ID") || exit 1
    STEM="${ID%%__*}"
    with_lock "$STEM"
    exists=$(jq --arg id "$ID" '[.tasks[] | select(.id == $id)] | length' "$F")
    [ "$exists" = "0" ] && { echo "NOT_FOUND: $ID"; exit 1; }
    status=$(jq -r --arg id "$ID" '.tasks[] | select(.id == $id) | .status' "$F")
    [ "$status" != "pending" ] && { echo "ALREADY_CLAIMED: $ID (status=$status)"; exit 1; }
    NOW="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    tmp=$(mktemp)
    jq --arg id "$ID" --arg label "$LABEL" --arg now "$NOW" '
      .tasks |= map(if .id == $id then . + {status: "in_progress", claimed_by: $label, claimed_at: $now, updated_at: $now} else . end)
    ' "$F" > "$tmp" && mv "$tmp" "$F"
    echo "CLAIMED: $ID -> in_progress ($LABEL)"
    ;;
  set)
    ID="${2:?用法: mcp-rajah-tasks.sh set <id> <狀態> [notes]}"
    ST="${3:?缺狀態}"
    NOTES="${4:-}"
    case "$ST" in pending|in_progress|review|done|failed|needs_clarification) ;; *) echo "ERROR: 非法狀態 $ST"; exit 1;; esac
    F=$(file_for_id "$ID") || exit 1
    STEM="${ID%%__*}"
    with_lock "$STEM"
    exists=$(jq --arg id "$ID" '[.tasks[] | select(.id == $id)] | length' "$F")
    [ "$exists" = "0" ] && { echo "NOT_FOUND: $ID"; exit 1; }
    NOW="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    tmp=$(mktemp)
    jq --arg id "$ID" --arg st "$ST" --arg notes "$NOTES" --arg now "$NOW" '
      .tasks |= map(if .id == $id then . + {status: $st, updated_at: $now} + (if $notes != "" then {notes: $notes} else {} end) else . end)
    ' "$F" > "$tmp" && mv "$tmp" "$F"
    echo "SET: $ID -> $ST"
    ;;
  set-category)
    ID="${2:?用法: mcp-rajah-tasks.sh set-category <id> <分類>}"
    CAT="${3:?缺分類}"
    F=$(file_for_id "$ID") || exit 1
    STEM="${ID%%__*}"
    with_lock "$STEM"
    exists=$(jq --arg id "$ID" '[.tasks[] | select(.id == $id)] | length' "$F")
    [ "$exists" = "0" ] && { echo "NOT_FOUND: $ID"; exit 1; }
    NOW="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    tmp=$(mktemp)
    jq --arg id "$ID" --arg cat "$CAT" --arg now "$NOW" '
      .tasks |= map(if .id == $id then . + {category: $cat, updated_at: $now} else . end)
    ' "$F" > "$tmp" && mv "$tmp" "$F"
    echo "CATEGORY: $ID -> $CAT"
    ;;
  retry)
    ID="${2:?用法: mcp-rajah-tasks.sh retry <id>}"
    F=$(file_for_id "$ID") || exit 1
    STEM="${ID%%__*}"
    with_lock "$STEM"
    status=$(jq -r --arg id "$ID" '.tasks[] | select(.id == $id) | .status' "$F")
    [ -z "$status" ] && { echo "NOT_FOUND: $ID"; exit 1; }
    case "$status" in failed|needs_clarification) ;; *) echo "ERROR: 只有 failed/needs_clarification 可以 retry（目前是 $status）"; exit 1;; esac
    NOW="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    tmp=$(mktemp)
    jq --arg id "$ID" --arg now "$NOW" '
      .tasks |= map(if .id == $id then . + {status: "pending", claimed_by: null, claimed_at: null, updated_at: $now} else . end)
    ' "$F" > "$tmp" && mv "$tmp" "$F"
    echo "RETRY: $ID -> pending"
    ;;
  counts)
    jq -s '[.[].tasks[]] | group_by(.status) | map({status: .[0].status, count: length}) | .[] | "\(.status) \(.count)"' -r \
      $(ls "$DIR"/*.json | grep -v '/_index.json$')
    ;;
  files)
    for f in $(ls "$DIR"/*.json | grep -v '/_index.json$' | sort); do
        jq -r --arg f "$(basename "$f" .json)" '
          "\($f)\t" + (.tasks | length | tostring) + "\t" +
          ([.tasks[] | .status] | group_by(.) | map("\(.[0])=\(length)") | join(" "))
        ' "$f"
    done
    ;;
  reindex)
    bun /Users/user/aladdin/obsidian/scripts/mcp-rajah-tasks-build-index.ts
    ;;
  *)
    echo "用法：mcp-rajah-tasks.sh {next|claim|row|set|set-category|retry|counts|files|reindex} [args]（詳見檔頭註解）"; exit 1
    ;;
esac
