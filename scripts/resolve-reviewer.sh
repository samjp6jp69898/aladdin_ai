#!/bin/bash
# resolve-reviewer.sh — 由 Notion 當前指派推導 reviewer email（/create-mr Step 0.5）
#
# 用法：bash scripts/resolve-reviewer.sh <notion_page_url_或_page_id>
# 輸出（最後一行契約）：
#   TECH_MATCH:<email>   — 當前指派命中 tech-users.csv
#   NOT_TECH             — 指派存在但無人在 tech 名單（本流程不處理該單，還原 pending）
#   ERROR:<原因>          — API/解析失敗（exit 1）
#
# token 單一來源 = scripts/notion.sh（不要在本檔或任何 prompt 硬編 token）。
set -u
ROOT=/Users/user/aladdin
CSV="$ROOT/obsidian/commands/create-mr/references/tech-users.csv"   # canonical：tg 腳本也讀寫這份

INPUT="${1:?用法: resolve-reviewer.sh <notion_page_url_或_page_id>}"
[ -f "$CSV" ] || { echo "ERROR:tech-users.csv 不存在 $CSV"; exit 1; }
command -v jq >/dev/null 2>&1 || { echo "ERROR:jq 未安裝（缺它會把有指派誤判成 NOT_TECH，故直接報錯）"; exit 1; }

# token 單一來源：環境變數 > /Users/user/aladdin/.env 的 ALD_NOTION_TOKEN（與 notion.sh 同源）
TOKEN="${ALD_NOTION_TOKEN:-}"
[ -z "$TOKEN" ] && TOKEN=$(grep -m1 '^ALD_NOTION_TOKEN=' "$ROOT/.env" 2>/dev/null | cut -d= -f2- | tr -d '"' | tr -d "'")
case "$TOKEN" in ntn_*) ;; *) echo "ERROR:讀不到有效 ALD_NOTION_TOKEN（.env 缺 ALD_NOTION_TOKEN= 行？）"; exit 1;; esac

# page_id 正規化（與 notion.sh extract_page_id 同邏輯）
if echo "$INPUT" | grep -qE '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'; then
  PAGE_ID="$INPUT"
else
  raw=$(echo "$INPUT" | grep -oE '[0-9a-f]{32}' | tail -1)
  [ -n "$raw" ] || { echo "ERROR:無法從輸入解析 page_id"; exit 1; }
  PAGE_ID="${raw:0:8}-${raw:8:4}-${raw:12:4}-${raw:16:4}-${raw:20:12}"
fi

RESP=$(curl -s -H "Authorization: Bearer $TOKEN" -H "Notion-Version: 2022-06-28" \
  "https://api.notion.com/v1/pages/$PAGE_ID")
echo "$RESP" | grep -q '"object":"error"' && { echo "ERROR:Notion API 錯誤 $(echo "$RESP" | head -c 200)"; exit 1; }

ASSIGNEE_IDS=$(echo "$RESP" | jq -r '.properties["當前指派"].people[]?.id' 2>/dev/null)
[ -n "$ASSIGNEE_IDS" ] || { echo "NOT_TECH"; exit 0; }

# CSV 欄位：notion_user_name,notion_user_id,email,pushed_repos[,tg_chat_id]
while IFS=, read -r _name nid email _rest; do
  for aid in $ASSIGNEE_IDS; do
    if [ "$aid" = "$nid" ] && [ -n "$email" ]; then
      echo "TECH_MATCH:$email"
      exit 0
    fi
  done
done < <(tail -n +2 "$CSV")

echo "NOT_TECH"
