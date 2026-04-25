# Incremental Codebase Sync 實作計劃

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立全自動增量同步機制，每日從 agrabah + rajah 的 git commit 偵測變更，自動更新 Obsidian Codebase 知識庫筆記。

**Architecture:** 四階段 pipeline：Stage 1 收集 git diff 並分類 → Stage 2 派 agent 更新受影響筆記 → Stage 3 重跑冪等腳本 → Stage 4 完整性檢查 + 每日報告 + commit。每個 stage 有獨立的 .ts 模組，以 `sync-from-git.ts` 為主入口串接。

**Tech Stack:** Bun + TypeScript，沿用既有 `gray-matter` 依賴與 `note-parser.ts` 共用 lib。Agent 派發透過 Claude Code Agent tool。

---

## File Structure

```
scripts/codebase-index/
├── sync-from-git.ts                        ← 主入口 CLI
├── noise-rules.json                        ← 過濾規則設定
├── sync-state.json                         ← 同步狀態（last_sync_commit、歷史）
├── lib/
│   ├── note-parser.ts                      ← [既有] 不修改
│   ├── git-diff-collector.ts               ← Stage 1: 掃 git commit + diff
│   ├── noise-filter.ts                     ← Stage 1: 過濾 noise commit/file
│   ├── rajah-change-resolver.ts            ← Stage 1: rajah 變更 → agrabah 檔對應
│   ├── file-to-note-mapper.ts              ← Stage 1: .ts 路徑 → 筆記路徑
│   ├── change-classifier.ts               ← Stage 1: 判定 added/modified/deleted + 變更類型
│   ├── note-integrity-checker.ts           ← Stage 4: commit 前健全檢查
│   └── daily-report-builder.ts             ← Stage 4: 產出日報
├── agent-prompts/
│   ├── incremental-new-entity.md           ← Agent prompt: 新增 method/service/file
│   ├── incremental-update-note.md          ← Agent prompt: 更新既有筆記
│   └── incremental-fix-broken-links.md     ← Agent prompt: 修復 broken links
├── [既有腳本不修改]
│   ├── build-backlinks.ts
│   ├── build-overview-aggregates.ts
│   ├── generate-call-chain.ts
│   ├── generate-cross-server-rpc-graph.ts
│   ├── generate-indexes.ts
│   └── check-orphan-notes.ts
```

### 設計約束

1. **不修改既有腳本**：`build-backlinks.ts` 等 6 支已驗證的冪等腳本保持不動
2. **不修改 `note-parser.ts`**：新功能需要的解析能力寫在各自模組裡
3. **不侵入 `scan-progress.json`**：增量同步用獨立的 `sync-state.json`
4. **不修改既有筆記結構**：不引入 anchor 標記（前面討論的防線 B），改用 diff 比對 + 健全檢查（防線 C）來確保正確性。理由：既有 304+ 篇筆記已在使用中，不引入 migration 風險
5. **Agent 更新策略**：agent 對筆記做 Edit（不是 Write），且一次只動一篇筆記的內容區塊，主腳本事後驗證

---

## Task 1: noise-rules.json — 過濾規則設定檔

**Files:**
- Create: `scripts/codebase-index/noise-rules.json`

- [ ] **Step 1: 建立 noise-rules.json**

```json
{
  "skip_commit_message_patterns": [
    "^\\[Chg\\] version -> ",
    "^VERSION ",
    "^版號",
    "^修改版號",
    "^更新版號",
    "^變更版號",
    "^bump version",
    "^version:",
    "^update version",
    "^chore\\(version\\)",
    "^chore\\(release\\)"
  ],
  "skip_file_patterns": [
    "package\\.json$",
    "bun\\.lock$",
    "yarn\\.lock$",
    "CHANGELOG\\.md$",
    "\\.gitignore$",
    "node_modules/"
  ],
  "low_signal_keywords": [
    "lint",
    "format",
    "prettier",
    "eslint",
    "style(",
    "style:"
  ],
  "low_signal_diff_patterns": [
    "^[-+]\\s*$",
    "^[-+]\\s*//",
    "^[-+]\\s*\\*",
    "^[-+]\\s*import\\s"
  ]
}
```

- [ ] **Step 2: Commit**

```bash
cd /Users/user/aladdin/obsidian
git add scripts/codebase-index/noise-rules.json
git commit -m "feat(codebase-sync): add noise-rules.json for incremental sync filtering"
```

---

## Task 2: sync-state.json — 同步狀態檔

**Files:**
- Create: `scripts/codebase-index/sync-state.json`

- [ ] **Step 1: 建立初始 sync-state.json**

```json
{
  "schema_version": 1,
  "agrabah_last_sync_commit": null,
  "rajah_last_sync_commit": null,
  "last_sync_date": null,
  "sync_history": []
}
```

- [ ] **Step 2: Commit**

```bash
cd /Users/user/aladdin/obsidian
git add scripts/codebase-index/sync-state.json
git commit -m "feat(codebase-sync): add sync-state.json for incremental sync tracking"
```

---

## Task 3: git-diff-collector.ts — 收集 git diff

**Files:**
- Create: `scripts/codebase-index/lib/git-diff-collector.ts`
- Test: 在 Task 11 整合測試

這個模組的職責：呼叫 `git log` + `git diff` 拿到指定時間區間內的 commit 和檔案變更。

- [ ] **Step 1: 寫 git-diff-collector.ts**

```typescript
import { $ } from 'bun';

export interface CommitInfo {
    hash: string;
    message: string;
    author: string;
    date: string;
    files: FileChange[];
}

export interface FileChange {
    status: 'A' | 'M' | 'D' | 'R';
    path: string;
    oldPath?: string; // only for renames
    additions: number;
    deletions: number;
}

export interface CollectorOptions {
    repoPath: string;
    since?: string;     // ISO date or git date string
    until?: string;
    commits?: string[]; // specific commit hashes
}

export async function collectCommits(opts: CollectorOptions): Promise<CommitInfo[]> {
    const { repoPath, since, until, commits: specificCommits } = opts;

    if (specificCommits?.length) {
        const results: CommitInfo[] = [];
        for (const hash of specificCommits) {
            const info = await getCommitInfo(repoPath, hash);
            if (info) results.push(info);
        }
        return results;
    }

    const args = ['git', 'log', '--pretty=format:%H|%s|%an|%aI'];
    if (since) args.push(`--since=${since}`);
    if (until) args.push(`--until=${until}`);

    const result = await $`${args}`.cwd(repoPath).text().catch(() => '');
    if (!result.trim()) return [];

    const hashes = result.trim().split('\n').map(line => {
        const [hash, message, author, date] = line.split('|');
        return { hash, message, author, date };
    });

    const commits: CommitInfo[] = [];
    for (const { hash, message, author, date } of hashes) {
        const files = await getFilesForCommit(repoPath, hash);
        commits.push({ hash, message, author, date, files });
    }

    return commits;
}

async function getCommitInfo(repoPath: string, hash: string): Promise<CommitInfo | null> {
    const info = await $`git log -1 --pretty=format:%H|%s|%an|%aI ${hash}`
        .cwd(repoPath).text().catch(() => '');
    if (!info.trim()) return null;

    const [h, message, author, date] = info.trim().split('|');
    const files = await getFilesForCommit(repoPath, h);
    return { hash: h, message, author, date, files };
}

async function getFilesForCommit(repoPath: string, hash: string): Promise<FileChange[]> {
    // --diff-filter=ADMR: Added, Deleted, Modified, Renamed
    const raw = await $`git diff-tree --no-commit-id -r --numstat --diff-filter=ADMR -M ${hash}`
        .cwd(repoPath).text().catch(() => '');
    const nameStatus = await $`git diff-tree --no-commit-id -r --name-status --diff-filter=ADMR -M ${hash}`
        .cwd(repoPath).text().catch(() => '');

    if (!raw.trim() || !nameStatus.trim()) return [];

    const statLines = raw.trim().split('\n');
    const statusLines = nameStatus.trim().split('\n');

    const files: FileChange[] = [];
    for (let i = 0; i < statusLines.length; i++) {
        const statusParts = statusLines[i].split('\t');
        const statusChar = statusParts[0][0] as FileChange['status'];

        let path: string;
        let oldPath: string | undefined;
        if (statusChar === 'R') {
            oldPath = statusParts[1];
            path = statusParts[2];
        } else {
            path = statusParts[1];
        }

        // Match numstat line
        const statLine = statLines[i];
        const statParts = statLine?.split('\t') ?? [];
        const additions = parseInt(statParts[0]) || 0;
        const deletions = parseInt(statParts[1]) || 0;

        files.push({ status: statusChar, path, oldPath, additions, deletions });
    }

    return files;
}

export async function getDiffContent(repoPath: string, hash: string, filePath: string): Promise<string> {
    return $`git diff ${hash}~1..${hash} -- ${filePath}`
        .cwd(repoPath).text().catch(() => '');
}
```

