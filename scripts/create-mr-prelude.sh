#!/bin/bash
# create-mr-prelude.sh — /create-mr Step 0：拉新 code + TG chat_id 回填（皆 best-effort）
# （2026-09-08 從 create-mr.md 抽出，因該檔超過 400 行上限；邏輯逐字沿用原 Step 0-a / 0-b，
#   見 pipeline-modes-project-docs/plan-pipeline-modes-v1.md §5 / Phase 0。）
#
# 用法：bash scripts/create-mr-prelude.sh
#
# 動作：
#   0-a  bash scripts/fresh-pull.sh → 取最後一行
#   0-b  bash scripts/tg-map-chatids.sh --list（TSV：chat_id source tg_first_name tg_username confidence
#        candidate_email candidate_name alt_candidates）→ confidence==HIGH 的行逐一 --set <email> <chat_id>，
#        SET_OK 者再 tg-notify.sh --email <email> --text "<tg_first_name> 連結成功"；ASK 只計數不寫。
#
# 輸出契約（呼叫端行首 grep，不假設順序）：
#   FRESH_PULL: FRESH_PULL_OK | FRESH_PULL_FAIL:<原因>
#   TG_CHATID_SYNC: SKIPPED | 自動對映 N / ASK 待處理 M / 確認訊息 X SENT, Y FAIL
# 紀律：一律 exit 0；任一子步驟失敗只反映在對應輸出行，不阻斷 pipeline。
# 環境變數（僅測試用 stub）：PRELUDE_FRESH_PULL_SH / PRELUDE_TG_MAP_SH / PRELUDE_TG_NOTIFY_SH 覆寫三支腳本路徑。
set -u
ROOT=/Users/user/aladdin
FRESH_SH="${PRELUDE_FRESH_PULL_SH:-$ROOT/aladdin_ai/scripts/fresh-pull.sh}"
MAP_SH="${PRELUDE_TG_MAP_SH:-$ROOT/aladdin_ai/scripts/tg-map-chatids.sh}"
NOTIFY_SH="${PRELUDE_TG_NOTIFY_SH:-$ROOT/aladdin_ai/scripts/tg-notify.sh}"

# ---- 0-a：Fresh Pull ----
if [ -f "$FRESH_SH" ]; then
  LAST=$(bash "$FRESH_SH" 2>&1 | tail -1)
  case "$LAST" in
    FRESH_PULL_OK|FRESH_PULL_FAIL:*) echo "FRESH_PULL: $LAST";;
    *) echo "FRESH_PULL: FRESH_PULL_FAIL:非預期輸出（$(printf '%s' "$LAST" | cut -c1-100)）";;
  esac
else
  echo "FRESH_PULL: FRESH_PULL_FAIL:查無 fresh-pull.sh"
fi

# ---- 0-b：TG chat_id 回填 ----
if [ ! -f "$MAP_SH" ]; then echo "TG_CHATID_SYNC: SKIPPED"; exit 0; fi
LIST=$(bash "$MAP_SH" --list 2>/dev/null) || LIST=""
if [ -z "$LIST" ]; then echo "TG_CHATID_SYNC: SKIPPED"; exit 0; fi

N=0; M=0; SENT=0; FAILN=0
while IFS=$'\t' read -r chat_id source first_name username confidence cand_email cand_name alt; do
  [ -z "${chat_id:-}" ] && continue
  case "${confidence:-}" in
    HIGH)
      [ -z "${cand_email:-}" ] && continue
      OUT=$(bash "$MAP_SH" --set "$cand_email" "$chat_id" 2>&1)
      case "$OUT" in
        *SET_OK*)
          N=$((N+1))
          if [ -f "$NOTIFY_SH" ]; then
            R=$(bash "$NOTIFY_SH" --email "$cand_email" --text "${first_name:-} 連結成功" 2>&1 | tail -1)
            case "$R" in TG_SENT*) SENT=$((SENT+1));; *) FAILN=$((FAILN+1));; esac
          else
            FAILN=$((FAILN+1))
          fi;;
        *) ;;   # SET 失敗：不計入自動對映，不通知
      esac;;
    ASK) M=$((M+1));;
    *) ;;
  esac
done <<EOF
$LIST
EOF
echo "TG_CHATID_SYNC: 自動對映 $N / ASK 待處理 $M / 確認訊息 $SENT SENT, $FAILN FAIL"
exit 0
