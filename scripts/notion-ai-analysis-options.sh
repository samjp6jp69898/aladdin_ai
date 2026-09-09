#!/bin/bash
# notion-ai-analysis-options.sh — pipeline-modes Phase 2 一次性腳本：
# 把 Notion Bug List「AI分析」select 屬性的選項改成 plan-pipeline-modes-v1.md §2.1 的最終值域：
#   改名（保留 option id）：待分析 → 一鍵分析＋修復＋開 MR；需要重跑 → 全部重跑
#   新增：只做問題分析（不改程式） / 問題分析完成，待確認 / 產出修復程式碼並開 MR / 依留言重新分析（不改程式）
#   其餘既有選項（不需分析 / 回測完成 / 分析中 / 分析成功 / 分析失敗 / 待規劃 / 待釐清）原樣保留（id/name/color 不動）
#
# 用法：
#   bash scripts/notion-ai-analysis-options.sh [--dry-run|--apply] [--data-source <id>]
#   預設 --dry-run；data source 預設 21c87d78-618a-817f-ae71-000baa9ab11b（Bug List）。
#
# 流程：
#   notion.sh get-datasource → 解析 properties.AI分析.select.options → 算出目標清單
#   （改名比對用「舊名」找 id；若舊名已不存在但新名已存在＝已改過，視為 no-op；新增項若已存在則跳過）
#   → 印出 diff（每個 option 一行：RENAME <id> 舊名 → 新名 / ADD 新名 / KEEP <id> 名 / NOOP <id> 名）
#   → --apply 時呼叫 notion.sh update-datasource 把整份目標清單送回（Notion 語意：送回的清單即為全部，
#     漏送會被刪除，所以一律先 GET 完整清單再整份送回）→ 成功後再 GET 一次 read-back 驗證最終名稱集合。
#
# 新增選項的 color（Notion 若拒絕該欄，自動去掉 color 重試一次）：
#   只做問題分析（不改程式）=blue／問題分析完成，待確認=yellow／
#   產出修復程式碼並開 MR=green／依留言重新分析（不改程式）=orange
#
# 安全：
#   - 屬性不是 select 型、GET 回錯誤、或 AI分析 屬性不存在 → RESULT: BLOCKED，exit 1，絕不送 PATCH。
#   - 目標清單必須包含全部既有 option 的 id（數量只增不減）、且兩個改名項的舊名/新名至少有一個存在，
#     否則視為 schema 異常 → RESULT: BLOCKED，exit 1。
#   - 全程只透過 notion.sh 打 Notion API，不在本檔手寫含 token 的 curl。
#
# 輸出契約（行首 grep，不假設順序）：
#   PLAN: <n> rename / <m> add / <k> keep
#   （後接每個 option 一行的 diff）
#   RESULT: DRY_RUN | APPLIED | NOOP | BLOCKED(<原因>)
#   --apply 且 RESULT: APPLIED 時另印一行：READBACK: OK | MISMATCH(<缺什麼/多什麼>)
#
# 冪等：對已完成變更的 data source 再跑一次（無論 --dry-run 或 --apply）→ RESULT: NOOP，不送 PATCH。
#
# 測試 hook：環境變數 NOTION_SH_OVERRIDE 指向一支 stub 腳本以取代 notion.sh（見同目錄 .test.sh）。
set -u
ROOT=/Users/user/aladdin
NOTION_SH="${NOTION_SH_OVERRIDE:-$ROOT/aladdin_ai/scripts/notion.sh}"
DEFAULT_DS_ID="21c87d78-618a-817f-ae71-000baa9ab11b"

MODE=dry-run
DS_ID="$DEFAULT_DS_ID"
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) MODE=dry-run; shift;;
    --apply) MODE=apply; shift;;
    --data-source) DS_ID="${2:-}"; shift 2;;
    *) echo "RESULT: BLOCKED(未知選項 $1)"; exit 1;;
  esac
done
[ -n "$DS_ID" ] || { echo "RESULT: BLOCKED(缺 --data-source)"; exit 1; }

TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

# ---- 1. 讀完整既有清單 ----
GET_OUT=$(bash "$NOTION_SH" get-datasource "$DS_ID" 2>&1)
GET_RC=$?
if [ $GET_RC -ne 0 ] || [ -z "$GET_OUT" ]; then
  echo "RESULT: BLOCKED(get-datasource 失敗: $(printf '%s' "$GET_OUT" | head -c 200))"
  exit 1
