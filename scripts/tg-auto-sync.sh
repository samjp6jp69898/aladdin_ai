#!/usr/bin/env bash
# tg-auto-sync.sh — 收到「還沒連接過」的 unknown sender 訊息後自動觸發的比對流程。
# 由 telegram-dispatcher（lib/security/whitelist.ts）在偵測到全新 chat_id 時
# background 觸發（fire-and-forget，不阻塞 webhook 回應），也可以手動重跑
# （全程冪等）。
#
# 行為（複用 tg-map-chatids.sh --list 的信心判斷，不重新實作比對邏輯）：
#   HIGH → 自動 --set，成功後發確認訊息給該同事（比照 /tg-chatid-sync 流程）。
#   ASK  → 不自行裁定候選（tg-chatid-sync SKILL.md 的硬紀律：「ASK 一定問使用
#          者，不自行裁定」）。改發一則通知給維運者（OPERATOR_CHAT_ID，同
#          health-monitor.ts 的告警對象），列出 chat_id / 名稱 / 候選 email，
#          讓人手動用 /tg-chatid-sync 決定；同一個 chat_id 只提醒一次
#          （ALERTED_FILE 記錄），避免同一人在被處理前每則訊息都轟炸維運者。
#
# 用法：bash tg-auto-sync.sh
# 覆寫用環境變數（測試用；生產不需設定）：
#   TG_MAP_SCRIPT / TG_NOTIFY_SCRIPT   換掉真正呼叫的子腳本
#   TG_AUTO_SYNC_LOG / TG_AUTO_SYNC_ALERTED_FILE / TG_AUTO_SYNC_LOCK_DIR
#   TG_AUTO_SYNC_OPERATOR_CHAT_ID
#   （TG_NOTIFY_CSV / TG_UNKNOWN_SENDERS_LOG 等會照原樣傳給子腳本，見它們自己的說明）
#
# 紀律：全程 exit 0，永不阻斷呼叫端（webhook message handler）；一律把結果寫進
# LOG_FILE 供事後稽核（比照 SKILL.md「自動不等於盲寫」——自動對映仍要留痕）。
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
MAP_SCRIPT="${TG_MAP_SCRIPT:-$HERE/tg-map-chatids.sh}"
NOTIFY_SCRIPT="${TG_NOTIFY_SCRIPT:-$HERE/tg-notify.sh}"
LOG_FILE="${TG_AUTO_SYNC_LOG:-/Users/user/aladdin/telegram-dispatcher/logs/tg-auto-sync.log}"
ALERTED_FILE="${TG_AUTO_SYNC_ALERTED_FILE:-/Users/user/aladdin/telegram-dispatcher/logs/tg-auto-sync-alerted.txt}"
LOCK_DIR="${TG_AUTO_SYNC_LOCK_DIR:-/tmp/tg-auto-sync.lock}"
OPERATOR_CHAT_ID="${TG_AUTO_SYNC_OPERATOR_CHAT_ID:-5022865804}" # 同 health-monitor.ts 的維運對象（Landon）

mkdir -p "$(dirname "$LOG_FILE")" "$(dirname "$ALERTED_FILE")"
touch "$ALERTED_FILE"

log(){ echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*" >> "$LOG_FILE"; }

# 同一時間只跑一個（mkdir 是原子操作，同 bug-lock.sh 慣例），避免併發寫 CSV。
# 搶不到鎖就直接放棄——另一個正在跑的 instance 的 --list 本來就會重掃全部
# pending，這筆不會漏。
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  log "SKIP_LOCKED: 已有另一個 instance 在跑"
  exit 0
fi
trap 'rmdir "$LOCK_DIR" 2>/dev/null' EXIT

OUT="$(bash "$MAP_SCRIPT" --list 2>>"$LOG_FILE")"
if [ -z "$OUT" ]; then
  log "NO_PENDING"
  exit 0
fi

while IFS= read -r tsvline; do
  [ -z "$tsvline" ] && continue
  # 注意：不能用 `IFS=$'\t' read -r a b c ...` 拆欄——bash 對純空白類 IFS
  # （tab 屬於此類，即使只設一個字元）會自動合併連續分隔符，TSV 裡的空欄位
  # （例如 ASK 列的 candidate_email/candidate_name）會被吞掉、後面欄位全部
  # 錯位。改用 cut -f 逐欄取值，空欄位也會正確保留。
  cid="$(cut -f1 <<< "$tsvline")"
  fn="$(cut -f3 <<< "$tsvline")"
  un="$(cut -f4 <<< "$tsvline")"
  conf="$(cut -f5 <<< "$tsvline")"
  cemail="$(cut -f6 <<< "$tsvline")"
  alt="$(cut -f8 <<< "$tsvline")"
  [ -z "$cid" ] && continue
  if [ "$conf" = "HIGH" ]; then
    res="$(bash "$MAP_SCRIPT" --set "$cemail" "$cid")"
    log "AUTO_HIGH $cid -> $cemail : $res"
    case "$res" in
      SET_OK:*)
        notify="$(bash "$NOTIFY_SCRIPT" --email "$cemail" --text "${fn} 連結成功")"
        log "NOTIFY_CONFIRM $cemail : $notify"
        ;;
    esac
  elif [ "$conf" = "ASK" ]; then
    if grep -qxF "$cid" "$ALERTED_FILE" 2>/dev/null; then
      continue
    fi
    msg="新同事待確認：chat_id=${cid} first_name=${fn} username=${un} 候選=${alt:-無}（跑 /tg-chatid-sync 手動比對）"
    alert="$(bash "$NOTIFY_SCRIPT" --chat-id "$OPERATOR_CHAT_ID" --text "$msg")"
    log "NOTIFY_OPERATOR $cid : $alert"
    echo "$cid" >> "$ALERTED_FILE"
  fi
done <<< "$OUT"