- [ ] **Step 2: Commit**

```bash
cd /Users/user/aladdin/obsidian
git add scripts/codebase-index/lib/git-diff-collector.ts
git commit -m "feat(codebase-sync): add git-diff-collector module"
```

---

## Task 4: noise-filter.ts — 過濾 noise

**Files:**
- Create: `scripts/codebase-index/lib/noise-filter.ts`

- [ ] **Step 1: 寫 noise-filter.ts**

```typescript
import { readFile } from 'node:fs/promises';
import type { CommitInfo, FileChange } from './git-diff-collector.ts';
import { getDiffContent } from './git-diff-collector.ts';

interface NoiseRules {
    skip_commit_message_patterns: string[];
    skip_file_patterns: string[];
    low_signal_keywords: string[];
    low_signal_diff_patterns: string[];
}

export interface FilterResult {
    kept: CommitInfo[];
    skipped: Array<{ commit: CommitInfo; reason: string }>;
    mixedSignal: Array<{ commit: CommitInfo; note: string }>;
}

let cachedRules: NoiseRules | null = null;

async function loadRules(rulesPath: string): Promise<NoiseRules> {
    if (cachedRules) return cachedRules;
    const raw = await readFile(rulesPath, 'utf-8');
    cachedRules = JSON.parse(raw);
    return cachedRules!;
}

export async function filterCommits(
    commits: CommitInfo[],
    repoPath: string,
    rulesPath: string
): Promise<FilterResult> {
    const rules = await loadRules(rulesPath);
    const skipPatterns = rules.skip_commit_message_patterns.map(p => new RegExp(p, 'i'));
    const filePatterns = rules.skip_file_patterns.map(p => new RegExp(p));
    const lowSignalKws = rules.low_signal_keywords.map(k => k.toLowerCase());
    const lowSignalDiffPats = rules.low_signal_diff_patterns.map(p => new RegExp(p));

    const result: FilterResult = { kept: [], skipped: [], mixedSignal: [] };

    for (const commit of commits) {
        // Layer 1: commit message skip
        if (skipPatterns.some(p => p.test(commit.message))) {
            result.skipped.push({ commit, reason: 'commit_message_match' });
            continue;
        }

        // Filter out noise files from commit
        const relevantFiles = commit.files.filter(f => !filePatterns.some(p => p.test(f.path)));
        if (relevantFiles.length === 0) {
            result.skipped.push({ commit, reason: 'all_files_noise' });
            continue;
        }

        // Layer 2: low signal keywords → check diff content
        const isLowSignal = lowSignalKws.some(kw => commit.message.toLowerCase().includes(kw));

        if (isLowSignal) {
            const hasSubstantiveChange = await checkSubstantiveChanges(
                repoPath, commit.hash, relevantFiles, lowSignalDiffPats
            );
            if (!hasSubstantiveChange) {
                result.skipped.push({ commit, reason: 'low_signal_no_substance' });
                continue;
            }
            result.mixedSignal.push({
                commit: { ...commit, files: relevantFiles },
                note: 'low_signal_keyword_but_has_substantive_changes'
            });
        }

        result.kept.push({ ...commit, files: relevantFiles });
    }

    return result;
}

async function checkSubstantiveChanges(
    repoPath: string,
    hash: string,
    files: FileChange[],
    noisePatterns: RegExp[]
): Promise<boolean> {
    for (const file of files.slice(0, 5)) { // check up to 5 files
        const diff = await getDiffContent(repoPath, hash, file.path);
        const changedLines = diff.split('\n').filter(l => l.startsWith('+') || l.startsWith('-'));
        const substantiveLines = changedLines.filter(l => {
            if (l === '+++' || l === '---') return false;
            return !noisePatterns.some(p => p.test(l));
        });
        if (substantiveLines.length > 0) return true;
    }
    return false;
}

export function filterFilesByScope(files: FileChange[]): FileChange[] {
    // Only keep files under src/servers/*/services/ or src/managers/
    return files.filter(f =>
        /^src\/servers\/[^/]+\/services\//.test(f.path) ||
        /^src\/managers\//.test(f.path) ||
        /^src\/servers\/[^/]+\/logic\//.test(f.path)
    );
}
```

- [ ] **Step 2: Commit**

```bash
cd /Users/user/aladdin/obsidian
git add scripts/codebase-index/lib/noise-filter.ts
git commit -m "feat(codebase-sync): add noise-filter module with 3-layer filtering"
```

---

## Task 5: rajah-change-resolver.ts — rajah 變更對應

**Files:**
- Create: `scripts/codebase-index/lib/rajah-change-resolver.ts`

職責：解析 rajah git diff，找出受影響的 service.method / model / enum FQN，反查對應的 agrabah 檔。

- [ ] **Step 1: 寫 rajah-change-resolver.ts**

