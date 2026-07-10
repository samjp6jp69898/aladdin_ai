#!/bin/bash
# test-dcr.sh — /daily-code-review 腳本層回歸測試
#
# 目的：固化 2026-07-03 v3 重寫＋兩輪對抗審查驗過的行為。未來任何人（尤其是弱模型）
# 修改 scan-workload.ts / collect-critical.ts / templates/ 之後，必須跑本測試全綠才算完成
# （對應 .claude/doctrine/40-maintenance-protocol.md 第 2 節的「scripts 需實測」）。
#
# 用法：bash /Users/user/aladdin/obsidian/skills/daily-code-review/test-dcr.sh
#   - 全部在 mktemp 沙盒內進行（--no-fetch --out-root），不碰真實 review/、不寫 4 repo
#   - git 依賴的案例會自動探測近 14 天內有 commit 的窗口；探測不到則 SKIP 該組（parser 組照跑）
# 結果：每案 PASS/FAIL 一行，最後總結；任一 FAIL → exit 1
set -u
DCR=/Users/user/aladdin/obsidian/skills/daily-code-review
SANDBOX="$(mktemp -d /tmp/dcr-test.XXXXXX)"
PASS=0; FAIL=0; SKIP=0

ok()   { PASS=$((PASS+1)); echo "PASS  $1"; }
bad()  { FAIL=$((FAIL+1)); echo "FAIL  $1 — $2"; }
skip() { SKIP=$((SKIP+1)); echo "SKIP  $1 — $2"; }

# ---------- T1: 參數防呆（不依賴 git） ----------
bun "$DCR/scan-workload.ts" 20260601 20260602 20260603 --no-fetch --out-root "$SANDBOX/t1" >/dev/null 2>&1
[ $? -eq 2 ] && ok "T1a scan 拒收 3 個日期(exit 2)" || bad "T1a" "3 dates 未回 exit 2"
bun "$DCR/scan-workload.ts" --bogus >/dev/null 2>&1
[ $? -eq 2 ] && ok "T1b scan 拒收未知參數(exit 2)" || bad "T1b" "--bogus 未回 exit 2"
bun "$DCR/collect-critical.ts" 20990101 --batch 1 --out-root "$SANDBOX" >/dev/null 2>&1
[ $? -eq 2 ] && ok "T1c collect 拒收 --batch 無 --check(exit 2)" || bad "T1c" "--batch without --check 未回 exit 2"

# ---------- T2: collect parser 與 CSV（不依賴 git） ----------
L=t2label; mkdir -p "$SANDBOX/$L/_critical"
printf 'AUTHOR: Alice\nWINDOW: 2026/07/02\nP0 ||| SQL injection ||| a.ts:1\nP1 ||| 含逗號,引號"的描述 ||| b.ts:2\n' > "$SANDBOX/$L/_critical/Alice_$L.critical.md"
printf 'AUTHOR: Bob\nWINDOW: 2026/07/02\nNone\n' > "$SANDBOX/$L/_critical/Bob_$L.critical.md"        # 大寫 None 應寬容
printf 'AUTHOR: Carol\nWINDOW: 2026/07/02\nnone\n' > "$SANDBOX/$L/_critical/Carol_$L.critical.md"
bun "$DCR/collect-critical.ts" "$L" --out-root "$SANDBOX" >"$SANDBOX/t2.out" 2>"$SANDBOX/t2.err"
RC=$?
CSV="$SANDBOX/$L/CRITICAL_ISSUES_$L.csv"
[ $RC -eq 0 ] && ok "T2a 合法輸入 exit 0（None 大寫寬容）" || bad "T2a" "exit=$RC stderr=$(head -2 "$SANDBOX/t2.err")"
grep -q '"含逗號,引號""的描述"' "$CSV" && ok "T2b CSV 逗號/引號轉義正確" || bad "T2b" "轉義列缺失: $(cat "$CSV")"
[ "$(grep -vc '^問題描述' "$CSV")" = "2" ] && ok "T2c CSV 恰 2 筆資料列" || bad "T2c" "列數=$(grep -vc '^問題描述' "$CSV")"
bun "$DCR/collect-critical.ts" "$L" --out-root "$SANDBOX" >"$SANDBOX/t2b.out" 2>/dev/null
grep -q "appended: 0" "$SANDBOX/t2b.out" && ok "T2d 冪等（二跑 appended:0）" || bad "T2d" "$(grep STATS "$SANDBOX/t2b.out")"
printf 'AUTHOR: Dave\nWINDOW: 2026/07/02\nP0|P1 ||| 字面歧義寫法 ||| c.ts:3\n' > "$SANDBOX/$L/_critical/Dave_$L.critical.md"
bun "$DCR/collect-critical.ts" "$L" --out-root "$SANDBOX" >/dev/null 2>"$SANDBOX/t2c.err"
[ $? -eq 1 ] && grep -q "unparseable" "$SANDBOX/t2c.err" && ok "T2e 字面 P0|P1 拒收（exit 1＋警告）" || bad "T2e" "未拒收字面 P0|P1"

