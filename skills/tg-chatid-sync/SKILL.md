---
name: tg-chatid-sync
description: Use when 需要把 DM 過 Telegram bot 的 chat_id 對映回填 tech-users.csv 的 tg_chat_id 欄、有人 DM 過 bot 但 CSV 還沒填 chat_id、pipeline 通知對某技術發不出去（TG_SKIP_NO_CHATID）、或新技術剛配對完要連結 Telegram 通知。
---

# tg-chatid-sync — Telegram chat_id 回填 tech-users.csv

## Overview

直接讀「誰 DM 過本 bot」，來源有兩個（`--list` 自動合併）：

1. **telegram-dispatcher 的未知 sender log（主要來源）**——`telegram-dispatcher` 是一支常駐掛 webhook 的正式服務（見 `/Users/user/aladdin/telegram-dispatcher`），白名單外的私聊 chat_id 原本一律靜默 return、不留任何痕跡；2026-08-21 起改為額外記一筆到 `telegram-dispatcher/logs/unknown-senders.jsonl`（見該 repo `lib/webhook-server/unknown-sender-log.ts`），不受下面第 2 點的 24h 視窗限制。
2. **bot 自己的 Bot API `getUpdates`（唯讀、不帶 offset、不確認更新）**——但 Telegram 規定同一支 bot **webhook 與 getUpdates 互斥**，`telegram-dispatcher` 平常都掛著 webhook，此時 getUpdates 一律回 409 Conflict（`--list` 對此視為正常情況，只警告不中止）。只有這支 bot「當下沒有掛 webhook」時，這個來源才讀得到資料。

兩者皆**不依賴 telegram channel 的 `access.json`**（本流程與 channel bot 完全無關）。這些名稱**常常**能對到 CSV 但不保證，故核心原則是：**高信心自動寫入、不確定問使用者**。發現與寫入由 script 分離，流程與人工確認由本 skill 編排。

> **時效提醒：** webhook-log 來源沒有時間窗限制（log 持續累積、CSV 回填後 `--list` 自動跳過已對映者）。getUpdates 來源仍受 Telegram 近 **~24h** 未確認更新緩衝限制，但這只在 webhook 未掛著時才有意義。CSV 一旦回填即永久保存（CSV 才是持久層）。

## 何時使用

- 「把有 DM 過 bot 的人對映到 tech-users.csv」「回填 tg_chat_id」
- tg-notify.sh 對某人印 `TG_SKIP_NO_CHATID` → 該技術 CSV 缺 chat_id
- 新技術剛 DM 過 bot，要連結 pipeline 通知

## 工具：`scripts/tg-map-chatids.sh`

| 指令 | 作用 |
|------|------|
| `bash scripts/tg-map-chatids.sh --list` | **唯讀**：合併 telegram-dispatcher 未知 sender log + bot 的 getUpdates，取得 DM 過的私聊 chat_id + 名稱，比對 CSV，輸出 TSV，不寫任何東西 |
| `bash scripts/tg-map-chatids.sh --set <email> <chat_id> [--force]` | 寫入單列 tg_chat_id；既有相同→`SET_NOOP`、既有不同→`SET_CONFLICT`（除非 `--force`）、email 不存在→`SET_ERR_NO_EMAIL`、成功→`SET_OK`（緊接著自動重啟 telegram-dispatcher，見下方說明） |
| `bash scripts/tg-map-chatids.sh --unset <email>` | 取消連接：清空該 email 的 tg_chat_id（不刪除整列）；本來就空→`UNSET_NOOP`、email 不存在→`UNSET_ERR_NO_EMAIL`、成功→`UNSET_OK` |

**2026-08-25：`--set` 成功（`SET_OK`）後會自動重啟 `com.aladdin.tg-dispatch-server`**（`launchctl kickstart -k gui/<uid>/com.aladdin.tg-dispatch-server`，印 `RESTART_OK`/失敗則 `RESTART_WARN`）。原因：telegram-dispatcher 的白名單 CSV 快取是 process 存活期間只讀一次（`lib/user-resolution/tech-user.ts`），不重啟的話剛連接的人在下次重啟前仍會被白名單靜默擋掉、`/bug` 等指令完全零回應。三個會寫入的路徑（本 skill、`tg-auto-sync.sh` 的 AUTO_HIGH、tg-monitor `/api/tg-users/assign`）都只呼叫這支腳本、不重新實作寫入邏輯，故在此一處收斂即可涵蓋全部新增連接管道。`--unset` 目前不比照重啟（移除白名單只是延後生效，不是新增授權，風險方向不同）。

`--list` TSV 欄位（無表頭，tab 分隔）：
`chat_id  source(webhook-log|getUpdates)  tg_first_name  tg_username  confidence(HIGH|ASK)  candidate_email  candidate_name  alt_candidates`

