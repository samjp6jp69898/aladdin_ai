# Aladdin 專案級 Skills

## 與 plugin / 全域 skill 的差異

| 類型 | 位置 | 適用範圍 | 與專案耦合度 |
|------|------|---------|-------------|
| 專案級 skill | `.claude/skills/<name>/` | 僅在本 monorepo 中可用 | 高（依賴本專案結構） |
| plugin / 全域 skill | `~/.claude/skills/` 或 npm plugin | 跨專案可用 | 低（通用能力） |

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
| `security-audit` | 白盒安全審計，產出安全報告 | 安全審計 / security audit / 審計 |
| `daily-code-review` | 每日代碼審查，掃描 commit 分派 review agent | daily code review / 每日審查 |
| `back-testing-stats` | Bug 回測統計與趨勢圖 | back testing stats / 回測統計 |
