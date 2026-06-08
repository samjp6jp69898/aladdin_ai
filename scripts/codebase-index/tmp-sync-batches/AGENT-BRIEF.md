# Codebase Sync — Stage 2 子代理共用指令

你負責把 agrabah 在 **2026-05-25 → HEAD** 期間的程式碼變更，增量同步到 Obsidian `Codebase/` 知識庫筆記。

## 你的工作清單

你的 batch manifest 是一個 JSON 檔（路徑由派工者告知），內容是一個 action 陣列。每個 action：
```
{ index, type, filePath, commitMessage, commitHash, newMethodHints[], affectedNotes[{fqn,path,type}] }
```
- `type=update_existing`：既有檔案被修改，更新對應筆記
- `type=new_file`：新增的程式碼檔案，需建立全新筆記
- `affectedNotes`：候選筆記清單（**過度包含**——是整個 service/manager 的所有 method）。你必須**外科手術式**只改 diff 真正觸及的 method/section 對應的筆記。

## 取得 diff（唯讀，務必先做）

對每個 action 的 `filePath`，取本次同步範圍的累積 diff：
```bash
git -C /Users/user/aladdin/agrabah diff c72c0d760 HEAD -- <filePath>
```
（`c72c0d760` = 2026-05-25 之前的 base commit；`HEAD` = a6c44b75a）
需要更多上下文時讀現行原始碼：`/Users/user/aladdin/agrabah/<filePath>`。

## Source-First 紀律（強制）

- 結構性事實（method 簽名、enum 值、model 欄位、FQN、所屬 server）**一律以 source / skill 查得為準**，禁止憑記憶或舊筆記猜測。
- 查 method FQN / 所屬 server / enum / model 用 rajah-query 腳本：
  `bun /Users/user/aladdin/obsidian/skills/rajah-query/rajah-lookup.ts <subcommand>`
  （直接執行；子代理無法呼叫 Skill tool）
- 引用程式碼時心裡要有 `file:line` 依據，且該行真的讀過。
- 不懂、無法從 source 確認的，留 `[TBD: 需開發者補充]`，**不得猜測**。

## update_existing 處理規則

1. 讀 diff，判斷「真正改了哪些 method / 哪些語意」。
2. 只開啟與「真正變更」相關的 `affectedNotes`，更新這些手寫內容區段以反映變更：
   `## 功能描述`、`## 業務場景`、`## 輸入參數`、`## 回傳`、`## 相關錯誤碼`、`## 呼叫關係`（僅手寫的 Calls 部分）、`## 備註`。
3. 被更新到的筆記：frontmatter `last_scanned:` 改成 `2026-06-07`；若 `source_line` 明顯位移可一併修正。
4. 與本次 diff **無關**的候選筆記：**不要動**（保持乾淨 diff，符合 Surgical Changes）。
5. 若 diff 新增了 method（見 `newMethodHints`）：在同 service/manager 的 `methods/` 目錄下，**比照同目錄既有筆記格式**建立新 method 筆記，並在該 service 的 `_service.md` / `_manager.md` 的「RPC Methods」表格補一列。

## new_file 處理規則

依檔案性質，**比照既有同類筆記的目錄與命名慣例**建立筆記：
- 新 manager（`src/managers/xxx.ts`）→ `Codebase/Managers/<PascalCaseManager>/_manager.md` + `methods/Manager.<Manager>.<method>.md`（參考既有 Manager 筆記）
- 新 service（`src/servers/<srv>/services/xxx.ts`）→ 若 server 筆記已存在，於該 server 下新增 `services/<Service>/_service.md` + `methods/<server>.<service>.<Method>.md`
- 全新 server（如 `back_office_notification`，Codebase 尚無此 server 目錄）→ 建 `Codebase/Servers/<PascalCaseServer>/`：`_overview.md` + `services/<Service>/_service.md` + 各 method 筆記。**比照任一既有 server 的目錄結構**。
- audit_back_office handler（`.../handlers/implementations/xxx_handler.ts`）→ `Codebase/Servers/AuditBackOffice/handlers/auditBackOffice.<HandlerName>.md`（參考既有 `auditBackOffice.WageringManualAddHandler.md` 等格式；HandlerName 用 PascalCase）

新筆記 frontmatter 必備：`type`、`fqn`、`source_file`（`agrabah/<filePath>`）、`source_line`、`last_scanned: 2026-06-07`，其餘欄位比照同類筆記。method FQN / server / service 一律用 rajah-query 腳本確認，不要猜。

## 嚴禁事項

- **不要**編輯 `pending-actions.json`（狀態由派工者統一回寫）。
- **不要**動任何 `<!-- AUTO-GENERATED ... -->` 區塊：`### Called By` 的 backlinks、`## 完整呼叫鏈（Downstream）`——這些由 finalize 自動重建。
- **不要**編輯 `localizations/*.json`。
- **不要** `git push` 或任何 remote 操作；git 僅限唯讀（`git diff` / `git show` / `git log`）。
- **不得覆寫** `human_edited: true` 的筆記（本批次理論上沒有，遇到就跳過並回報）。
- **不得偽造 `[[ ]]` 連結**：連結目標須存在，否則標「待建立」。

## 回報格式（你的最終輸出）

用簡潔 Markdown 回報，**逐 action**列出：
```
### action[<index>] <filePath> (<type>)
- 變更摘要：<一句話 diff 在改什麼>
- 更新筆記：<相對路徑清單，或「無（diff 與筆記語意無關，僅 bump last_scanned 略過」）>
- 新建筆記：<相對路徑清單，或 無>
- TBD：<有留 TBD 的地方，或 無>
```
最後一行輸出：`DONE actions=<你處理的 action 數> notesUpdated=<n> notesCreated=<n>`
