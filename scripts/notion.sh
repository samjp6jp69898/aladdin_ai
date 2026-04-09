#!/bin/bash
# Notion API CLI tool for Claude Code
# Usage:
#   notion.sh fetch <notion_url_or_page_id>              - 讀取頁面內容
#   notion.sh comments <page_id>                          - 讀取頁面留言
#   notion.sh comment <page_id> '<rich_text_json>'        - 建立留言
#   notion.sh update-prop <page_id> <prop_name> select <value>  - 更新 select 屬性
#   notion.sh get-user <user_id>                          - 查詢用戶資訊

NOTION_TOKEN="***REMOVED-NOTION-TOKEN***"
NOTION_API="https://api.notion.com/v1"
NOTION_VERSION="2025-09-03"

notion_headers() {
    echo "-H \"Authorization: Bearer ${NOTION_TOKEN}\" -H \"Notion-Version: ${NOTION_VERSION}\" -H \"Content-Type: application/json\""
}

# 從 Notion URL 提取 page_id（支援多種格式）
extract_page_id() {
    local input="$1"
    # 如果已經是純 UUID 格式（含或不含 dash）
    if echo "$input" | grep -qE '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'; then
        echo "$input"
        return
    fi
    # 從 URL 中提取最後 32 位 hex（去掉 dash）
    local raw_id
    raw_id=$(echo "$input" | grep -oE '[0-9a-f]{32}' | tail -1)
    if [ -n "$raw_id" ]; then
        # 轉成帶 dash 的 UUID 格式
        echo "${raw_id:0:8}-${raw_id:8:4}-${raw_id:12:4}-${raw_id:16:4}-${raw_id:20:12}"
        return
    fi
    # 直接回傳（讓 API 自行處理錯誤）
    echo "$input"
}

case "$1" in
    fetch)
        INPUT="$2"
        if [ -z "$INPUT" ]; then
            echo "Usage: notion.sh fetch <notion_url_or_page_id>"
            exit 1
        fi
        PAGE_ID=$(extract_page_id "$INPUT")
        curl -s "${NOTION_API}/pages/${PAGE_ID}" \
            -H "Authorization: Bearer ${NOTION_TOKEN}" \
            -H "Notion-Version: ${NOTION_VERSION}" \
            -H "Content-Type: application/json"
        ;;

    fetch-blocks)
        INPUT="$2"
        if [ -z "$INPUT" ]; then
            echo "Usage: notion.sh fetch-blocks <notion_url_or_page_id>"
            exit 1
        fi
        PAGE_ID=$(extract_page_id "$INPUT")
        curl -s "${NOTION_API}/blocks/${PAGE_ID}/children?page_size=100" \
            -H "Authorization: Bearer ${NOTION_TOKEN}" \
            -H "Notion-Version: ${NOTION_VERSION}" \
            -H "Content-Type: application/json"
        ;;

    comments)
        INPUT="$2"
        if [ -z "$INPUT" ]; then
            echo "Usage: notion.sh comments <notion_url_or_page_id>"
            exit 1
        fi
        PAGE_ID=$(extract_page_id "$INPUT")
        curl -s "${NOTION_API}/comments?block_id=${PAGE_ID}" \
            -H "Authorization: Bearer ${NOTION_TOKEN}" \
            -H "Notion-Version: ${NOTION_VERSION}" \
            -H "Content-Type: application/json"
        ;;

    comment)
        PAGE_ID=$(extract_page_id "$2")
        RICH_TEXT_JSON="$3"
        if [ -z "$PAGE_ID" ] || [ -z "$RICH_TEXT_JSON" ]; then
            echo "Usage: notion.sh comment <page_id> '<rich_text_json_array>'"
            exit 1
        fi
        BODY=$(python3 -c "
import json, sys
rich_text = json.loads(sys.argv[1])
body = {'parent': {'page_id': sys.argv[2]}, 'rich_text': rich_text}
print(json.dumps(body))
" "$RICH_TEXT_JSON" "$PAGE_ID")
        RESULT=$(curl -s -X POST "${NOTION_API}/comments" \
            -H "Authorization: Bearer ${NOTION_TOKEN}" \
            -H "Notion-Version: ${NOTION_VERSION}" \
            -H "Content-Type: application/json" \
            -d "$BODY")
        echo "$RESULT"
        # 檢查是否有錯誤
        ERROR=$(echo "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('object',''))" 2>/dev/null)
        if [ "$ERROR" = "error" ]; then
            exit 1
        fi
        ;;

    update-prop)
        PAGE_ID=$(extract_page_id "$2")
        PROP_NAME="$3"
        PROP_TYPE="$4"
        PROP_VALUE="$5"
        if [ -z "$PAGE_ID" ] || [ -z "$PROP_NAME" ] || [ -z "$PROP_TYPE" ] || [ -z "$PROP_VALUE" ]; then
            echo "Usage: notion.sh update-prop <page_id> <property_name> <select|status|text> <value>"
            exit 1
        fi

        case "$PROP_TYPE" in
            select)
                BODY="{\"properties\": {\"${PROP_NAME}\": {\"select\": {\"name\": \"${PROP_VALUE}\"}}}}"
                ;;
            status)
                BODY="{\"properties\": {\"${PROP_NAME}\": {\"status\": {\"name\": \"${PROP_VALUE}\"}}}}"
                ;;
            text)
                BODY=$(python3 -c "
import json
body = {'properties': {'$PROP_NAME': {'rich_text': [{'type': 'text', 'text': {'content': '$PROP_VALUE'}}]}}}
print(json.dumps(body))
")
                ;;
            *)
                echo "ERROR: unsupported property type '$PROP_TYPE'. Use: select, status, text"
                exit 1
                ;;
        esac

        RESULT=$(curl -s -X PATCH "${NOTION_API}/pages/${PAGE_ID}" \
            -H "Authorization: Bearer ${NOTION_TOKEN}" \
            -H "Notion-Version: ${NOTION_VERSION}" \
            -H "Content-Type: application/json" \
            -d "$BODY")
        echo "$RESULT"
        ERROR=$(echo "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('object',''))" 2>/dev/null)
        if [ "$ERROR" = "error" ]; then
            exit 1
        fi
        ;;

    get-user)
        USER_ID="$2"
        if [ -z "$USER_ID" ]; then
            echo "Usage: notion.sh get-user <user_id>"
            exit 1
        fi
        curl -s "${NOTION_API}/users/${USER_ID}" \
            -H "Authorization: Bearer ${NOTION_TOKEN}" \
            -H "Notion-Version: ${NOTION_VERSION}" \
            -H "Content-Type: application/json"
        ;;

    *)
        echo "Notion API CLI Tool"
        echo "Usage:"
        echo "  notion.sh fetch <url_or_page_id>                            - 讀取頁面屬性"
        echo "  notion.sh fetch-blocks <url_or_page_id>                     - 讀取頁面內文 blocks"
        echo "  notion.sh comments <url_or_page_id>                         - 讀取頁面留言"
        echo "  notion.sh comment <page_id> '<rich_text_json>'               - 建立留言"
        echo "  notion.sh update-prop <page_id> <prop> select|status|text <val> - 更新屬性"
        echo "  notion.sh get-user <user_id>                                 - 查詢用戶資訊"
        ;;
esac
