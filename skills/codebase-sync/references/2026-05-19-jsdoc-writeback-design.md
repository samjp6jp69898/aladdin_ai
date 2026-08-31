# JSDoc Writeback — Stage 4 Design Spec

**Date**: 2026-05-19
**Status**: Approved (pending implementation)
**Author**: Brainstormed with user (Landon)
**Related skill**: `codebase-sync`

## 背景

`/codebase-sync` 目前是單向 pipeline（git → obsidian）。完成 Stage 2（AI 改 obsidian 筆記）與 Stage 3（finalize 跑索引）後，使用者另外手工請 AI「把 obsidian 註解寫回 source code 當 JSDoc」（如 commit `ff9eb5df2 docs: 將 obsidian 註解以 JSDoc 寫回 source`）。

這個手工步驟沒有任何衝突偵測，導致 2026-05-19 跑出 3 個 regression（最具代表性的是 hiro0519 於 `bc8175000` 加在 `methodRegister` JSDoc 的「送 `trackEvent(userRegister, success)` 埋點」被洗掉，因為對應的 obsidian 筆記 `last_scanned: 2026-04-22`、根本不知道有這段更新）。

本 spec 把這個寫回步驟正式化為 Stage 4，並引入 source-優先的合併策略防止 regression 再發生。

## Goal

Stage 4：在 `sync-from-git.ts --finalize` 結尾自動執行，把本輪 Stage 2 動過的 obsidian rpc-method / service 筆記，以「paragraph / bullet 集合聯集 + source 優先」策略合併寫回對應 source 檔案的 JSDoc 區塊。只改 working tree，不 commit。

## In Scope

- `type: rpc-method` 與 `type: service` 兩種 obsidian 筆記類型
- 寫回對應 TS 方法或 class 的 `/** ... */` JSDoc
- 只處理本次 `--finalize` 對應的 `pending-actions.json` 中 `status === "processed"` 的 action
- Section 範圍：主描述、`業務場景`、`相關規則與踩坑`、`備註`

## Out of Scope

- `type: enum` / `type: model` / `type: db-table` / `type: job` 等筆記類型（TS 對應結構不適合 JSDoc 敘述）
- 自動 commit / 自動發 PR
- 主動掃 obsidian 全庫做寫回（只走本輪 processed action）
- Source JSDoc 中既有的 `@param` / `@returns` / `@throws` / `@deprecated` 等 `@` 標籤合併（直接照搬，不參與 merge）
- 跨檔案 JSDoc 移動（rename 由 Stage 1 的 `rename_file` action 處理，不在此 spec）

## 觸發

在 `sync-from-git.ts --finalize` 流程中，**Stage 3 所有腳本跑完後**追加 Stage 4：

```
Stage 3 finalize:
  1. build-backlinks
  2. generate-indexes
  3. generate-call-chain
  4. generate-cross-server-rpc-graph
  5. 完整性檢查
  6. 產 daily report
  7. 更新 sync-state.json
  8. [NEW] writeback-jsdoc      ← Stage 4
```

可用 `--skip-writeback` flag 在 finalize 時關閉（給特殊情境）。
獨立呼叫：`bun run writeback-jsdoc.ts [--dry-run]`（與 finalize 解耦，方便 debug／重跑）。

## Scope 過濾（三道關）

對每個 `pending-actions.json` 中 status=processed 的 action，逐一檢查：

1. `affectedNotes` 中至少一篇 frontmatter `type` 為 `rpc-method` 或 `service`
2. 對應 source 檔案在 working tree 沒有「非本次 writeback 寫的」未提交改動
   - 實作：對 source 檔案做 `git diff --quiet` 檢查；若有改動，先 stash 暫存其他變更後再 writeback，writeback 完還原
   - 簡化版（v1）：若 source 檔案有任何 dirty changes → 整個 action 跳過，記入 `writeback-report.json` 的 `skipped` 區段
3. 對應 obsidian 筆記 frontmatter `human_edited !== true`

任一條件不過 → 該 action 跳過，記入報告 `skipped` 區段附原因。

## Source JSDoc 定位

依 note frontmatter 的 `source_file` + `source_line`：

1. 從 `source_line - 1` 往上掃描原始檔
2. 跳過空行、單行 `//` 註解
3. 預期遇到 `*/` → 開始往上抓 `/**` 到 `*/` 之間整段
4. 抓不到 → 此 action 標記為「source JSDoc 不存在」記入報告，**v1 不主動插入新 JSDoc**（避免改變 LOC 影響其他 line 數）

抓到的 JSDoc 區塊作為 source 端 base，進入下一步。

## Source JSDoc 解析（→ unit 集合）

把抓到的 `/** ... */` 區塊每行去掉 `* `/`*` 前綴後，按下列規則拆 section：