# ---------- T7: coverage-audit 子指令（唯讀，不依賴 git 歷史；未來窗口必無 commit） ----------
bun "$DCR/scan-workload.ts" coverage-audit --bogus >/dev/null 2>&1
[ $? -eq 2 ] && ok "T7a coverage-audit 拒收未知參數(exit 2)" || bad "T7a" "--bogus 未回 exit 2"
mkdir -p "$SANDBOX/cov/20991203"
bun "$DCR/scan-workload.ts" coverage-audit 20991201 20991205 --no-fetch --out-root "$SANDBOX/cov" >"$SANDBOX/t7.out" 2>&1
RC7=$?
{ [ $RC7 -eq 0 ] && grep -q "無缺口" "$SANDBOX/t7.out"; } && ok "T7b 未來窗口無 commit → 無缺口(exit 0)" || bad "T7b" "exit=$RC7 out=$(tail -1 "$SANDBOX/t7.out")"
bun "$DCR/scan-workload.ts" coverage-audit 20991205 20991201 --no-fetch >/dev/null 2>&1
[ $? -eq 2 ] && ok "T7c start>end 報錯(exit 2)" || bad "T7c" "start>end 未回 exit 2"

# ---------- 探測 git 依賴測試用的窗口 ----------
WINDOW=""
probe() { # $1=起 $2=迄（YYYYMMDD）
  bun "$DCR/scan-workload.ts" "$1" "$2" --no-fetch --out-root "$SANDBOX/probe-$1" 2>/dev/null | head -1
}
for back in 1 2 3 7 14; do
  D=$(python3 -c "from datetime import datetime,timedelta,timezone; print((datetime.now(timezone(timedelta(hours=8)))-timedelta(days=$back)).strftime('%Y%m%d'))")
  FIRST=$(probe "$D" "$D")
  case "$FIRST" in "[SCAN]"*) WINDOW="$D";; esac
  [ -n "$WINDOW" ] && break
done

if [ -z "$WINDOW" ]; then
  skip "T3–T6" "近 14 天無 dev−pro 未合併 commit，git 依賴案例無資料（parser 組已測）"
else
  S="$SANDBOX/git"; bun "$DCR/scan-workload.ts" "$WINDOW" --no-fetch --out-root "$S" >"$SANDBOX/t3.out" 2>&1
  DJ="$S/$WINDOW/_dispatch/dispatch.json"
  # ---------- T3: scan 基本 ----------
  [ -f "$DJ" ] && ok "T3a dispatch.json 生成" || bad "T3a" "缺 $DJ"
  NAGENT=$(python3 -c "import json;print(len(json.load(open('$DJ'))['agents']))" 2>/dev/null || echo 0)
  [ "$NAGENT" -ge 1 ] && ok "T3b agents ≥1（=${NAGENT}）" || bad "T3b" "agents=$NAGENT"
  if grep -rlE '\{\{[A-Z_]+\}\}' "$S/$WINDOW/_dispatch/" --include='*.md' >/dev/null 2>&1; then bad "T3c" "prompt 檔有未替換佔位符"; else ok "T3c prompt 檔無 {{WORD}} 殘留"; fi

  # 取第一個 author 的檔名資訊
  eval "$(python3 -c "
