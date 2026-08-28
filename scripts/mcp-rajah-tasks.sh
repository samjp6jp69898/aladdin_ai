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
#
# 多 session 協調（同一台機器開多個 Claude Code session、各自處理不同 rajah 檔案時用）：
#   bash scripts/mcp-rajah-tasks.sh domain-claim <stem> <session_label> [claim_token]   # 宣告「這個 rajah 檔案我在處理」，已被別人宣告會擋下；成功時會印出 CLAIM_TOKEN
#   bash scripts/mcp-rajah-tasks.sh domain-release <stem> <session_label> [claim_token] # 這個檔案的任務全做完/要換人了，釋放宣告（要帶 claim 時拿到的 token）
#   bash scripts/mcp-rajah-tasks.sh domain-status                                        # 印目前所有宣告（誰在處理哪個檔案、何時宣告的、有沒有 token）
#
# 為什麼 claim/release 要帶 claim_token（2026-08-28 事故後新增）：
#   session_label 是各 session 自己取的短代號，沒有任何唯一性保證。實際發生過兩個 session 都取名
#   rajah-worker-dune，結果 (a) claim 的「同 label 視為本人」分支讓後來者直接蓋掉前一個的 claimed_at、
#   (b) release 的持有者檢查（只比對 label 字串）讓其中一個把另一個正在進行中的登記放掉，
#   該 domain 因此被第三個 session 認領，一份工作差點被做兩次。
#   修法：claim 成功時發一個隨機 claim_token 寫進登記並印給呼叫者，release 與「同 label 的再次 claim」
#   都要求 token 相符。**這只防呆、不防惡意**——_domain-claims.json 本來就人人可讀，token 也在裡面；
#   它擋的是「我以為那筆是我的」這種誤判，不是刻意的搶占。
#   向後相容：既有的舊格式登記沒有 claim_token，claim/release 一律照舊放行（並在 claim 時補發 token）。
# 這只是「宣告」不是硬鎖——避免兩個 session 同時挑同一個 rajah 檔案、在 integrate 階段
# 搶改同一個 MCP server 的 index.ts/README.md/const.ts。真正的任務認領仍是 claim（原子性、
# 真的擋得住雙重認領），domain-claim 只是協調用的禮讓機制。
set -u
DIR="${RAJAH_TASKS_DIR:-/Users/user/aladdin/obsidian/mcps/rajah-inventory}"
CLAIMS_FILE="$DIR/_domain-claims.json"
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
    case "$status" in failed|needs_clarification) ;; *) echo "ERROR: 只有 failed/needs_clarification 可以 retry (目前是 ${status})"; exit 1;; esac
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
  domain-claim)
    STEM="${2:?用法: mcp-rajah-tasks.sh domain-claim <stem> <session_label> [claim_token]}"
    LABEL="${3:?缺 session_label}"
    TOKEN="${4:-}"
    [ -f "$DIR/$STEM.json" ] || { echo "ERROR: $DIR/$STEM.json 不存在（stem 打錯？）"; exit 1; }
    with_lock "_domain-claims"
    [ -f "$CLAIMS_FILE" ] || echo '{"claims":[]}' > "$CLAIMS_FILE"
    holder=$(jq -r --arg s "$STEM" '.claims[] | select(.domain == $s) | .session_label' "$CLAIMS_FILE")
    holder_token=$(jq -r --arg s "$STEM" '.claims[] | select(.domain == $s) | .claim_token // ""' "$CLAIMS_FILE")
    if [ -n "$holder" ] && [ "$holder" != "$LABEL" ]; then
        echo "ALREADY_CLAIMED: $STEM 已被 $holder 宣告，先用 domain-status 看狀況或找對方協調"; exit 1
    fi
    # 同 label 的情形要再分辨「是本人重新宣告」還是「兩個 session 剛好取了同一個代號」，
    # 見檔頭「為什麼 claim/release 要帶 claim_token」。舊格式（沒有 claim_token 的既有登記）
    # 一律放行並補發 token，維持向後相容。
    if [ -n "$holder" ] && [ -n "$holder_token" ] && [ "$TOKEN" != "$holder_token" ]; then
        echo "LABEL_COLLISION: ${STEM} 目前的持有者代號跟你一樣是 ${LABEL}，但 claim_token 對不上。"
        echo "  這代表你們是兩個不同的 session 剛好取了同一個代號（不是你自己重新宣告）。"
        echo "  → 若這個 domain 真的是你先前宣告的，把當初 domain-claim 印出來的 token 當第 4 個參數帶上。"
        echo "  → 若不是，請改用一個沒人用過的代號（先跑 domain-status 與 git branch --list 'mcp-rajah/*' 確認）。"
        exit 1
    fi
    NEW_TOKEN="$holder_token"
    [ -z "$NEW_TOKEN" ] && NEW_TOKEN="$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')"
    NOW="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    tmp=$(mktemp)
    jq --arg s "$STEM" --arg label "$LABEL" --arg now "$NOW" --arg tok "$NEW_TOKEN" '
      .claims |= (map(select(.domain != $s)) + [{domain: $s, session_label: $label, claimed_at: $now, claim_token: $tok}])
    ' "$CLAIMS_FILE" > "$tmp" && mv "$tmp" "$CLAIMS_FILE"
    echo "DOMAIN_CLAIMED: $STEM -> $LABEL"
    if [ -n "$holder" ] && [ -z "$holder_token" ]; then
        echo "（這筆是舊格式登記、原本沒有 claim_token，已補發）"
    fi
    echo "CLAIM_TOKEN: $NEW_TOKEN    ← 記住它，domain-release 時要帶上（第 4 個參數）"
    ;;
  domain-release)
    STEM="${2:?用法: mcp-rajah-tasks.sh domain-release <stem> <session_label> [claim_token]}"
    LABEL="${3:?缺 session_label}"
    TOKEN="${4:-}"
    with_lock "_domain-claims"
    [ -f "$CLAIMS_FILE" ] || { echo "NOT_CLAIMED: $STEM"; exit 0; }
    holder=$(jq -r --arg s "$STEM" '.claims[] | select(.domain == $s) | .session_label' "$CLAIMS_FILE")
    holder_token=$(jq -r --arg s "$STEM" '.claims[] | select(.domain == $s) | .claim_token // ""' "$CLAIMS_FILE")
    [ -z "$holder" ] && { echo "NOT_CLAIMED: $STEM"; exit 0; }
    [ "$holder" != "$LABEL" ] && { echo "ERROR: ${STEM} 是 ${holder} 宣告的，不是你 (${LABEL})，不能代放"; exit 1; }
    if [ -n "$holder_token" ] && [ "$TOKEN" != "$holder_token" ]; then
        echo "LABEL_COLLISION: ${STEM} 的持有者代號雖然跟你一樣是 ${LABEL}，但 claim_token 對不上，拒絕釋放。"
        echo "  代號相同不代表是同一個 session——2026-08-28 真的發生過：兩個 session 同時叫 rajah-worker-dune，"
        echo "  其中一個把另一個正在進行中的 domain 登記放掉了（這道檢查就是為了那次事故加的）。"
        echo "  → 真的是你宣告的，就帶上當初 domain-claim 印出的 token（第 4 個參數）。"
        exit 1
    fi
    tmp=$(mktemp)
    jq --arg s "$STEM" '.claims |= map(select(.domain != $s))' "$CLAIMS_FILE" > "$tmp" && mv "$tmp" "$CLAIMS_FILE"
    echo "DOMAIN_RELEASED: $STEM"
    [ -z "$holder_token" ] && echo "（這筆是舊格式登記、沒有 claim_token，僅比對代號就放行；新的 domain-claim 會自動帶 token）"
    ;;
  domain-status)
    [ -f "$CLAIMS_FILE" ] || { echo "（目前沒有任何 domain 宣告）"; exit 0; }
    # 刻意不印出 claim_token 本身，只印有沒有——印出來就等於誰都能複製貼上，那道防線就白做了。
    jq -r '.claims | sort_by(.domain)[] | "\(.domain)\t\(.session_label)\t\(.claimed_at)\ttoken=\(if (.claim_token // "") == "" then "no(舊格式)" else "yes" end)"' "$CLAIMS_FILE"
    ;;
  *)
    echo "用法：mcp-rajah-tasks.sh {next|claim|row|set|set-category|retry|counts|files|reindex|domain-claim|domain-release|domain-status} [args]（詳見檔頭註解）"; exit 1
    ;;
esac
