# 維護協議（40-maintenance-protocol）

> 任何 session（不論模型強弱）要修改 CLAUDE.md / commands / agents / scripts / doctrine 之前，先讀完本檔。
> 本協議的目的：讓制度能被安全地演化，而不是被好心地弄壞。

## 0. 環境事實（改檔前必知，2026-07-21 實測；2026-09-01 更新）

- `.claude/commands`、`.claude/agents`、`.claude/skills`、`.claude/doctrine`、根目錄 `scripts`、`conn` **全是 symlink**，指向 `aladdin_ai/` 下的同名目錄——改一處即改全部，**不存在**「兩份 commands 要分別改」這回事。換機器 clone/pull `aladdin_ai` 後跑 `bash aladdin_ai/scripts/setup-symlinks.sh` 一鍵重建這組 symlink（歷史：`.claude/doctrine` 2026-07-21 由實體目錄轉 symlink；2026-08-31 這整組連同 `conn` 帶完整 git 歷史遷到獨立 `aladdin_ai` repo，同批 `mcps/` 遷到獨立 `aladdin_mcps` repo 且路徑攤平）。
- `/Users/user/aladdin/CLAUDE.md` **是 symlink**，指向唯一實體檔 `obsidian/CLAUDE.md`（2026-09-01 由「雙實體 + sync-mirrors.sh 手動同步」改成單一來源 symlink，實測 `readlink` 確認；舊版需要跑 sync 才會反映改動的行為已不存在）。**一律改 `obsidian/CLAUDE.md`**，根目錄那份自動反映。
- `AGENTS.md`（`/Users/user/aladdin/AGENTS.md`、`obsidian/AGENTS.md` 各一份，皆為 `AGENTS.md -> CLAUDE.md` 的 symlink，2026-08-25 新增）：給 Codex CLI 等遵循 agents.md 標準的工具讀同一份內容，改 `CLAUDE.md` 即同時生效，不需要另外維護。`sync-mirrors.sh --check` 的 symlink 健檢已涵蓋這兩個。⚠️ **環境事實更新（2026-08-28 實測）**：`obsidian/AGENTS.md` 正常，但 `/Users/user/aladdin/AGENTS.md` **目前不存在**，`--check` 會固定報一行 `SYMLINK_MISSING`。使用者當日裁定不修復，所以這行不是新故障、也不要自行重建；判斷 `--check` 是否全綠時把這行排除。
- 陷阱：`find` 對「本身是 symlink 的目錄」作為路徑參數會**靜默回空**。要遍歷請用實體路徑（`aladdin_ai/...`，`mcps/` 相關則用 `aladdin_mcps/...`）或先 `cd` 進去。引用路徑前先 `ls -ld` 確認身分。
- bash 3.2 陷阱：`"$VAR全形字"` 中變數後直接接全形字元會把變數名解析壞（unbound variable）。變數與 CJK 之間留空格或用 `${VAR}`。

## 1. 分區：什麼可以自改、什麼要先問使用者

