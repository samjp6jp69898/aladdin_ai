#!/bin/bash
# create-mr-success-notify.sh — /create-mr Step 7b.1：success 出口的 TG 通知
# 從 create-mr.md 抽出（跟已抽出的 create-mr-exit-comment.sh 同類操作，這裡原本還沒抽）。
#
# 用法：
#   bash scripts/create-mr-success-notify.sh <reviewer_email> <ticket_id> <base_branch> \
#     <drive_link> <notion_url> <mr_links_json>
#   mr_links_json：mr-pusher 回報的 MR_LINKS JSON 陣列，例如
#     [{"repo":"agrabah","url":"https://gitlab.../merge_requests/123"}]
#
# 跟原 inline 版本的差異：拿掉「先 ls 查 tg-notify.sh 是否存在」的防禦性寫法——
# 腳本路徑是固定的 repo 資產，不會忽然消失，不需要每次呼叫都驗證存在性。
#
# 輸出契約（單行，恆定 exit 0，不阻斷 pipeline）：
#   tg-notify.sh 自己的結果行（TG_SENT / TG_SKIP_* / TG_FAIL）
set -u
ROOT=/Users/user/aladdin
TG_SH="$ROOT/aladdin_ai/scripts/tg-notify.sh"

EMAIL="${1:?用法: create-mr-success-notify.sh <reviewer_email> <ticket_id> <base_branch> <drive_link> <notion_url> <mr_links_json>}"
TICKET="${2:?缺 ticket_id}"
BASE_BRANCH="${3:?缺 base_branch}"
DRIVE_LINK="${4:-N/A}"
NOTION_URL="${5:-}"
MR_LINKS_JSON="${6:-[]}"

MR_LINES=$(printf '%s' "$MR_LINKS_JSON" | python3 -c '
import sys, json
try:
    items = json.load(sys.stdin)
    for it in items:
        repo = it.get("repo", "?")
        url = it.get("url", "?")
        print(f"{repo}: {url}")
except Exception:
    pass
')

TEXT="✅ [已開 MR] ${TICKET}
AI 已完成修復並開出 MR（目標分支：${BASE_BRANCH}），待你 review：
${MR_LINES}
分析文件：${DRIVE_LINK}
Notion：${NOTION_URL}"

bash "$TG_SH" --email "$EMAIL" --text "$TEXT"
exit 0