```typescript
import type { CommitInfo, FileChange } from './git-diff-collector.ts';
import { getDiffContent } from './git-diff-collector.ts';
import { Glob } from 'bun';
import { readFile } from 'node:fs/promises';

export interface RajahImpact {
    rajahFile: string;
    affectedFqns: string[];      // e.g. ['wallet.wallet.GetBalance']
    changeType: 'signature' | 'model' | 'enum' | 'new_method' | 'deleted_method';
    commitHash: string;
    diffSummary: string;
}

export async function resolveRajahImpacts(
    commits: CommitInfo[],
    rajahRepoPath: string,
    agrabahRepoPath: string
): Promise<RajahImpact[]> {
    const impacts: RajahImpact[] = [];

    for (const commit of commits) {
        const rajahFiles = commit.files.filter(f =>
            f.path.startsWith('services/') && f.path.endsWith('.rajah')
        );

        for (const file of rajahFiles) {
            const diff = await getDiffContent(rajahRepoPath, commit.hash, file.path);
            const fileImpacts = parseRajahDiff(diff, file.path, commit.hash);
            impacts.push(...fileImpacts);
        }
    }

    return impacts;
}

function parseRajahDiff(diff: string, rajahPath: string, commitHash: string): RajahImpact[] {
    const impacts: RajahImpact[] = [];
    const lines = diff.split('\n');

    // Extract the rajah filename (e.g. "wallet" from "services/wallet.rajah")
    const rajahName = rajahPath.replace('services/', '').replace('.rajah', '');

    let currentService: string | null = null;

    for (const line of lines) {
        // Track current service context
        const serviceMatch = line.match(/^[\s]*service\s+(\w+)/);
        if (serviceMatch) {
            currentService = serviceMatch[1];
            continue;
        }

        // Detect added/removed methods
        if (line.startsWith('+') && !line.startsWith('+++')) {
            const methodMatch = line.match(/^\+\s*method\s+(\w+)\s*\(/);
            if (methodMatch && currentService) {
                const methodName = methodMatch[1].replace(/^method/, '');
                const serviceCamel = toCamelCase(currentService);
                const fqn = `${rajahName}.${serviceCamel}.${methodName}`;
                impacts.push({
                    rajahFile: rajahPath,
                    affectedFqns: [fqn],
                    changeType: 'new_method',
                    commitHash,
                    diffSummary: line.trim()
                });
            }

            // Detect model/enum changes
            const modelMatch = line.match(/^\+\s*(model|enum)\s+(\w+)/);
            if (modelMatch) {
                const kind = modelMatch[1] as 'model' | 'enum';
                impacts.push({
                    rajahFile: rajahPath,
                    affectedFqns: [`${capitalize(rajahName)}.${capitalize(kind)}.${modelMatch[2]}`],
                    changeType: kind,
                    commitHash,
                    diffSummary: line.trim()
                });
            }
        }

        if (line.startsWith('-') && !line.startsWith('---')) {
            const methodMatch = line.match(/^-\s*method\s+(\w+)\s*\(/);
            if (methodMatch && currentService) {
                const methodName = methodMatch[1].replace(/^method/, '');
                const serviceCamel = toCamelCase(currentService);
                const fqn = `${rajahName}.${serviceCamel}.${methodName}`;
                impacts.push({
                    rajahFile: rajahPath,
                    affectedFqns: [fqn],
                    changeType: 'deleted_method',
                    commitHash,
                    diffSummary: line.trim()
                });
            }
        }

        // Detect signature changes: lines that modify existing method params/response
        if ((line.startsWith('+') || line.startsWith('-')) && !line.startsWith('+++') && !line.startsWith('---')) {
            // Field changes inside a method, model, or enum
            const fieldMatch = line.match(/^[-+]\s+(\w+)\s+(i32|i64|string|bool|\w+)\s+\d+/);
            if (fieldMatch && currentService) {
                // This is a field change in a model or method
                impacts.push({
                    rajahFile: rajahPath,
                    affectedFqns: [], // will be enriched later
                    changeType: 'signature',
                    commitHash,
                    diffSummary: line.trim()
                });
            }
        }
    }

    return impacts;
}

function toCamelCase(s: string): string {
    return s.charAt(0).toLowerCase() + s.slice(1);
}

function capitalize(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1);
}

export function mapRajahToAgrabahFiles(
    rajahFile: string,
    agrabahRepoPath: string
): string[] {
    // rajah filename → server directory
    // e.g. "services/wallet.rajah" → "src/servers/wallet/services/"
    const name = rajahFile.replace('services/', '').replace('.rajah', '');

    // Common patterns:
    // wallet.rajah → src/servers/wallet/services/
    // wallet_back_office.rajah → src/servers/wallet_back_office/services/
    // agent_common.rajah → shared definitions (no server)
    if (name.endsWith('_common') || name === 'common' || name === 'service_common') {
        return []; // shared definitions, no direct server mapping
    }

    return [`src/servers/${name}/services/`];
}
```

- [ ] **Step 2: Commit**

```bash
cd /Users/user/aladdin/obsidian
git add scripts/codebase-index/lib/rajah-change-resolver.ts
git commit -m "feat(codebase-sync): add rajah-change-resolver for rajah → agrabah mapping"
```

---

## Task 6: file-to-note-mapper.ts — .ts 路徑 → 筆記路徑

**Files:**
- Create: `scripts/codebase-index/lib/file-to-note-mapper.ts`

職責：給定一個 agrabah .ts 檔案路徑，找出所有對應的 Obsidian 筆記。

- [ ] **Step 1: 寫 file-to-note-mapper.ts**

```typescript
import { Glob } from 'bun';
import { parseNote, type ParsedNote } from './note-parser.ts';

const CODEBASE_ROOT = '/Users/user/aladdin/obsidian/Codebase';

let noteIndex: Map<string, ParsedNote[]> | null = null;

export async function buildNoteIndex(): Promise<Map<string, ParsedNote[]>> {
    if (noteIndex) return noteIndex;

    noteIndex = new Map();
    const glob = new Glob('**/*.md');

    for await (const rel of glob.scan(CODEBASE_ROOT)) {
        const path = `${CODEBASE_ROOT}/${rel}`;
        const note = await parseNote(path);
        if (!note) continue;

        const sourceFile = note.frontmatter.source_file as string | undefined;
        if (!sourceFile) continue;

        if (!noteIndex.has(sourceFile)) {
            noteIndex.set(sourceFile, []);
        }
        noteIndex.get(sourceFile)!.push(note);
    }

    return noteIndex;
}

export interface NoteMatch {
    note: ParsedNote;
    relation: 'direct';  // the note's source_file matches the changed file
}

export async function findNotesForFile(agrabahFilePath: string): Promise<NoteMatch[]> {
    const index = await buildNoteIndex();

    // agrabahFilePath is relative to agrabah repo, e.g. "src/servers/wallet/services/wallet.ts"
    // frontmatter source_file is "agrabah/src/servers/wallet/services/wallet.ts"
    const fullPath = agrabahFilePath.startsWith('agrabah/')
        ? agrabahFilePath
        : `agrabah/${agrabahFilePath}`;

    const matches: NoteMatch[] = [];
    const notes = index.get(fullPath);
    if (notes) {
        for (const note of notes) {
            matches.push({ note, relation: 'direct' });
        }
    }

    return matches;
}

export async function findNoteByFqn(fqn: string): Promise<ParsedNote | null> {
    const index = await buildNoteIndex();
    for (const notes of index.values()) {
        for (const note of notes) {
            if (note.fqn === fqn) return note;
        }
    }
    return null;
}

export function getServerFromPath(filePath: string): string | null {
    const match = filePath.match(/src\/servers\/([^/]+)\//);
    return match ? match[1] : null;
}

export function getManagerFromPath(filePath: string): string | null {
    const match = filePath.match(/src\/managers\/(\w+)_manager\.ts$/);
    if (match) {
        return match[1].split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('') + 'Manager';
    }
    const simpleMatch = filePath.match(/src\/managers\/(\w+)\.ts$/);
    if (simpleMatch) {
        return simpleMatch[1].split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('');
    }
    return null;
}
```

- [ ] **Step 2: Commit**

```bash
cd /Users/user/aladdin/obsidian
git add scripts/codebase-index/lib/file-to-note-mapper.ts
git commit -m "feat(codebase-sync): add file-to-note-mapper for .ts → note resolution"
```

---

## Task 7: change-classifier.ts — 變更分類器

**Files:**
- Create: `scripts/codebase-index/lib/change-classifier.ts`

職責：將 commit + file change 分類為具體的「更新動作」。

- [ ] **Step 1: 寫 change-classifier.ts**

