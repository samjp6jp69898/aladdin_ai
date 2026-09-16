#!/usr/bin/env bash
# tg-map-chatids.sh — 把 Telegram bot 的 DM chat_id 對映到 tech_users 名冊的 tg_chat_id 欄
# 用法：
#   tg-map-chatids.sh --list                      # 唯讀：輸出待處理對映表（TSV），不寫任何東西
#   tg-map-chatids.sh --set <email> <chat_id> [--force]   # 寫入單列 tg_chat_id
#
# 環境變數（皆可覆寫，預設對齊 tg-notify.sh）：
#   TG_ENV_FILE         讀 TELEGRAM_BOT_TOKEN 的 .env（getUpdates 用；預設 /Users/user/aladdin/aladdin_ai/.env.local，與 tg-notify.sh 同一支 bot）
#   TG_API_BASE         Telegram API base（預設 https://api.telegram.org）
#   TG_GETUPDATES_CMD   覆寫 getUpdates 取得方式（測試用 stub）：被呼叫為 `$TG_GETUPDATES_CMD`（不帶參數），
#                       須印出 getUpdates 風格 JSON `{"ok":true,"result":[{"message":{"chat":{...}}}, ...]}`
#   TG_UNKNOWN_SENDERS_LOG  telegram-dispatcher 的未知 sender log 路徑（JSONL，每行
#                       {"ts","chat_id","first_name","last_name","username"}）；預設
#                       /Users/user/aladdin/telegram-dispatcher/logs/unknown-senders.jsonl
#   TG_RESTART_CMD      --set 成功寫入後用來重啟 telegram-dispatcher 的指令（測試用 stub，
#                       預設 `launchctl kickstart -k gui/<uid>/com.aladdin.tg-dispatch-server`）
#
# 來源（兩者合併，後者覆蓋前者的同 chat_id 資訊）：
#   1) telegram-dispatcher 的未知 sender log——本服務常駐掛 webhook，白名單外的私聊
#      chat_id 會被記一筆到這份 JSONL（見 telegram-dispatcher/lib/webhook-server/
#      unknown-sender-log.ts）。這是主要來源：webhook 常駐、不受 24h 視窗限制。
#   2) bot 自己的 getUpdates——僅在「這支 bot 目前沒有掛 webhook」時才讀得到資料
#      （Telegram 規定 webhook 與 getUpdates 互斥，webhook 掛著時 getUpdates 一律
#      409，此處視為正常情況、只警告不中止，不影響來源 1 的結果）。
# 紀律：
#   - --list 兩個來源都唯讀；getUpdates 不帶 offset（不確認更新）。
#   - --list 跳過已對映 chat_id。
#   - --set 遇既有「不同」非空 chat_id 一律拒絕，除非 --force。
#   - --unset 清空 tg_chat_id（取消連接），不刪除該 email 這一整列。
#   - --set 成功寫入後一律嘗試重啟 telegram-dispatcher（見 TG_RESTART_CMD），失敗只警告
#     不中止（DB 已經寫成功，不能因為重啟失敗就回報整體失敗）。--unset 目前不重啟
#     （移除白名單只是延後生效到下次重啟，非新增授權，風險方向不同，故未比照處理）。
#
# 2026-09-02（Phase 5 監控 DB 化）：--set/--unset 的寫入邏輯收斂到
# telegram-dispatcher/lib/registry/tech-users-sync.ts（單一寫入者）。
# CLI 呼叫本身失敗（bun 不在、腳本炸掉）一律 fail-loud exit 1，不回退舊 awk
# 路徑（與 aladdin_mcps 委派層同一裁定：silent fallback 會讓 DB 與檔案靜默
# 分岔）。輸出契約不變：呼叫端（tg-chatid-sync skill、tg-auto-sync.sh、
# tg-monitor lib/tg-users.ts）全部只做 SET_OK/UNSET_OK 等 prefix 比對；
# SET_OK 後的 dispatcher 重啟仍收斂在本檔（唯一出口，見 do_set）。
#
# 2026-09-16（Phase 6：tech-users.csv 刪檔退役）：本檔不再有 CSV 路徑——名冊
# 從 registry CLI 的 --list-roster 取得、「已連接」從 --check-connected 判斷
# （CSV 的 tg_chat_id 欄自 2026-09-15 起就已凍結不再更新，--list 過去用它濾掉
# 已對映的人，那個判斷從那天起就已經不準了，一併改對）。
#   TG_REGISTRY_CLI   覆寫 registry CLI 呼叫方式（測試用 stub）
set -uo pipefail