### 綠區（可自改，走第 2 節儀式）
- 在 `refs/pitfalls-*.md` **追加**踩坑條目（格式見第 3 節）
- doctrine 檔中「環境事實」與實際環境不符時的**事實修正**（必附當日驗證證據與日期）
- `30-delegation-templates.md` 新增模板
- scripts 的 **bug 修復**（行為修正，非語意變更；需 `bash -n` + 實測一條正常路徑一條失敗路徑）
- 指令檔（commands/*.md）中路徑、工具名、契約格式的**與實況對齊**修正
- 新增 dated 診斷檔（如 `00-diagnosis-YYYYMMDD.md`）——舊診斷檔是歷史快照，**不回頭改**

### 紅區（先問使用者，說明動機與影響再動）
- CLAUDE.md 的「硬規則」section 的任何增刪改
- `refs/permissions-worktree.md`（授權邊界）的任何變更
- 任何涉及 secrets 的變更（notion.sh 的 token 處理、.env 引用方式）
- pipeline 的**語意**變更：claim/lock 協議、tracker 狀態集合、出口路徑表、重試上限
- 刪除任何制度檔、把 agent 的 model 分級整批調升（成本影響）
- 把 symlink 換成實體目錄（或反之）

判斷模糊時：當紅區處理。問的方式照 `20-judgment-rubrics.md` 第 3 節（附選項與後果）。

## 2. 改檔儀式（綠區紅區都適用）

1. **備份**：`cp -p <檔> /Users/user/aladdin/.claude/backups/<YYYYMMDD 或 YYYYMMDD-標記>/<檔名>.<標記>`（目錄不存在先 mkdir -p；日期後可帶後綴，如既有的 `20260703-fable`）。
2. **改**：surgical——只動要動的行。
3. **一致性檢查**（絕對路徑，不依賴 cwd）：`grep -rn "<你改動涉及的關鍵字>" /Users/user/aladdin/aladdin_ai/commands/ /Users/user/aladdin/aladdin_ai/agents/ /Users/user/aladdin/aladdin_ai/scripts/ /Users/user/aladdin/.claude/doctrine/ /Users/user/aladdin/CLAUDE.md` 確認沒有別處還在講舊行為；有 → 同場修掉或明列給使用者。
4. **驗證**：scripts → `bash -n` + 實測；文件 → read-back 引用路徑逐一 `ls`；指令檔 → 通讀一次確認步驟編號與跳轉一致。
5. **同步**：跑 `bash scripts/sync-mirrors.sh --check`（健檢全部 symlink，含 CLAUDE.md／AGENTS.md）。
6. **留痕**：一句話記錄「改了什麼、為何、驗了什麼」——追加到 `.claude/doctrine/refs/change-log.md`（沒有就建，格式：`- YYYY-MM-DD | 檔案 | 一句摘要 | 驗證方式`）。

## 3. 踩坑寫回（教訓的固定去處與格式）

**去處判定**：
- 屬 worktree/pipeline 環境 → `refs/pitfalls-worktree.md` 追加
- 屬業務/程式碼知識（修 bug 學到的）→ `obsidian/Rules/` 對應分類（見其 `_index.md`），用 `[[ ]]` 連結
- 屬 harness/工具行為（如 find symlink 陷阱）→ 本檔第 0 節追加一行 + change-log 留痕
- **可以用腳本消滅的坑，優先改腳本**（如 setup-worktree.sh），文件只留「為什麼腳本長這樣」

**條目格式（固定五欄，缺一不收）**：
```
## <坑名>（YYYY-MM-DD）
症狀：<看到什麼錯誤/行為，含關鍵錯誤訊息原文>
根因：<為什麼>
判別法：<下次怎麼快速確認是這個坑，而不是別的>
修法：<具體動作；已固化進腳本的注明腳本名>
影響範圍：<哪些流程/檔案受影響>
```

## 4. 精簡觸發條件（防再度肥大）

| 檔案 | 上限 | 超限動作 |
|---|---|---|
| `CLAUDE.md` | 120 行 | 抽內容到 refs/，只留規則+路由（紅區，先問） |
| doctrine 各檔 | 300 行 | 拆檔或把過時內容移到 dated 歸檔 |
| `refs/pitfalls-*.md` | 300 行 | 最舊條目搬到 obsidian Rules 對應分類，原地留一行指標 |
| commands 各檔 | 400 行 | 抽可確定化的步驟成 scripts/*.sh |
| `refs/change-log.md` | 200 行 | 保留最近 100 行，其餘刪除（backups 有底） |

## 5. 衝突裁決規則

- **腳本 vs 文件**不一致：以腳本實際行為為準，當場修文件（文件是腳本的說明書，不是反過來）。
- **文件 vs 環境**不一致：以實測為準（`ls -ld`、`--help`、實跑），修文件並附驗證日期。
- **兩份文件**不一致：以層級高者為準（CLAUDE.md 硬規則 > doctrine > commands 內嵌說明），修低層那份。
- 修不動（紅區）→ 在低層文件加一行「⚠ 與 X 衝突，待使用者裁定」，別讓下一個讀者踩同一個雷。

## 6. Backups 紀律

- 位置：`/Users/user/aladdin/.claude/backups/<日期>/`。
- **任何 grep/搜尋/引用都不得把 backups/ 當現行版本**；搜尋時主動排除該目錄。
- 只保留最近 3 個日期目錄；更舊的可整目錄刪除（屬綠區）。

## 7. 季度健檢清單（或「感覺文件在說謊」的時候跑）

```bash
bash /Users/user/aladdin/scripts/sync-mirrors.sh --check          # 全部 symlink 完好（含 CLAUDE.md／AGENTS.md）
ls -ld /Users/user/aladdin/scripts /Users/user/aladdin/.claude/commands
bash /Users/user/aladdin/scripts/tracker.sh counts                 # tracker 可讀且格式未變
head -12 /Users/user/aladdin/aladdin_ai/agents/bug-tracer-with-callgraph.md   # frontmatter model/effort 還在
```
再抽查 CLAUDE.md 路由表指向的檔案是否都存在（`ls .claude/doctrine/`）。發現漂移 → 按第 5 節裁決、按第 2 節儀式修。