fi
printf '%s' "$GET_OUT" > "$TMPDIR/get1.json"

# ---- 2. 算目標清單 + diff（純函式，不打任何 API）----
PLAN_PY="$TMPDIR/plan.py"
cat > "$PLAN_PY" <<'PY'
import json, sys, base64

RENAME = {
    '待分析': '一鍵分析＋修復＋開 MR',
    '需要重跑': '全部重跑',
}
RENAME_NEW = set(RENAME.values())
ADD_DEFS = [
    ('只做問題分析（不改程式）', 'blue'),
    ('問題分析完成，待確認', 'yellow'),
    ('產出修復程式碼並開 MR', 'green'),
    ('依留言重新分析（不改程式）', 'orange'),
]
ADD_NAMES = {n for n, _ in ADD_DEFS}


def block(reason):
    print(f"STATUS:BLOCKED:{reason}")
    sys.exit(0)


path = sys.argv[1]
try:
    with open(path, encoding='utf-8') as f:
        d = json.loads(f.read())
except Exception as e:
    block(f"GET 回應非合法 JSON: {e}")

if not isinstance(d, dict):
    block("GET 回應格式異常（非 JSON object）")

if d.get('object') == 'error':
    block(f"get-datasource 失敗: {d.get('message', d.get('code', ''))}")

properties = d.get('properties') or {}
prop = properties.get('AI分析')
if prop is None:
    block("AI分析 屬性不存在")

if prop.get('type') != 'select':
    block(f"AI分析 不是 select 型（實際: {prop.get('type')}）")

options = ((prop.get('select') or {}).get('options')) or []
existing_names = {o.get('name') for o in options}
existing_ids = {o.get('id') for o in options}

target = []
plan_lines = []
rename_n = add_n = keep_n = 0
changed = False

for opt in options:
    name = opt.get('name')
    oid = opt.get('id')
    color = opt.get('color')
    if name in RENAME:
        new_name = RENAME[name]
        entry = {'id': oid, 'name': new_name}
        if color is not None:
            entry['color'] = color
        target.append(entry)
        plan_lines.append(f"RENAME {oid} {name} → {new_name}")
        rename_n += 1
        changed = True
    elif name in RENAME_NEW or name in ADD_NAMES:
        entry = {'id': oid, 'name': name}
        if color is not None:
            entry['color'] = color
        target.append(entry)
        plan_lines.append(f"NOOP {oid} {name}")
        keep_n += 1
    else:
        entry = {'id': oid, 'name': name}
        if color is not None:
            entry['color'] = color
        target.append(entry)
        plan_lines.append(f"KEEP {oid} {name}")
        keep_n += 1

for old, new in RENAME.items():
    if old not in existing_names and new not in existing_names:
        block(f"找不到選項「{old}」也找不到「{new}」，schema 異常，拒絕變更")

for name, color in ADD_DEFS:
    if name in existing_names:
        continue
    entry = {'name': name, 'color': color}
    target.append(entry)
    plan_lines.append(f"ADD {name}")
    add_n += 1
    changed = True

target_ids = {e['id'] for e in target if 'id' in e}
missing_ids = existing_ids - target_ids
if missing_ids:
    block(f"目標清單遺漏既有選項 id：{','.join(sorted(missing_ids))}")

expected_names = [e['name'] for e in target]
props_json = json.dumps({'AI分析': {'select': {'options': target}}}, ensure_ascii=False)

print("STATUS:OK")
print(f"PLAN: {rename_n} rename / {add_n} add / {keep_n} keep")
for line in plan_lines:
    print(line)
print(f"CHANGED:{1 if changed else 0}")
print("PROPS_B64:" + base64.b64encode(props_json.encode('utf-8')).decode('ascii'))
print("EXPECTED_NAMES_B64:" + base64.b64encode("\n".join(expected_names).encode('utf-8')).decode('ascii'))
PY

PY_OUT=$(python3 "$PLAN_PY" "$TMPDIR/get1.json")

STATUS_LINE=$(printf '%s\n' "$PY_OUT" | head -1)
case "$STATUS_LINE" in
  STATUS:BLOCKED:*)
    echo "RESULT: BLOCKED(${STATUS_LINE#STATUS:BLOCKED:})"
    exit 1
    ;;
  STATUS:OK) ;;
  *)
    echo "RESULT: BLOCKED(內部解析錯誤: $STATUS_LINE)"
    exit 1
    ;;
