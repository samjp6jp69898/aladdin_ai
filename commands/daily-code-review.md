---
name: daily-code-review
description: Daily code review manager — deterministic scan script builds the dispatch plan and per-agent prompt files; manager only dispatches review agents batch by batch, QA per batch, then aggregates critical issues to CSV via script.
user-invocable: true
---

# Daily Code Review v3 Workflow

You are the review **manager**. 掃描、身份消歧、工作量分組、model 指派、agent prompt 組裝已全部由腳本確定性完成——你的工作只剩：**跑腳本 → 按 dispatch.json 派工 → 驗收 → 跑聚合腳本 → 回報**。

鐵律（違反即為事故）：
- 你自己**不**解析 `git log`、**不**計算工作量、**不**手寫/改寫 review agent prompt 內容、**不**在對話中累積 issue 清單（事實源永遠是檔案）。
- 本指令為自主 pipeline：superpowers 的 brainstorming 等互動式流程 skill 不適用，全程不停下來等使用者（除了本檔明寫的回報時機）。

## Review Scope（不變式）

- **Branches reviewed:** `origin/dev` of `agrabah` / `abu` / `lago` / `rajah` **only**. `origin/pro` is used only as the exclusion baseline. `origin/feature/*` branches are **not** scanned.
- **Commits reviewed:** every commit reachable from `origin/dev` but not from `origin/pro`, whose **commit date** falls within the requested date window.

> ⚠️ **掃描範圍守則 — 請勿移除 `origin/dev`**：`origin/dev` 是本流程**唯一**的掃描來源（`origin/pro` 僅作排除基準），移除它等同整個流程掃不到任何 commit、所有開發者連續多日完全無報告且無錯誤訊息（2026-05-21 曾因把 `origin/dev` 移出掃描、只留 `origin/feature/*` 而踩過此坑）。本流程已於 2026-06-01 起改為**只掃 `origin/dev`、不再掃 `origin/feature/*`**：`feature/*` 是從 `dev` cherry-pick 組出來的，原始 authored commit 都在 `dev` 上，因此只掃 `dev` 不會漏人，也不再需要 patch-id 去重。代價是**只存在於 `feature/*`、從未進過 `dev` 的 commit 不在審查範圍內**（依分支策略本不應發生）。掃描邏輯現位於 `scan-workload.ts`；修改該腳本前先讀本守則與 `.claude/doctrine/40-maintenance-protocol.md`。

> 註：同一窗口在不同日子重跑，結果本來就可能不同——今天已 merge 進 `origin/pro` 的 commit 不再入列（實證：20260702 窗口在 07-03 重掃時，Vic 的 `838175c1` 已進 pro 故不再出現）。這是設計行為，不是掃描 bug。

## Parameters

`$ARGUMENTS` format: `/daily-code-review [date1] [date2] [concurrent]`（token 依形狀分類：8 位數字＝日期、其他數字＝每批併發數，位置無關）

**你不需要自己解析參數**——把 `$ARGUMENTS` 原樣接在腳本後面即可（見 Step 1）。腳本規則：無日期＝台北時區的昨天；一個日期＝單日；兩個日期＝閉區間（自動排序）；併發預設 5。

Examples:
- `/daily-code-review` → 昨天，5 per batch
- `/daily-code-review 20260520` → 2026-05-20
- `/daily-code-review 20260515 20260520 10` → 區間，10 per batch

## Execution Flow

### Step 0: Bootstrap（每次執行都必跑，無條件）

```bash
cd /Users/user/aladdin && sh daily_bootstrap.sh
```

等它跑完再繼續（失敗會記在 `review/bootstrap.log`，不中斷本流程）。**為什麼無條件跑**：review agent 會用 Read 讀修改檔案的工作樹全文，bootstrap 內的 `update.sh` 會把所有 repo 工作樹 pull 到最新 dev——不跑它，agent 讀到的檔案內容可能落後於被審的 commit。

### Step 1: 掃描與派工計畫（腳本，一條指令）

```bash
bun /Users/user/aladdin/aladdin_ai/skills/daily-code-review/scan-workload.ts $ARGUMENTS
```

