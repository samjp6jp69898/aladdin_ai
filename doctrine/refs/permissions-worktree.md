# Worktree 隔離環境 / CQA Grounding 放行條款（完整版，2026-07-03 從 CLAUDE.md 抽出）

> CLAUDE.md 留有壓縮版授權表（那是硬邊界）。本檔是完整措辭，修改授權範圍前必讀，且**修改授權屬「需使用者核准」類**（見 40-maintenance-protocol.md）。

## Worktree 隔離環境放行條款

適用範圍：`git worktree` 隔離環境（branch 命名 `landon/FAQ-*`；`/create-mr` 流程命名 `mr/FAQ-*`）。

- **bug-fixer / bug-fixer-with-tests** 可執行生成指令（`sh bootstrap.sh`、`bun run generate-*`、`bun run lint`）
- **evaluator / test-validator / solution-reviewer** 可執行測試指令（`bun test`、`bun test --coverage`）
- **evaluator / test-validator** 可使用 DB 工具（見 `/Users/user/aladdin/conn/README.md`）和本機 Redis（`redis-cli`）
- **所有 agent 禁止推送至 remote**（`git push` 一律禁止），除下列兩個例外：

### mr-pusher 例外（/create-mr 最終步驟）
允許在 `mr/FAQ-*` 分支上執行：
- `git fetch origin <base_branch>`、`git rebase origin/<base_branch>`（推前基準新鮮度校驗；`base_branch` 預設 `main`，技術人員在 Notion 工單留言明確指定分支（如 `feature/20260815`、`hotfix/*`）時為該分支——由 manager 傳入，mr-pusher 不得自行決定）
- `git push origin mr/FAQ-*`（含 `--force-with-lease`，用於 rebase 後的 push）
- `glab mr create --source-branch mr/FAQ-* --target-branch <base_branch> --reviewer <username>`（reviewer username 由 reviewer_email localpart 推導；target 與上列 rebase 基準必須是同一個值）

其他 agent（bug-fixer-with-tests、solution-reviewer、drive-uploader-mr、bug-tracer-with-callgraph、所有 /analyze-single-bug agent）仍嚴禁推送至 remote 與發 MR。

### /refine-mr 流程例外
- `mr-feedback-fixer`：可執行生成與 lint 指令（`sh bootstrap.sh`、`bun run generate-*`、`bun run lint`）
- `mr-feedback-evaluator`：可執行測試指令（`bun test`）
- `mr-feedback-pusher`（/refine-mr 最終步驟）：允許在 `mr/FAQ-*` 分支上執行 `git fetch origin mr/FAQ-*` 與 `git push origin mr/FAQ-*`（**僅 plain fast-forward push，把新 commit 接到既有 MR 分支；禁用 `--force` / `--force-with-lease`、禁用 `glab mr create`**），並可執行 `glab mr note`（在既有 MR 留言）
- 其他 /refine-mr agent 仍嚴禁推送至 remote

### 界線
此放行條款僅適用於 worktree 隔離環境，不適用於主工作目錄。

## CQA 實證 Grounding 放行條款

`/create-mr` 的 `cqa-grounder` agent（及被授權執行 grounding 的 tracer）允許在**主工作目錄**執行：
- `bash /Users/user/aladdin/conn/db-cqa-query.sh <db> "<SELECT/SHOW/DESC/EXPLAIN>"`（唯讀查 CQA DB）
- `/Users/user/aladdin/cqa-e2e/` 下的 Playwright（node）登入、**依 ticket 重現步驟實際操作**（app 與後台皆可）與截圖
- `bash /Users/user/aladdin/conn/portainer-login.sh cqa`、`bash /Users/user/aladdin/conn/portainer-logs.sh cqa <application> [--tail N]`（唯讀查 K8s pod log）
- `bash /Users/user/aladdin/conn/kibana-logs.sh cqa <application> [--tail N]`（唯讀查 Elasticsearch log）
- `Read` 截圖檔（含 app 端驗證碼視覺讀碼）

界定（2026-09-02 使用者核准擴大重現操作範圍）：
- **DB 僅唯讀**：只能 SELECT/SHOW/DESC/EXPLAIN，不因本次擴權而放寬
- **瀏覽器可重現操作**：允許依 ticket 描述的步驟實際操作（含表單送出、按鈕點擊、寫入、不可逆/破壞性操作），目的是取得比對 ticket 症狀的第一手證據；操作前後建議截圖存證。因本 pipeline 全自動無人工中斷點，agent 不需為此類操作停下詢問使用者
- **log 查詢僅唯讀**：Portainer/Kibana 只用來查已有 log，不做任何設定變更、不重啟服務、不刪除資料
- 一邊操作重現一邊查對應服務的 log（Portainer/Kibana），佐證症狀與後端行為的關聯
- **僅限 CQA 測試環境**：只能對 `*.ald777.com` 的 CQA 測試站、`landon_ai` 唯讀 DB、CQA 的 Portainer/Kibana；**嚴禁對 production**
- 連線資訊一律從 `aladdin_ai/.env.cqa`（2026-08-31 前為根目錄 `/Users/user/aladdin/.env`）讀，不得寫死於腳本或 prompt
- 此放行適用於主工作目錄（grounder 跑在 worktree 建立之前），與 Worktree 放行條款分屬不同層級
