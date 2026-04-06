# Code Review 核心規則

> 此檔案是所有 Review Agent 的必讀核心規則。Dimension 細節請依據主代理指示讀取對應的 dimensions/*.md。

---

## 1. Severity 定義

| 級別 | 圖示 | 名稱 | 定義 | 進入 CSV |
|------|------|------|------|----------|
| P0 | 🔴 | Blocker | 線上必出事：資料遺失、安全漏洞（SQL injection / 未授權存取）、邏輯錯誤導致資金異常 | Yes |
| P1 | 🟠 | Critical | 高風險：高併發 race condition、N+1 嚴重效能問題、權限檢查遺漏、跨平台資料洩漏 | Yes |
| P2 | 🟡 | Warning | 不符規範但不會立即出事：型別選用不當（TEXT/DECIMAL）、命名不符規範、null check 遺漏、console.log 殘留 | No |
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
7. **agrabah RPC 必須交叉驗證 rajah 定義**：確認 service group 設定正確。
8. **Rajah-only commits**：如果 author 只有 rajah commits，仍然審查 rajah 定義的合理性。
9. **Emoji 用法**：一律使用 Unicode emoji 字元（🔴 🟠 🟡 🔵 🟢 ✅ ❌ ⚠️ 💡 🐛），禁止使用 shortcode 語法（如 `:red_circle:`）。

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
