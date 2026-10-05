#!/bin/bash
# Notion 頁面內文寫入 CLI（給既有頁面改標題／補內文 blocks；跟 notion.sh 共用同一把 token）
# Usage:
#   notion-page-write.sh update-title <page_id_or_url> <title_text>            - 改頁面標題
#   notion-page-write.sh append-blocks <page_id_or_url> <blocks_json_file> [after_block_id] - 從檔案讀 blocks JSON 陣列，分批（每批<=100）附加到頁面內文尾端；帶 after_block_id 時插在該 block 之後（parent 也可以是表格等 block）
#   notion-page-write.sh clear-children <page_id_or_url>                      - 移除頁面目前所有直屬子區塊（Notion 端會進垃圾桶，非永久刪除）
#   notion-page-write.sh update-block <block_id> <block_json_file>            - 從檔案讀 block 型別物件，修改單一 block（段落、程式碼、表格列等）
#   notion-page-write.sh delete-block <block_id>                              - 刪除單一 block（Notion 端會進垃圾桶，非永久刪除）

# token 單一來源：/Users/user/aladdin/aladdin_ai/.env.local 的 ALD_NOTION_TOKEN（或已 export 的同名環境變數）。
# 禁止把明文 token 寫回本檔或任何 prompt/文件——輪替 token 時只需改 .env 一處。
NOTION_TOKEN="${ALD_NOTION_TOKEN:-$(grep -m1 '^ALD_NOTION_TOKEN=' /Users/user/aladdin/aladdin_ai/.env.local 2>/dev/null | cut -d= -f2- | tr -d '"' | tr -d "'")}"
case "$NOTION_TOKEN" in
    ntn_*) ;;
    *) echo "ERROR: ALD_NOTION_TOKEN 未設定——請在 /Users/user/aladdin/aladdin_ai/.env.local 加一行 ALD_NOTION_TOKEN=ntn_xxx（或 export 環境變數）" >&2; exit 1;;
esac
NOTION_API="https://api.notion.com/v1"
NOTION_VERSION="2025-09-03"

# 從 Notion URL 提取 page_id（支援多種格式；與 notion.sh 相同邏輯）
extract_page_id() {
    local input="$1"
    if echo "$input" | grep -qE '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'; then
        echo "$input"
        return
    fi
    local raw_id
    raw_id=$(echo "$input" | grep -oE '[0-9a-f]{32}' | tail -1)
    if [ -n "$raw_id" ]; then
        echo "${raw_id:0:8}-${raw_id:8:4}-${raw_id:12:4}-${raw_id:16:4}-${raw_id:20:12}"
        return
    fi
    echo "$input"
}