```typescript
import type { CommitInfo, FileChange } from './git-diff-collector.ts';
import type { NoteMatch } from './file-to-note-mapper.ts';
import type { RajahImpact } from './rajah-change-resolver.ts';
import { findNotesForFile } from './file-to-note-mapper.ts';
import { filterFilesByScope } from './noise-filter.ts';

export type ActionType =
    | 'new_file'           // 新增 .ts 檔 → 需建立新筆記
    | 'update_existing'    // 修改 .ts 檔 → 更新已有筆記
    | 'delete_file'        // 刪除 .ts 檔 → 標記筆記 deprecated
    | 'rename_file'        // rename .ts 檔 → 筆記改名 + 連結更新
    | 'rajah_signature'    // rajah 簽章變更 → 更新筆記 input/output
    | 'rajah_new_method'   // rajah 新增 method → 需建立新筆記
    | 'rajah_delete_method' // rajah 刪除 method → 標記筆記 deprecated
    | 'uncovered';         // 無法對應到任何筆記

export interface ChangeAction {
    type: ActionType;
    commit: CommitInfo;
    file: FileChange;
    affectedNotes: NoteMatch[];
    rajahImpact?: RajahImpact;
    summary: string;
}

export async function classifyChanges(
    commits: CommitInfo[],
    rajahImpacts: RajahImpact[]
): Promise<ChangeAction[]> {
    const actions: ChangeAction[] = [];

    for (const commit of commits) {
        const scopedFiles = filterFilesByScope(commit.files);

        for (const file of scopedFiles) {
            const notes = await findNotesForFile(file.path);

            switch (file.status) {
                case 'A': {
                    if (notes.length > 0) {
                        // File already has notes (edge case: re-added)
                        actions.push({
                            type: 'update_existing',
                            commit, file, affectedNotes: notes,
                            summary: `Re-added file with existing notes: ${file.path}`
                        });
                    } else {
                        actions.push({
                            type: 'new_file',
                            commit, file, affectedNotes: [],
                            summary: `New file needs new notes: ${file.path}`
                        });
                    }
                    break;
                }
                case 'M': {
                    if (notes.length > 0) {
                        actions.push({
                            type: 'update_existing',
                            commit, file, affectedNotes: notes,
                            summary: `Modified file affects ${notes.length} notes: ${file.path}`
                        });
                    } else {
                        actions.push({
                            type: 'uncovered',
                            commit, file, affectedNotes: [],
                            summary: `Modified file has no matching notes: ${file.path}`
                        });
                    }
                    break;
                }
                case 'D': {
                    actions.push({
                        type: 'delete_file',
                        commit, file, affectedNotes: notes,
                        summary: `Deleted file: ${file.path} (${notes.length} notes affected)`
                    });
                    break;
                }
                case 'R': {
                    actions.push({
                        type: 'rename_file',
                        commit, file, affectedNotes: notes,
                        summary: `Renamed: ${file.oldPath} → ${file.path}`
                    });
                    break;
                }
            }
        }
    }

    // Process rajah impacts
    for (const impact of rajahImpacts) {
        switch (impact.changeType) {
            case 'new_method':
                actions.push({
                    type: 'rajah_new_method',
                    commit: { hash: impact.commitHash, message: '', author: '', date: '', files: [] },
                    file: { status: 'A', path: impact.rajahFile, additions: 0, deletions: 0 },
                    affectedNotes: [],
                    rajahImpact: impact,
                    summary: `Rajah new method: ${impact.affectedFqns.join(', ')}`
                });
                break;
            case 'deleted_method':
                actions.push({
                    type: 'rajah_delete_method',
                    commit: { hash: impact.commitHash, message: '', author: '', date: '', files: [] },
                    file: { status: 'D', path: impact.rajahFile, additions: 0, deletions: 0 },
                    affectedNotes: [],
                    rajahImpact: impact,
                    summary: `Rajah deleted method: ${impact.affectedFqns.join(', ')}`
                });
                break;
            case 'signature':
            case 'model':
            case 'enum':
                actions.push({
                    type: 'rajah_signature',
                    commit: { hash: impact.commitHash, message: '', author: '', date: '', files: [] },
                    file: { status: 'M', path: impact.rajahFile, additions: 0, deletions: 0 },
                    affectedNotes: [],
                    rajahImpact: impact,
                    summary: `Rajah ${impact.changeType} change: ${impact.diffSummary}`
                });
                break;
        }
    }

    return actions;
}

export function deduplicateActions(actions: ChangeAction[]): ChangeAction[] {
    const seen = new Map<string, ChangeAction>();

    for (const action of actions) {
        // Key by file path + action type to avoid duplicates from multiple commits
        for (const note of action.affectedNotes) {
            const key = `${note.note.fqn}:${action.type}`;
            if (!seen.has(key)) {
                seen.set(key, action);
            }
        }
        if (action.affectedNotes.length === 0) {
            const key = `${action.file.path}:${action.type}`;
            if (!seen.has(key)) {
                seen.set(key, action);
            }
        }
    }

    return [...seen.values()];
}
```

- [ ] **Step 2: Commit**

```bash
cd /Users/user/aladdin/obsidian
git add scripts/codebase-index/lib/change-classifier.ts
git commit -m "feat(codebase-sync): add change-classifier for action type classification"
```

---

## Task 8: note-integrity-checker.ts — 筆記健全檢查

**Files:**
- Create: `scripts/codebase-index/lib/note-integrity-checker.ts`

- [ ] **Step 1: 寫 note-integrity-checker.ts**

```typescript
import { readFile } from 'node:fs/promises';
import matter from 'gray-matter';

export interface IntegrityIssue {
    notePath: string;
    severity: 'error' | 'warning';
    issue: string;
}

export async function checkNoteIntegrity(notePath: string, originalContent?: string): Promise<IntegrityIssue[]> {
    const issues: IntegrityIssue[] = [];
    let content: string;
    try {
        content = await readFile(notePath, 'utf-8');
    } catch {
        issues.push({ notePath, severity: 'error', issue: 'File does not exist' });
        return issues;
    }

    // Check 1: frontmatter parseable
    try {
        const { data } = matter(content);
        if (!data.fqn) {
            issues.push({ notePath, severity: 'error', issue: 'Missing fqn in frontmatter' });
        }
        if (!data.source_file) {
            issues.push({ notePath, severity: 'warning', issue: 'Missing source_file in frontmatter' });
        }
        if (!data.type) {
            issues.push({ notePath, severity: 'error', issue: 'Missing type in frontmatter' });
        }
    } catch {
        issues.push({ notePath, severity: 'error', issue: 'Frontmatter YAML parse error' });
        return issues; // can't do further checks
    }

    // Check 2: AUTO-GENERATED blocks intact
    const autoGenStart = (content.match(/<!-- AUTO-GENERATED, DO NOT EDIT -->/g) || []).length;
    const autoGenEnd = (content.match(/<!-- END AUTO-GENERATED -->/g) || []).length;
    if (autoGenStart !== autoGenEnd) {
        issues.push({ notePath, severity: 'error', issue: `Mismatched AUTO-GENERATED markers (${autoGenStart} start, ${autoGenEnd} end)` });
    }

    // Check 3: no stale Phase X placeholders
    if (/<!-- Phase [34] will fill this -->/.test(content)) {
        issues.push({ notePath, severity: 'warning', issue: 'Contains stale Phase 3/4 placeholder' });
    }

    // Check 4: if originalContent provided, check size delta
    if (originalContent) {
        const originalLen = originalContent.length;
        const newLen = content.length;
        if (originalLen > 100) { // only for non-trivial notes
            const ratio = newLen / originalLen;
            if (ratio > 3.0) {
                issues.push({ notePath, severity: 'warning', issue: `Content grew ${Math.round(ratio * 100)}% (suspicious)` });
            }
            if (ratio < 0.3) {
                issues.push({ notePath, severity: 'warning', issue: `Content shrank to ${Math.round(ratio * 100)}% (suspicious)` });
            }
        }
    }

    // Check 5: regression — new [TBD] where there wasn't one
    if (originalContent) {
        const oldTbds = (originalContent.match(/\[TBD/g) || []).length;
        const newTbds = (content.match(/\[TBD/g) || []).length;
        if (newTbds > oldTbds) {
            issues.push({ notePath, severity: 'warning', issue: `TBD count increased from ${oldTbds} to ${newTbds}` });
        }
    }

    return issues;
}

export async function batchCheck(notePaths: string[], originals?: Map<string, string>): Promise<IntegrityIssue[]> {
    const allIssues: IntegrityIssue[] = [];
    for (const p of notePaths) {
        const issues = await checkNoteIntegrity(p, originals?.get(p));
        allIssues.push(...issues);
    }
    return allIssues;
}

export function hasErrors(issues: IntegrityIssue[]): boolean {
    return issues.some(i => i.severity === 'error');
}
```

- [ ] **Step 2: Commit**

```bash
cd /Users/user/aladdin/obsidian
git add scripts/codebase-index/lib/note-integrity-checker.ts
git commit -m "feat(codebase-sync): add note-integrity-checker for pre-commit validation"
```

---

## Task 9: daily-report-builder.ts — 日報產出

**Files:**
- Create: `scripts/codebase-index/lib/daily-report-builder.ts`