import json; d=json.load(open('$DJ')); a=d['agents'][0]['authors'][0]
print(f'A_REPORT=\"{a[\"report_file\"]}\"'); print(f'A_CRIT=\"{a[\"critical_file\"]}\"'); print(f'A_NAME=\"{a[\"name\"]}\"')")"
  BASE="${A_REPORT%.md}"

  # ---------- T4: 收斂序列（審查 MAJOR-3＋復核 finding 的固化） ----------
  echo x > "$A_REPORT"   # crash：只有報告、無 critical
  bun "$DCR/scan-workload.ts" "$WINDOW" --no-fetch --skip-existing --out-root "$S" >"$SANDBOX/t4a.out" 2>&1
  DJ2="$S/$WINDOW/_dispatch/dispatch.json"
  R2=$(python3 -c "
import json; d=json.load(open('$DJ2'))
m=[a['report_file'] for ag in d['agents'] for a in ag['authors'] if a['name']=='$A_NAME']
print(m[0] if m else 'ABSENT')")
  case "$R2" in *_r2.md) ok "T4a crash author 不被 skip、改派 _r2";; *) bad "T4a" "expected _r2, got $R2";; esac
  echo x > "${BASE}_r2.md"
  printf 'AUTHOR: %s\nWINDOW: x\nnone\n' "$A_NAME" > "$S/$WINDOW/_critical/$(basename "$BASE")_r2.critical.md"
  bun "$DCR/scan-workload.ts" "$WINDOW" --no-fetch --skip-existing --out-root "$S" >"$SANDBOX/t4b.out" 2>&1
  grep -q "SKIPPED_AUTHORS" "$SANDBOX/t4b.out" && grep -q "$A_NAME" "$SANDBOX/t4b.out" && ok "T4b _r2 完成後被 skip（收斂）" || bad "T4b" "$(head -3 "$SANDBOX/t4b.out")"
  python3 -c "
import json; d=json.load(open('$S/$WINDOW/_dispatch/dispatch.json'))
for ag in d['agents']:
    for a in ag['authors']:
        open(a['report_file'],'w').write('x')
        open(a['critical_file'],'w').write(f'AUTHOR: {a[\"name\"]}\nWINDOW: x\nnone\n')" 2>/dev/null
  OUT=$(bun "$DCR/scan-workload.ts" "$WINDOW" --no-fetch --skip-existing --out-root "$S" 2>&1 | head -1)
  case "$OUT" in "[DONE]"*) ok "T4c 全員完成 → [DONE]";; *) bad "T4c" "$OUT";; esac
  OUT=$(bun "$DCR/scan-workload.ts" "$WINDOW" --no-fetch --skip-existing --out-root "$S" 2>&1 | head -1)
  case "$OUT" in "[DONE]"*) ok "T4d 再跑仍 [DONE]（穩定收斂、不派 _r3）";; *) bad "T4d" "$OUT";; esac

  # ---------- T5: --check --batch 過濾（審查 BLOCKER-1 的固化） ----------
  # T4c 已把最後一版 dispatch 的全部檔案補齊 → batch 1 必 all done
  bun "$DCR/collect-critical.ts" "$WINDOW" --check --batch 1 --out-root "$S" >"$SANDBOX/t5.out" 2>&1
  grep -q "batch 1: all done" "$SANDBOX/t5.out" && ok "T5a --batch 1 精準驗收" || bad "T5a" "$(tail -1 "$SANDBOX/t5.out")"
  bun "$DCR/collect-critical.ts" "$WINDOW" --check --batch 99 --out-root "$S" >/dev/null 2>&1
  [ $? -eq 2 ] && ok "T5b 非法 batch 號報錯(exit 2)" || bad "T5b" "batch 99 未報錯"

  # ---------- T6: 非 skip 模式 _rK 遞增不受影響 ----------
  bun "$DCR/scan-workload.ts" "$WINDOW" --no-fetch --out-root "$S" >/dev/null 2>&1
  R3=$(python3 -c "
import json; d=json.load(open('$S/$WINDOW/_dispatch/dispatch.json'))
m=[a['report_file'] for ag in d['agents'] for a in ag['authors'] if a['name']=='$A_NAME']
print(m[0] if m else 'ABSENT')")
  case "$R3" in *_r*.md) ok "T6 非 skip 重跑遞增到下一代（$(basename "$R3")）";; *) bad "T6" "expected _rK, got $R3";; esac
fi

echo "----------------------------------------"
echo "RESULT: $PASS passed / $FAIL failed / $SKIP skipped  (sandbox: $SANDBOX)"
[ $FAIL -eq 0 ] || exit 1
