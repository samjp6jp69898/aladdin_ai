# Aladdin 專案級 Skills

| 類型 | 位置 | 適用範圍 | 與專案耦合度 |
|------|------|---------|-------------|
| 專案級 skill | `.claude/skills/<name>/` | 僅在本 monorepo 中可用 | 高（依賴本專案結構） |

## 如何新增專案級 skill

1. 在 `.claude/skills/<skill-name>/` 建 `SKILL.md`
2. frontmatter 包含 `name` 與 `description`
   - description 必須包含中文觸發詞，否則模型不會自動觸發
3. 若需要輔助檔案（參考文件等），放在同目錄下
4. 在本 README.md 表格新增一筆

## 目前的專案級 skill

| Skill | 用途 | 觸發詞 |
|-------|------|--------|
| `method-call-graph` | 分析指定 service method 的四維呼叫鏈（同 server / 跨 server gRPC / 前端 / 三方回調） | 分析方法呼叫鏈 / 列出 caller / 找 method 被誰呼叫 / 呼叫鏈分析 |
| `deadlock-analyzer` | 分析指定 server 中哪些 transaction 持有指定 table 的鎖，並交叉比對 deadlock 風險 | deadlock 分析 / 死鎖排查 / transaction 鎖分析 / 找 deadlock / 哪些 transaction 鎖了這張表 |
| `codebase-sync` | 根據 git 歷史紀錄增量更新 Obsidian Codebase 知識庫筆記（三階段 pipeline：收集 diff → AI 更新筆記 → finalize 腳本） | 更新 Codebase 知識庫 / sync-from-git / git 同步筆記 / 增量更新筆記 / codebase sync |
