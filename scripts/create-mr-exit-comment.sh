#!/bin/bash
# create-mr-exit-comment.sh — /create-mr Step 7c：非 success 出口的 Notion 留言 + AI分析 欄位 + TG 通知
# （2026-09-01 從 create-mr.md 抽出，因該檔超過 400 行上限；留言文字逐字沿用原 Step 7c 模板）
#
# 用法：
#   bash scripts/create-mr-exit-comment.sh <pipeline_status> <page_id> [選項]
#   pipeline_status ∈ already_fixed | i18n_manual_handoff | needs_qa_clarification | failed
#   選項：
#     --ticket <FAQ-xxxx>               TG 標題用的單號（needs_qa / failed 發 TG 時建議必帶）
#     --drive-link <url|N/A>            分析文件連結（N/A 或省略 → 留言不附連結行、TG 省略該行）
#     --fixed-commit <hash>             already_fixed 用（省略 → 留言寫「(未提供)」）
#     --qa-question <text>              needs_qa_clarification 用
#     --failure-reason <text>           failed 用
#     --attempts <tracer> <fixer> <total>   failed 用（省略 → 0 0 0）
#     --bootstrap-partial               留言尾端加「DB 資料供給未完成」披露句
#     --reviewer-email <email>          needs_qa / failed 才發 TG；省略或空 → TG: SKIPPED
#     --notion-url <url>                TG 內文的 Notion 連結
#     --dry-run                         只印將送出的內容，不打 Notion / TG
#
# 輸出契約（呼叫端行首 grep，不假設順序）：
#   NOTION_COMMENT: ok|failed(<摘要>)
#   NOTION_AI_FIELD: ok|failed(<摘要>)   值：already_fixed / i18n → 分析成功；needs_qa → 待釐清；failed → 分析失敗
#   TG: <tg-notify.sh 的結果行>|SKIPPED(<原因>)
# 紀律：一律 exit 0（出口動作不得再讓 pipeline 失敗）；留言失敗不影響欄位更新（欄位是最核心任務，比照 mr-pusher）。
set -u
ROOT=/Users/user/aladdin
NOTION_SH=$ROOT/aladdin_ai/scripts/notion.sh
TG_SH=$ROOT/aladdin_ai/scripts/tg-notify.sh

STATUS="${1:-}"; PAGE_ID="${2:-}"; shift 2 2>/dev/null || true
DRIVE="N/A"; COMMIT=""; QA=""; REASON=""; T_A=0; T_F=0; T_T=0
PARTIAL=0; EMAIL=""; NOTION_URL=""; TICKET=""; DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --ticket) TICKET="${2:-}"; shift 2;;
    --drive-link) DRIVE="${2:-N/A}"; shift 2;;
    --fixed-commit) COMMIT="${2:-}"; shift 2;;
    --qa-question) QA="${2:-}"; shift 2;;
    --failure-reason) REASON="${2:-}"; shift 2;;
    --attempts) T_A="${2:-0}"; T_F="${3:-0}"; T_T="${4:-0}"; shift 4;;
    --bootstrap-partial) PARTIAL=1; shift;;
    --reviewer-email) EMAIL="${2:-}"; shift 2;;
    --notion-url) NOTION_URL="${2:-}"; shift 2;;
    --dry-run) DRY=1; shift;;
    *) echo "NOTION_COMMENT: failed(未知選項 $1)"; echo "NOTION_AI_FIELD: failed(未知選項 $1)"; echo "TG: SKIPPED(參數錯誤)"; exit 0;;
  esac
done

case "$STATUS" in
  already_fixed|i18n_manual_handoff|needs_qa_clarification|failed) ;;
  *) echo "NOTION_COMMENT: failed(pipeline_status 非法：${STATUS:-空}；本腳本只處理非 success 出口)"
     echo "NOTION_AI_FIELD: failed(pipeline_status 非法)"; echo "TG: SKIPPED(參數錯誤)"; exit 0;;
esac
[ -n "$PAGE_ID" ] || { echo "NOTION_COMMENT: failed(缺 page_id)"; echo "NOTION_AI_FIELD: failed(缺 page_id)"; echo "TG: SKIPPED(參數錯誤)"; exit 0; }
[ "$DRIVE" = "" ] && DRIVE="N/A"

# ---- 依 status 組留言文字（逐字沿用原 create-mr.md Step 7c 模板）----
# TEXT = 主文；INTRO = 連結引言（只在有 drive link 時接在最後、緊鄰 notion.sh 附加的超連結）；
# bootstrap 披露句放在主文與引言之間，避免插在「引言：」與連結中間。
LINK_URL=""; LINK_TEXT=""; INTRO=""
case "$STATUS" in
  already_fixed)
    TEXT="AI 分析完成。Tracer 確認此 bug 已於 commit ${COMMIT:-(未提供)} 修復，無需再發 PR。"
    INTRO="分析報告："; FIELD="分析成功";;
  i18n_manual_handoff)
    TEXT="AI 分析完成。主因為 i18n 翻譯缺失/錯誤，依專案規範 AI 不主動修 localizations JSON。已在分析文件附上建議匯入的 key/value 草稿："
    INTRO="請開發者參考 i18n keys 清單從 Google Sheets 匯入："; FIELD="分析成功";;
  needs_qa_clarification)
    TEXT="AI 在實證 grounding 階段發現 bug 單描述與 CQA 實際狀況可能有出入，需 QA 確認後才繼續分析：
