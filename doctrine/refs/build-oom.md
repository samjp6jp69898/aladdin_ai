# Lint / Build OOM 完整說明（從 CLAUDE.md 抽出，2026-07-03）

> CLAUDE.md 只留硬規則；本檔保留完整背景、風險表與失敗特徵，除錯時讀。

## 背景

agrabah 後端 1300+ TS 檔（92MB）+ `typescript-eslint` type-aware rules；前端各 app 的 `vite build` 帶 `vue-tsc`。type-aware 工具會把整個 TS Program 載入記憶體，預設 V8 old-space heap（約 1.5GB）必定不夠，會被 Node 或 OS 殺掉。團隊已多次踩坑，**OOM 是必然結果，不是隨機事件**。

## 風險分級表

| 指令 | 風險 | 必加 `NODE_OPTIONS=--max-old-space-size=8192` |
|------|------|--------------------|
| `bun run lint`（agrabah / jafar / genie 等後端全量 ESLint） | 極高 | ✅ |
| `bun run build`、`vite build`（abu / lago / cassim 等前端含 vue-tsc） | 高 | ✅ |
| 多個 lint / build 任務並行（CI、AI agent 並行派工） | 極高 | ✅ 每個 process 各自設定 |
| `eslint <單一檔案 / 小目錄>`、`vite dev` 局部範圍 | 低 | 可省略 |

依機器 RAM 可放大到 12288 / 16384，不得小於 8192。

## 標準執行模式

```bash
# 後端全量 lint
NODE_OPTIONS=--max-old-space-size=8192 bun run lint

# 前端 build
NODE_OPTIONS=--max-old-space-size=8192 bun run build
```

## 失敗特徵（兩者都視同 OOM，勿當 lint 規則錯誤排查）

- `FATAL ERROR: ... JavaScript heap out of memory` + `<--- Last few GCs --->` log → V8 heap 軟限制
- 無任何錯誤訊息直接 `Killed` / exit code `137` / `signal: SIGKILL` → OS 或 container cgroup OOM Killer

## 不要做的事

- ❌ 不要為了「跑得過」就縮小 lint glob 範圍（例如只 lint 改動檔）——那是繞過問題，不是修復
- ❌ 不要關掉 `typescript-eslint` 的 type-aware rules 來省記憶體——那會弱化型別檢查
- ❌ 不要直接 kill 重跑期望「這次運氣好」——OOM 是必然結果

## 與 Worktree 放行條款的關係

worktree 內 bug-fixer 的 `bun run lint` / `bun run generate-*`、evaluator / test-validator 的 `bun test --coverage`，一律加上 `NODE_OPTIONS=--max-old-space-size=8192`，不得省略。