- [ ] **Step 1: 寫 daily-report-builder.ts**

```typescript
import { writeFile, mkdir } from 'node:fs/promises';
import type { ChangeAction } from './change-classifier.ts';
import type { FilterResult } from './noise-filter.ts';
import type { IntegrityIssue } from './note-integrity-checker.ts';

export interface DailyReportData {
    date: string;
    agrabahCommitRange: { since: string; until: string; total: number };
    rajahCommitRange: { since: string; until: string; total: number };
    filterResult: FilterResult;
    actions: ChangeAction[];
    integrityIssues: IntegrityIssue[];
    brokenLinksCount: number;
    newNotesCreated: string[];
    notesUpdated: string[];
    notesDeprecated: string[];
    rejectedUpdates: Array<{ note: string; reason: string }>;
    agentDispatches: number;
}

export async function buildDailyReport(data: DailyReportData): Promise<string> {
    const lines: string[] = [
        `# Daily Sync Report — ${data.date}`,
        '',
        `Generated: ${new Date().toISOString()}`,
        '',
        '## Summary',
        '',
        `| Metric | Count |`,
        `|--------|-------|`,
        `| agrabah commits processed | ${data.agrabahCommitRange.total} |`,
        `| rajah commits processed | ${data.rajahCommitRange.total} |`,
        `| Commits skipped (noise) | ${data.filterResult.skipped.length} |`,
        `| Commits kept | ${data.filterResult.kept.length} |`,
        `| Mixed signal commits | ${data.filterResult.mixedSignal.length} |`,
        `| Actions classified | ${data.actions.length} |`,
        `| Agent dispatches | ${data.agentDispatches} |`,
        `| Notes created | ${data.newNotesCreated.length} |`,
        `| Notes updated | ${data.notesUpdated.length} |`,
        `| Notes deprecated | ${data.notesDeprecated.length} |`,
        `| Rejected updates | ${data.rejectedUpdates.length} |`,
        `| Integrity issues | ${data.integrityIssues.length} |`,
        `| Broken links | ${data.brokenLinksCount} |`,
        '',
    ];

    // Commits processed
    if (data.filterResult.kept.length > 0) {
        lines.push('## Commits Processed', '');
        lines.push('| Hash | Message | Author |');
        lines.push('|------|---------|--------|');
        for (const c of data.filterResult.kept) {
            lines.push(`| \`${c.hash.slice(0, 7)}\` | ${c.message} | ${c.author} |`);
        }
        lines.push('');
    }

    // Skipped commits
    if (data.filterResult.skipped.length > 0) {
        lines.push('## Skipped Commits', '');
        lines.push('| Hash | Message | Reason |');
        lines.push('|------|---------|--------|');
        for (const { commit: c, reason } of data.filterResult.skipped) {
            lines.push(`| \`${c.hash.slice(0, 7)}\` | ${c.message} | ${reason} |`);
        }
        lines.push('');
    }

    // Actions
    if (data.actions.length > 0) {
        lines.push('## Actions Taken', '');
        lines.push('| Type | File | Notes Affected | Summary |');
        lines.push('|------|------|----------------|---------|');
        for (const a of data.actions) {
            const noteNames = a.affectedNotes.map(n => n.note.fqn).join(', ') || '-';
            lines.push(`| ${a.type} | \`${a.file.path}\` | ${noteNames} | ${a.summary} |`);
        }
        lines.push('');
    }

    // Integrity issues
    if (data.integrityIssues.length > 0) {
        lines.push('## Integrity Issues', '');
        lines.push('| Note | Severity | Issue |');
        lines.push('|------|----------|-------|');
        for (const i of data.integrityIssues) {
            lines.push(`| \`${i.notePath}\` | ${i.severity} | ${i.issue} |`);
        }
        lines.push('');
    }

    // Rejected updates
    if (data.rejectedUpdates.length > 0) {
        lines.push('## Rejected Updates', '');
        for (const r of data.rejectedUpdates) {
            lines.push(`- \`${r.note}\`: ${r.reason}`);
        }
        lines.push('');
    }

    const content = lines.join('\n');

    // Write to daily report file
    const reportDir = '/Users/user/aladdin/obsidian/Codebase/_index/daily-sync-reports';
    await mkdir(reportDir, { recursive: true });
    const reportPath = `${reportDir}/${data.date}.md`;
    await writeFile(reportPath, content);

    return reportPath;
}
```

- [ ] **Step 2: Commit**

```bash
cd /Users/user/aladdin/obsidian
git add scripts/codebase-index/lib/daily-report-builder.ts
git commit -m "feat(codebase-sync): add daily-report-builder"
```

---

## Task 10: Agent Prompt 模板

**Files:**
- Create: `scripts/codebase-index/agent-prompts/incremental-new-entity.md`
- Create: `scripts/codebase-index/agent-prompts/incremental-update-note.md`
- Create: `scripts/codebase-index/agent-prompts/incremental-fix-broken-links.md`

- [ ] **Step 1: 寫 incremental-new-entity.md**

```markdown
# Incremental Sync Agent — 新增實體

## 你的角色

你是 agrabah codebase 增量同步的**新增實體處理者**。一個新的 .ts 檔案或 rajah method 被加入了 codebase，你的任務是為它建立完整的 Obsidian 筆記（骨架 + 內容，一次到位）。

## 輸入

你會收到以下資訊：
1. 需要建立筆記的 .ts 檔案路徑（或 rajah FQN）
2. 該檔案所屬的 server / manager 名稱
3. 對應的 rajah 檔路徑
4. git diff 內容（知道具體新增了什麼）

## 絕對規則

1. **筆記結構必須與既有筆記完全一致** — Read 同 server 下一篇既有筆記作為範本
2. **FQN 命名對齊 Phase 1 規範**：
   - rpc-method: `<camelServer>.<camelService>.<PascalMethod>`
   - manager-method: `Manager.<PascalManager>.<camelMethod>`
3. **檔名 = FQN + .md**
4. **禁止編造** — 看不懂的留 `[TBD: 需開發者補充]`
5. **不翻譯未確認名詞** — 不在 `obsidian/Rules/中英對照辭典.md` 中的保留英文
6. **連結即使目標未建也要寫 `[[ ]]`**
7. **必須同時產出「功能描述」「業務場景」「相關規則與踩坑」** — 不留 Phase 2 佔位

## 步驟

1. Read 同 server 下一篇既有 method 筆記，作為結構範本
2. Read 原始碼檔案，解析 method 簽名、呼叫關係
3. Read 對應 rajah 檔，解析 input/output/error code
4. Read `obsidian/Rules/中英對照辭典.md` 確認翻譯
5. 搜尋 `obsidian/Projects/` 和 `obsidian/Rules/` 中相關的筆記
6. Write 新筆記，frontmatter + 全部 section 一次完成
7. 如果是 service 的新 method，Read 該 service 的 `_service.md`，Edit 把新 method 加進 RPC Methods 表格

## 回報

- 建立的筆記清單（含完整路徑）
- 修改的既有筆記清單（如 _service.md）
- [TBD] 位置清單
- 任何異常
```

- [ ] **Step 2: 寫 incremental-update-note.md**

```markdown
# Incremental Sync Agent — 更新既有筆記

## 你的角色

你是 agrabah codebase 增量同步的**筆記更新者**。一個既有的 .ts 檔案被修改了，你的任務是更新對應的 Obsidian 筆記，反映最新的程式碼狀態。

## 輸入

你會收到以下資訊：
1. 被修改的 .ts 檔案路徑
2. git diff 內容
3. 受影響的筆記路徑清單
4. commit message（了解改動意圖）

## 絕對規則

1. **用 Edit 修改筆記，不用 Write 覆蓋**
2. **不得動以下區塊**：
   - `<!-- AUTO-GENERATED BACKLINKS -->` 下方內容
   - `<!-- AUTO-GENERATED, DO NOT EDIT -->` 到 `<!-- END AUTO-GENERATED -->` 之間
   - `<!-- AUTO-GENERATED AGGREGATE -->` 下方內容
