#!/usr/bin/env bash
# tg-map-chatids.sh — 把 Telegram bot 的 DM chat_id 對映到 tech-users.csv 的 tg_chat_id 欄
# 用法：
#   tg-map-chatids.sh --list                      # 唯讀：輸出待處理對映表（TSV），不寫任何東西
#   tg-map-chatids.sh --set <email> <chat_id> [--force]   # 寫入單列 tg_chat_id
#
# 環境變數（皆可覆寫，預設對齊 tg-notify.sh）：
#   TG_NOTIFY_CSV       tech-users.csv 路徑（與 tg-notify.sh 同一變數）
#   TG_ENV_FILE         讀 TELEGRAM_BOT_TOKEN 的 .env（getUpdates 用；預設 /Users/user/aladdin/aladdin_ai/.env.local，與 tg-notify.sh 同一支 bot）
#   TG_API_BASE         Telegram API base（預設 https://api.telegram.org）
#   TG_GETUPDATES_CMD   覆寫 getUpdates 取得方式（測試用 stub）：被呼叫為 `$TG_GETUPDATES_CMD`（不帶參數），
#                       須印出 getUpdates 風格 JSON `{"ok":true,"result":[{"message":{"chat":{...}}}, ...]}`
#   TG_UNKNOWN_SENDERS_LOG  telegram-dispatcher 的未知 sender log 路徑（JSONL，每行
#                       {"ts","chat_id","first_name","last_name","username"}）；預設
#                       /Users/user/aladdin/telegram-dispatcher/logs/unknown-senders.jsonl
#   TG_RESTART_CMD      --set 成功寫入 CSV 後用來重啟 telegram-dispatcher 的指令（測試用 stub，
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
#     不中止（CSV 已經寫成功，不能因為重啟失敗就回報整體失敗）。--unset 目前不重啟
#     （移除白名單只是延後生效到下次重啟，非新增授權，風險方向不同，故未比照處理）。
set -uo pipefail

CSV="${TG_NOTIFY_CSV:-/Users/user/aladdin/aladdin_ai/commands/create-mr/references/tech-users.csv}"

usage(){
  cat >&2 <<'U'
usage:
  tg-map-chatids.sh --list
  tg-map-chatids.sh --set <email> <chat_id> [--force]
  tg-map-chatids.sh --unset <email>
U
}

# ───────────────────────── --set（純 bash，header-aware 單格編輯）─────────────────────────
do_set(){
  local email="${1:-}" chat="${2:-}" force=0
  case "${3:-}" in --force) force=1;; esac
  [ -z "$email" ] || [ -z "$chat" ] && { echo "SET_ERR_ARGS: need <email> <chat_id>"; return 0; }
  [ ! -f "$CSV" ] && { echo "SET_ERR_NO_CSV: $CSV"; return 0; }

  # header-aware 欄位索引（1-based，給 awk 用）；本 CSV 純逗號切分，欄位值不得含逗號
  local header ecol ccol
  header="$(head -n1 "$CSV" | tr -d '\r')"
  ecol="$(awk -F',' -v want=email     'NR==1{for(i=1;i<=NF;i++)if($i==want){print i;exit}}' "$CSV")"
  ccol="$(awk -F',' -v want=tg_chat_id 'NR==1{for(i=1;i<=NF;i++)if($i==want){print i;exit}}' "$CSV")"
  [ -z "$ecol" ] || [ -z "$ccol" ] && { echo "SET_ERR_NO_COL: email/tg_chat_id 欄缺失"; return 0; }

  # 找該 email 列的現值；找不到 → exit 3
  local cur rc
  cur="$(awk -F',' -v e="$email" -v ec="$ecol" -v cc="$ccol" \
        'NR>1 && $ec==e{gsub(/[ \t\r]/,"",$cc); print $cc; f=1} END{if(!f)exit 3}' "$CSV")"
  rc=$?
  [ "$rc" -eq 3 ] && { echo "SET_ERR_NO_EMAIL: $email"; return 0; }

  if [ "$cur" = "$chat" ]; then
    echo "SET_NOOP: $email $chat"; return 0
  fi
  if [ -n "$cur" ] && [ "$force" -ne 1 ]; then
    echo "SET_CONFLICT: $email has $cur (want $chat); use --force"; return 0
  fi

  local tmp; tmp="$(mktemp)"
  awk -F',' -v OFS=',' -v e="$email" -v ec="$ecol" -v cc="$ccol" -v v="$chat" \
    'NR>1 && $ec==e{$cc=v} {print}' "$CSV" > "$tmp" && mv "$tmp" "$CSV"
  echo "SET_OK: $email $chat"

  # 2026-08-25（使用者要求）：telegram-dispatcher 的白名單快取是 process 存活期間
  # 只讀一次（見 lib/user-resolution/tech-user.ts），--set 寫入 CSV 後若不重啟，
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

