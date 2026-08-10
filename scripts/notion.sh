#!/bin/bash
# Notion API CLI tool for Claude Code
# Usage:
#   notion.sh fetch <notion_url_or_page_id>              - 讀取頁面內容
#   notion.sh comments <page_id>                          - 讀取頁面留言
#   notion.sh comment <page_id> '<rich_text_json>'        - 建立留言
#   notion.sh update-prop <page_id> <prop_name> select <value>  - 更新 select 屬性
#   notion.sh get-user <user_id>                          - 查詢用戶資訊
#   notion.sh list-users                                  - 列出工作區全體成員（唯讀）
#   notion.sh query-datasource <data_source_id> ['<filter_json>'] - 查詢 data source（唯讀）
#   notion.sh upload-file <filepath> [content_type]       - 上傳檔案（<20MB），回傳 file_upload id
#   notion.sh create-page <data_source_id> '<properties_json>' - 在 database 建立新頁面

# token 單一來源：/Users/user/aladdin/.env 的 ALD_NOTION_TOKEN（或已 export 的同名環境變數）。
# 禁止把明文 token 寫回本檔或任何 prompt/文件——輪替 token 時只需改 .env 一處。
NOTION_TOKEN="${ALD_NOTION_TOKEN:-$(grep -m1 '^ALD_NOTION_TOKEN=' /Users/user/aladdin/.env 2>/dev/null | cut -d= -f2- | tr -d '"' | tr -d "'")}"
case "$NOTION_TOKEN" in
    ntn_*) ;;
    *) echo "ERROR: ALD_NOTION_TOKEN 未設定——請在 /Users/user/aladdin/.env 加一行 ALD_NOTION_TOKEN=ntn_xxx（或 export 環境變數）" >&2; exit 1;;