${QA:-(未提供具體問題)}"
    INTRO="（完整佐證見分析文件）"; FIELD="待釐清";;
  failed)
    TEXT="AI 分析失敗，需人工介入。
失敗原因：${REASON:-(未提供)}
Tracer 嘗試：${T_A} 次，Fixer 嘗試：${T_F} 次（總 ${T_T}）"
    INTRO="分析與審查文件（含各 reviewer 否決理由，供人工接手）："; FIELD="分析失敗";;
esac
[ "$PARTIAL" = 1 ] && TEXT="$TEXT
（注：隔離環境 bootstrap 的 DB 資料供給步驟未完成，不影響本次 L0 分析結論）"
[ "$DRIVE" != "N/A" ] && { TEXT="$TEXT
$INTRO"; LINK_URL="$DRIVE"; }

# ---- TG 文字（僅 needs_qa / failed；drive N/A 時省略該行）----
TG_TEXT=""
case "$STATUS" in
  needs_qa_clarification)
    TG_TEXT="🟡 [待釐清] {ticket}
AI 發現 bug 單與 CQA 實況可能有出入，需你確認：
${QA:-(未提供具體問題)}";;
  failed)
    TG_TEXT="🔴 [分析失敗] {ticket}
失敗原因：${REASON:-(未提供)}
嘗試：tracer ${T_A} / fixer ${T_F}（總 ${T_T}）";;
esac
if [ -n "$TG_TEXT" ]; then
  [ "$DRIVE" != "N/A" ] && TG_TEXT="$TG_TEXT
分析文件：$DRIVE"
  [ -n "$NOTION_URL" ] && TG_TEXT="$TG_TEXT
Notion：$NOTION_URL"
  TG_TEXT="${TG_TEXT//\{ticket\}/${TICKET:-(未提供單號)}}"
fi

# ---- 摘要工具：從 notion.sh 輸出抽 message，截 120 字 ----
summ() { printf '%s' "$1" | python3 -c "import sys,json
s=sys.stdin.read()
try:
  d=json.loads(s); print((d.get('message') or d.get('code') or s)[:120])
except Exception: print(s.strip().replace('\n',' ')[:120])" 2>/dev/null; }

if [ "$DRY" = 1 ]; then
  echo "DRY: notion.sh comment-text $PAGE_ID <<<"; printf '%s\n' "$TEXT"; [ -n "$LINK_URL" ] && echo "DRY:   + link: $LINK_URL"
  echo "DRY: notion.sh update-prop $PAGE_ID AI分析 select $FIELD"
  if [ -n "$TG_TEXT" ] && [ -n "$EMAIL" ]; then echo "DRY: tg-notify.sh --email $EMAIL --text <<<"; printf '%s\n' "$TG_TEXT"; fi
  echo "NOTION_COMMENT: ok(dry-run)"; echo "NOTION_AI_FIELD: ok(dry-run) ${FIELD}"
  if [ -n "$TG_TEXT" ]; then [ -n "$EMAIL" ] && echo "TG: SKIPPED(dry-run)" || echo "TG: SKIPPED(無 reviewer_email)"; else echo "TG: SKIPPED(${STATUS} 不發 TG)"; fi
  exit 0
fi

# ---- 1. 留言 ----
if OUT=$(bash "$NOTION_SH" comment-text "$PAGE_ID" "$TEXT" "$LINK_URL" "$LINK_TEXT" 2>&1); then
  echo "NOTION_COMMENT: ok"
else
  echo "NOTION_COMMENT: failed($(summ "$OUT"))"
fi
# ---- 2. AI分析 欄位（最核心，留言失敗仍做）----
if OUT=$(bash "$NOTION_SH" update-prop "$PAGE_ID" "AI分析" select "$FIELD" 2>&1); then
  echo "NOTION_AI_FIELD: ok ${FIELD}"
else
  echo "NOTION_AI_FIELD: failed($(summ "$OUT"))"
fi
# ---- 3. TG ----
if [ -z "$TG_TEXT" ]; then echo "TG: SKIPPED(${STATUS} 不發 TG)"
elif [ -z "$EMAIL" ]; then echo "TG: SKIPPED(無 reviewer_email)"
elif [ ! -f "$TG_SH" ]; then echo "TG: TG_FAIL(scripts/ 查無 tg-notify.sh)"
else echo "TG: $(bash "$TG_SH" --email "$EMAIL" --text "$TG_TEXT" 2>&1 | tail -1)"
fi
exit 0