- stdout 第一行印 `[DONE] ...` → 窗口內無 commit（或 `--skip-existing` 下全部已完成）：把該行回報使用者，流程結束。
- 否則 stdout 是派工摘要表；完整計畫已寫入 `review/{LABEL}/_dispatch/dispatch.json`（含每個 agent 的 `model`、`prompt_file`、每位 author 的 `report_file` / `critical_file`、`batches` 切分）。
- **中斷後接續**：重跑同一指令並加 `--skip-existing`（**最新一代報告＋critical 檔配對俱全**的 author 才會被跳過；只有報告、缺 critical 者視為未完成會重新入列）。不加的話，既有報告不會被覆蓋，本輪報告自動改用 `_r2` / `_r3` 後綴（re-review 語意）。
- 身份消歧（同人多 email、同名不同人防呆）由腳本按單一來源 `aladdin_ai/skills/daily-code-review/author-identities.json` 處理。掃描摘要或報告中發現新的身份亂象時：先依該檔 `_comment` 的規則更新它，再重跑本步驟。
- 腳本失敗（非 0 exit 且非 `[DONE]`）：把錯誤原文回報使用者並停止，不要自己用 git 指令替代腳本。

### Step 2: 批次派 Review Agents（你唯一的核心工作）

依 `dispatch.json` 的 `batches` 順序處理每一批：

1. **同一則訊息**並行派出該批全部 agent（禁止逐一序列派）。每個 agent 用 Agent tool，`model` 用 dispatch.json 該 agent 的值（`opus` 或 `sonnet`），prompt **照抄**下面模板、只替換路徑：

   ```
   You are a review agent. Read the file below and follow ALL instructions in it exactly:
   /Users/user/aladdin/review/{LABEL}/_dispatch/agent-{N}.md
   Your final message must end with the machine-readable AUTHOR_DONE / RESULT lines that file requires.
   ```

   （effort 無法 per-call 指定，會繼承主對話——這是 harness 事實，見 `.claude/doctrine/10-model-dispatch.md` 第 0 節；不要在派工參數裡編造 effort 欄位。）

2. 該批全部回報後，跑**該批**的驗收（`--batch {B}` 必帶——不帶會連尚未派工的後續批次一起列成 MISSING，那不是缺檔）：

   ```bash
   bun /Users/user/aladdin/aladdin_ai/skills/daily-code-review/collect-critical.ts {LABEL} --check --batch {B}
   ```

3. 有缺檔或 agent 回 `RESULT: PARTIAL` / `RESULT: BLOCKED` → 走 `.claude/doctrine/10-model-dispatch.md` 第 5 節升降級（同一子任務 sonnet 連錯 2 次升 opus 並附完整失敗軌跡；總計最多 3 次嘗試）。重派時 prompt 仍用同一個 `agent-{N}.md`，另加一行 `Only process author(s): <缺的名單>; other authors in the file are already done.`。3 次仍失敗 → 記下該 author，流程繼續，最後回報使用者。

4. 派該批的 **QA agent**（`model: sonnet`，一批一個）：

   ```
   You are a report QA agent. Read the file below and follow ALL instructions in it exactly:
   /Users/user/aladdin/review/{LABEL}/_dispatch/qa-batch-{B}.md
   Your final message must end with the machine-readable QA_COMPLETE / RESULT lines that file requires.
   ```

5. QA 執行期間可以並行派下一批的 review agents（QA 只碰報告檔，review 只寫新檔，不互斥）。**不確定時序列執行（等 QA 完再派下一批）也完全正確**——寧慢勿亂。

每批完成後在對話裡只留一行進度（例：`batch 2/3 done, 6 reports + QA ok`），其他細節不要複述——都在檔案裡。

### Step 3: 最終閘門 + 聚合 CSV（腳本，兩條指令）

全部批次（review + QA）完成後，先跑**全量**完成度閘門（不帶 `--batch`）：

```bash
bun /Users/user/aladdin/aladdin_ai/skills/daily-code-review/collect-critical.ts {LABEL} --check
```

- 有 MISSING → 回 Step 2.3 對缺的 author 補派（同樣的升降級與次數上限），補齊後重跑本閘門。**閘門不過，不准聚合**——否則缺的 critical 檔會被靜默略過、CSV 不完整卻無錯誤。
- 3 次嘗試仍缺的 author：明確記下，聚合照做，但必須在 Step 4 回報中列出「未納入 CSV 的 author」。

閘門通過（或已明確記錄殘缺名單）後聚合：

