#!/bin/bash
# extract-tracer-fields.sh — /create-mr Step 2c「附加行補救」：AFFECTED_REPOS / I18N_ONLY /
# ALREADY_FIXED 契約行缺失時的定向抽取。也給 Step 0.2 resume 分支（step4-7）重複用到的同一段
# 邏輯共用，避免兩處各自維護一份。
#
# 用法：bash scripts/extract-tracer-fields.sh <ticket_id>
#
# 邏輯（跟原 create-mr.md Step 2c 一致）：
#   - sed -n '/primary_fix_paths/,/```/p' 抓出 analysis-notes.md 的 primary_fix_paths YAML 區塊
#   - AFFECTED_REPOS：區塊內出現的 repo（agrabah/abu/lago/rajah）子集，逗號分隔；都沒有 → none
#     （優先讀 YAML 的 `repo:` 欄位；同時相容原描述「路徑前綴字面比對」，兩種方式取聯集）
#   - I18N_ONLY：區塊內每個 `file:` 值是否都落在 localizations/*.json —— 全部是 → yes；
#     部分是 → mixed；都不是 → no
#   - ALREADY_FIXED：固定回報 no（**嚴禁**用「已修復紀錄」之類的字樣猜測 already-fixed——
#     那是 tracer 模板固定 section 標題，多數文件都含它，grep 判定會大量假成功；
#     這個值只在契約行缺失時保守 fallback，真正的判定必須來自 tracer 自己的契約行）
#
# 輸出契約（3 行，恆定 exit 0）：
#   AFFECTED_REPOS: <逗號分隔子集|none>
#   I18N_ONLY: yes|no|mixed
#   ALREADY_FIXED: no
set -u
TICKET="${1:?用法: extract-tracer-fields.sh <ticket_id>}"
NOTES="/Users/user/aladdin/obsidian/Debug/$TICKET/${TICKET}-analysis-notes.md"

if [ ! -f "$NOTES" ]; then
  echo "AFFECTED_REPOS: none"
  echo "I18N_ONLY: no"
  echo "ALREADY_FIXED: no"
  exit 0
fi

BLOCK=$(sed -n '/primary_fix_paths/,/```/p' "$NOTES")

REPOS=""
if [ -n "$BLOCK" ]; then
  # 主要方式：YAML 的 `repo:` 欄位
  REPOS=$(printf '%s\n' "$BLOCK" | grep -oE 'repo:[[:space:]]*(agrabah|abu|lago|rajah)' \
    | sed -E 's/^repo:[[:space:]]*//')
  # 相容方式：原描述的路徑前綴字面比對（涵蓋 repo: 欄位不存在、但路徑字串本身帶了前綴的情況）
  for r in agrabah abu lago rajah; do
    printf '%s\n' "$BLOCK" | grep -q "$r/" && REPOS="$REPOS
$r"
  done
fi

AFFECTED_REPOS="none"
if [ -n "$REPOS" ]; then
  DEDUP=$(printf '%s\n' "$REPOS" | grep -E '^(agrabah|abu|lago|rajah)$' | sort -u | paste -sd, -)
  [ -n "$DEDUP" ] && AFFECTED_REPOS="$DEDUP"
fi

I18N_ONLY="no"
if [ -n "$BLOCK" ]; then
  FILES=$(printf '%s\n' "$BLOCK" | grep -oE 'file:[[:space:]]*\S+' | sed -E 's/^file:[[:space:]]*//')
  # 注意：grep -c 找不到匹配時仍會印出 "0" 但 exit 1——不能用 `|| echo 0` 接住失敗，
  # 否則兩邊輸出疊加變成 "0\n0"。直接吃它的 stdout，不管 exit code。
  TOTAL=$(printf '%s\n' "$FILES" | grep -c .)
  I18N_HITS=$(printf '%s\n' "$FILES" | grep -icE 'localizations/.*\.json$')
  if [ "$TOTAL" -gt 0 ]; then
    if [ "$I18N_HITS" -eq "$TOTAL" ]; then
      I18N_ONLY="yes"
    elif [ "$I18N_HITS" -gt 0 ]; then
      I18N_ONLY="mixed"
    fi
  fi
fi

echo "AFFECTED_REPOS: $AFFECTED_REPOS"
echo "I18N_ONLY: $I18N_ONLY"
echo "ALREADY_FIXED: no"
exit 0