esac

# ---- 3. 印 PLAN + diff（STATUS:OK 之後、CHANGED: 之前）----
printf '%s\n' "$PY_OUT" | sed -n '2,/^CHANGED:/p' | sed '$d'

CHANGED=$(printf '%s\n' "$PY_OUT" | grep '^CHANGED:' | sed 's/^CHANGED://')
PROPS_B64=$(printf '%s\n' "$PY_OUT" | grep '^PROPS_B64:' | sed 's/^PROPS_B64://')
EXPECTED_B64=$(printf '%s\n' "$PY_OUT" | grep '^EXPECTED_NAMES_B64:' | sed 's/^EXPECTED_NAMES_B64://')

if [ "$CHANGED" = "0" ]; then
  echo "RESULT: NOOP"
  exit 0
fi

if [ "$MODE" = dry-run ]; then
  echo "RESULT: DRY_RUN"
  exit 0
fi

# ---- 4. --apply：整份目標清單送回 ----
PROPS_JSON=$(printf '%s' "$PROPS_B64" | base64 -d)
APPLY_OUT=$(bash "$NOTION_SH" update-datasource "$DS_ID" "$PROPS_JSON" 2>&1)
APPLY_RC=$?

if [ $APPLY_RC -ne 0 ] && printf '%s' "$APPLY_OUT" | grep -qi color; then
  # Notion 拒絕新增項的 color 欄 → 去掉新增項的 color 重試一次
  STRIPCOLOR_PY="$TMPDIR/stripcolor.py"
  cat > "$STRIPCOLOR_PY" <<'PY'
import json, sys
d = json.load(sys.stdin)
for o in d['AI分析']['select']['options']:
    if 'id' not in o:
        o.pop('color', None)
print(json.dumps(d, ensure_ascii=False))
PY
  PROPS_JSON_NOCOLOR=$(printf '%s' "$PROPS_JSON" | python3 "$STRIPCOLOR_PY")
  APPLY_OUT=$(bash "$NOTION_SH" update-datasource "$DS_ID" "$PROPS_JSON_NOCOLOR" 2>&1)
  APPLY_RC=$?
fi

if [ $APPLY_RC -ne 0 ]; then
  echo "RESULT: BLOCKED(update-datasource 失敗: $(printf '%s' "$APPLY_OUT" | head -c 200))"
  exit 1
fi
echo "RESULT: APPLIED"

# ---- 5. read-back 驗證 ----
GET2_OUT=$(bash "$NOTION_SH" get-datasource "$DS_ID" 2>&1)
GET2_RC=$?
printf '%s' "$EXPECTED_B64" | base64 -d > "$TMPDIR/expected_names.txt"
if [ $GET2_RC -ne 0 ] || [ -z "$GET2_OUT" ]; then
  echo "READBACK: MISMATCH(read-back GET 失敗: $(printf '%s' "$GET2_OUT" | head -c 200))"
  exit 1
fi
printf '%s' "$GET2_OUT" > "$TMPDIR/get2.json"

READBACK_PY="$TMPDIR/readback.py"
cat > "$READBACK_PY" <<'PY'
import json, sys

expected_file, actual_file = sys.argv[1], sys.argv[2]
with open(expected_file, encoding='utf-8') as f:
    expected = {x for x in f.read().split('\n') if x}
try:
    with open(actual_file, encoding='utf-8') as f:
        d = json.load(f)
    opts = ((d.get('properties') or {}).get('AI分析') or {}).get('select', {}).get('options', [])
    actual = {o.get('name', '') for o in opts}
except Exception as e:
    print(f"MISMATCH:讀取失敗 {e}")
    sys.exit(0)

missing = expected - actual
extra = actual - expected
if missing or extra:
    parts = []
    if missing:
        parts.append('missing=' + ','.join(sorted(missing)))
    if extra:
        parts.append('extra=' + ','.join(sorted(extra)))
    print("MISMATCH:" + ' '.join(parts))
else:
    print("OK")
PY

RB_OUT=$(python3 "$READBACK_PY" "$TMPDIR/expected_names.txt" "$TMPDIR/get2.json")
if [ "$RB_OUT" = "OK" ]; then
  echo "READBACK: OK"
  exit 0
else
  echo "READBACK: MISMATCH(${RB_OUT#MISMATCH:})"
  exit 1
fi
