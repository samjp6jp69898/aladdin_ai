# Worktree 踩坑完整紀錄（從 CLAUDE.md 抽出，2026-07-03）

> 可執行的修法已固化進 `/Users/user/aladdin/scripts/setup-worktree.sh`（/create-mr Step 4 一律走該腳本）。
> 本檔保留完整敘事與判別法，供腳本行為異常時除錯、或未來新增 repo 時擴充腳本參考。

## 踩坑 1：abu 多子專案 node_modules（2026-07-01）

舊版 worktree 建立指令對 `node_modules` 只做**頂層** symlink（`ln -sfn /Users/user/aladdin/$repo/node_modules ...`）。這對 agrabah 這種頂層有 `node_modules` 的 repo 成立，但 **abu 是多子專案結構（platform / admin / common），node_modules 分散在各子專案下**（`abu/platform/node_modules`、`abu/admin/node_modules`），頂層 `abu/node_modules` 不存在。因此頂層 symlink 會變成失效連結，bug-fixer 會回 `BRANCH_ERROR: ENV_MISSING:node_modules:abu`。

**修法**（已固化進 setup-worktree.sh）：不假設 node_modules 位置——掃描主 repo 內實際存在的 `node_modules` 目錄（maxdepth 2），對每一個逐一建立對應 symlink，並寫入 `.git/info/exclude`。lago / cassim 若同為多子專案結構自動適用（因為是掃描而非列舉）。

## 踩坑 2：rajah 本身在 affected_repos 時（2026-07-02）

`bootstrap.sh` 註解假設「rajah 為 shared symlink」，但當修復範圍本身涉及 rajah（例如 FAQ-3710：`.rajah` model 需加欄位），rajah 也會建成真正的 git worktree 而非 symlink。此時行為與文件描述的「寫入主 repo」不同：

- `bootstrap.sh` 內以 `cd ../agrabah` 等相對路徑跳轉；rajah 是真 worktree（非 symlink）時，bash 的邏輯 PWD 不會被解析回主 repo 物理路徑，`../agrabah` 會落在同一 ticket worktree 根目錄下的 agrabah worktree，而非主 repo。實測：main repo 的 `agrabah/src/generated` mtime 全程未變、`rajah` git status 全程乾淨——此情境下 bootstrap 產物完整隔離在 worktree 內，比 rajah-as-symlink 標準情境更乾淨，不需仰賴尾端 sync 迴圈鏡像 generated code。
- 但暴露新缺口：agrabah 有一份**未進版控**的 `.env.local`（含 `CONTROL_CENTER_CONNECTION_STRING`、`ALADDIN_SECRET` 等，`.gitignore` 第 107 行排除），只存在主 repo，全新 `git worktree add` checkout 不會帶到。缺這檔時 `bun run migrate ControlCenter`（bootstrap.sh 尾段）報 `can not found connection string in database setting [ControlCenter]`，屬 `set -e` 硬中斷。

**修法**（已固化進 setup-worktree.sh；⚠ 條件以腳本為準）：當 **agrabah 在 affected_repos（即 agrabah 是真 worktree）**時，才 symlink 主 repo 的 `agrabah/.env.local` 進該 worktree 並寫入 `.git/info/exclude`。agrabah 是 symlink 的情境**不需要也不可以**做這件事——對 symlink 目錄執行 `ln -sfn` 會穿透打到主 repo，把真正的 .env.local 換成自指連結（毀主 repo 配置）。原始踩坑紀錄寫的觸發情境是「rajah 在 affected_repos」，但正確的判定條件是「agrabah 為真 worktree 導致 .env.local 未被 checkout」。

## 獨立問題：migrate ControlCenter ECONNREFUSED（非 worktree 造成，勿誤判）

即使連線字串已修好，`bun run migrate ControlCenter` 仍可能因本機 ControlCenter MySQL 連不上而 `ECONNREFUSED`（error code 12 `unknownDatabaseError`）。

**判別法**：直接在主 repo（非 worktree）跑同一指令，若重現一樣的錯誤 → 是既有本機環境問題，與 worktree 操作無關，不必也不應在 worktree 側修。

bootstrap.sh 卡住的位置在 `migrate ControlCenter` / `sync-configurations` / `sync-all`（DB 資料供給步驟）；**在此之前**的程式碼生成步驟（`generate-genie.sh`、agrabah 的 `generate-configuration-files` / `generate-standalone-settings` / `generate-entries`、rajah 的 `generate-all.sh`）已成功完成——這些才是後續 fixer 需要的東西。若該次修復只需 L0 單元測試（不啟動 server、不連真實 DB），可略過卡住的尾段步驟繼續 pipeline；**是否略過需先知會使用者確認，不得默默跳過**。

## agrabah worktree 缺 src/generated 致 migrate 失敗（2026-07-03）