case "$1" in
    update-title)
        PAGE_ID=$(extract_page_id "$2")
        TITLE_TEXT="$3"
        if [ -z "$PAGE_ID" ] || [ -z "$TITLE_TEXT" ]; then
            echo "Usage: notion-page-write.sh update-title <page_id_or_url> <title_text>"
            exit 1
        fi
        BODY=$(python3 -c "
import json, sys
print(json.dumps({'properties': {'title': {'title': [{'type': 'text', 'text': {'content': sys.argv[1]}}]}}}))
" "$TITLE_TEXT")
        RESULT=$(curl -s -X PATCH "${NOTION_API}/pages/${PAGE_ID}" \
            -H "Authorization: Bearer ${NOTION_TOKEN}" \
            -H "Notion-Version: ${NOTION_VERSION}" \
            -H "Content-Type: application/json" \
            -d "$BODY")
        [ -z "$RESULT" ] && { echo "ERROR: Notion API 空回應（網路失敗？）"; exit 1; }
        echo "$RESULT"
        ERROR=$(echo "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('object',''))" 2>/dev/null)
        if [ "$ERROR" = "error" ]; then
            exit 1
        fi
        ;;

    append-blocks)
        PAGE_ID=$(extract_page_id "$2")
        BLOCKS_FILE="$3"
        # 選填：插在這個 block 之後（須為 PAGE_ID 的直屬子 block）；不帶時接在尾端，與原行為相同
        AFTER_ID=""
        [ -n "$4" ] && AFTER_ID=$(extract_page_id "$4")
        if [ -z "$PAGE_ID" ] || [ -z "$BLOCKS_FILE" ] || [ ! -f "$BLOCKS_FILE" ]; then
            echo "Usage: notion-page-write.sh append-blocks <page_id_or_url> <blocks_json_file> [after_block_id]"
            exit 1
        fi
        CHUNK_COUNT=$(python3 -c "
import json
blocks = json.load(open('$BLOCKS_FILE'))
print((len(blocks) + 99) // 100)
")
        # 指定位置插入只支援單批：多批時後一批的插入點要取前一批新 block 的 id，容易錯，直接擋下
        if [ -n "$AFTER_ID" ] && [ "$CHUNK_COUNT" -gt 1 ]; then
            echo "ERROR: 帶 after_block_id 時一次最多 100 個 blocks（目前 ${CHUNK_COUNT} 批），請拆成多次呼叫" >&2
            exit 1
        fi
        for ((i=0; i<CHUNK_COUNT; i++)); do
            CHUNK_BODY=$(python3 -c "
import json, sys
blocks = json.load(open('$BLOCKS_FILE'))
i = int(sys.argv[1])
chunk = blocks[i*100:(i+1)*100]
body = {'children': chunk}
if sys.argv[2]:
    body['after'] = sys.argv[2]
print(json.dumps(body))
" "$i" "$AFTER_ID")
            RESULT=$(curl -s -X PATCH "${NOTION_API}/blocks/${PAGE_ID}/children" \
                -H "Authorization: Bearer ${NOTION_TOKEN}" \
                -H "Notion-Version: ${NOTION_VERSION}" \
                -H "Content-Type: application/json" \
                -d "$CHUNK_BODY")
            [ -z "$RESULT" ] && { echo "ERROR: Notion API 空回應（網路失敗？，batch $i）"; exit 1; }
            ERROR=$(echo "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('object',''))" 2>/dev/null)
            if [ "$ERROR" = "error" ]; then
                echo "ERROR: batch $i 失敗：$RESULT" >&2
                exit 1
            fi
            echo "batch $i/$((CHUNK_COUNT-1)) OK"
        done
        ;;

    clear-children)
        PAGE_ID=$(extract_page_id "$2")
        if [ -z "$PAGE_ID" ]; then
            echo "Usage: notion-page-write.sh clear-children <page_id_or_url>"
            exit 1
        fi
        START_CURSOR=""
        IDS_FILE=$(mktemp)
        while :; do
            URL="${NOTION_API}/blocks/${PAGE_ID}/children?page_size=100"
            [ -n "$START_CURSOR" ] && URL="${URL}&start_cursor=${START_CURSOR}"
            PAGE_RESULT=$(curl -s "$URL" \
                -H "Authorization: Bearer ${NOTION_TOKEN}" \
                -H "Notion-Version: ${NOTION_VERSION}" \
                -H "Content-Type: application/json")
            echo "$PAGE_RESULT" | python3 -c "
import sys, json
d = json.load(sys.stdin)
for b in d.get('results', []):
    print(b['id'])
" >> "$IDS_FILE"
            HAS_MORE=$(echo "$PAGE_RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('has_more', False))" 2>/dev/null)
            if [ "$HAS_MORE" != "True" ]; then
                break
            fi
            START_CURSOR=$(echo "$PAGE_RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('next_cursor',''))" 2>/dev/null)
        done
        TOTAL=$(wc -l < "$IDS_FILE" | tr -d ' ')
        echo "共 ${TOTAL} 個子區塊，開始移除…"
        i=0
        while IFS= read -r BLOCK_ID; do
            [ -z "$BLOCK_ID" ] && continue
            curl -s -X DELETE "${NOTION_API}/blocks/${BLOCK_ID}" \
                -H "Authorization: Bearer ${NOTION_TOKEN}" \
                -H "Notion-Version: ${NOTION_VERSION}" > /dev/null
            i=$((i+1))
        done < "$IDS_FILE"
        rm -f "$IDS_FILE"
        echo "已移除 ${i} 個子區塊"
        ;;

    update-block)
        # 修改單一 block（PATCH /v1/blocks/<id>），檔案內容為 block 型別物件，例如
        #   {"paragraph":{"rich_text":[{"type":"text","text":{"content":"新內容"}}]}}
        #   {"table_row":{"cells":[[{"type":"text","text":{"content":"a"}}],[…]]}}
        BLOCK_ID=$(extract_page_id "$2")
        BLOCK_FILE="$3"
        if [ -z "$BLOCK_ID" ] || [ -z "$BLOCK_FILE" ] || [ ! -f "$BLOCK_FILE" ]; then
            echo "Usage: notion-page-write.sh update-block <block_id> <block_json_file>"
            exit 1
        fi
        BODY=$(python3 -c "import json,sys; print(json.dumps(json.load(open(sys.argv[1]))))" "$BLOCK_FILE") || { echo "ERROR: $BLOCK_FILE 不是合法 JSON"; exit 1; }
        RESULT=$(curl -s -X PATCH "${NOTION_API}/blocks/${BLOCK_ID}" \
            -H "Authorization: Bearer ${NOTION_TOKEN}" \
            -H "Notion-Version: ${NOTION_VERSION}" \
            -H "Content-Type: application/json" \
            -d "$BODY")
        [ -z "$RESULT" ] && { echo "ERROR: Notion API 空回應（網路失敗？）"; exit 1; }
        echo "$RESULT"
        ERROR=$(echo "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('object',''))" 2>/dev/null)
        if [ "$ERROR" = "error" ]; then
            exit 1
        fi
        ;;

    delete-block)
        BLOCK_ID=$(extract_page_id "$2")
        if [ -z "$BLOCK_ID" ]; then
            echo "Usage: notion-page-write.sh delete-block <block_id>"
            exit 1
        fi
        RESULT=$(curl -s -X DELETE "${NOTION_API}/blocks/${BLOCK_ID}" \
            -H "Authorization: Bearer ${NOTION_TOKEN}" \
            -H "Notion-Version: ${NOTION_VERSION}")
        [ -z "$RESULT" ] && { echo "ERROR: Notion API 空回應（網路失敗？）"; exit 1; }
        echo "$RESULT"
        ERROR=$(echo "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('object',''))" 2>/dev/null)
        if [ "$ERROR" = "error" ]; then
            exit 1
        fi
        ;;

    *)
        echo "Notion 頁面內文寫入 CLI Tool"
        echo "Usage:"
        echo "  notion-page-write.sh update-title <page_id_or_url> <title_text>          - 改頁面標題"
        echo "  notion-page-write.sh append-blocks <page_id_or_url> <blocks_json_file> [after_block_id] - 從檔案讀 blocks JSON 陣列並分批附加"
        echo "  notion-page-write.sh clear-children <page_id_or_url>                     - 移除頁面目前所有直屬子區塊"
        echo "  notion-page-write.sh update-block <block_id> <block_json_file>           - 修改單一 block"
        echo "  notion-page-write.sh delete-block <block_id>                             - 刪除單一 block"
        ;;
esac