# ───────────────────────── --unset（取消連接：清空 tg_chat_id，不刪除整列）─────────────────────────
do_unset(){
  local email="${1:-}"
  [ -z "$email" ] && { echo "UNSET_ERR_ARGS: need <email>"; return 0; }
  [ ! -f "$CSV" ] && { echo "UNSET_ERR_NO_CSV: $CSV"; return 0; }

  local ecol ccol
  ecol="$(awk -F',' -v want=email     'NR==1{for(i=1;i<=NF;i++)if($i==want){print i;exit}}' "$CSV")"
  ccol="$(awk -F',' -v want=tg_chat_id 'NR==1{for(i=1;i<=NF;i++)if($i==want){print i;exit}}' "$CSV")"
  [ -z "$ecol" ] || [ -z "$ccol" ] && { echo "UNSET_ERR_NO_COL: email/tg_chat_id 欄缺失"; return 0; }

  local cur rc
  cur="$(awk -F',' -v e="$email" -v ec="$ecol" -v cc="$ccol" \
        'NR>1 && $ec==e{gsub(/[ \t\r]/,"",$cc); print $cc; f=1} END{if(!f)exit 3}' "$CSV")"
  rc=$?
  [ "$rc" -eq 3 ] && { echo "UNSET_ERR_NO_EMAIL: $email"; return 0; }

  if [ -z "$cur" ]; then
    echo "UNSET_NOOP: $email (已經沒有 chat_id)"; return 0
  fi

  local tmp; tmp="$(mktemp)"
  awk -F',' -v OFS=',' -v e="$email" -v ec="$ecol" -v cc="$ccol" \
    'NR>1 && $ec==e{$cc=""} {print}' "$CSV" > "$tmp" && mv "$tmp" "$CSV"
  echo "UNSET_OK: $email (was $cur)"
}

# ───────────────────────── --list（python：webhook-log + getUpdates + 比對信心）─────────────────────────
do_list(){
  TG_NOTIFY_CSV="$CSV" python3 - <<'PYEOF'
import sys, os, re, json, subprocess

csv_path        = os.environ["TG_NOTIFY_CSV"]
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

# ── CSV 名冊 + 已對映 chat_id 集合 ──
import csv as csvmod
rows = []
with open(csv_path, newline="", encoding="utf-8") as f:
    r = csvmod.reader(f)
    header = next(r)
    iname, iemail, ichat = (header.index("notion_user_name"),
                            header.index("email"), header.index("tg_chat_id"))
    for rec in r:
        if not rec or all(c.strip() == "" for c in rec):
            continue
        rows.append({"name": rec[iname], "email": rec[iemail],
                     "chat": (rec[ichat] if len(rec) > ichat else "").strip()})
mapped = {x["chat"] for x in rows if x["chat"]}

# ── 比對工具 ──
def norm(s): return re.sub(r"\s+", "", (s or "")).lower()
def localpart(email):
    lp = email.split("@")[0].lower()
    for pre in ("pkh_", "ptp_"):
        if lp.startswith(pre):
            lp = lp[len(pre):]
    return lp

def candidates(info):
    fn = norm(info.get("first_name")); ln = norm(info.get("last_name")); fnln = fn + ln
    un = re.sub(r"\d+$", "", (info.get("username") or "")).lower()
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
  --set)   shift; do_set "${1:-}" "${2:-}" "${3:-}" ;;
  --unset) shift; do_unset "${1:-}" ;;
  -h|--help|"") usage; exit 2 ;;
  *) echo "unknown mode: $1" >&2; usage; exit 2 ;;
esac