## 流程

1. 跑 `--list`，逐行處理：
   - **`confidence == HIGH`**（整份 CSV 恰好一個候選列）→ 直接 `--set <candidate_email> <chat_id>`，記入「自動對映」清單（仍會在報告列出供事後核對）。
   - **`confidence == ASK`**（0 或 ≥2 候選）→ 用 **AskUserQuestion** 問使用者：顯示 `chat_id` + `tg_first_name`/`tg_username` + `alt_candidates`，請使用者：選某候選 email / 直接給 email / skip。選定後 `--set`。
2. 對每個**本次成功寫入**者（`SET_OK`），發測試訊息確認連結：
   `bash scripts/tg-notify.sh --email <email> --text "<first_name> 連結成功"`（`first_name` 取自 getUpdates）。
3. 最終報告：自動對映 N、人工確認 M、skip K、各測試訊息結果（`TG_SENT` / `TG_FAIL`）。

## 信心規則

對 getUpdates 取得的 `{first_name, last_name, username}`，逐 CSV 列判斷是否為「候選」（正規化＝去空白、轉小寫）：

- **名稱訊號**：`first_name`（或 `first_name+last_name`）等於 `notion_user_name`、為其 token、或互為子字串。
- **帳號訊號**：`username` 去尾數字後，等於 / 互為包含 email localpart（去 `pkh_`/`ptp_` 前綴）。
- 任一訊號成立 → 候選。**HIGH** = 恰好一個候選列；**ASK** = 0 或 ≥2。

不做更花俏的模糊比對（YAGNI）；偏寬鬆比對會偏向 ASK（安全的失敗方向），自動寫入者一律列入報告供事後核對，「自動」不等於「盲寫」。

## 紀律（必守）

- **兩來源皆唯讀**：webhook-log 只讀檔；getUpdates 不帶 offset、不確認更新（不消費 update queue）。冪等可重跑。
- **不碰 telegram channel**：本流程與 channel bot / `access.json` 完全無關，絕不讀寫 `access.json`、絕不核准任何配對（配對與核准走 `/telegram:access`，由使用者自己執行）。
- **冪等**：`--list` 跳過已對映 chat_id，可重複執行。
- **不覆蓋**：`--set` 遇既有不同 chat_id 拒絕，除非使用者明確要求 `--force`。
- **出站訊息只對「本次新寫入」者發**，不對既有對映重發。
- token 從 `/Users/user/aladdin/.env` 的 `TELEGRAM_BOT_TOKEN` 讀（與 tg-notify.sh 同一支 bot），不硬編。

## Common Mistakes

- ❌ 把 HIGH 當成不必回報就盲寫 → ✅ 自動對映**仍要**列進最終報告。
- ❌ ASK 時自己猜一個 email 寫下去 → ✅ ASK 一定問使用者，不自行裁定。
- ❌ 對已對映的人重發測試訊息 → ✅ 只對本次 `SET_OK` 者發。
- ❌ 去讀 / 核准 telegram channel 的 `access.json` / pending → ✅ 本流程不碰 channel；配對走 `/telegram:access`。
- ❌ 以為 `--list` 看得到「曾經」DM 過的所有人 → ✅ webhook-log 來源沒有時間窗，但只從 2026-08-21 這份 log 開始生效之後才有紀錄；更早、且從未再次 DM 過的人仍看不到，請對方重發一則訊息再跑。

## 相關工具

- `tg-auto-sync.sh`（同目錄）：白名單外的人 DM bot 時，telegram-dispatcher 會 fire-and-forget 自動觸發這支腳本，複用本腳本的 `--list`/`--set`——HIGH 自動寫入 + 發確認訊息，ASK 改為通知維運者（不自動猜）。
- `tg-monitor`（`/Users/user/aladdin/tg-monitor`，http://127.0.0.1:8799）：本機監控 UI，「TG 已連接」「TG 待處理」兩個頁籤可視化目前狀態；已連接頁籤可「取消連接」（複用 `--unset`）與「測試發送」（複用 tg-notify.sh），待處理頁籤可手動選技術人員「指定」（複用 `--set`）。UI 本身不重新實作任何比對/寫入邏輯，一律呼叫本目錄的腳本。

## 可調

測試訊息名稱預設用 getUpdates `first_name`（`Landon 連結成功` / `洋蔥 連結成功`，較口語）；若想改用 CSV `notion_user_name` 可在 step 2 自行替換。

## 測試

`bash scripts/tg-map-chatids.test.sh`（全離線，stub getUpdates + fixture unknown-senders.jsonl + fixture CSV，涵蓋 `--set` 五種結果、`--list` 的 HIGH / ASK / 已對映跳過 / 非私聊忽略，以及 getUpdates 409（webhook 掛著時的正常情況）不中止、仍從 webhook-log 拿到結果）。
