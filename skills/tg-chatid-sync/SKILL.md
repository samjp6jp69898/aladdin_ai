---
name: tg-chatid-sync
description: Use when 需要把 Telegram bot 的 allowFrom / pending chat_id 對映回填 tech-users.csv 的 tg_chat_id 欄、有人 DM 過 bot 但 CSV 還沒填 chat_id、pipeline 通知對某技術發不出去（TG_SKIP_NO_CHATID）、或新技術剛配對完要連結 Telegram 通知。
---

# tg-chatid-sync — Telegram chat_id 回填 tech-users.csv

## Overview

bot 的 `access.json`（`allowFrom` / `pending`）**只有 chat_id、沒有姓名**，無法直接對到 CSV 技術列。唯一身分線索是 Bot API `getChat`（唯讀、不送訊息、不與 long-polling 衝突）回傳的 `first_name` / `username`。這些名稱**常常**能對到 CSV 但不保證，故核心原則是：**高信心自動寫入、不確定問使用者**。發現與寫入由 script 分離，流程與人工確認由本 skill 編排。

## 何時使用

- 「把有 DM 過 bot 的人對映到 tech-users.csv」「回填 tg_chat_id」
- tg-notify.sh 對某人印 `TG_SKIP_NO_CHATID` → 該技術 CSV 缺 chat_id
- 新技術剛被 `/telegram:access` 配對完，要連結 pipeline 通知

## 工具：`scripts/tg-map-chatids.sh`

| 指令 | 作用 |
|------|------|
| `bash scripts/tg-map-chatids.sh --list` | **唯讀**：對每個未對映 chat_id 跑 getChat + 比對 CSV，輸出 TSV，不寫任何東西、不碰 access.json |
| `bash scripts/tg-map-chatids.sh --set <email> <chat_id> [--force]` | 寫入單列 tg_chat_id；既有相同→`SET_NOOP`、既有不同→`SET_CONFLICT`（除非 `--force`）、email 不存在→`SET_ERR_NO_EMAIL`、成功→`SET_OK` |

`--list` TSV 欄位（無表頭，tab 分隔）：
`chat_id  source(allowFrom|pending)  tg_first_name  tg_username  confidence(HIGH|ASK)  candidate_email  candidate_name  alt_candidates`

## 流程

1. 跑 `--list`，逐行處理：
   - **`confidence == HIGH`**（整份 CSV 恰好一個候選列）→ 直接 `--set <candidate_email> <chat_id>`，記入「自動對映」清單（仍會在報告列出供事後核對）。
   - **`confidence == ASK`**（0 或 ≥2 候選）→ 用 **AskUserQuestion** 問使用者：顯示 `chat_id` + `tg_first_name`/`tg_username` + `alt_candidates`，請使用者：選某候選 email / 直接給 email / skip。選定後 `--set`。
2. 對每個**本次成功寫入**者（`SET_OK`），發測試訊息確認連結：
   `bash scripts/tg-notify.sh --email <email> --text "<first_name> 連結成功"`（`first_name` 取自 getChat）。
3. 最終報告：自動對映 N、人工確認 M、skip K、各測試訊息結果（`TG_SENT` / `TG_FAIL`）。

## 信心規則

對 getChat 結果 `{first_name, last_name, username}`，逐 CSV 列判斷是否為「候選」（正規化＝去空白、轉小寫）：

- **名稱訊號**：`first_name`（或 `first_name+last_name`）等於 `notion_user_name`、為其 token、或互為子字串。
- **帳號訊號**：`username` 去尾數字後，等於 / 互為包含 email localpart（去 `pkh_`/`ptp_` 前綴）。
- 任一訊號成立 → 候選。**HIGH** = 恰好一個候選列；**ASK** = 0 或 ≥2。

不做更花俏的模糊比對（YAGNI）；偏寬鬆比對會偏向 ASK（安全的失敗方向），自動寫入者一律列入報告供事後核對，「自動」不等於「盲寫」。

## 紀律（必守）

- **只讀 `access.json`**：絕不編輯、絕不核准 `pending`。核准一律走 `/telegram:access`，由使用者自己執行。
- **冪等**：`--list` 跳過已對映 chat_id，可重複執行。
- **不覆蓋**：`--set` 遇既有不同 chat_id 拒絕，除非使用者明確要求 `--force`。
- **出站訊息只對「本次新寫入」者發**，不對既有對映重發。
- token 從 `telegram/.env` 讀，不硬編。

## Common Mistakes

- ❌ 把 HIGH 當成不必回報就盲寫 → ✅ 自動對映**仍要**列進最終報告。
- ❌ ASK 時自己猜一個 email 寫下去 → ✅ ASK 一定問使用者，不自行裁定。
- ❌ 對已對映的人重發測試訊息 → ✅ 只對本次 `SET_OK` 者發。
- ❌ 想「順手」核准 pending 或編輯 access.json → ✅ 嚴禁；配對走 `/telegram:access`。

## 可調

測試訊息名稱預設用 getChat `first_name`（`Landon 連結成功` / `洋蔥 連結成功`，較口語）；若想改用 CSV `notion_user_name` 可在 step 2 自行替換。

## 測試

`bash scripts/tg-map-chatids.test.sh`（全離線，stub getChat + fixture access.json/CSV，涵蓋 `--set` 五種結果與 `--list` 的 HIGH/ASK/skip/pending 納入）。