| 偵測規則 | 對應 section |
|---------|-------------|
| 第一個非空段落（直到遇到 `**業務場景**` 等粗體標題或檔尾） | `description` |
| `**業務場景**` 之後到下一個 `**...**` 標題或檔尾 | `scenarios` |
| `**相關規則與踩坑**` 之後 | `rules` |
| `**備註**` 之後 | `notes` |
| 任何 `@param` / `@returns` / `@throws` / `@deprecated` 等 `@xxx` 標籤行 | `tags`（整段照搬，不 merge） |

每個 section 的 unit 切法：

- `description`：以「。」「；」「.」「;」為分隔切成 sentence list（保留分隔符）
- `scenarios` / `rules` / `notes`：以 `- ` 開頭行為單位切成 bullet list

## Note 解析（→ unit 集合）

從 `.md` 筆記抓對應 section：

| Note h2 | 對應 section |
|---------|-------------|
| `## 功能描述` | `description` |
| `## 業務場景` | `scenarios` |
| `## 相關規則與踩坑` | `rules` |
| `## 備註` | `notes` |
| 其他 h2（輸入參數 / 回傳 / 相關錯誤碼 / 呼叫關係 / 權限 / 完整呼叫鏈 / Called By 等） | **忽略**（不寫回 JSDoc） |

切 unit 時對筆記內容做正規化：

| 筆記寫法 | 寫回 JSDoc 時轉成 |
|---------|------------------|
| `[[頁面名稱]]` | `「頁面名稱」` |
| 反引號 `code` | 去掉反引號，留下純文字 |
| 粗體 `**xxx**` | 去掉粗體標記 |
| `- ` bullet | `- ` bullet（保留） |
| `1.` 開頭的編號列表（多行）| 合併成單行 `1) xxx；2) xxx；...`（描述段內），section 標題保留 |

## Merge 演算法

對每個 section 獨立執行：

```
def merge_section(source_units, note_units):
    # 為每個 unit 算正規化 key：去前後空白、壓縮空白、刪 backtick/粗體標記、
    # 統一全形/半形括號等；只用於比對，不影響輸出
    source_keys = { normalize(u): u for u in source_units }
    note_keys = { normalize(u): u for u in note_units }

    merged = []

    # 1. 跑過 note 的 unit（保留 note 順序作為基準）
    for u in note_units:
        key = normalize(u)
        if key in source_keys:
            merged.append(source_keys[key])  # 兩邊都有 → source 版本贏（保留同事可能加的細節）
        else:
            merged.append(u)                 # 只有 note 有 → note 改進，採用

    # 2. 跑過 source 只有、note 沒有的 unit → 同事新增，附加在 section 結尾
    for u in source_units:
        if normalize(u) not in note_keys:
            merged.append(u)

    return merged
```

`@xxx` tag 區段不參與 merge，直接以 source 原樣輸出。

## 渲染回 JSDoc

固定模板：

```
/**
 * <description sentences joined by 「；」 or 「. 」, single long line>
 *
 * **業務場景**
 * - <scenario bullet 1>
 * - <scenario bullet 2>
 *
 * **相關規則與踩坑**
 * - <rule bullet 1>
 * ...
 *
 * **備註**
 * - <note bullet 1>
 * ...
 *
 * @param ...   ← from source `tags` section, untouched
 * @returns ... ← from source `tags` section, untouched
 */
```

規則：

- 任一 section（除 description 外）為空 → 整段（含 `**標題**` 行）省略
- description 為空 → 整個 JSDoc 不寫回，記入報告（避免產生空殼）
- section 之間以單行 `*` 分隔（與既有 JSDoc 風格一致）
- description 內若原本 note 有編號列表，渲染成單行的 `詳細步驟：1) xxx；2) xxx；...`（與既有 source 風格一致，見 `app_user.ts:752`）

## 寫回

1. 計算新 JSDoc 文字
2. 對比原 JSDoc 文字，**完全相同則跳過**（不寫檔，記入報告 `unchanged`）
3. 不同 → 用 `Bun.file().writer()` 把新 JSDoc 替換原 JSDoc，其他內容不動

## 輸出

`aladdin_ai/scripts/codebase-index/writeback-report.json`：

```json
{
  "timestamp": "2026-05-19T14:00:00+08:00",
  "summary": {
    "processed_actions": 18,
    "files_modified": 7,
    "actions_skipped": 3,
    "actions_unchanged": 8
  },
  "modified": [
    {
      "file": "src/servers/app_user/services/app_user.ts",
      "method": "methodRegister",
      "note": "appUser.appUser.Register.md",
      "diff_summary": "+2 lines (scenarios), -1 line (notes)"
    }
  ],
  "skipped": [
    {
      "action_id": "...",
      "reason": "source file has uncommitted changes"
    }
  ],
  "unchanged": [...]
}
```

