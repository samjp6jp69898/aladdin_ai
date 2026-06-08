#!/usr/bin/env bash
# tg-map-chatids.sh — 把 Telegram bot 的 DM chat_id 對映到 tech-users.csv 的 tg_chat_id 欄
# 用法：
#   tg-map-chatids.sh --list                      # 唯讀：輸出待處理對映表（TSV），不寫任何東西
#   tg-map-chatids.sh --set <email> <chat_id> [--force]   # 寫入單列 tg_chat_id
#
# 環境變數（皆可覆寫，預設對齊 tg-notify.sh）：
#   TG_NOTIFY_CSV     tech-users.csv 路徑（與 tg-notify.sh 同一變數）
#   TG_ENV_FILE       讀 TELEGRAM_BOT_TOKEN 的 .env（getUpdates 用；預設 /Users/user/aladdin/.env，與 tg-notify.sh 同一支 bot）
#   TG_API_BASE       Telegram API base（預設 https://api.telegram.org）
#   TG_GETUPDATES_CMD 覆寫 getUpdates 取得方式（測試用 stub）：被呼叫為 `$TG_GETUPDATES_CMD`（不帶參數），
#                     須印出 getUpdates 風格 JSON `{"ok":true,"result":[{"message":{"chat":{...}}}, ...]}`
#
# 來源：直接讀「誰 DM 過本 bot」——呼叫 bot 自己的 getUpdates（不依賴 telegram channel 的 access.json）。
# 紀律：
#   - --list 只讀 getUpdates、不帶 offset（不確認更新），Telegram 仍緩衝近 ~24h 未確認更新，冪等可重跑。
#   - --list 跳過已對映 chat_id。
#   - --set 遇既有「不同」非空 chat_id 一律拒絕，除非 --force。
set -uo pipefail

CSV="${TG_NOTIFY_CSV:-/Users/user/aladdin/obsidian/commands/create-mr/references/tech-users.csv}"

usage(){
  cat >&2 <<'U'
usage:
  tg-map-chatids.sh --list
  tg-map-chatids.sh --set <email> <chat_id> [--force]
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
}

# ───────────────────────── --list（python：getUpdates + 比對信心）─────────────────────────
do_list(){
  TG_NOTIFY_CSV="$CSV" python3 - <<'PYEOF'
import sys, os, re, json, subprocess

csv_path       = os.environ["TG_NOTIFY_CSV"]
env_file       = os.environ.get("TG_ENV_FILE", "/Users/user/aladdin/.env")
api_base       = os.environ.get("TG_API_BASE", "https://api.telegram.org")
getupdates_cmd = os.environ.get("TG_GETUPDATES_CMD", "").strip()

def die(msg):
    sys.stderr.write(msg + "\n"); sys.exit(1)

# ── 來源 chat_id：本 bot 的 getUpdates（誰 DM 過本 bot）；不依賴 telegram channel 的 access.json ──
# 唯讀紀律：不帶 offset、不確認更新；Telegram 仍緩衝近 ~24h 的未確認更新，可重複跑。
def fetch_updates():
    if getupdates_cmd:
        try:
            out = subprocess.run(getupdates_cmd.split(), capture_output=True, text=True, timeout=20).stdout
        except Exception as e:
            die(f"LIST_ERR_GETUPDATES_STUB: {e}")
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
            die(f"LIST_ERR_GETUPDATES: {e}")
    try:
        j = json.loads(out)
    except Exception as e:
        die(f"LIST_ERR_BAD_JSON: {e}")
    if not j.get("ok"):
        die(f"LIST_ERR_NOT_OK: {j.get('description', '')}")
    return j.get("result", []) or []

updates = fetch_updates()
if len(updates) >= 100:
    sys.stderr.write("LIST_WARN: getUpdates 回傳達上限 100，可能有更多未顯示（請被遺漏者重發 DM 後再跑）\n")

# 逐 update 取私聊 chat 的 id + 名稱（後到覆蓋，保留首次出現順序）
info_by_cid, order = {}, []
def consider(msg):
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
for upd in updates:
    consider(upd.get("message") or upd.get("edited_message") or {})

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
    w("\t".join([cid, "getUpdates", fn, un, conf, cemail, cname, alt]) + "\n")
PYEOF
}

# ───────────────────────── dispatch ─────────────────────────
case "${1:-}" in
  --list) shift; do_list ;;
  --set)  shift; do_set "${1:-}" "${2:-}" "${3:-}" ;;
  -h|--help|"") usage; exit 2 ;;
  *) echo "unknown mode: $1" >&2; usage; exit 2 ;;
esac
