#!/usr/bin/env bash
# resume-plan.sh 離線測試：resume-inventory 與 DB 查詢 CLI 全部用 stub
# （RESUME_INVENTORY_SH / RESUME_PLAN_QUERY_CMD 兩個環境變數覆寫），不碰真的
# git repo、不碰監控 DB。
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$HERE/resume-plan.sh"
TMP="$(mktemp -d)"
T=FAQ-999902

fail=0
has() { if printf '%s\n' "$1" | grep -qxF "$2"; then echo "PASS: $3"; else echo "FAIL: $3 — expected line [$2] in:"; printf '%s\n' "$1" | sed 's/^/    /'; fail=1; fi }
no() { if printf '%s\n' "$1" | grep -qxF "$2"; then echo "FAIL: $3 — 不該有 [$2]"; fail=1; else echo "PASS: $3"; fi }

# ── stub 1：resume-inventory.sh。輸出內容由 INV_POINT 決定 ──
cat > "$TMP/inv.sh" <<'STUB'
#!/bin/bash
echo "ANALYTICS: present"
echo "SPEC: present"
echo "GROUNDING: ${INV_GROUNDING:-present}"
echo "ANALYSIS_NOTES: ${INV_NOTES:-present}"
echo "REVIEW_A: PASSED"
echo "REVIEW_B: PASSED"
echo "REVIEW_C: PASSED"
echo "BRANCH_COMMITS: agrabah=3"
echo "RESUME_POINT: ${INV_POINT:-step7}"
STUB
chmod +x "$TMP/inv.sh"
export RESUME_INVENTORY_SH="$TMP/inv.sh"

# ── stub 2：DB 查詢 CLI。輸出由 DB_JSON 決定 ──
cat > "$TMP/query.sh" <<'STUB'
#!/bin/bash
echo "${DB_JSON:-{\"available\":false\}}"
STUB
chmod +x "$TMP/query.sh"
export RESUME_PLAN_QUERY_CMD="bash $TMP/query.sh"

# ── 1. DB 不可用（available:false）：輸出必須與 resume-inventory 逐位元組相同再加三行 ──
export DB_JSON='{"available":false}'
out="$(bash "$SCRIPT" "$T" main)"
inv="$(bash "$TMP/inv.sh")"
if [ "$(printf '%s\n' "$out" | head -n 9)" = "$inv" ]; then
  echo "PASS: DB 關閉時前 9 行與 resume-inventory 逐位元組相同"
else
  echo "FAIL: 前段輸出與 resume-inventory 不同"
  diff <(printf '%s\n' "$out" | head -n 9) <(printf '%s\n' "$inv") | sed 's/^/    /'
  fail=1
fi
[ "$(printf '%s\n' "$out" | wc -l | tr -d ' ')" = 12 ] && echo "PASS: 總行數 = 9 + 3" || { echo "FAIL: 總行數 $(printf '%s\n' "$out" | wc -l)"; fail=1; }
has "$out" "STAGE_SOURCE: files" "DB 不可用 → files"
has "$out" "ARTIFACT_HOST: local" "本機有 analysis-notes → local"
has "$out" "PRIOR_ANALYSIS: no" "未指定 mode → no"

# ── 2. DB 可用但這張票沒有紀錄 → 仍是 files ──
export DB_JSON='{"available":true,"stages":[],"artifact_sync":null}'
out="$(bash "$SCRIPT" "$T" main)"
has "$out" "STAGE_SOURCE: files" "DB 可用但查無紀錄 → files"

# ── 3. DB 有紀錄、本機沒有產物 → ARTIFACT_HOST 取 DB 的 host ──
export DB_JSON='{"available":true,"stages":[{"stage":"analytics","status":"done","host":"landon2","run_id":null,"mode":"analysis","finished_at":"2026-09-08 01:00:00.000"},{"stage":"analysis-notes","status":"done","host":"landon2","run_id":null,"mode":"analysis","finished_at":"2026-09-08 02:00:00.000"}],"artifact_sync":null}'
INV_NOTES=missing INV_GROUNDING=missing INV_POINT=step2 out="$(INV_NOTES=missing INV_GROUNDING=missing INV_POINT=step2 bash "$SCRIPT" "$T" main fix)"
has "$out" "STAGE_SOURCE: db" "DB 有紀錄 → db"
has "$out" "ARTIFACT_HOST: landon2" "本機無產物 → 取 DB host"
has "$out" "PRIOR_ANALYSIS: yes" "fix 模式 + DB 說 analysis-notes done → yes"