Console 印出 summary 表：

```
Stage 4: writeback-jsdoc
  ✓ 7 files modified
  − 8 actions unchanged (JSDoc identical)
  ⊘ 3 actions skipped (see writeback-report.json)

Please review changes:
  cd /Users/user/aladdin/agrabah && git diff
```

## 安全規則

1. **絕不 commit**：只動 working tree，使用者自行 review 後再 commit
2. **絕不刪 JSDoc**：description 為空就跳過整個 action
3. **絕不亂插**：source 沒有 JSDoc 時，**不主動建立**（v1 範圍）
4. **fail-fast**：任何 action 的 source JSDoc 解析失敗 → 該 action 跳過，但其他繼續；如果跳過率 > 30% → 整批 abort
5. **`@` tag 必保留**：source 上的 `@param` / `@returns` / `@throws` / `@deprecated` 等全段原樣回填
6. **冪等**：對同一個 working tree 連跑兩次 Stage 4，第二次應全部 `unchanged`

## SKILL.md 更新

在現有「完整工作流程（三階段）」標題改成「完整工作流程（四階段）」，並追加 Stage 4 章節：

```markdown
### Stage 4：寫回 source JSDoc

```bash
bun run writeback-jsdoc.ts --dry-run   # 預覽
bun run writeback-jsdoc.ts             # 正式寫
```

讀 `pending-actions.json` status=processed 的 action，把對應 obsidian rpc-method/service
筆記合併寫回 source 的 JSDoc 區塊。合併策略：paragraph/bullet 集合聯集，source 內容優先
（保留同事直接在 source 加的註解）。只改 working tree，不 commit，請自行 `git diff` 確認後 commit。

**Section 對應表**：

| Obsidian h2 | JSDoc section |
|---|---|
| `## 功能描述` | 主描述 |
| `## 業務場景` | `**業務場景**` |
| `## 相關規則與踩坑` | `**相關規則與踩坑**` |
| `## 備註` | `**備註**` |
| 其他（輸入參數 / 回傳 / 呼叫關係 等） | 不寫回 JSDoc |
```

並在「絕對規則」追加第 6 條：

```markdown
6. **不得手工把 obsidian 內容貼回 source 當 JSDoc**：必須走 Stage 4 的 writeback-jsdoc.ts merge 流程；
   手工複製貼上會洗掉同事在 source 後加的註解（見 2026-05-19 trackEvent regression 事件）。
```

## 新增檔案

| 檔案 | 用途 |
|------|------|
| `aladdin_ai/scripts/codebase-index/writeback-jsdoc.ts` | 主腳本 entry point，CLI 處理、orchestration |
| `aladdin_ai/scripts/codebase-index/lib/jsdoc-extractor.ts` | 從 source 抓 `/** */` 區塊；輸入：file path + line, 輸出：JSDoc 區塊起訖行 + 內容 |
| `aladdin_ai/scripts/codebase-index/lib/jsdoc-parser.ts` | 把 JSDoc 區塊切成 section + unit |
| `aladdin_ai/scripts/codebase-index/lib/note-section-parser.ts` | 把 obsidian 筆記切成 section + unit，含正規化 |
| `aladdin_ai/scripts/codebase-index/lib/section-merger.ts` | 對單一 section 跑聯集 merge |
| `aladdin_ai/scripts/codebase-index/lib/jsdoc-renderer.ts` | 把 merged section 渲染成 JSDoc 字串 |
| `aladdin_ai/scripts/codebase-index/writeback-report.json` | 執行報告（git-ignored） |

修改：`aladdin_ai/scripts/codebase-index/sync-from-git.ts` 在 `runFinalize` 結尾呼叫 writeback-jsdoc，並加 `--skip-writeback` flag handling。

## 測試策略

不寫單元測試框架（與既有 codebase-index 腳本一致，靠 dry-run + 視覺檢查）。

採取**三個黃金測試 case**手動驗證：

1. **trackEvent regression case**：對 `app_user.ts :: methodRegister`，先 `git checkout` 回 hiro0519 commit `bc8175000` 後狀態（source 含 `送 trackEvent 埋點`，note `last_scanned: 2026-04-22` 不含）→ 跑 Stage 4 → 預期 JSDoc 保留 `送 trackEvent` 那段
2. **純 note 改進 case**：在 note 改寫一條 rule（source 沒有的），跑 Stage 4 → 預期 source JSDoc 多出該條 rule
3. **冪等 case**：跑兩次 Stage 4，第二次預期全部 `unchanged`

驗證腳本：`scripts/codebase-index/test-writeback-golden.ts`（手動執行，非 CI）。

## Open Questions

無（已在 brainstorming 中拍板）。