3. **frontmatter 修改限制**：只可更新 `source_line`、`last_scanned`、`permission`
4. **禁止編造** — 看不懂的留 `[TBD: 需開發者補充]`
5. **不翻譯未確認名詞**

## 可以修改的段落

- **輸入參數** — 如果 method 簽名 / rajah input 有變
- **回傳** — 如果 response model 有變
- **相關錯誤碼** — 如果新增或移除了 AgrabahErrorCodeEnum 使用
- **Calls Manager Methods** — 如果新增或移除了 manager 呼叫
- **Calls RPC Cross-Server** — 如果新增或移除了跨 server RPC
- **Calls Internal Helpers** — 如果新增或移除了內部函數呼叫
- **功能描述** — 如果邏輯行為有本質變更（不是微調）
- **業務場景** — 如果使用場景有變
- **相關規則與踩坑** — 如果新的改動觸及已知規則
- **備註** — 補充新發現

## 步驟

1. Read 每篇受影響的筆記（記住原始內容）
2. Read 修改後的 .ts 原始碼
3. 比對 diff，判斷哪些段落需要更新
4. 如果簽名變更（新增/移除 呼叫），直接 Edit 對應 Calls section
5. 如果邏輯變更，Read Projects/Rules 相關筆記後 Edit 功能描述/業務場景
6. 更新 frontmatter 的 `last_scanned` 為今天日期

## 回報

- 修改的筆記清單 + 每篇改了哪些 section
- 未修改的筆記清單（檢查後判斷無需改動）
- [TBD] 位置清單
- 任何異常
```

- [ ] **Step 3: 寫 incremental-fix-broken-links.md**

```markdown
# Incremental Sync Agent — 修復 Broken Links

## 你的角色

你是 agrabah codebase 增量同步的**連結修復者**。broken-links-report.md 顯示一些筆記連結指向不存在的目標，你的任務是修復它們。

## 輸入

你會收到以下資訊：
1. broken-links-report.md 中嚴重等級的 broken links 清單
2. 每條 broken link 的 source FQN、target FQN、kind

## 修復策略

### Case 1: 目標筆記「應存在但消失」
- 判斷標準：target FQN 的 server 已在 scan-progress.json 的 completed_packages 中
- 動作：建立新筆記（同 incremental-new-entity 流程）

### Case 2: 目標筆記「拼寫/大小寫錯誤」
- 判斷標準：存在一篇檔名高度相似的筆記（Levenshtein distance ≤ 3）
- 動作：Edit source 筆記裡的 `[[ ]]` 連結，修正拼寫

### Case 3: 目標筆記「rename 後連結未更新」
- 判斷標準：source 筆記裡有 `[[Old.Name]]` 但應指向 `[[New.Name]]`
- 動作：Edit source 筆記裡的 `[[ ]]` 連結

### Case 4: 目標筆記「尚未建立的 server/manager」
- 判斷標準：target FQN 的 server 不在 completed_packages 中
- 動作：不處理（預期行為，等對應 batch 建立）

## 回報

- 修復的 broken links 數量（按 case 分類）
- 新建立的筆記清單
- 無法處理的 broken links 清單
```

- [ ] **Step 4: Commit**

```bash
cd /Users/user/aladdin/obsidian
git add scripts/codebase-index/agent-prompts/
git commit -m "feat(codebase-sync): add agent prompt templates for incremental sync"
```

---

## Task 11: sync-from-git.ts — 主入口 CLI

**Files:**
- Create: `scripts/codebase-index/sync-from-git.ts`
- Modify: `scripts/codebase-index/package.json`

這是整套系統的核心，串接所有模組。

- [ ] **Step 1: 寫 sync-from-git.ts**

```typescript
import { readFile, writeFile } from 'node:fs/promises';
import { collectCommits } from './lib/git-diff-collector.ts';
import { filterCommits, type FilterResult } from './lib/noise-filter.ts';
import { resolveRajahImpacts } from './lib/rajah-change-resolver.ts';
import { buildNoteIndex } from './lib/file-to-note-mapper.ts';
import { classifyChanges, deduplicateActions, type ChangeAction } from './lib/change-classifier.ts';
import { batchCheck, hasErrors, type IntegrityIssue } from './lib/note-integrity-checker.ts';
import { buildDailyReport, type DailyReportData } from './lib/daily-report-builder.ts';
import { $ } from 'bun';

// ------- Paths -------
const AGRABAH_REPO = '/Users/user/aladdin/agrabah';
const RAJAH_REPO = '/Users/user/aladdin/rajah';
const OBSIDIAN_ROOT = '/Users/user/aladdin/obsidian';
const SCRIPTS_DIR = `${OBSIDIAN_ROOT}/scripts/codebase-index`;
const NOISE_RULES_PATH = `${SCRIPTS_DIR}/noise-rules.json`;
const SYNC_STATE_PATH = `${SCRIPTS_DIR}/sync-state.json`;
const CODEBASE_ROOT = `${OBSIDIAN_ROOT}/Codebase`;

// ------- CLI Args -------
const args = process.argv.slice(2);
function getArg(name: string): string | undefined {
    const arg = args.find(a => a.startsWith(`--${name}=`));
    return arg?.split('=')[1];
}
const dryRun = args.includes('--dry-run');
const since = getArg('since');
const until = getArg('until');
const commitArg = getArg('commits');
const specificCommits = commitArg?.split(',');