```bash
bun /Users/user/aladdin/aladdin_ai/skills/daily-code-review/collect-critical.ts {LABEL}
```

- 事實源是 `review/{LABEL}/_critical/*.critical.md`（review agent 落檔、QA agent 同步過 severity），**不是** agent 的對話回報。
- exit 1 並列出 `PARSE_ERRORS` → 對每個列出的檔案：讀該檔與對應報告，把 critical 檔修成規定格式——`AUTHOR:` 與 `WINDOW:` 頭兩行，之後每個 issue 一行、行首寫 `P0` 或 `P1`（擇一，例：`P0 ||| 描述 ||| 位置`），無 P0/P1 則單獨一行小寫 `none`；只收報告 Issue List 內的 P0/P1。修完重跑本指令。腳本冪等，重跑不會重複 append。

### Step 4: 回報使用者

一則訊息收尾，含：
- 窗口與 label、審了幾位 author / 幾個 agent / 幾批
- P0/P1 摘要（直接引用 CSV 內容行；無則明說「本窗口無 P0/P1」）
- 被跳過的 repo（fetch 失敗等，見 dispatch.json `skipped_repos`）、`--skip-existing` 跳過的 author、重派後仍失敗的 author（如有）
- 報告目錄：`/Users/user/aladdin/review/{LABEL}/`

## Notes

1. **併發**：每批必須同一則訊息並行派出；批間依 Step 2.5 規則。
2. **Re-run 語意**：同窗口重跑預設產生 `_r2` 報告（不覆蓋）；接續中斷才用 `--skip-existing`。
3. **QA 的權限邊界**（downgrade/upgrade 規則、可改什麼）以 `aladdin_ai/skills/daily-code-review/report-qa.md` 為唯一權威，本檔不重複。
4. **Prompt 內容的唯一事實源**是 `aladdin_ai/skills/daily-code-review/templates/*.tpl.md`（由腳本代入變數生成 `_dispatch/*.md`）。要改 review/QA 行為 → 改模板或 review-core.md / report-qa.md，**不要**改派工三行式、也不要在派工時往 prompt 塞額外指示（僅有的兩個例外：Step 2.3 的重派名單行、升級重派時按 doctrine/10 第 5 節必附的失敗軌跡）。
5. **Bootstrap 每次必跑**、不設 flag 跳過（歷史決策，見 Step 0 理由）。
6. **檔案結構**：`review/{LABEL}/` 下——報告 `*.md`、`CRITICAL_ISSUES_{LABEL}.csv`、`_dispatch/`（計畫與 prompt）、`_critical/`（結構化 issue，兼作 per-author 完成 marker）。
7. **回歸測試**：修改 `scan-workload.ts` / `collect-critical.ts` / `templates/*.tpl.md` 後，**必跑** `bash /Users/user/aladdin/aladdin_ai/skills/daily-code-review/test-dcr.sh` 且全綠才算完成（21 案，全沙盒執行、不碰真實 review/）。
8. **覆蓋稽核（唯讀輔助，非 pipeline 主流程）**：`bun /Users/user/aladdin/aladdin_ai/skills/daily-code-review/scan-workload.ts coverage-audit [起] [迄] [--no-fetch]` 列出「未被任何 review 目錄涵蓋、但當日 origin/dev 有 commit」的漏批日（純 stdout、不寫檔）。用於常態偵測排程漏批——例行跑 review 前後可掃一次，確認無日曆空洞。

## v3 變更摘要（2026-07-03，供追溯）

v2 → v3：掃描/消歧/分組/prompt 組裝從 manager 手工改為 `scan-workload.ts` 確定性生成（舊版 Step 1–5 的手工規則全數遷入腳本與 `author-identities.json`）；CRITICAL_ISSUE 從「agent 對話回報＋manager 手寫 CSV」改為「agent 落檔 `_critical/` ＋ `collect-critical.ts` 冪等聚合」；QA 改 Edit-only 並負責同步 critical 檔；移除無效的 per-call effort 宣稱；agent prompt 不再要求重讀 CLAUDE.md（subagent 自動載入）。動機與證據：`.claude/doctrine/00-diagnosis-20260703.md`（漏洞 1/2、易錯 1）。舊版全文備份：`.claude/backups/20260703-fable-dcr/daily-code-review.md.obsidian-commands`。