REGISTRY_CLI="${TG_REGISTRY_CLI:-bun /Users/user/aladdin/telegram-dispatcher/lib/registry/tech-users-sync.ts}"

usage(){
  cat >&2 <<'U'
usage:
  tg-map-chatids.sh --list
  tg-map-chatids.sh --list-roster
  tg-map-chatids.sh --list-connected
  tg-map-chatids.sh --check-connected <chat_id...>   # 放最後一個參數，會吞掉後面全部
  tg-map-chatids.sh --set <email> <chat_id> [--force]
  tg-map-chatids.sh --unset <email>
  tg-map-chatids.sh --move <old_email> <new_email>
U
}

# ───────────────────────── --set（委派 registry CLI；見檔頭 2026-09-02 註記）─────────────────────────
do_set(){
  local email="${1:-}" chat="${2:-}" force=0
  case "${3:-}" in --force) force=1;; esac
  [ -z "$email" ] || [ -z "$chat" ] && { echo "SET_ERR_ARGS: need <email> <chat_id>"; return 0; }

  local out rc
  if [ "$force" -eq 1 ]; then
    out="$($REGISTRY_CLI --set "$email" "$chat" --force 2>&1)"; rc=$?
  else
    out="$($REGISTRY_CLI --set "$email" "$chat" 2>&1)"; rc=$?
  fi
  [ -n "$out" ] && printf '%s\n' "$out"
  if [ "$rc" -ne 0 ]; then
    echo "SET_ERR_REGISTRY: tech-users-sync.ts exit ${rc}（fail-loud，未回退舊路徑）" >&2
    exit 1
  fi
  case "$out" in *SET_OK*) ;; *) return 0;; esac

  # 2026-08-25（使用者要求）：telegram-dispatcher 的白名單快取是 process 存活期間
  # 只讀一次（見 lib/user-resolution/tech-user.ts），--set 寫入名冊後若不重啟，
  # 剛連接的人在下一次重啟前仍會被白名單擋掉、拿不到任何回應。這裡是 --set 的
  # 唯一出口（tg-chatid-sync skill、tg-auto-sync.sh 的 AUTO_HIGH、tg-monitor 的
  # /api/tg-users/assign 全部只呼叫這支腳本，不重新實作寫入邏輯），在此收斂重啟
  # 動作即可涵蓋全部新增連接路徑，不用三處各自補。
  local restart_cmd
  restart_cmd="${TG_RESTART_CMD:-launchctl kickstart -k gui/$(id -u)/com.aladdin.tg-dispatch-server}"
  if $restart_cmd >/dev/null 2>&1; then
    echo "RESTART_OK: com.aladdin.tg-dispatch-server"
  else
    echo "RESTART_WARN: 重啟失敗，需自行重啟 com.aladdin.tg-dispatch-server 讓白名單生效"
  fi
}

# ───────────────────────── --unset（委派 registry CLI；清空 tg_chat_id，不刪除整列）─────────────────────────
do_unset(){
  local email="${1:-}"
  [ -z "$email" ] && { echo "UNSET_ERR_ARGS: need <email>"; return 0; }

  local out rc
  out="$($REGISTRY_CLI --unset "$email" 2>&1)"; rc=$?
  [ -n "$out" ] && printf '%s\n' "$out"
  if [ "$rc" -ne 0 ]; then
    echo "UNSET_ERR_REGISTRY: tech-users-sync.ts exit ${rc}（fail-loud，未回退舊路徑）" >&2
    exit 1
  fi
  return 0
}