// ------- Main -------
async function main() {
    console.log('=== Incremental Codebase Sync ===');
    console.log(`Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}`);

    // 1. Determine sync range
    const syncState = JSON.parse(await readFile(SYNC_STATE_PATH, 'utf-8'));
    const effectiveSince = since ?? syncState.last_sync_date ?? '2026-04-21 20:00';
    const effectiveUntil = until ?? new Date().toISOString();
    const today = new Date().toISOString().split('T')[0];

    console.log(`\nRange: ${effectiveSince} → ${effectiveUntil}`);

    // 2. Stage 1: Collect git diffs
    console.log('\n--- Stage 1: Collecting git diffs ---');

    const agrabahCommits = await collectCommits({
        repoPath: AGRABAH_REPO,
        since: effectiveSince,
        until: effectiveUntil,
        commits: specificCommits,
    });
    console.log(`agrabah: ${agrabahCommits.length} commits`);

    const rajahCommits = await collectCommits({
        repoPath: RAJAH_REPO,
        since: effectiveSince,
        until: effectiveUntil,
    });
    console.log(`rajah: ${rajahCommits.length} commits`);

    // 3. Filter noise
    console.log('\n--- Filtering noise ---');
    const agrabahFiltered = await filterCommits(agrabahCommits, AGRABAH_REPO, NOISE_RULES_PATH);
    const rajahFiltered = await filterCommits(rajahCommits, RAJAH_REPO, NOISE_RULES_PATH);

    console.log(`agrabah: kept=${agrabahFiltered.kept.length}, skipped=${agrabahFiltered.skipped.length}, mixed=${agrabahFiltered.mixedSignal.length}`);
    console.log(`rajah: kept=${rajahFiltered.kept.length}, skipped=${rajahFiltered.skipped.length}`);

    // 4. Resolve rajah impacts
    console.log('\n--- Resolving rajah impacts ---');
    const rajahImpacts = await resolveRajahImpacts(rajahFiltered.kept, RAJAH_REPO, AGRABAH_REPO);
    console.log(`rajah impacts: ${rajahImpacts.length}`);

    // 5. Build note index
    console.log('\n--- Building note index ---');
    const noteIndex = await buildNoteIndex();
    console.log(`Note index: ${noteIndex.size} source files mapped`);

    // 6. Classify changes
    console.log('\n--- Classifying changes ---');
    const rawActions = await classifyChanges(agrabahFiltered.kept, rajahImpacts);
    const actions = deduplicateActions(rawActions);
    console.log(`Actions: ${actions.length} (deduplicated from ${rawActions.length})`);

    // Group actions by type
    const byType = new Map<string, ChangeAction[]>();
    for (const a of actions) {
        if (!byType.has(a.type)) byType.set(a.type, []);
        byType.get(a.type)!.push(a);
    }
    for (const [type, acts] of byType) {
        console.log(`  ${type}: ${acts.length}`);
    }

    if (dryRun) {
        console.log('\n=== DRY RUN — Actions that would be taken ===\n');
        for (const action of actions) {
            console.log(`[${action.type}] ${action.summary}`);
            if (action.affectedNotes.length > 0) {
                for (const n of action.affectedNotes) {
                    console.log(`  → ${n.note.fqn} (${n.note.path})`);
                }
            }
        }

        // Still build report in dry run mode
        const reportData: DailyReportData = {
            date: today,
            agrabahCommitRange: { since: effectiveSince, until: effectiveUntil, total: agrabahCommits.length },
            rajahCommitRange: { since: effectiveSince, until: effectiveUntil, total: rajahCommits.length },
            filterResult: agrabahFiltered,
            actions,
            integrityIssues: [],
            brokenLinksCount: 0,
            newNotesCreated: [],
            notesUpdated: [],
            notesDeprecated: [],
            rejectedUpdates: [],
            agentDispatches: 0,
        };
        const reportPath = await buildDailyReport(reportData);
        console.log(`\nDry-run report written to: ${reportPath}`);
        return;
    }

    // ============ LIVE MODE ============

    // Stage 2: Process actions
    // This stage is designed to be called by the orchestrating Claude session,
    // which will dispatch agents based on the action list.
    // The main script outputs the action list as JSON for the orchestrator to consume.

    console.log('\n--- Stage 2: Action list for agent dispatch ---');
    const actionListPath = `${SCRIPTS_DIR}/pending-actions.json`;
    await writeFile(actionListPath, JSON.stringify(actions, null, 2));
    console.log(`Action list written to: ${actionListPath}`);
    console.log(`Total actions requiring agent dispatch: ${actions.filter(a => ['new_file', 'update_existing', 'rajah_new_method', 'rajah_signature'].includes(a.type)).length}`);

    // Stage 3 & 4 are run after agents complete.
    // The orchestrator calls: bun run sync-from-git.ts --finalize

    if (args.includes('--finalize')) {
        await runFinalize(today, effectiveSince, effectiveUntil, agrabahCommits, rajahCommits, agrabahFiltered, actions);
    }
}

async function runFinalize(
    today: string,
    since: string,
    until: string,
    agrabahCommits: any[],
    rajahCommits: any[],
    filterResult: FilterResult,
    actions: ChangeAction[]
) {
    console.log('\n--- Stage 3: Running idempotent scripts ---');

    const scripts = [
        'build-backlinks.ts',
        'build-overview-aggregates.ts',
        'generate-call-chain.ts',
        'generate-cross-server-rpc-graph.ts',
        'generate-indexes.ts',
        'check-orphan-notes.ts',
    ];

    for (const script of scripts) {
        console.log(`Running ${script}...`);
        await $`bun run ${script}`.cwd(SCRIPTS_DIR);
    }

    // Stage 4: Integrity check + broken links
    console.log('\n--- Stage 4: Integrity check ---');

    // Get all modified notes
    const modifiedNotes = actions
        .filter(a => a.affectedNotes.length > 0)
        .flatMap(a => a.affectedNotes.map(n => n.note.path));
    const uniqueModifiedNotes = [...new Set(modifiedNotes)];

    const integrityIssues = await batchCheck(uniqueModifiedNotes);
    const errors = integrityIssues.filter(i => i.severity === 'error');
    const warnings = integrityIssues.filter(i => i.severity === 'warning');
    console.log(`Integrity: ${errors.length} errors, ${warnings.length} warnings`);

    // Read broken links count
    let brokenLinksCount = 0;
    try {
        const brokenReport = await readFile(`${CODEBASE_ROOT}/_index/broken-links-report.md`, 'utf-8');
        const match = brokenReport.match(/Total broken: (\d+)/);
        brokenLinksCount = match ? parseInt(match[1]) : 0;
    } catch { /* file might not exist yet */ }
    console.log(`Broken links: ${brokenLinksCount}`);

    // Build daily report
    const reportData: DailyReportData = {
        date: today,
        agrabahCommitRange: { since, until, total: agrabahCommits.length },
        rajahCommitRange: { since, until, total: rajahCommits.length },
        filterResult,
        actions,
        integrityIssues,
        brokenLinksCount,
        newNotesCreated: actions.filter(a => a.type === 'new_file').map(a => a.file.path),
        notesUpdated: uniqueModifiedNotes,
        notesDeprecated: actions.filter(a => a.type === 'delete_file').map(a => a.file.path),
        rejectedUpdates: errors.map(e => ({ note: e.notePath, reason: e.issue })),
        agentDispatches: actions.filter(a => ['new_file', 'update_existing', 'rajah_new_method', 'rajah_signature'].includes(a.type)).length,
    };
    const reportPath = await buildDailyReport(reportData);
    console.log(`\nDaily report: ${reportPath}`);

    // Update sync state
    const syncState = JSON.parse(await readFile(SYNC_STATE_PATH, 'utf-8'));
    syncState.last_sync_date = until;
    syncState.sync_history.push({
        date: today,
        agrabah_commits: agrabahCommits.length,
        rajah_commits: rajahCommits.length,
        actions: actions.length,
        report: reportPath,
    });
    await writeFile(SYNC_STATE_PATH, JSON.stringify(syncState, null, 2));

    console.log('\n=== Sync complete ===');
}

await main();
```

- [ ] **Step 2: 更新 package.json 加入 sync 指令**

在 `scripts` 區塊加入：

```json
"sync": "bun run sync-from-git.ts",
"sync-dry": "bun run sync-from-git.ts --dry-run"
```

- [ ] **Step 3: Commit**

```bash
cd /Users/user/aladdin/obsidian
git add scripts/codebase-index/sync-from-git.ts scripts/codebase-index/package.json
git commit -m "feat(codebase-sync): add sync-from-git.ts main entry CLI"
```

---

## Task 12: 整合測試 — Dry Run

**Files:**
- 不建立新檔，用既有腳本測試

- [ ] **Step 1: 跑 dry-run 測試同步範圍 2026-04-21 20:00 → now**

```bash
cd /Users/user/aladdin/obsidian/scripts/codebase-index
bun run sync-from-git.ts --dry-run --since="2026-04-21 20:00"
```

Expected: 看到 commit 統計、noise 過濾結果、action 分類清單。不會修改任何筆記。

- [ ] **Step 2: 檢查 dry-run 報告**

```bash
cat /Users/user/aladdin/obsidian/Codebase/_index/daily-sync-reports/2026-04-24.md | head -60
```

Expected: 報告包含 summary 表格、processed commits、skipped commits、actions 分類。

- [ ] **Step 3: 驗證 action 分類合理性**

人工檢查幾個 action:
1. 已知修改的檔案（如 `wallet.ts` 被改 4 次）→ 應出現 `update_existing` action
2. 版本號 commit → 應被 skip
3. `style(...)` commit → 應被 low_signal 檢查

- [ ] **Step 4: 修復 dry-run 暴露的問題**

若有任何 bug，修復後重跑 dry-run 確認。

- [ ] **Step 5: Commit 修復（如有）**

```bash
cd /Users/user/aladdin/obsidian
git add scripts/codebase-index/
git commit -m "fix(codebase-sync): fixes from dry-run testing"
```

---

## Task 13: 完整 SOP 文件

**Files:**
- Create: `docs/superpowers/plans/2026-04-24-incremental-sync-spec.md`

- [ ] **Step 1: 寫完整 SOP 文件**

```markdown
# Incremental Codebase Sync — SOP

