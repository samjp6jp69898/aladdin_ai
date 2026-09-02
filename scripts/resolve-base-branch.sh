#!/bin/bash
# resolve-base-branch.sh — /create-mr Step 1「base_branch 決定」三層判定鏈
# 從 create-mr.md 抽出（regex 驗證 + 檔案存在性檢查，純機械式判斷）。
#
# 用法：bash scripts/resolve-base-branch.sh <ticket_id> [target_branch_raw]
#   target_branch_raw：Step 1 bug-report-and-spec-analyst 回報的 TARGET_BRANCH: 值
#                       （N/A、空字串、或省略都視同「沒有」）
#
# 判定順序（跟原 create-mr.md 一致，manager 不得憑 ticket 內容自行猜分支）：
#   1. target_branch_raw 非空且不是 N/A，且符合 ^[A-Za-z0-9][A-Za-z0-9._/-]*$ 且不含 ".."
#      → 採用該值
#   2. 否則（含上一步驗證失敗）→ fallback：grep -m1 '^Target Branch:' <analytics.md>，
#      取到的值非空、不是 "(Not provided)" → 採用
#   3. 否則 → main
#
# 輸出契約（3 行，恆定 exit 0）：
#   BASE_BRANCH: <值>
#   SOURCE: analyst|analytics_fallback|default
#   NOTE: invalid_raw:<被判定不合法的原值>（沒有則空）
set -u
TICKET="${1:?用法: resolve-base-branch.sh <ticket_id> [target_branch_raw]}"
RAW="${2:-N/A}"
ANALYTICS="/Users/user/aladdin/obsidian/Debug/$TICKET/${TICKET}-analytics.md"

is_valid_branch_name() {
  case "$1" in
    *..*) return 1 ;;
  esac
  echo "$1" | grep -qE '^[A-Za-z0-9][A-Za-z0-9._/-]*$'
}

NOTE=""
if [ -n "$RAW" ] && [ "$RAW" != "N/A" ]; then
  if is_valid_branch_name "$RAW"; then
    echo "BASE_BRANCH: $RAW"
    echo "SOURCE: analyst"
    echo "NOTE:"
    exit 0
  else
    NOTE="invalid_raw:$RAW"
  fi
fi

FALLBACK=""
if [ -f "$ANALYTICS" ]; then
  FALLBACK=$(grep -m1 '^Target Branch:' "$ANALYTICS" | sed -E 's/^Target Branch:[[:space:]]*//; s/[[:space:]]+$//')
fi

if [ -n "$FALLBACK" ] && [ "$FALLBACK" != "(Not provided)" ]; then
  echo "BASE_BRANCH: $FALLBACK"
  echo "SOURCE: analytics_fallback"
  echo "NOTE: $NOTE"
  exit 0
fi

echo "BASE_BRANCH: main"
echo "SOURCE: default"
echo "NOTE: $NOTE"
exit 0