# ── 4. ticket_artifact_sync.source_host 優先於 stage host ──
export DB_JSON='{"available":true,"stages":[{"stage":"analysis-notes","status":"done","host":"landon2","run_id":null,"mode":"fix","finished_at":"2026-09-08 02:00:00.000"}],"artifact_sync":{"source_host":"landon3","head_synced_at":null,"last_attempt_at":"2026-09-08 03:00:00.000","file_count":null}}'
out="$(INV_NOTES=missing bash "$SCRIPT" "$T" main fix)"
has "$out" "ARTIFACT_HOST: landon3" "artifact_sync.source_host 優先"

# ── 5. 本機有產物時 local 壓過 DB host（plan §4.3 A1）──
out="$(bash "$SCRIPT" "$T" main fix)"
has "$out" "ARTIFACT_HOST: local" "本機有產物 → local 優先於 DB host"
has "$out" "PRIOR_ANALYSIS: yes" "fix 模式 + 本機有 analysis-notes → yes"

# ── 6. PRIOR_ANALYSIS 只在 fix/reanalyze 成立 ──
for m in "" full analysis; do
  out="$(bash "$SCRIPT" "$T" main "$m")"
  has "$out" "PRIOR_ANALYSIS: no" "mode='${m:-（空）}' → PRIOR_ANALYSIS no"
done
out="$(bash "$SCRIPT" "$T" main reanalyze)"
has "$out" "PRIOR_ANALYSIS: yes" "reanalyze + 本機有產物 → yes"

# ── 7. 模式上限：analysis/reanalyze 的 RESUME_POINT 最深 step2 ──
export DB_JSON='{"available":false}'
for m in analysis reanalyze; do
  for p in step4 step5 step6 step7; do
    out="$(INV_POINT=$p bash "$SCRIPT" "$T" main "$m")"
    has "$out" "RESUME_POINT: step2" "mode=$m + $p → 降為 step2"
  done
  for p in step1 step2; do
    out="$(INV_POINT=$p bash "$SCRIPT" "$T" main "$m")"
    has "$out" "RESUME_POINT: $p" "mode=$m + $p → 不動"
  done
done
# full / fix 不套上限
for m in full fix; do
  out="$(INV_POINT=step7 bash "$SCRIPT" "$T" main "$m")"
  has "$out" "RESUME_POINT: step7" "mode=$m + step7 → 不降"
  no "$out" "RESUME_POINT: step2" "mode=$m 不出現 step2"
done

# ── 8. DB 查詢 CLI 壞掉（非零退出／印垃圾）→ 不影響前段、三行安全退回 ──
cat > "$TMP/query.sh" <<'STUB'
#!/bin/bash
echo "boom: not json" >&2
exit 3
STUB
out="$(bash "$SCRIPT" "$T" main fix)"
has "$out" "RESUME_POINT: step7" "查詢 CLI 壞掉不影響 RESUME_POINT"
has "$out" "STAGE_SOURCE: files" "查詢 CLI 壞掉 → files"
has "$out" "PRIOR_ANALYSIS: yes" "查詢 CLI 壞掉仍能用本機檔案判 PRIOR_ANALYSIS"

# ── 9. ticket 格式錯誤：resume-inventory 自己會噴 ERROR + step1，本腳本照樣加三行 ──
unset RESUME_INVENTORY_SH
out="$(bash "$SCRIPT" "NOT-A-TICKET" main)"
has "$out" "RESUME_POINT: step1" "非法 ticket → step1（沿用 resume-inventory 的行為）"
has "$out" "STAGE_SOURCE: files" "非法 ticket → files"
has "$out" "ARTIFACT_HOST: unknown" "非法 ticket → unknown"

rm -rf "$TMP"
[ "$fail" = 0 ] && echo "ALL PASS" || echo "SOME FAILED"
exit "$fail"