## 概述

每日從 agrabah + rajah 的 git commit 偵測變更，自動更新 Obsidian Codebase 知識庫筆記。

## 觸發方式

| 模式 | 指令 | 適用場景 |
|------|------|---------|
| 每日同步 | `bun run sync-from-git.ts --since=yesterday` | 自動化每日 |
| 區間補跑 | `bun run sync-from-git.ts --since=2026-04-20 --until=2026-04-23` | 漏跑時補上 |
| 指定 commit | `bun run sync-from-git.ts --commits=abc123,def456` | 精準重跑 |
| Dry run | 加 `--dry-run` 在任何指令後 | 預覽不執行 |

## 四階段流程

### Stage 1: 收集 + 分類（腳本自動）

1. 掃 agrabah + rajah 的 git commit
2. 三層 noise 過濾（commit 訊息 → 檔案路徑 → diff 內容）
3. rajah 變更推導受影響的 agrabah 檔
4. 分類為 action（new_file / update_existing / delete_file / rename_file / rajah_*）
5. 輸出 `pending-actions.json`

### Stage 2: 派 Agent 更新筆記（主代理協調）

主代理讀取 `pending-actions.json`，依 action type 派 agent：

| Action Type | Agent Prompt | 並行限制 |
|------------|-------------|---------|
| new_file | incremental-new-entity.md | ≤6 |
| update_existing | incremental-update-note.md | ≤6 |
| rajah_new_method | incremental-new-entity.md | ≤6 |
| rajah_signature | incremental-update-note.md | ≤6 |
| delete_file | 腳本直接處理（標 deprecated） | - |
| rename_file | 腳本直接處理（改名 + 更新連結） | - |

分批策略：每批 ≤6 個 agent 並行，等全部完成再派下一批。

### Stage 3: 重跑冪等腳本（腳本自動）

```bash
bun run sync-from-git.ts --finalize
```

依序執行：build-backlinks → build-overview-aggregates → generate-call-chain → generate-cross-server-rpc-graph → generate-indexes → check-orphan-notes

### Stage 4: 驗證 + 報告 + Commit

1. 對所有被動筆記跑 integrity check
2. 讀取 broken-links-report.md 計數
3. 若 broken links > 0 且屬「嚴重」等級，派修復 agent（≤3）
4. 產出日報到 `Codebase/_index/daily-sync-reports/YYYY-MM-DD.md`
5. 更新 sync-state.json
6. Commit

## Commit 策略

- 每日一個 commit：`chore(codebase): daily sync YYYY-MM-DD (N commits, M notes)`
- 若觸及筆記 > 30 篇，按 server 拆分 commit

## 健全檢查項目

| 檢查 | 嚴重度 | 失敗動作 |
|------|--------|---------|
| frontmatter YAML 可解析 | error | 排除出 commit |
| fqn 欄位存在 | error | 排除出 commit |
| type 欄位存在 | error | 排除出 commit |
| AUTO-GENERATED 標記配對 | error | 排除出 commit |
| 內容成長/萎縮 > 300% | warning | 寫入日報 |
| TBD 數量增加 | warning | 寫入日報 |
| Phase 3/4 佔位殘留 | warning | 寫入日報 |

## Noise 過濾規則

規則檔：`scripts/codebase-index/noise-rules.json`

三層過濾：
1. **commit 訊息比對** → 整個 commit 跳過
2. **檔案路徑比對** → 該檔變更跳過
3. **low signal 關鍵字 + diff 檢查** → 全是 noise 才跳過

## 日報指標

每日必檢：
- `broken links: N` — 理想值 0，上升代表有連結異常
- `rejected updates: N` — 理想值 0，>0 代表有 integrity 問題
- `uncovered: N` — 有變更但無對應筆記的檔案數
```

- [ ] **Step 2: Commit**

```bash
cd /Users/user/aladdin/obsidian
git add docs/superpowers/plans/2026-04-24-incremental-sync-spec.md
git commit -m "docs(codebase-sync): add incremental sync SOP specification"
```

---

## Task 14: Live 測試（2026-04-21 20:00 → now）

此 task 需要主代理協調，不是純腳本可完成。

- [ ] **Step 1: 跑 Stage 1 收集 + 分類**

```bash
cd /Users/user/aladdin/obsidian/scripts/codebase-index
bun run sync-from-git.ts --since="2026-04-21 20:00"
```

- [ ] **Step 2: 讀取 pending-actions.json，確認 action 清單**

```bash
cat pending-actions.json | bun -e "const d=JSON.parse(await Bun.stdin.text());const t={};d.forEach(a=>{t[a.type]=(t[a.type]||0)+1});console.table(t)"
```

- [ ] **Step 3: 依 action type 分批派 agent**

主代理按 pending-actions.json 內容：
1. 先處理 `delete_file` 和 `rename_file`（腳本直接處理，不派 agent）
2. 分批派 agent 處理 `new_file` + `update_existing` + `rajah_*`（每批 ≤6）
3. 等每批完成後驗收再派下一批

- [ ] **Step 4: Agent 全部完成後跑 finalize**

```bash
cd /Users/user/aladdin/obsidian/scripts/codebase-index
bun run sync-from-git.ts --finalize --since="2026-04-21 20:00"
```

- [ ] **Step 5: 檢查日報 + broken links**

```bash
cat /Users/user/aladdin/obsidian/Codebase/_index/daily-sync-reports/2026-04-24.md
cat /Users/user/aladdin/obsidian/Codebase/_index/broken-links-report.md | head -20
```

- [ ] **Step 6: 抽查 3-5 篇被更新的筆記**

人工 Read 幾篇確認：
1. 該動的段落有更新
2. AUTO-GENERATED 區塊完好
3. frontmatter 完好
4. 連結沒斷

- [ ] **Step 7: Commit 結果**

```bash
cd /Users/user/aladdin/obsidian
git add Codebase/ scripts/codebase-index/
git commit -m "chore(codebase): incremental sync test run 2026-04-21~2026-04-24"
```

---

## Self-Review Checklist

### 1. Spec Coverage

| 需求 | Task |
|------|------|
| 三種觸發模式（daily / range / specific commits） | Task 11 CLI args |
| agrabah + rajah 雙 repo 掃描 | Task 3 + Task 5 |
| 三層 noise 過濾 | Task 4 |
| low_signal 二段判斷 | Task 4 |
| 新增 method → 派 agent 建筆記 | Task 10 prompt + Task 11 dispatch |
| 簽章變更 → 派 agent 更新 | Task 10 prompt + Task 11 dispatch |
| 邏輯變更 → 派 agent 更新（當天完成） | Task 10 prompt + Task 11 dispatch |
| 檔案刪除 → 標 deprecated | Task 7 classifier |
| 檔案 rename → 改名 + 更新連結 | Task 7 classifier |
| integrity check | Task 8 |
| 每日 broken links 檢查 | Task 11 finalize + 既有 build-backlinks.ts |
| 日報產出 | Task 9 |
| sync-state 紀錄 | Task 2 + Task 11 |
| commit 拆分策略 | Task 13 SOP |
| dry-run 模式 | Task 11 + Task 12 |

### 2. Placeholder Scan

無 TBD / TODO / "implement later" / "similar to Task N" 殘留。

### 3. Type Consistency

- `CommitInfo` / `FileChange` — 定義在 Task 3，使用在 Task 4/5/7/9/11 ✓
- `ChangeAction` / `ActionType` — 定義在 Task 7，使用在 Task 9/11 ✓
- `FilterResult` — 定義在 Task 4，使用在 Task 9/11 ✓
- `IntegrityIssue` — 定義在 Task 8，使用在 Task 9/11 ✓
- `NoteMatch` — 定義在 Task 6，使用在 Task 7 ✓
- `RajahImpact` — 定義在 Task 5，使用在 Task 7 ✓
- `ParsedNote` — 定義在既有 note-parser.ts，使用在 Task 6/8 ✓
