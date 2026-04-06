# Dimension F: 前端（abu / lago）

> 適用於：abu（後台前端，Vue 3 + Quasar）、lago（前端 App，Vue 3 + Vant 4 + Tailwind CSS 4 + Vite）

## 核心檢查方向

1. **元件設計**：無不必要的 prop drilling；適當使用 composables
2. **Reactivity**：`reactive`/`ref` 使用正確；大陣列或深層巢狀物件考慮 `shallowRef`
3. **API 呼叫**：錯誤處理和 loading 狀態已處理
4. **i18n**：文字使用 i18n key，不可硬編碼字串
5. **生命週期清理**：`onMounted` 中註冊的 event listener、timer、WebSocket 必須在 `onUnmounted`/`onBeforeUnmount` 中清理
6. **v-for key**：`:key` 必須使用 unique stable ID（如 `row.id`），禁止用 array index
7. **權限控制**：CRUD UI 元素（新增、編輯、狀態切換按鈕）必須有 `api.role.hasPermission()` 檢查
8. **非同步 race condition**：快速觸發的非同步操作（搜尋、分頁）必須有 debounce 或取消前一個請求

## 專案特有規則（地雷）

- **rajah Model 建構（前端強制）**：前端（abu/lago）**完全禁止** `new` 建構 rajah model；必須用 `Model.create()` 或 `Model.fromObject()`。搜尋參數初始化用 `ref(SearchModel.create())`；表單提交前用 `EditModel.fromObject(data)`
- **API error handling pattern**：abu/lago genie RPC client 有**全域請求錯誤處理器**；所有 RPC 錯誤自動由 `ui.showError()` 顯示。開發者只需檢查 `result.failed` 並 `return`，**不需手動 `ui.showError()`**。`result.errorTo()` 是**型別轉換**用途。寫入操作應用 `ui.wrapLoading()` 包裝
- **DataTable search vs reload**：abu 搜尋操作必須用 `dataTable.reset()`（重置到第 1 頁），不是 `dataTable.reload()`（重新載入當前頁）
- **common symlink 影響範圍**：編輯 `abu/common/` 下的檔案時，`admin/src/common` 和 `platform/src/common` 都是 symlink 指向 `../../common`，變更同時影響兩者
- **檔案命名規範**：`.vue` 元件用 PascalCase；`.ts` 檔案用 snake_case；資料夾用 snake_case
- **Generated files 不可修改**：`common/generated/` 下的檔案不可出現手動編輯

> 以上為重點檢查項，不限於此。基於你的專業判斷，覆蓋該維度的其他潛在問題。