# ───────────────────────── --move（委派 registry CLI；換綁 tg_chat_id 到另一個 email）─────────────────────────
# 2026-09-15（使用者決定 DB 為 tg_chat_id 唯一權威）：給 tg-monitor 的「更改
# 信箱」功能用。全程在 registry CLI（唯一有解密權限的模組）內完成換綁，明碼
# chat_id 不會流出那個行程，本腳本與呼叫端都看不到明碼。
do_move(){
  local old_email="${1:-}" new_email="${2:-}"
  { [ -z "$old_email" ] || [ -z "$new_email" ]; } && { echo "MOVE_ERR_ARGS: need <old_email> <new_email>"; return 0; }

  local out rc
  out="$($REGISTRY_CLI --move "$old_email" "$new_email" 2>&1)"; rc=$?
  [ -n "$out" ] && printf '%s\n' "$out"
  if [ "$rc" -ne 0 ]; then
    echo "MOVE_ERR_REGISTRY: tech-users-sync.ts exit ${rc}（fail-loud，未回退舊路徑）" >&2
    exit 1
  fi
  return 0
}

# ───────────────────────── --list-roster（委派 registry CLI；名冊四欄，不含 chat_id）─────────────────────────
# 2026-09-16：取代「下游各自讀 tech-users.csv」。輸出即 CSV（header +
# notion_user_name,notion_user_id,email,pushed_repos），純逗號切分。
do_list_roster(){
  local out rc
  out="$($REGISTRY_CLI --list-roster 2>&1)"; rc=$?
  [ -n "$out" ] && printf '%s\n' "$out"
  if [ "$rc" -ne 0 ]; then
    echo "LIST_ROSTER_ERR_REGISTRY: tech-users-sync.ts exit ${rc}" >&2
    exit 1
  fi
  return 0
}

# ───────────────────────── --list-connected（委派 registry CLI；只列 email，不含 chat_id）─────────────────────────
do_list_connected(){
  local out rc
  out="$($REGISTRY_CLI --list-connected 2>&1)"; rc=$?
  [ -n "$out" ] && printf '%s\n' "$out"
  if [ "$rc" -ne 0 ]; then
    echo "LIST_CONNECTED_ERR_REGISTRY: tech-users-sync.ts exit ${rc}" >&2
    exit 1
  fi
  return 0
}

# ───────────────────────── --check-connected（委派 registry CLI；依輸入順序回報，不迴響 chat_id）─────────────────────────
do_check_connected(){
  local out rc
  out="$($REGISTRY_CLI --check-connected "$@" 2>&1)"; rc=$?
  [ -n "$out" ] && printf '%s\n' "$out"
  if [ "$rc" -ne 0 ]; then
    echo "CHECK_CONNECTED_ERR_REGISTRY: tech-users-sync.ts exit ${rc}" >&2
    exit 1
  fi
  return 0
}

