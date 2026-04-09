# Code Review 核心規則

> 此檔案是所有 Review Agent 的必讀核心規則。Dimension 細節請依據主代理指示讀取對應的 dimensions/*.md。

---

## 1. Severity 定義

| 級別 | 圖示 | 名稱 | 定義 | 進入 CSV |
|------|------|------|------|----------|
| P0 | 🔴 | Blocker | 線上必出事：資料遺失、安全漏洞（SQL injection / 未授權存取）、邏輯錯誤導致資金異常 | Yes |
| P1 | 🟠 | Critical | 高風險：高併發 race condition、N+1 嚴重效能問題、權限檢查遺漏、跨平台資料洩漏、`console.log`/`console.error`/`debugger` 殘留在生產代碼、嚴重度校準錯誤（將功能性 bug 或規範違反降級至 P3/P4） | Yes |
| P2 | 🟡 | Warning | 不符規範但不會立即出事：型別選用不當（TEXT/DECIMAL）、命名不符規範、null check 遺漏 | No |
| P3 | 🔵 | Note | 可改進但有合理理由不改：效能優化建議、架構改進方向、可讀性提升 | No |
| P4 | 🟢 | Nit | 風格偏好：import 順序、命名風格、註解格式 | No |

### Severity 判定指引

- **是否有合理的業務理由**：如果變更有明確的業務需求支撐（如資料遷移暫存、企劃規劃的特殊流程），severity 應降級
- **是否為專案已知例外**：如落地頁 config 必須包含 URL、特定欄位長度不固定需用 TEXT
- **是否為設計意圖**：如故意的 fire-and-forget、故意移除某個過濾條件
- **懷疑時降級**：不確定是否為 P0/P1 時，先歸為 P2 並在描述中說明不確定的原因

---

## 2. 輸出格式

一份 Markdown 檔案 per author，存放於：

```
/Users/user/aladdin/review/YYYYMMDD/<author_name>_YYYYMMDD.md
```

### 報告結構

報告按子專案分段（agrabah / abu / lago / rajah）。每段包含 commit 摘要、逐 commit 審查、問題清單。如果 author 當天只修改一個專案，只需該專案的段落。總評分跨所有專案，放在最後。

```markdown
# Code Review Report — <Author Name>
> Review date: YYYY-MM-DD | Execution date: YYYY-MM-DD | Scope: agrabah / abu / lago / rajah

---

## agrabah

### Commit Summary

| Commit | Message | Time |
|--------|---------|------|
| `abc1234` | commit message | HH:MM |

### Per-Commit Review

#### `<commit_hash>` — <commit message>

**Files involved:**
- `path/to/file.ts`

##### <Sub-heading>

\`\`\`<language>
// Key code snippet
\`\`\`

- ✅ <正確做法描述>
- 🐛 **<P0-P4 級別>:** <問題描述> — <建議修正>
- ⚠️ <潛在風險或建議>
- 💡 <優化建議（optional）>

### Issue List

已在同日後續 commit 修復的問題不列入此表。

| Severity | Location | Description |
|----------|----------|-------------|
| 🔴 P0 | `file.ts:42` | <問題描述> |
| 🟠 P1 | `migration.sql` | <問題描述> |

---

## Cross-repo Impact Analysis

> 僅當 author 同日修改多個 repo 時需要此段落。

| Aspect | Finding |
|--------|---------|
| rajah <-> agrabah sync | rajah 定義變更是否有對應的 agrabah 實作？ |
| Schema <-> Code alignment | migration 是否與 DbObject 定義一致？ |
| Frontend <-> Backend contract | abu/lago 的 model 使用是否與 agrabah 回傳一致？ |

## Trend Note

> 僅當同一類問題在此 author 過去的 review 中重複出現時才需要。

## Overall Score

**⭐⭐⭐⭐⭐ Excellent / ⭐⭐⭐⭐ Good / ⭐⭐⭐ Acceptable / ⭐⭐ Needs Improvement / ⭐ Needs Refactoring**

<4-6 句：跨所有專案的整體品質評估、重點亮點、主要問題、改進方向>
```

---

## 3. 執行規則

1. **報告語言**：所有報告內容使用**繁體中文**。程式碼片段、檔案路徑、變數名稱、commit hash 等技術識別符保持原文。
2. **必須讀全檔**：僅看 diff 不足以做出準確審查，需讀取修改檔案的完整內容。
3. **引用程式碼**：所有審查中引用的程式碼必須實際存在於 diff 或檔案中。
4. **不做模糊描述**：每個 issue 必須引用具體檔案、行號（如有）和程式碼片段。
5. **正面回饋**：明確以 ✅ 標記良好的設計和正確實作。
6. **跳過生成檔案**：不審查 `src/generated/`、`src/entries/`、`node_modules/` 下的檔案。
6b. **禁止跳過多語系 commit**：所有修改 `.json` locale 檔案（如 `en-US.json`、`zh-CN.json`、`zh-TW.json`）的 commit **必須逐 key 審查**，不可以「僅涉及翻譯/不涉及邏輯變更」為由跳過。i18n key 內容錯誤（如 key 名稱被中文污染、翻譯內容被覆蓋、key 遺失）是嚴重的線上顯示 bug（P0/P1 級）。審查重點：(1) key 名稱是否被意外修改或污染 (2) 同一 key 在不同語系檔案間是否一致 (3) 是否有 key 被意外刪除或覆蓋。
7. **agrabah RPC 必須交叉驗證 rajah 定義**：確認 service group 設定正確。
8. **Rajah-only commits**：如果 author 只有 rajah commits，仍然審查 rajah 定義的合理性。
9. **Emoji 用法**：一律使用 Unicode emoji 字元（🔴 🟠 🟡 🔵 🟢 ✅ ❌ ⚠️ 💡 🐛），禁止使用 shortcode 語法（如 `:red_circle:`）。
10. **Dimension 清單是下限，不是上限**：每個 dimension 的檢查項是「必須覆蓋的最低要求」。你必須基於資深架構師的專業判斷，主動發現清單之外的問題 — 包括但不限於 JavaScript 語言陷阱、業務邏輯漏洞、跨 commit 的不一致、隱含的資料正確性問題等。清單未列出的問題不代表不需要審查。
11. **每個 commit 的每個修改點都必須獨立審查**：不可因 commit 數量多而跳過或簡略帶過任何 commit。每個 diff hunk 都必須逐一檢視，確保問題覆蓋面的完整性。特別注意跨 commit 之間的時序依賴和中間狀態問題。
12. **刪除操作必須追查引用點**：當 commit 刪除元件、路由、函式、變數時，必須主動搜索（Grep/Glob）是否有其他檔案仍在引用被刪除的目標。殘留的引用會導致 runtime crash、白屏、404 等嚴重問題，屬於 P0/P1 級別。

---

## 4. 回報格式

完成審查後，回報主代理時使用以下格式：

每個 P0/P1 issue 獨立一行，欄位以 ` ||| ` 分隔：

```
CRITICAL_ISSUE ||| <P0 或 P1> ||| <Issue Description> ||| <Issue Location: file / method name / line number>
```

範例：
```
CRITICAL_ISSUE ||| P0 ||| SQL injection: 使用字串拼接而非 placeholder ||| agrabah/src/servers/payment/models/order.ts:142 / createOrder
CRITICAL_ISSUE ||| P1 ||| Missing @Permission on GetCommissionInvoiceOriginalData ||| rajah/services/agent_back_office.rajah:1970
```

若無 P0/P1 issues：`CRITICAL_ISSUE ||| none`