症狀：setup-worktree.sh 對 agrabah 單輸出 `SETUP_FAIL:bootstrap 未知錯誤`；bootstrap.log 尾段為 `[agrabah] bun run migrate ControlCenter` → `error: Cannot find module '../../generated/services.gen.ts' from '.../worktrees/FAQ-XXXX/agrabah/src/tools/database/create_default_user.ts'`。worktree 的 `agrabah/src/generated/` 整個目錄不存在。

根因：rajah 為 symlink（agrabah 才是真 worktree）的**標準情境**下，bootstrap 的 `./generate-all.sh`（以 dirname 解析回主 repo rajah）把 `services.gen.ts` 產進「主 repo」agrabah；但同一支 bootstrap 尾段的 `migrate ControlCenter` / `sync-*` 以邏輯相對路徑 `../agrabah` 對「worktree」agrabah 執行，需要 worktree 內已存在 `src/generated`。原本負責把主 repo→worktree 鏡像 generated 的 derived-sync（腳本 Step 7）排在 bootstrap **之後**，而 migrate 因缺 generated 失敗（訊息不匹配 line 119 的 DB 樣式 grep）即 `exit 1` → Step 7 永遠跑不到 → 每張 agrabah 單必然卡死。2026-07-02 補 `.env.local`（踩坑 2）讓 migrate 跨過 connection-string 錯誤，反而往前暴露此更深的「缺 generated」致命錯誤。

判別法：worktree `ls agrabah/src/generated`（不存在）＋主 repo `ls agrabah/src/generated`（存在、mtime 恰為本次 setup 時刻）→ 即本坑。與「migrate ECONNREFUSED」（獨立問題段，會被判 partial）不同：本坑錯誤是 `Cannot find module ...generated...`，不含 DB 連線字樣。

修法（已固化進 setup-worktree.sh）：bootstrap 之前新增「Step 5.5 pre-bootstrap derived-sync」，先把主 repo 已有的 gitignored generated 鏡像進 worktree（只補缺的、不覆蓋；bootstrap 後 Step 7 仍會 top-up）。修後 migrate 找得到 generated → SETUP_OK（實測 FAQ-3778：SETUP_FAIL→SETUP_OK、worktree services.gen.ts 補齊 73065 行、git status 乾淨）。

影響範圍：/create-mr Step 4 所有 agrabah（及其他被設為真 worktree 的 repo）單。⚠ `refine-mr.md` 的**內嵌** worktree setup（自帶 sync 迴圈、未用本腳本）有同源潛在風險，待另行評估修復。

## 歷史踩坑：跨 repo cherry-pick 漏 pick（2026-06-01）

`e7d7a734c`（agrabah）打賞審核修復有同步，但 rajah 對應節點漏 pick 到 `feature/20260609`，導致正式環境 `GetTipAuditList` 回傳空白列表。→ 跨 repo 同一功能的所有節點必須全部 pick 完整。

## bootstrap DB schema 漂移被誤判成「未知失敗」擋死整批 pipeline（2026-07-30）
症狀：`setup-worktree.sh` 最後一行 `SETUP_FAIL:bootstrap 未知錯誤`，bootstrap.log 尾為 `error: migrate [Agent] error(12) at [202607291718_add_settle_to_general_agent_id_to_agent_commission_invoice.sql]`，上游 mysql 錯誤 `ER_DUP_FIELDNAME / Duplicate column name 'settle_to_general_agent_id'`、`error: script "sync-all" exited with code 1`。連跑兩次同錯。
根因：`Duplicate column name` 字面意義是欄位已存在——dev DB schema 其實正確，只是 migration 版本記錄未同步。但 :142 的 db-seed 分類器只 grep 連線層樣式（ECONNREFUSED / unknownDatabaseError / can not found connection string），schema 漂移型錯誤落到 else 判 SETUP_FAIL。又因 bootstrap（:139）**無條件執行、與 affected_repos 無關**，連純 lago 前端單也被 agrabah 的 DB 擋死 → /create-mrs 整批每張都會先燒 25–40 分鐘 analyst/grounder/tracer 再死在 Step 4，並被錯標 failed 污染 tracker 與 Notion。
判別法：看 bootstrap.log 是否含 `migrate [X] error(N)` 或 `script "sync-all" exited`；若程式碼生成階段（generate-*）已完成、失敗只落在 migrate/sync-*，即屬此坑而非真環境失敗。人工復核：在主 repo 跑同指令，同錯 = 本機既有問題，與 worktree 無關。
修法：已固化進 `setup-worktree.sh`——分類器樣式加入 `migrate \[[A-Za-z]+\] error\(` 與 `script "(sync-all|sync-configurations)" exited`，改判 `SETUP_OK BOOTSTRAP_PARTIAL:db-seed` 續行（本 pipeline 只跑 L0 測試不連 DB）。真正未知錯誤仍判 SETUP_FAIL。
影響範圍：`scripts/setup-worktree.sh`、/create-mr Step 4、/create-mrs 整批、/analyze-bugs 系列共用同一腳本。