esac
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
        [ -z "$RESULT" ] && { echo "ERROR: Notion API 空回應（網路失敗？）"; exit 1; }
        echo "$RESULT"
        # 檢查是否有錯誤
        ERROR=$(echo "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('object',''))" 2>/dev/null)
        if [ "$ERROR" = "error" ]; then
            exit 1
        fi
        ;;

    comment-text)
        # 純文字留言（免手寫 rich_text JSON；跳脫交給 python 處理）
        # 用法：notion.sh comment-text <page_id_or_url> <text> [link_url] [link_text]
        #   text 可含換行；有 link_url 時會在文字後附一個超連結（顯示文字預設為 URL 本身）
        PAGE_ID=$(extract_page_id "$2")
        TEXT="${3:-}"
        LINK_URL="${4:-}"
        LINK_TEXT="${5:-}"
        if [ -z "$PAGE_ID" ] || [ -z "$TEXT" ]; then
            echo "Usage: notion.sh comment-text <page_id_or_url> <text> [link_url] [link_text]"
            exit 1
        fi
        BODY=$(python3 -c "
import json, sys
pid, text, url, ltext = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
rt = [{'type': 'text', 'text': {'content': text}}]
if url:
    rt.append({'type': 'text', 'text': {'content': ltext or url, 'link': {'url': url}}})
print(json.dumps({'parent': {'page_id': pid}, 'rich_text': rt}))
" "$PAGE_ID" "$TEXT" "$LINK_URL" "$LINK_TEXT")
        RESULT=$(curl -s -X POST "${NOTION_API}/comments" \
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
import json, sys
print(json.dumps({'properties': {sys.argv[1]: {'rich_text': [{'type': 'text', 'text': {'content': sys.argv[2]}}]}}}))
" "$PROP_NAME" "$PROP_VALUE")
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
        [ -z "$RESULT" ] && { echo "ERROR: Notion API 空回應（網路失敗？）"; exit 1; }
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

    list-users)
        # 唯讀：列出 Notion 工作區成員一頁（GET /v1/users，page_size 100）
        # 用法：notion.sh list-users [start_cursor]　— 有 next_cursor/has_more 需翻頁時，帶上一頁回傳的 next_cursor
        START_CURSOR="$2"
        URL="${NOTION_API}/users?page_size=100"
        [ -n "$START_CURSOR" ] && URL="${URL}&start_cursor=${START_CURSOR}"
        curl -s "$URL" \
            -H "Authorization: Bearer ${NOTION_TOKEN}" \
            -H "Notion-Version: ${NOTION_VERSION}" \
            -H "Content-Type: application/json"
        ;;

    query-datasource)
        # 唯讀：查詢 data source（POST /v1/data_sources/<id>/query）
        # 用法：notion.sh query-datasource <data_source_id> ['<filter_json>']
        #   例：notion.sh query-datasource 21c87d78-618a-817f-ae71-000baa9ab11b '{"property":"單號","unique_id":{"equals":3843}}'
        #   filter_json 省略時查全部（page_size 100，不分頁）
        DS_ID="$2"
        FILTER_JSON="$3"
        if [ -z "$DS_ID" ]; then
            echo "Usage: notion.sh query-datasource <data_source_id> ['<filter_json>']"
            exit 1
        fi
        BODY=$(python3 -c "
import json, sys
filter_json = sys.argv[1] if len(sys.argv) > 1 and sys.argv[1] else None
body = {'page_size': 100}
if filter_json:
    body['filter'] = json.loads(filter_json)
print(json.dumps(body))
" "$FILTER_JSON")
        curl -s -X POST "${NOTION_API}/data_sources/${DS_ID}/query" \
            -H "Authorization: Bearer ${NOTION_TOKEN}" \
            -H "Notion-Version: ${NOTION_VERSION}" \
            -H "Content-Type: application/json" \
            -d "$BODY"
        ;;

    upload-file)
        # 上傳檔案到 Notion File Upload（僅支援 single_part，即 <20MB 檔案），回傳 file_upload 物件（含 id）
        # 用法：notion.sh upload-file <filepath> [content_type]
        FILEPATH="$2"
        CONTENT_TYPE="${3:-text/html}"
        if [ -z "$FILEPATH" ] || [ ! -f "$FILEPATH" ]; then
            echo "Usage: notion.sh upload-file <filepath> [content_type]"
            exit 1
        fi
        FILENAME=$(basename "$FILEPATH")
        CREATE_RESULT=$(curl -s -X POST "${NOTION_API}/file_uploads" \
            -H "Authorization: Bearer ${NOTION_TOKEN}" \
            -H "Notion-Version: ${NOTION_VERSION}" \
            -H "Content-Type: application/json" \
            -d "{\"filename\": \"${FILENAME}\", \"content_type\": \"${CONTENT_TYPE}\"}")
        UPLOAD_ID=$(echo "$CREATE_RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))" 2>/dev/null)
        UPLOAD_URL=$(echo "$CREATE_RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('upload_url',''))" 2>/dev/null)
        if [ -z "$UPLOAD_ID" ] || [ -z "$UPLOAD_URL" ]; then
            echo "ERROR: 建立 file_upload 失敗：$CREATE_RESULT" >&2
            exit 1
        fi
        SEND_RESULT=$(curl -s -X POST "$UPLOAD_URL" \
            -H "Authorization: Bearer ${NOTION_TOKEN}" \
            -H "Notion-Version: ${NOTION_VERSION}" \
            -F "file=@${FILEPATH};type=${CONTENT_TYPE}")
        echo "$SEND_RESULT"
        STATUS=$(echo "$SEND_RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status',''))" 2>/dev/null)
        if [ "$STATUS" != "uploaded" ]; then
            echo "ERROR: 上傳未完成，status=$STATUS" >&2
            exit 1
        fi
        ;;

    create-page)
        # 在指定 database（data source）建立新頁面
        # 用法：notion.sh create-page <data_source_id> '<properties_json>'
        #   例：notion.sh create-page 37d87d78-618a-80a1-9aad-000b02c4f2cf '{"標題":{"title":[{"text":{"content":"0714"}}]},"更新日期":{"date":{"start":"2026-07-14"}},"html檔案":{"files":[{"type":"file_upload","file_upload":{"id":"<upload_id>"},"name":"xxx.html"}]}}'
        DS_ID="$2"
        PROPS_JSON="$3"
        if [ -z "$DS_ID" ] || [ -z "$PROPS_JSON" ]; then
            echo "Usage: notion.sh create-page <data_source_id> '<properties_json>'"
            exit 1
        fi
        BODY=$(python3 -c "
import json, sys
props = json.loads(sys.argv[1])
print(json.dumps({'parent': {'type': 'data_source_id', 'data_source_id': sys.argv[2]}, 'properties': props}))
" "$PROPS_JSON" "$DS_ID")
        RESULT=$(curl -s -X POST "${NOTION_API}/pages" \
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

    *)
        echo "Notion API CLI Tool"
        echo "Usage:"
        echo "  notion.sh fetch <url_or_page_id>                            - 讀取頁面屬性"
        echo "  notion.sh fetch-blocks <url_or_page_id>                     - 讀取頁面內文 blocks"
        echo "  notion.sh comments <url_or_page_id>                         - 讀取頁面留言"
        echo "  notion.sh comment <page_id> '<rich_text_json>'               - 建立留言"
        echo "  notion.sh comment-text <page_id> <text> [link_url] [link_text] - 建立純文字留言（免 JSON）"
        echo "  notion.sh update-prop <page_id> <prop> select|status|text <val> - 更新屬性"
        echo "  notion.sh get-user <user_id>                                 - 查詢用戶資訊"
        echo "  notion.sh list-users                                         - 列出工作區全體成員（唯讀）"
        echo "  notion.sh query-datasource <data_source_id> ['<filter_json>']  - 查詢 data source（唯讀）"
        echo "  notion.sh upload-file <filepath> [content_type]              - 上傳檔案（<20MB），回傳 file_upload id"
        echo "  notion.sh create-page <data_source_id> '<properties_json>'   - 在 database 建立新頁面"
        ;;
esac