# ───────────────────────── --list（python：webhook-log + getUpdates + 比對信心）─────────────────────────
do_list(){
  TG_REGISTRY_CLI="$REGISTRY_CLI" python3 - <<'PYEOF'
import sys, os, re, json, subprocess

registry_cli    = os.environ["TG_REGISTRY_CLI"].split()
env_file        = os.environ.get("TG_ENV_FILE", "/Users/user/aladdin/aladdin_ai/.env.local")
api_base        = os.environ.get("TG_API_BASE", "https://api.telegram.org")
getupdates_cmd  = os.environ.get("TG_GETUPDATES_CMD", "").strip()
unknown_log     = os.environ.get("TG_UNKNOWN_SENDERS_LOG",
                    "/Users/user/aladdin/telegram-dispatcher/logs/unknown-senders.jsonl")

def die(msg):
    sys.stderr.write(msg + "\n"); sys.exit(1)

# ── 來源 1：telegram-dispatcher 的未知 sender log（見該檔 unknown-sender-log.ts）──
# webhook 常駐寫入，不受 getUpdates 的 ~24h 視窗限制，是主要來源。
def fetch_unknown_senders_log():
    if not os.path.isfile(unknown_log):
        return []
    out = []
    with open(unknown_log, encoding="utf-8") as f:
        for ln in f:
            ln = ln.strip()
            if not ln:
                continue
            try:
                row = json.loads(ln)
            except Exception:
                continue
            cid = row.get("chat_id")
            if cid is None:
                continue
            out.append({"message": {"chat": {
                "type": "private",
                "id": cid,
                "first_name": row.get("first_name") or "",
                "last_name":  row.get("last_name") or "",
                "username":   row.get("username") or "",
            }}})
    return out

# ── 來源 2：本 bot 的 getUpdates（誰 DM 過本 bot）；不依賴 telegram channel 的 access.json ──
# 唯讀紀律：不帶 offset、不確認更新；Telegram 仍緩衝近 ~24h 的未確認更新。
# webhook 掛著時 Telegram 一律回 409（webhook 與 getUpdates 互斥，二選一，不是設定
# 問題）——這是本服務常態，此處視為正常情況，只警告不中止、回空清單即可，來源 1
# 才是主要管道。
def fetch_updates():
    if getupdates_cmd:
        try:
            out = subprocess.run(getupdates_cmd.split(), capture_output=True, text=True, timeout=20).stdout
        except Exception as e:
            sys.stderr.write(f"LIST_WARN_GETUPDATES_SKIPPED: {e}\n"); return []
    else:
        token = ""
        try:
            with open(env_file, encoding="utf-8") as f:
                for ln in f:
                    if ln.startswith("TELEGRAM_BOT_TOKEN="):
                        token = ln.split("=", 1)[1].strip(); break
        except OSError as e:
            die(f"LIST_ERR_NO_ENV: {env_file} ({e})")
        if not token:
            die(f"LIST_ERR_NO_TOKEN: {env_file} 缺 TELEGRAM_BOT_TOKEN")
        import urllib.request
        url = f"{api_base}/bot{token}/getUpdates?limit=100"
        try:
            out = urllib.request.urlopen(url, timeout=20).read().decode()
        except Exception as e:
            sys.stderr.write(f"LIST_WARN_GETUPDATES_SKIPPED: {e}（webhook 掛著時屬正常，改讀未知 sender log）\n"); return []
    try:
        j = json.loads(out)
    except Exception as e:
        sys.stderr.write(f"LIST_WARN_GETUPDATES_SKIPPED: bad json ({e})\n"); return []
    if not j.get("ok"):
        sys.stderr.write(f"LIST_WARN_GETUPDATES_SKIPPED: {j.get('description', '')}\n"); return []
    return j.get("result", []) or []

log_entries = fetch_unknown_senders_log()
updates = fetch_updates()
if len(updates) >= 100:
    sys.stderr.write("LIST_WARN: getUpdates 回傳達上限 100，可能有更多未顯示（請被遺漏者重發 DM 後再跑）\n")

# 逐筆取私聊 chat 的 id + 名稱（後到覆蓋，保留首次出現順序）；先 getUpdates 後
# webhook-log，同 chat_id 時以 webhook-log（較新的主要來源）為準。
info_by_cid, source_by_cid, order = {}, {}, []
def consider(msg, source):
    chat = (msg or {}).get("chat") or {}
    if chat.get("type") != "private":
        return
    cid = chat.get("id")
    if cid is None:
        return
    cid = str(cid)
    if cid not in info_by_cid:
        order.append(cid)
    info_by_cid[cid] = {
        "first_name": chat.get("first_name") or "",
        "last_name":  chat.get("last_name") or "",
        "username":   chat.get("username") or "",
    }
    source_by_cid[cid] = source
for upd in updates:
    consider(upd.get("message") or upd.get("edited_message") or {}, "getUpdates")
for upd in log_entries:
    consider(upd.get("message") or {}, "webhook-log")

# ── 名冊（registry CLI --list-roster；DB 為唯一來源，見檔頭 2026-09-16）──
def load_roster():
    try:
        p = subprocess.run(registry_cli + ["--list-roster"], capture_output=True, text=True, timeout=30)
    except Exception as e:
        die(f"LIST_ERR_ROSTER: 呼叫 registry CLI 失敗 ({e})")
    if p.returncode != 0:
        die(f"LIST_ERR_ROSTER: registry CLI exit {p.returncode} {p.stderr.strip()}")
    lines = [ln for ln in p.stdout.split("\n") if ln.strip()]
    if not lines:
        die("LIST_ERR_ROSTER: registry CLI 回空輸出")
    header = lines[0].split(",")
    try:
        iname, iemail = header.index("notion_user_name"), header.index("email")
    except ValueError:
        die(f"LIST_ERR_ROSTER: 名冊欄位不如預期：{lines[0]}")
    out = []
    for ln in lines[1:]:
        rec = ln.split(",")
        if len(rec) <= max(iname, iemail):
            continue
        out.append({"name": rec[iname], "email": rec[iemail]})
    return out

# ── 已連接的 chat_id（registry CLI --check-connected；只拿布林，看不到明碼）──
# 過去這裡讀 CSV 的 tg_chat_id 欄，但那一欄自 2026-09-15 起就不再被寫入，
# 拿它當「已對映」判準會把早就連接好的人重新列成待處理。
def connected_flags(cids):
    if not cids:
        return []
    try:
        p = subprocess.run(registry_cli + ["--check-connected", *cids], capture_output=True, text=True, timeout=30)
    except Exception as e:
        die(f"LIST_ERR_CHECK_CONNECTED: 呼叫 registry CLI 失敗 ({e})")
    if p.returncode != 0:
        die(f"LIST_ERR_CHECK_CONNECTED: registry CLI exit {p.returncode} {p.stderr.strip()}")
    flags = [ln.strip() for ln in p.stdout.split("\n") if ln.strip() in ("CONNECTED", "NOT_CONNECTED")]
    if len(flags) != len(cids):
        die(f"LIST_ERR_CHECK_CONNECTED: 回傳行數（{len(flags)}）與輸入 chat_id 數（{len(cids)}）不符")
    return flags

rows = load_roster()
mapped = {cid for cid, flag in zip(order, connected_flags(order)) if flag == "CONNECTED"}

# ── 比對工具 ──
# 2026-09-08（ting xuan / 天狼星 leon_chennnn 兩案例配對不上後優化）：名冊名稱與
# email localpart 常見用 -/_/./空白 混用當分隔符（如「Ting-xuan」vs TG 顯示名
# 「Ting Xuan」、email「leon.chen」vs TG username「leon_chennnn」），原本只去空白
# 會讓這些同義分隔符被當成不同字元、比對失敗。一併去除後再比對（已對整份名冊
# 跑過 collision 檢查，無人因此撞名）。
def norm(s): return re.sub(r"[\s\-_./]+", "", (s or "")).lower()
def localpart(email):
    lp = email.split("@")[0].lower()
    for pre in ("pkh_", "ptp_"):
        if lp.startswith(pre):
            lp = lp[len(pre):]
    return norm(lp)

def candidates(info):
    fn = norm(info.get("first_name")); ln = norm(info.get("last_name")); fnln = fn + ln
    un = norm(re.sub(r"\d+$", "", (info.get("username") or "")))
    out = []
    for row in rows:
        nm = norm(row["name"])
        tokens = [norm(t) for t in re.split(r"\s+", row["name"].strip()) if t]
        lp = localpart(row["email"])
        name_sig = bool(fn) and (
            fn == nm or fnln == nm or fn in tokens or fnln in tokens
            or fn in nm or nm in fn
        )
        acct_sig = bool(un) and bool(lp) and (un == lp or lp in un or un in lp)
        if name_sig or acct_sig:
            out.append(row)
    return out

# ── 輸出（TSV，無表頭；欄位見檔頭與 SKILL.md）──
# chat_id  source  tg_first_name  tg_username  confidence  candidate_email  candidate_name  alt_candidates
w = sys.stdout.write
for cid in order:
    if cid in mapped:
        continue
    info = info_by_cid[cid]
    fn = info.get("first_name", "") or ""
    un = info.get("username", "") or ""
    cands = candidates(info)
    if len(cands) == 1:
        conf, cemail, cname, alt = "HIGH", cands[0]["email"], cands[0]["name"], ""
    else:
        conf, cemail, cname = "ASK", "", ""
        alt = ",".join(c["email"] for c in cands)
    w("\t".join([cid, source_by_cid[cid], fn, un, conf, cemail, cname, alt]) + "\n")
PYEOF
}

# ───────────────────────── dispatch ─────────────────────────
case "${1:-}" in
  --list)  shift; do_list ;;
  --list-roster) shift; do_list_roster ;;
  --list-connected) shift; do_list_connected ;;
  --check-connected) shift; do_check_connected "$@" ;;
  --set)   shift; do_set "${1:-}" "${2:-}" "${3:-}" ;;
  --unset) shift; do_unset "${1:-}" ;;
  --move)  shift; do_move "${1:-}" "${2:-}" ;;
  -h|--help|"") usage; exit 2 ;;
  *) echo "unknown mode: $1" >&2; usage; exit 2 ;;
esac
