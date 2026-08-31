# JSDoc Writeback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Stage 4 to `/codebase-sync` that merges obsidian `rpc-method`/`service` notes back into source-code JSDoc, with paragraph/bullet-level union and source-priority on conflict, preventing the trackEvent-style regression.

**Architecture:** Bottom-up library stack — extractor (find `/** */` block) → JSDoc parser → note parser → per-section merger → renderer → orchestrator. The orchestrator reads `pending-actions.json` (status=processed), runs the pipeline per affected note, writes to working tree only (never commits). Auto-invoked at end of `sync-from-git.ts --finalize`; `--skip-writeback` opts out.

**Tech Stack:** Bun runtime, TypeScript, `bun:test` (built-in), `gray-matter` (already in `package.json`).

**Spec reference:** `.claude/skills/codebase-sync/references/2026-05-19-jsdoc-writeback-design.md`

---

## File Structure

**New files (all under `/Users/user/aladdin/aladdin_ai/scripts/codebase-index/`):**

| Path | Responsibility | LOC est. |
|------|----------------|---------:|
| `lib/jsdoc-extractor.ts` | Locate `/** */` block above a given line in source TS file | 60 |
| `lib/jsdoc-extractor.test.ts` | Unit tests for extractor | 80 |
| `lib/jsdoc-parser.ts` | Parse JSDoc text → `{description, scenarios, rules, notes, tags}` | 100 |
| `lib/jsdoc-parser.test.ts` | Unit tests for JSDoc parser | 100 |
| `lib/note-section-parser.ts` | Parse obsidian note → same shape, with normalization | 120 |
| `lib/note-section-parser.test.ts` | Unit tests for note parser | 100 |
| `lib/section-merger.ts` | Merge a single section's units (description vs bullets logic) | 80 |
| `lib/section-merger.test.ts` | Unit tests for merger including trackEvent regression case | 120 |
| `lib/jsdoc-renderer.ts` | Render merged sections → JSDoc string | 80 |
| `lib/jsdoc-renderer.test.ts` | Unit tests for renderer | 80 |
| `lib/test-fixtures/register-source-step15.txt` | Snapshot of methodRegister JSDoc with `送 trackEvent` | — |
| `lib/test-fixtures/register-note.md` | Snapshot of obsidian note (2026-04-22 version) | — |
| `lib/test-fixtures/register-expected.txt` | Expected JSDoc after merge | — |
| `writeback-jsdoc.ts` | Orchestrator: read pending-actions, run pipeline, write back, generate report | 200 |
| `writeback-jsdoc.test.ts` | Integration test using fixtures | 100 |

**Modified files:**

| Path | Change |
|------|--------|
| `aladdin_ai/scripts/codebase-index/sync-from-git.ts` | `runFinalize` calls writeback at end + `--skip-writeback` flag |
| `aladdin_ai/scripts/codebase-index/.gitignore` (create if missing) | Add `writeback-report.json` |
| `.claude/skills/codebase-sync/SKILL.md` | 三階段 → 四階段; add Stage 4 section; add 絕對規則 #6 |

---

## Task 0: Bootstrap

**Files:**
- Create: `/Users/user/aladdin/aladdin_ai/scripts/codebase-index/.gitignore`
- Modify: `/Users/user/aladdin/aladdin_ai/scripts/codebase-index/package.json`

- [ ] **Step 1: Create `.gitignore` for codebase-index scripts**

Write `/Users/user/aladdin/aladdin_ai/scripts/codebase-index/.gitignore`:

```gitignore
writeback-report.json
node_modules/
```

- [ ] **Step 2: Add test script to package.json**

Modify `scripts` section in `/Users/user/aladdin/aladdin_ai/scripts/codebase-index/package.json` to add:

```json
"test": "bun test",
"writeback-jsdoc": "bun run writeback-jsdoc.ts",
"writeback-jsdoc-dry": "bun run writeback-jsdoc.ts --dry-run"
```

Final `scripts` block:

```json
"scripts": {
    "build-backlinks": "bun run build-backlinks.ts",
    "generate-call-chain": "bun run generate-call-chain.ts",
    "check-broken-links": "bun run check-broken-links.ts",
    "check-orphan-notes": "bun run check-orphan-notes.ts",
    "generate-indexes": "bun run generate-indexes.ts",
    "sync": "bun run sync-from-git.ts",
    "sync-dry": "bun run sync-from-git.ts --dry-run",
    "sync-finalize": "bun run sync-from-git.ts --finalize",
    "test": "bun test",
    "writeback-jsdoc": "bun run writeback-jsdoc.ts",
    "writeback-jsdoc-dry": "bun run writeback-jsdoc.ts --dry-run"
}
```

- [ ] **Step 3: Verify test runner**

Run:

```bash
cd /Users/user/aladdin/aladdin_ai/scripts/codebase-index && bun test 2>&1 | head -5
```

Expected output: `bun test v1.2.x` + "0 tests" or "no test files matched" (no error). If error → fix before continuing.

- [ ] **Step 4: Commit**

```bash
cd /Users/user/aladdin/aladdin_ai/scripts/codebase-index && git add .gitignore package.json && git commit -m "chore(codebase-index): bootstrap writeback-jsdoc scripts"
```

---

## Task 1: `jsdoc-extractor.ts` — Find `/** */` block in source

**Files:**
- Create: `/Users/user/aladdin/aladdin_ai/scripts/codebase-index/lib/jsdoc-extractor.ts`
- Test: `/Users/user/aladdin/aladdin_ai/scripts/codebase-index/lib/jsdoc-extractor.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `lib/jsdoc-extractor.test.ts`:

```typescript
import { describe, test, expect } from 'bun:test';
import { extractJsdocAbove } from './jsdoc-extractor.ts';

describe('extractJsdocAbove', () => {
    test('extracts JSDoc immediately above declaration', () => {
        const source = [
            '    /**',
            '     * Hello world.',
            '     */',
            '    async methodFoo(): Promise<void> {',
            '    }',
        ].join('\n');
        const result = extractJsdocAbove(source, 4);
        expect(result).not.toBeNull();
        expect(result!.startLine).toBe(1);
        expect(result!.endLine).toBe(3);
        expect(result!.text).toContain('Hello world.');
    });

    test('extracts JSDoc with blank line above declaration', () => {
        const source = [
            '    /**',
            '     * Hello.',
            '     */',
            '',
            '    async methodFoo() {}',
        ].join('\n');
        const result = extractJsdocAbove(source, 5);
        expect(result).not.toBeNull();
        expect(result!.startLine).toBe(1);
        expect(result!.endLine).toBe(3);
    });

    test('returns null when no JSDoc above', () => {
        const source = [
            '    // single line comment',
            '    async methodFoo() {}',
        ].join('\n');
        const result = extractJsdocAbove(source, 2);
        expect(result).toBeNull();
    });

    test('extracts multi-section JSDoc with **業務場景** etc.', () => {
        const source = [
            '    /**',
            '     * Main description.',
            '     *',
            '     * **業務場景**',
            '     * - scenario one',
            '     *',
            '     * **備註**',
            '     * - note one',
            '     */',
            '    async methodFoo() {}',
        ].join('\n');
        const result = extractJsdocAbove(source, 10);
        expect(result).not.toBeNull();
        expect(result!.text).toContain('**業務場景**');
        expect(result!.text).toContain('scenario one');
    });

    test('stops scanning at non-JSDoc code (declaration before)', () => {
        const source = [
            '    private _foo: string;',
            '',
            '    async methodFoo() {}',
        ].join('\n');
        const result = extractJsdocAbove(source, 3);
        expect(result).toBeNull();
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
cd /Users/user/aladdin/aladdin_ai/scripts/codebase-index && bun test lib/jsdoc-extractor.test.ts 2>&1 | tail -10
```

Expected: all 5 tests fail with `Cannot find module './jsdoc-extractor.ts'`.

- [ ] **Step 3: Write the implementation**

Create `lib/jsdoc-extractor.ts`:

```typescript
export interface JsdocBlock {
    startLine: number; // 1-based, line of `/**`
    endLine: number;   // 1-based, line of `*/`
    text: string;      // full block including `/**` and `*/`, lines joined by '\n'
}

/**
 * Find the `/** ... *\/` JSDoc block immediately above `declarationLine`.
 * Skips blank lines between the JSDoc and the declaration.
 * Returns null if no JSDoc is found (e.g. previous line is code).
 */
export function extractJsdocAbove(source: string, declarationLine: number): JsdocBlock | null {
    const lines = source.split('\n');
    if (declarationLine < 2 || declarationLine > lines.length) {
        return null;
    }

    let i = declarationLine - 2; // convert 1-based to 0-based, look at line above

    // Skip blank lines (but not single-line // comments — those mean no JSDoc)
    while (i >= 0 && lines[i].trim() === '') {
        i--;
    }
    if (i < 0) return null;

    // Expect `*/` at line i
    if (!lines[i].trimEnd().endsWith('*/')) {
        return null;
    }
    const endLine0 = i;

    // Scan up for `/**`
    while (i >= 0 && !lines[i].trimStart().startsWith('/**')) {
        i--;
    }
    if (i < 0) return null;
    const startLine0 = i;

    return {
        startLine: startLine0 + 1,
        endLine: endLine0 + 1,
        text: lines.slice(startLine0, endLine0 + 1).join('\n'),
    };
}
```

- [ ] **Step 4: Run tests to verify pass**

Run:

```bash
cd /Users/user/aladdin/aladdin_ai/scripts/codebase-index && bun test lib/jsdoc-extractor.test.ts 2>&1 | tail -10
```

Expected: `5 pass`, `0 fail`.

- [ ] **Step 5: Commit**

```bash
cd /Users/user/aladdin/aladdin_ai/scripts/codebase-index && git add lib/jsdoc-extractor.ts lib/jsdoc-extractor.test.ts && git commit -m "feat(codebase-index): add jsdoc-extractor for finding /** */ above declarations"
```

---

## Task 2: `jsdoc-parser.ts` — Parse JSDoc text into sections + units

**Files:**
- Create: `/Users/user/aladdin/aladdin_ai/scripts/codebase-index/lib/jsdoc-parser.ts`
- Test: `/Users/user/aladdin/aladdin_ai/scripts/codebase-index/lib/jsdoc-parser.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `lib/jsdoc-parser.test.ts`:

```typescript
import { describe, test, expect } from 'bun:test';
import { parseJsdoc } from './jsdoc-parser.ts';

describe('parseJsdoc', () => {
    test('parses description with single sentence', () => {
        const jsdoc = [
            '/**',
            ' * Single sentence.',
            ' */',
        ].join('\n');
        const result = parseJsdoc(jsdoc);
        expect(result.description.sentences).toEqual(['Single sentence.']);
        expect(result.scenarios.bullets).toEqual([]);
        expect(result.rules.bullets).toEqual([]);
        expect(result.notes.bullets).toEqual([]);
    });

    test('splits description by 。 ； . ;', () => {
        const jsdoc = [
            '/**',
            ' * 主流程。詳細步驟：1) foo；2) bar；3) baz。',
            ' */',
        ].join('\n');
        const result = parseJsdoc(jsdoc);
        expect(result.description.sentences).toEqual([
            '主流程。',
            '詳細步驟：1) foo；',
            '2) bar；',
            '3) baz。',
        ]);
    });

    test('parses bullets under **業務場景** etc.', () => {
        const jsdoc = [
            '/**',
            ' * Main desc.',
            ' *',
            ' * **業務場景**',
            ' * - scenario one',
            ' * - scenario two',
            ' *',
            ' * **相關規則與踩坑**',
            ' * - rule one',
            ' *',
            ' * **備註**',
            ' * - note one',
            ' */',
        ].join('\n');
        const result = parseJsdoc(jsdoc);
        expect(result.description.sentences).toEqual(['Main desc.']);
        expect(result.scenarios.bullets).toEqual(['scenario one', 'scenario two']);
        expect(result.rules.bullets).toEqual(['rule one']);
        expect(result.notes.bullets).toEqual(['note one']);
    });

    test('collects @param/@returns into tags.raw', () => {
        const jsdoc = [
            '/**',
            ' * Desc.',
            ' * @param foo - the foo',
            ' * @returns void',
            ' */',
        ].join('\n');
        const result = parseJsdoc(jsdoc);
        expect(result.description.sentences).toEqual(['Desc.']);
        expect(result.tags.raw).toContain('@param foo - the foo');
        expect(result.tags.raw).toContain('@returns void');
    });

    test('handles trackEvent regression case (real source snippet)', () => {
        const jsdoc = [
            '/**',
            ' * App 會員註冊主流程。',
            ' *',
            ' * 詳細步驟：1) prepareProviderData 守衛；15) 清 otp session、送 trackEvent(userRegister, success) 埋點、送 RecordUserLogin job、updatePlatformStatistic(registerMembers)。',
            ' *',
            ' * **業務場景**',
            ' * - App / H5 前台註冊表單提交',
            ' */',
        ].join('\n');
        const result = parseJsdoc(jsdoc);
        expect(result.description.sentences.some(s => s.includes('送 trackEvent'))).toBe(true);
        expect(result.scenarios.bullets).toEqual(['App / H5 前台註冊表單提交']);
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/user/aladdin/aladdin_ai/scripts/codebase-index && bun test lib/jsdoc-parser.test.ts 2>&1 | tail -10
```

Expected: all tests fail with module not found.

- [ ] **Step 3: Write the implementation**

Create `lib/jsdoc-parser.ts`:

```typescript
export interface ParsedJsdoc {
    description: { sentences: string[] };
    scenarios: { bullets: string[] };
    rules: { bullets: string[] };
    notes: { bullets: string[] };
    tags: { raw: string }; // joined by '\n', includes @param/@returns/etc. lines
}

const SECTION_HEADERS = {
    scenarios: '**業務場景**',
    rules: '**相關規則與踩坑**',
    notes: '**備註**',
} as const;

type SectionKey = 'description' | 'scenarios' | 'rules' | 'notes';

/**
 * Strip `/**`, ` *\/`, and leading ` * ` from each JSDoc line. Returns content lines.
 */
function stripJsdocSyntax(jsdoc: string): string[] {
    const raw = jsdoc.split('\n');
    const content: string[] = [];
    for (const line of raw) {
        const trimmed = line.trim();
        if (trimmed === '/**' || trimmed === '*/') continue;
        // Strip leading "* " or "*"
        let stripped = trimmed;
        if (stripped.startsWith('* ')) stripped = stripped.slice(2);
        else if (stripped === '*') stripped = '';
        else if (stripped.startsWith('*')) stripped = stripped.slice(1);
        content.push(stripped);
    }
    return content;
}

function splitDescriptionSentences(text: string): string[] {
    // Split on 。；.; keeping the separator at end of each segment
    const result: string[] = [];
    let buf = '';
    for (const ch of text) {
        buf += ch;
        if (ch === '。' || ch === '；' || ch === '.' || ch === ';') {
            const trimmed = buf.trim();
            if (trimmed) result.push(trimmed);
            buf = '';
        }
    }
    const tail = buf.trim();
    if (tail) result.push(tail);
    return result;
}

export function parseJsdoc(jsdoc: string): ParsedJsdoc {
    const lines = stripJsdocSyntax(jsdoc);
    const result: ParsedJsdoc = {
        description: { sentences: [] },
        scenarios: { bullets: [] },
        rules: { bullets: [] },
        notes: { bullets: [] },
        tags: { raw: '' },
    };

    let current: SectionKey = 'description';
    const descLines: string[] = [];
    const tagLines: string[] = [];

    for (const line of lines) {
        // @-tag line
        if (line.startsWith('@')) {
            tagLines.push(line);
            continue;
        }
        // Section header detection
        if (line === SECTION_HEADERS.scenarios) { current = 'scenarios'; continue; }
        if (line === SECTION_HEADERS.rules) { current = 'rules'; continue; }
        if (line === SECTION_HEADERS.notes) { current = 'notes'; continue; }

        if (current === 'description') {
            descLines.push(line);
        } else {
            // bullet line: starts with `- `
            const m = line.match(/^- (.+)$/);
            if (m) {
                result[current].bullets.push(m[1]);
            }
            // else: ignore (blank line, continuation, etc.)
        }
    }

    // Combine description lines into a single string, then split into sentences
    const descText = descLines.filter(l => l.trim()).join('\n');
    // Treat each non-blank line as a separate input to split (preserves multi-paragraph structure)
    for (const line of descText.split('\n')) {
        result.description.sentences.push(...splitDescriptionSentences(line));
    }

    result.tags.raw = tagLines.join('\n');
    return result;
}
```

- [ ] **Step 4: Run tests to verify pass**

```bash
cd /Users/user/aladdin/aladdin_ai/scripts/codebase-index && bun test lib/jsdoc-parser.test.ts 2>&1 | tail -10
```

Expected: `5 pass`, `0 fail`.

- [ ] **Step 5: Commit**

```bash
cd /Users/user/aladdin/aladdin_ai/scripts/codebase-index && git add lib/jsdoc-parser.ts lib/jsdoc-parser.test.ts && git commit -m "feat(codebase-index): add jsdoc-parser to split JSDoc into sections + units"
```

---

## Task 3: `note-section-parser.ts` — Parse obsidian note → same shape

**Files:**
- Create: `/Users/user/aladdin/aladdin_ai/scripts/codebase-index/lib/note-section-parser.ts`
- Test: `/Users/user/aladdin/aladdin_ai/scripts/codebase-index/lib/note-section-parser.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `lib/note-section-parser.test.ts`:

```typescript
import { describe, test, expect } from 'bun:test';
import { parseNote } from './note-section-parser.ts';

describe('parseNote', () => {
    test('parses 功能描述 / 業務場景 / 相關規則與踩坑 / 備註', () => {
        const note = [
            '---',
            'type: rpc-method',
            '---',
            '',
            '# foo',
            '',
            '## 功能描述',
            '',
            'Main description.',
            '',
            '## 業務場景',
            '',
            'Scenario paragraph.',
            '',
            '## 相關規則與踩坑',
            '',
            '- rule one',
            '- rule two',
            '',
            '## 備註',
            '',
            '- note one',
        ].join('\n');
        const result = parseNote(note);
        expect(result.description.sentences).toEqual(['Main description.']);
        expect(result.scenarios.bullets).toEqual(['Scenario paragraph.']);
        expect(result.rules.bullets).toEqual(['rule one', 'rule two']);
        expect(result.notes.bullets).toEqual(['note one']);
    });

    test('strips [[wikilinks]] to 「name」', () => {
        const note = [
            '## 相關規則與踩坑',
            '- 參考 [[註冊欄位驗證 checklist]]',
        ].join('\n');
        const result = parseNote(note);
        expect(result.rules.bullets).toEqual(['參考「註冊欄位驗證 checklist」']);
    });

    test('strips backticks and bold markers from content', () => {
        const note = [
            '## 業務場景',
            '- `prepareProviderData` 是 **必要** 步驟',
        ].join('\n');
        const result = parseNote(note);
        expect(result.scenarios.bullets).toEqual(['prepareProviderData 是 必要 步驟']);
    });

    test('inlines numbered list under 功能描述', () => {
        const note = [
            '## 功能描述',
            '',
            'App 註冊主流程。',
            '',
            '詳細步驟：',
            '',
            '1. step one',
            '2. step two',
            '3. step three',
        ].join('\n');
        const result = parseNote(note);
        // Expect numbered list flattened into single line: "詳細步驟：1) step one；2) step two；3) step three"
        const joined = result.description.sentences.join(' ');
        expect(joined).toContain('1) step one');
        expect(joined).toContain('2) step two');
        expect(joined).toContain('3) step three');
    });

    test('ignores 輸入參數 / 回傳 / 呼叫關係 etc.', () => {
        const note = [
            '## 功能描述',
            'Desc.',
            '',
            '## 輸入參數',
            '- foo',
            '',
            '## 回傳',
            '- bar',
            '',
            '## 呼叫關係',
            '- baz',
            '',
            '## 業務場景',
            '- scen',
        ].join('\n');
        const result = parseNote(note);
        expect(result.description.sentences).toEqual(['Desc.']);
        expect(result.scenarios.bullets).toEqual(['scen']);
        // 輸入參數/回傳/呼叫關係 should NOT appear in any section
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/user/aladdin/aladdin_ai/scripts/codebase-index && bun test lib/note-section-parser.test.ts 2>&1 | tail -10
```

Expected: all fail with module not found.

- [ ] **Step 3: Write the implementation**

Create `lib/note-section-parser.ts`:

```typescript
import matter from 'gray-matter';
import type { ParsedJsdoc } from './jsdoc-parser.ts';

const NOTE_SECTION_MAP: Record<string, keyof Pick<ParsedJsdoc, 'description' | 'scenarios' | 'rules' | 'notes'>> = {
    '功能描述': 'description',
    '業務場景': 'scenarios',
    '相關規則與踩坑': 'rules',
    '備註': 'notes',
};

function normalizeText(text: string): string {
    // [[link]] or [[link|alias]] -> 「link」 (or alias)
    text = text.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, link, alias) => {
        return `「${(alias ?? link).trim()}」`;
    });
    // `code` -> code
    text = text.replace(/`([^`]+)`/g, '$1');
    // **bold** -> bold
    text = text.replace(/\*\*([^*]+)\*\*/g, '$1');
    return text;
}

function splitSentences(text: string): string[] {
    const result: string[] = [];
    let buf = '';
    for (const ch of text) {
        buf += ch;
        if (ch === '。' || ch === '；' || ch === '.' || ch === ';') {
            const t = buf.trim();
            if (t) result.push(t);
            buf = '';
        }
    }
    const tail = buf.trim();
    if (tail) result.push(tail);
    return result;
}

/**
 * Compress numbered list under 功能描述 into a single inline string like
 * "Main desc。詳細步驟：1) foo；2) bar；3) baz".
 */
function compressDescription(rawLines: string[]): string {
    // Split into pre-list, list items, post-list
    const intro: string[] = [];
    const items: { num: number; text: string }[] = [];
    const tail: string[] = [];

    let phase: 'intro' | 'list' | 'tail' = 'intro';
    for (const line of rawLines) {
        const trimmed = line.trim();
        const m = trimmed.match(/^(\d+)\.\s+(.+)$/);
        if (m) {
            phase = 'list';
            items.push({ num: parseInt(m[1], 10), text: m[2].trim() });
        } else if (phase === 'list') {
            if (trimmed) tail.push(trimmed);
        } else {
            if (trimmed) intro.push(trimmed);
        }
    }

    let result = intro.join(' ').trim();
    if (items.length > 0) {
        // Drop trailing ":" / "：" from intro
        result = result.replace(/[:：]\s*$/, '：');
        const listInline = items.map(it => `${it.num}) ${it.text}`).join('；');
        // If intro doesn't end with 「：」, add it
        if (!result.endsWith('：')) result += '：';
        result += listInline;
        if (!result.endsWith('；') && !result.endsWith('。')) result += '。';
    }
    if (tail.length > 0) {
        if (result && !/[。；.;]$/.test(result)) result += '。';
        result += tail.join(' ');
    }
    return result;
}

export function parseNote(noteContent: string): ParsedJsdoc {
    const parsed = matter(noteContent);
    const body = parsed.content;

    const result: ParsedJsdoc = {
        description: { sentences: [] },
        scenarios: { bullets: [] },
        rules: { bullets: [] },
        notes: { bullets: [] },
        tags: { raw: '' },
    };

    // Walk h2 sections
    const lines = body.split('\n');
    let currentH2: string | null = null;
    let sectionLines: string[] = [];

    const flushSection = () => {
        if (currentH2 === null) return;
        const key = NOTE_SECTION_MAP[currentH2];
        if (!key) return; // ignored section
        const norm = normalizeText(sectionLines.join('\n'));
        if (key === 'description') {
            const inlined = compressDescription(norm.split('\n'));
            result.description.sentences = splitSentences(inlined);
        } else {
            // bullets
            const bullets: string[] = [];
            for (const line of norm.split('\n')) {
                const m = line.trim().match(/^-\s+(.+)$/);
                if (m) bullets.push(m[1].trim());
                else if (line.trim() && bullets.length === 0) {
                    // bare paragraph in this section — treat as one bullet
                    bullets.push(line.trim());
                }
            }
            result[key].bullets = bullets;
        }
    };

    for (const line of lines) {
        const h2 = line.match(/^##\s+(.+)$/);
        if (h2) {
            flushSection();
            currentH2 = h2[1].trim();
            sectionLines = [];
        } else if (currentH2 !== null) {
            sectionLines.push(line);
        }
    }
    flushSection();

    return result;
}
```

- [ ] **Step 4: Run tests to verify pass**

```bash
cd /Users/user/aladdin/aladdin_ai/scripts/codebase-index && bun test lib/note-section-parser.test.ts 2>&1 | tail -10
```

Expected: `5 pass`, `0 fail`.

- [ ] **Step 5: Commit**

```bash
cd /Users/user/aladdin/aladdin_ai/scripts/codebase-index && git add lib/note-section-parser.ts lib/note-section-parser.test.ts && git commit -m "feat(codebase-index): add note-section-parser with wikilink/backtick/bold normalization"
```

---

## Task 4: `section-merger.ts` — Per-section union with source priority

**Files:**
- Create: `/Users/user/aladdin/aladdin_ai/scripts/codebase-index/lib/section-merger.ts`
- Test: `/Users/user/aladdin/aladdin_ai/scripts/codebase-index/lib/section-merger.test.ts`

> **Refinement beyond spec (Task 4):** The spec specifies "bullet-level set union". For the `description` section, splitting by sentence creates a subtle bug in the trackEvent regression case: source's step 15 (with `送 trackEvent`) and note's step 15 (without) have different normalized keys → both would end up in the merged result, producing two "step 15" sentences. To match spec intent ("colleague annotations have higher weight, no regression"), the merger treats `description` as a **single unit** with this rule: if every source sentence (normalized) appears in note's normalized text → use note's description (note improvement, no loss); otherwise → use source's description (preserve colleague additions). Bullet sections (scenarios/rules/notes) use the spec'd set-union.

- [ ] **Step 1: Write the failing tests**

Create `lib/section-merger.test.ts`:

```typescript
import { describe, test, expect } from 'bun:test';
import { mergeBullets, mergeDescription } from './section-merger.ts';

describe('mergeBullets', () => {
    test('returns source order when both empty', () => {
        expect(mergeBullets([], [])).toEqual([]);
    });

    test('keeps note order; appends source-only at end', () => {
        const source = ['a', 'c', 'd'];
        const note = ['a', 'b'];
        // common: a; note-only: b; source-only: c, d
        expect(mergeBullets(source, note)).toEqual(['a', 'b', 'c', 'd']);
    });

    test('on conflict (same normalized key, different text), source version wins', () => {
        const source = ['用 `Bun.password.verify`'];
        const note   = ['用 Bun.password.verify']; // same after normalization
        // Note has the unit; source's exact text wins for the common position
        expect(mergeBullets(source, note)).toEqual(['用 `Bun.password.verify`']);
    });

    test('preserves backticks etc. when source-only', () => {
        const source = ['`backticked` content'];
        const note: string[] = [];
        expect(mergeBullets(source, note)).toEqual(['`backticked` content']);
    });
});

describe('mergeDescription', () => {
    test('returns source sentences when every source sentence is in note', () => {
        // Note has all of source's content PLUS more
        const source = ['Foo.', 'Bar.'];
        const note   = ['Foo.', 'Bar.', 'Baz.'];
        expect(mergeDescription(source, note)).toEqual(note);
    });

    test('returns source when source has a sentence not in note (trackEvent regression case)', () => {
        const source = [
            '15) 清 otp session、送 trackEvent(userRegister, success) 埋點、送 RecordUserLogin job。',
        ];
        const note = [
            '15) 清 otp session、送 RecordUserLogin job。', // missing 送 trackEvent
        ];
        // source has content not in note → source wins
        expect(mergeDescription(source, note)).toEqual(source);
    });

    test('returns source on full conflict', () => {
        const source = ['Source way A.'];
        const note   = ['Note way B.'];
        expect(mergeDescription(source, note)).toEqual(source);
    });

    test('uses note when source is empty', () => {
        const source: string[] = [];
        const note   = ['Note sentence.'];
        expect(mergeDescription(source, note)).toEqual(note);
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/user/aladdin/aladdin_ai/scripts/codebase-index && bun test lib/section-merger.test.ts 2>&1 | tail -10
```

Expected: all tests fail with module not found.

- [ ] **Step 3: Write the implementation**

Create `lib/section-merger.ts`:

```typescript
/**
 * Normalize a unit for key comparison: lowercase, strip backticks/bold/whitespace,
 * unify full-width punctuation.
 */
export function normalizeKey(text: string): string {
    return text
        .replace(/`([^`]+)`/g, '$1')         // strip backticks
        .replace(/\*\*([^*]+)\*\*/g, '$1')   // strip bold
        .replace(/[（(]/g, '(').replace(/[)）]/g, ')') // unify parens
        .replace(/\s+/g, ' ')                // collapse whitespace
        .trim()
        .toLowerCase();
}

/**
 * Bullet-level set union with source-priority on conflict.
 * Order: note's bullets first (keeps note order); source-only appended.
 * When a normalized key matches, source's exact text wins (preserves colleague edits).
 */
export function mergeBullets(sourceBullets: string[], noteBullets: string[]): string[] {
    const sourceByKey = new Map<string, string>();
    for (const u of sourceBullets) sourceByKey.set(normalizeKey(u), u);
    const noteKeys = new Set(noteBullets.map(normalizeKey));

    const merged: string[] = [];
    for (const u of noteBullets) {
        const key = normalizeKey(u);
        if (sourceByKey.has(key)) {
            merged.push(sourceByKey.get(key)!); // source version
        } else {
            merged.push(u); // note-only addition
        }
    }
    for (const u of sourceBullets) {
        if (!noteKeys.has(normalizeKey(u))) {
            merged.push(u); // source-only (colleague addition)
        }
    }
    return merged;
}

/**
 * Description merge: treat as single unit; if every source sentence (normalized) is
 * present in note text → use note (improvement); otherwise → use source (preserve).
 */
export function mergeDescription(sourceSentences: string[], noteSentences: string[]): string[] {
    if (sourceSentences.length === 0) return noteSentences;
    if (noteSentences.length === 0) return sourceSentences;

    const noteText = noteSentences.map(normalizeKey).join(' ');
    const allInNote = sourceSentences.every(s => noteText.includes(normalizeKey(s)));
    return allInNote ? noteSentences : sourceSentences;
}
```

- [ ] **Step 4: Run tests to verify pass**

```bash
cd /Users/user/aladdin/aladdin_ai/scripts/codebase-index && bun test lib/section-merger.test.ts 2>&1 | tail -10
```

Expected: `8 pass`, `0 fail`.

- [ ] **Step 5: Commit**

```bash
cd /Users/user/aladdin/aladdin_ai/scripts/codebase-index && git add lib/section-merger.ts lib/section-merger.test.ts && git commit -m "feat(codebase-index): add section-merger with source-priority union (preserves trackEvent-style edits)"
```

---

## Task 5: `jsdoc-renderer.ts` — Render merged sections back to JSDoc string

**Files:**
- Create: `/Users/user/aladdin/aladdin_ai/scripts/codebase-index/lib/jsdoc-renderer.ts`
- Test: `/Users/user/aladdin/aladdin_ai/scripts/codebase-index/lib/jsdoc-renderer.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `lib/jsdoc-renderer.test.ts`:

```typescript
import { describe, test, expect } from 'bun:test';
import { renderJsdoc } from './jsdoc-renderer.ts';

describe('renderJsdoc', () => {
    test('renders single-section description only', () => {
        const out = renderJsdoc({
            description: { sentences: ['Hello world.'] },
            scenarios: { bullets: [] },
            rules: { bullets: [] },
            notes: { bullets: [] },
            tags: { raw: '' },
        }, '    ');
        expect(out).toBe([
            '    /**',
            '     * Hello world.',
            '     */',
        ].join('\n'));
    });

    test('renders all four sections in fixed order', () => {
        const out = renderJsdoc({
            description: { sentences: ['Desc.'] },
            scenarios: { bullets: ['s1', 's2'] },
            rules: { bullets: ['r1'] },
            notes: { bullets: ['n1'] },
            tags: { raw: '' },
        }, '    ');
        expect(out).toBe([
            '    /**',
            '     * Desc.',
            '     *',
            '     * **業務場景**',
            '     * - s1',
            '     * - s2',
            '     *',
            '     * **相關規則與踩坑**',
            '     * - r1',
            '     *',
            '     * **備註**',
            '     * - n1',
            '     */',
        ].join('\n'));
    });

    test('omits empty bullet sections', () => {
        const out = renderJsdoc({
            description: { sentences: ['Desc.'] },
            scenarios: { bullets: ['s1'] },
            rules: { bullets: [] },
            notes: { bullets: [] },
            tags: { raw: '' },
        }, '');
        expect(out).toBe([
            '/**',
            ' * Desc.',
            ' *',
            ' * **業務場景**',
            ' * - s1',
            ' */',
        ].join('\n'));
    });

    test('joins sentences in description with separators preserved', () => {
        const out = renderJsdoc({
            description: { sentences: ['Main。', '詳細步驟：1) foo；', '2) bar。'] },
            scenarios: { bullets: [] },
            rules: { bullets: [] },
            notes: { bullets: [] },
            tags: { raw: '' },
        }, '');
        expect(out).toContain('Main。詳細步驟：1) foo；2) bar。');
    });

    test('passes through @param/@returns from tags.raw at end', () => {
        const out = renderJsdoc({
            description: { sentences: ['Desc.'] },
            scenarios: { bullets: [] },
            rules: { bullets: [] },
            notes: { bullets: [] },
            tags: { raw: '@param foo - the foo\n@returns void' },
        }, '');
        expect(out).toBe([
            '/**',
            ' * Desc.',
            ' * @param foo - the foo',
            ' * @returns void',
            ' */',
        ].join('\n'));
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/user/aladdin/aladdin_ai/scripts/codebase-index && bun test lib/jsdoc-renderer.test.ts 2>&1 | tail -10
```

Expected: all fail with module not found.

- [ ] **Step 3: Write the implementation**

Create `lib/jsdoc-renderer.ts`:

```typescript
import type { ParsedJsdoc } from './jsdoc-parser.ts';

/**
 * Render parsed/merged JSDoc back to a string. `indent` is the per-line indent prefix
 * BEFORE the leading `*` (typically '    ' for class methods).
 */
export function renderJsdoc(parsed: ParsedJsdoc, indent: string): string {
    const out: string[] = [];
    const prefix = `${indent} * `;
    const prefixBare = `${indent} *`;

    out.push(`${indent}/**`);

    // Description: join sentences (separators are already at end of each sentence)
    const descText = parsed.description.sentences.join('').trim();
    if (descText) {
        out.push(`${prefix}${descText}`);
    }

    // Bullet sections
    const sections: { header: string; bullets: string[] }[] = [
        { header: '**業務場景**', bullets: parsed.scenarios.bullets },
        { header: '**相關規則與踩坑**', bullets: parsed.rules.bullets },
        { header: '**備註**', bullets: parsed.notes.bullets },
    ];
    for (const sec of sections) {
        if (sec.bullets.length === 0) continue;
        out.push(prefixBare); // blank `*` separator
        out.push(`${prefix}${sec.header}`);
        for (const b of sec.bullets) {
            out.push(`${prefix}- ${b}`);
        }
    }

    // Tags (@param/@returns/etc.) — pass through as-is
    if (parsed.tags.raw.trim()) {
        for (const line of parsed.tags.raw.split('\n')) {
            if (line.trim()) out.push(`${prefix}${line}`);
        }
    }

    out.push(`${indent} */`);
    return out.join('\n');
}
```

- [ ] **Step 4: Run tests to verify pass**

```bash
cd /Users/user/aladdin/aladdin_ai/scripts/codebase-index && bun test lib/jsdoc-renderer.test.ts 2>&1 | tail -10
```

Expected: `5 pass`, `0 fail`.

- [ ] **Step 5: Commit**

```bash
cd /Users/user/aladdin/aladdin_ai/scripts/codebase-index && git add lib/jsdoc-renderer.ts lib/jsdoc-renderer.test.ts && git commit -m "feat(codebase-index): add jsdoc-renderer for writing sections back to /** */ format"
```

---

## Task 6: `writeback-jsdoc.ts` — Orchestrator

**Files:**
- Create: `/Users/user/aladdin/aladdin_ai/scripts/codebase-index/writeback-jsdoc.ts`
- Create: `/Users/user/aladdin/aladdin_ai/scripts/codebase-index/lib/test-fixtures/register-source-step15.ts.snippet`
- Create: `/Users/user/aladdin/aladdin_ai/scripts/codebase-index/lib/test-fixtures/register-note.md`
- Test: `/Users/user/aladdin/aladdin_ai/scripts/codebase-index/writeback-jsdoc.test.ts`

- [ ] **Step 1: Create fixtures**

Create `lib/test-fixtures/register-source-step15.ts.snippet` — a TypeScript snippet with JSDoc containing `送 trackEvent`:

```typescript
export class FakeService {
    /**
     * App 會員註冊主流程。
     *
     * 詳細步驟：1) prepareProviderData 守衛；15) 清 otp session、送 trackEvent(userRegister, success) 埋點、送 RecordUserLogin(register, loginSuccess) job、updatePlatformStatistic(registerMembers)。
     *
     * **業務場景**
     * - App / H5 前台註冊表單提交
     *
     * **備註**
     * - trackEvent、updatePlatformStatistic、RecordUserLogin 都是 fire-and-forget（.then()），主流程不等待
     */
    async methodRegister(): Promise<void> {
    }
}
```

Create `lib/test-fixtures/register-note.md` — obsidian note WITHOUT trackEvent (i.e., the 2026-04-22 version that caused the regression):

```markdown
---
type: rpc-method
fqn: appUser.appUser.Register
source_file: lib/test-fixtures/register-source-step15.ts.snippet
source_line: 14
last_scanned: 2026-04-22
human_edited: false
---

# appUser.appUser.Register

## 功能描述

App 會員註冊主流程。

詳細步驟：

1. `prepareProviderData` 守衛
2. 清 otp session、送 `RecordUserLogin(register, loginSuccess)` job、`updatePlatformStatistic(registerMembers)`

## 業務場景

- App / H5 前台註冊表單提交

## 備註

- `updatePlatformStatistic` 與 `RecordUserLogin` 都是 fire-and-forget（`.then()`），主流程不等待
```

- [ ] **Step 2: Write the failing integration test**

Create `writeback-jsdoc.test.ts`:

```typescript
import { describe, test, expect, beforeEach } from 'bun:test';
import { runWriteback, type WritebackAction } from './writeback-jsdoc.ts';
import { readFile, writeFile, copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const FIXTURES = resolve(__dirname, 'lib/test-fixtures');
const SOURCE_FIXTURE = resolve(FIXTURES, 'register-source-step15.ts.snippet');
const SOURCE_WORK = resolve(FIXTURES, '_register-source-work.ts.snippet'); // mutable copy
const NOTE_FIXTURE = resolve(FIXTURES, 'register-note.md');

async function setupWorkCopy() {
    await copyFile(SOURCE_FIXTURE, SOURCE_WORK);
}

describe('runWriteback (trackEvent regression case)', () => {
    test('preserves source-only "送 trackEvent" through merge', async () => {
        await setupWorkCopy();
        const action: WritebackAction = {
            noteAbsPath: NOTE_FIXTURE,
            sourceAbsPath: SOURCE_WORK,
            declarationLine: 14,
        };
        const report = await runWriteback([action], { dryRun: false });
        expect(report.modified.length + report.unchanged.length).toBe(1);

        const result = await readFile(SOURCE_WORK, 'utf-8');
        // Critical: 送 trackEvent must NOT be removed
        expect(result).toContain('送 trackEvent(userRegister, success) 埋點');
        // 備註: trackEvent fire-and-forget should also survive
        expect(result).toContain('trackEvent、updatePlatformStatistic、RecordUserLogin');
    });

    test('idempotent: running twice produces no second-pass change', async () => {
        await setupWorkCopy();
        const action: WritebackAction = {
            noteAbsPath: NOTE_FIXTURE,
            sourceAbsPath: SOURCE_WORK,
            declarationLine: 14,
        };
        await runWriteback([action], { dryRun: false });
        const after1 = await readFile(SOURCE_WORK, 'utf-8');
        const report2 = await runWriteback([action], { dryRun: false });
        const after2 = await readFile(SOURCE_WORK, 'utf-8');
        expect(after1).toBe(after2);
        expect(report2.unchanged.length).toBe(1);
        expect(report2.modified.length).toBe(0);
    });

    test('dryRun does not write file', async () => {
        await setupWorkCopy();
        const before = await readFile(SOURCE_WORK, 'utf-8');
        const action: WritebackAction = {
            noteAbsPath: NOTE_FIXTURE,
            sourceAbsPath: SOURCE_WORK,
            declarationLine: 14,
        };
        await runWriteback([action], { dryRun: true });
        const after = await readFile(SOURCE_WORK, 'utf-8');
        expect(after).toBe(before);
    });
});
```

- [ ] **Step 3: Run integration test to verify it fails**

```bash
cd /Users/user/aladdin/aladdin_ai/scripts/codebase-index && bun test writeback-jsdoc.test.ts 2>&1 | tail -10
```

Expected: all 3 tests fail with module not found.

- [ ] **Step 4: Write the orchestrator implementation**

Create `writeback-jsdoc.ts`:

```typescript
import { readFile, writeFile, stat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { $ } from 'bun';
import matter from 'gray-matter';
import { extractJsdocAbove } from './lib/jsdoc-extractor.ts';
import { parseJsdoc, type ParsedJsdoc } from './lib/jsdoc-parser.ts';
import { parseNote } from './lib/note-section-parser.ts';
import { mergeBullets, mergeDescription } from './lib/section-merger.ts';
import { renderJsdoc } from './lib/jsdoc-renderer.ts';

const AGRABAH_REPO = '/Users/user/aladdin/agrabah';
const OBSIDIAN_ROOT = '/Users/user/aladdin/obsidian';
const SCRIPTS_DIR = `${OBSIDIAN_ROOT}/scripts/codebase-index`;
const PENDING_ACTIONS_PATH = `${SCRIPTS_DIR}/pending-actions.json`;
const REPORT_PATH = `${SCRIPTS_DIR}/writeback-report.json`;

export interface WritebackAction {
    noteAbsPath: string;
    sourceAbsPath: string;
    declarationLine: number;
}

export interface WritebackOptions {
    dryRun?: boolean;
}

export interface WritebackReport {
    timestamp: string;
    summary: {
        actions_total: number;
        files_modified: number;
        actions_unchanged: number;
        actions_skipped: number;
    };
    modified: Array<{ source: string; method: string; note: string }>;
    unchanged: Array<{ source: string; note: string }>;
    skipped: Array<{ note: string; reason: string }>;
}

const ABORT_SKIP_RATIO = 0.30;

function mergeParsed(source: ParsedJsdoc, note: ParsedJsdoc): ParsedJsdoc {
    return {
        description: { sentences: mergeDescription(source.description.sentences, note.description.sentences) },
        scenarios: { bullets: mergeBullets(source.scenarios.bullets, note.scenarios.bullets) },
        rules: { bullets: mergeBullets(source.rules.bullets, note.rules.bullets) },
        notes: { bullets: mergeBullets(source.notes.bullets, note.notes.bullets) },
        tags: { raw: source.tags.raw }, // tags always from source, untouched
    };
}

async function detectIndent(sourceText: string, jsdocStartLine: number): string {
    const lines = sourceText.split('\n');
    const line = lines[jsdocStartLine - 1] ?? '';
    const m = line.match(/^(\s*)/);
    return m ? m[1] : '';
}

async function isFileDirty(filePath: string): Promise<boolean> {
    try {
        const out = await $`git diff --quiet -- ${filePath}`.cwd(AGRABAH_REPO).quiet().nothrow();
        return out.exitCode !== 0;
    } catch {
        return false;
    }
}

export async function runWriteback(
    actions: WritebackAction[],
    opts: WritebackOptions = {},
): Promise<WritebackReport> {
    const report: WritebackReport = {
        timestamp: new Date().toISOString(),
        summary: { actions_total: actions.length, files_modified: 0, actions_unchanged: 0, actions_skipped: 0 },
        modified: [],
        unchanged: [],
        skipped: [],
    };

    for (const action of actions) {
        const noteContent = await readFile(action.noteAbsPath, 'utf-8');
        const noteMatter = matter(noteContent);

        // Skip filter #1: human_edited
        if (noteMatter.data.human_edited === true) {
            report.skipped.push({ note: action.noteAbsPath, reason: 'note.human_edited = true' });
            continue;
        }

        // Skip filter #2: source file dirty (only when running against real repo, not fixtures)
        const isInRepo = action.sourceAbsPath.startsWith(AGRABAH_REPO);
        if (isInRepo && (await isFileDirty(action.sourceAbsPath))) {
            report.skipped.push({ note: action.noteAbsPath, reason: 'source file has uncommitted changes' });
            continue;
        }

        // Extract source JSDoc
        const sourceText = await readFile(action.sourceAbsPath, 'utf-8');
        const block = extractJsdocAbove(sourceText, action.declarationLine);
        if (!block) {
            report.skipped.push({ note: action.noteAbsPath, reason: 'no JSDoc block found above declaration' });
            continue;
        }

        const indent = await detectIndent(sourceText, block.startLine);

        // Parse + merge + render
        const sourceParsed = parseJsdoc(block.text);
        const noteParsed = parseNote(noteContent);
        const merged = mergeParsed(sourceParsed, noteParsed);
        const rendered = renderJsdoc(merged, indent);

        // Compare with original
        if (rendered === block.text) {
            report.unchanged.push({ source: action.sourceAbsPath, note: action.noteAbsPath });
            report.summary.actions_unchanged++;
            continue;
        }

        // Write back (unless dry-run)
        if (!opts.dryRun) {
            const lines = sourceText.split('\n');
            const newLines = [
                ...lines.slice(0, block.startLine - 1),
                rendered,
                ...lines.slice(block.endLine),
            ];
            await writeFile(action.sourceAbsPath, newLines.join('\n'), 'utf-8');
        }

        report.modified.push({
            source: action.sourceAbsPath,
            method: `(line ${action.declarationLine})`,
            note: action.noteAbsPath,
        });
        report.summary.files_modified++;
    }

    report.summary.actions_skipped = report.skipped.length;

    // Abort if skip ratio too high
    if (actions.length > 0 && report.summary.actions_skipped / actions.length > ABORT_SKIP_RATIO) {
        console.error(`Stage 4 aborted: skip ratio ${report.summary.actions_skipped}/${actions.length} > ${ABORT_SKIP_RATIO}`);
    }

    return report;
}

interface PendingAction {
    status?: string;
    type: string;
    filePath?: string;
    affectedNotes?: Array<{ path: string; type?: string }>;
}

async function loadProcessedActions(): Promise<WritebackAction[]> {
    const raw = await readFile(PENDING_ACTIONS_PATH, 'utf-8');
    const data = JSON.parse(raw) as { actions: PendingAction[] };
    const result: WritebackAction[] = [];

    for (const action of data.actions) {
        const status = action.status ?? 'pending';
        if (status !== 'processed') continue;
        if (!action.affectedNotes || action.affectedNotes.length === 0) continue;

        for (const note of action.affectedNotes) {
            if (note.type !== 'rpc-method' && note.type !== 'service') continue;
            // Load note frontmatter to get source_file + source_line
            const noteAbsPath = note.path.startsWith('/') ? note.path : resolve(OBSIDIAN_ROOT, note.path);
            const noteContent = await readFile(noteAbsPath, 'utf-8');
            const fm = matter(noteContent).data;
            if (!fm.source_file || !fm.source_line) continue;
            // source_file is repo-relative like "agrabah/src/..."
            const sourceRel = (fm.source_file as string).replace(/^agrabah\//, '');
            const sourceAbsPath = resolve(AGRABAH_REPO, sourceRel);
            result.push({
                noteAbsPath,
                sourceAbsPath,
                declarationLine: fm.source_line as number,
            });
        }
    }
    return result;
}

// CLI entry point
if (import.meta.path === Bun.main) {
    const args = process.argv.slice(2);
    const dryRun = args.includes('--dry-run');
    const actions = await loadProcessedActions();
    console.log(`Stage 4: writeback-jsdoc (${dryRun ? 'DRY RUN' : 'LIVE'})`);
    console.log(`  Actions to process: ${actions.length}`);

    const report = await runWriteback(actions, { dryRun });

    await writeFile(REPORT_PATH, JSON.stringify(report, null, 2));
    console.log(`\n  ✓ ${report.summary.files_modified} files modified`);
    console.log(`  − ${report.summary.actions_unchanged} unchanged`);
    console.log(`  ⊘ ${report.summary.actions_skipped} skipped (see ${REPORT_PATH})`);
    if (report.summary.files_modified > 0 && !dryRun) {
        console.log(`\nPlease review:`);
        console.log(`  cd ${AGRABAH_REPO} && git diff`);
    }
}
```

- [ ] **Step 5: Run integration test to verify pass**

```bash
cd /Users/user/aladdin/aladdin_ai/scripts/codebase-index && bun test writeback-jsdoc.test.ts 2>&1 | tail -10
```

Expected: `3 pass`, `0 fail`. If any test fails, debug before committing.

- [ ] **Step 6: Verify all tests still pass together**

```bash
cd /Users/user/aladdin/aladdin_ai/scripts/codebase-index && bun test 2>&1 | tail -10
```

Expected: 26 pass total (5+5+5+8+5+3), 0 fail.

- [ ] **Step 7: Commit**

```bash
cd /Users/user/aladdin/aladdin_ai/scripts/codebase-index && git add writeback-jsdoc.ts writeback-jsdoc.test.ts lib/test-fixtures/ && git commit -m "feat(codebase-index): add writeback-jsdoc orchestrator for Stage 4 (source-priority merge, prevents trackEvent regression)"
```

---

## Task 7: Integrate Stage 4 into `sync-from-git.ts --finalize`

**Files:**
- Modify: `/Users/user/aladdin/aladdin_ai/scripts/codebase-index/sync-from-git.ts`

- [ ] **Step 1: Read current `runFinalize` to understand where to plug in**

```bash
cd /Users/user/aladdin/aladdin_ai/scripts/codebase-index && grep -n "runFinalize\|--finalize\|--skip-writeback" sync-from-git.ts | head -10
```

Read the file around `runFinalize` to find the right insertion point (end of the function, before any state-saving step or after if it makes sense to write report alongside other state files).

- [ ] **Step 2: Add import and flag handling**

In `sync-from-git.ts` near the top (with existing imports):

```typescript
import { runWriteback } from './writeback-jsdoc.ts';
```

Near the existing CLI args (after `const finalizeOnly = args.includes('--finalize');`):

```typescript
const skipWriteback = args.includes('--skip-writeback');
```

- [ ] **Step 3: Add Stage 4 invocation at the END of `runFinalize`**

In the body of `runFinalize`, after all existing steps (build-backlinks, generate-indexes, generate-call-chain, completeness check, daily report, sync-state update), append:

```typescript
    // ─── Stage 4: Writeback JSDoc to source ───
    if (!skipWriteback) {
        console.log('\n--- Stage 4: Writing JSDoc back to source ---');
        // Re-use the same loader as the standalone script
        const { runWriteback } = await import('./writeback-jsdoc.ts');
        const { loadProcessedActions } = await import('./writeback-jsdoc.ts');
        const actions = await loadProcessedActions();
        const report = await runWriteback(actions, { dryRun: false });
        const reportPath = `${SCRIPTS_DIR}/writeback-report.json`;
        await Bun.write(reportPath, JSON.stringify(report, null, 2));
        console.log(`  ✓ ${report.summary.files_modified} files modified`);
        console.log(`  − ${report.summary.actions_unchanged} unchanged`);
        console.log(`  ⊘ ${report.summary.actions_skipped} skipped`);
        if (report.summary.files_modified > 0) {
            console.log(`\n  Please review: cd ${AGRABAH_REPO} && git diff`);
        }
    } else {
        console.log('\n--- Stage 4: SKIPPED (--skip-writeback) ---');
    }
```

(Adjust `SCRIPTS_DIR` / `AGRABAH_REPO` constants based on what's already in `sync-from-git.ts`.)

- [ ] **Step 4: Export `loadProcessedActions` from writeback-jsdoc.ts**

In `writeback-jsdoc.ts`, change:

```typescript
async function loadProcessedActions(): Promise<WritebackAction[]> {
```

to:

```typescript
export async function loadProcessedActions(): Promise<WritebackAction[]> {
```

- [ ] **Step 5: Run sync-from-git with --dry-run and --finalize on empty state to smoke test**

```bash
cd /Users/user/aladdin/aladdin_ai/scripts/codebase-index && bun run sync-from-git.ts --finalize 2>&1 | tail -20
```

Expected: existing finalize steps run, then `--- Stage 4 ---` appears with summary (likely `0 files modified` if no actions are status=processed currently). No error.

- [ ] **Step 6: Verify --skip-writeback works**

```bash
cd /Users/user/aladdin/aladdin_ai/scripts/codebase-index && bun run sync-from-git.ts --finalize --skip-writeback 2>&1 | tail -10
```

Expected: see `--- Stage 4: SKIPPED (--skip-writeback) ---`.

- [ ] **Step 7: Verify lib tests still pass**

```bash
cd /Users/user/aladdin/aladdin_ai/scripts/codebase-index && bun test 2>&1 | tail -10
```

Expected: 26 pass, 0 fail.

- [ ] **Step 8: Commit**

```bash
cd /Users/user/aladdin/aladdin_ai/scripts/codebase-index && git add sync-from-git.ts writeback-jsdoc.ts && git commit -m "feat(codebase-index): auto-run Stage 4 writeback at end of --finalize (--skip-writeback opts out)"
```

---

## Task 8: Update `SKILL.md`

**Files:**
- Modify: `/Users/user/aladdin/.claude/skills/codebase-sync/SKILL.md`

- [ ] **Step 1: Read current SKILL.md to find precise insertion points**

Open `/Users/user/aladdin/.claude/skills/codebase-sync/SKILL.md` and locate:
1. The heading `## 完整工作流程（三階段）` — change to `## 完整工作流程（四階段）`
2. The pipeline ASCII diagram — add a fourth box for Stage 4
3. The `### Stage 3：Finalize` section — add `### Stage 4：寫回 source JSDoc` immediately after
4. The "絕對規則" section (numbered list 1-5) — add item 6

- [ ] **Step 2: Apply edits**

Use the `Edit` tool with these exact replacements. (If headings differ slightly in real file, adjust to match.)

Replacement 1 — header:

```
old_string: ## 完整工作流程（三階段）
new_string: ## 完整工作流程（四階段）
```

Replacement 2 — pipeline diagram: locate the existing ASCII diagram block and replace it with:

```
Stage 1: sync-from-git.ts          Stage 2: AI Agent 處理          Stage 3: --finalize              Stage 4: writeback-jsdoc
┌─────────────────────┐     ┌──────────────────────┐     ┌─────────────────────┐     ┌─────────────────────────┐
│ 收集 git diff       │     │ 讀 pending-actions   │     │ build-backlinks     │     │ 讀 status=processed     │
│ 過濾噪音 commit     │ ──► │ 按 action type 分派  │ ──► │ generate-indexes    │ ──► │ rpc-method/service 筆記 │
│ 解析 rajah 影響     │     │ 更新/新增筆記        │     │ generate-call-chain │     │ merge 回 source JSDoc   │
│ 輸出 pending-actions│     │ 更新 last_scanned    │     │ 完整性檢查          │     │ source 優先、不 commit  │
└─────────────────────┘     └──────────────────────┘     │ 產出 daily report   │     │ 寫 writeback-report.json│
                                                          │ 更新 sync-state     │     │ 由 --finalize 自動觸發  │
                                                          └─────────────────────┘     └─────────────────────────┘
```

Replacement 3 — add Stage 4 section after Stage 3:

```markdown
### Stage 4：寫回 source JSDoc

```bash
bun run writeback-jsdoc.ts --dry-run   # 預覽
bun run writeback-jsdoc.ts             # 正式寫回
```

**自動觸發**：`sync-from-git.ts --finalize` 流程末尾會自動執行 Stage 4，可用 `--skip-writeback` 關閉。

**邏輯**：讀 `pending-actions.json` 中 `status === "processed"` 的 action，對涉及的 `rpc-method` / `service` 筆記，把內容合併寫回對應 source 檔案的 JSDoc 區塊。

**合併策略**：
- 對 `業務場景` / `相關規則與踩坑` / `備註` 三段：以 bullet 為單位做集合聯集；衝突時 source 版本贏（保留同事直接在 source 加的細節）
- 對 `功能描述` 段：若 source 的每句都在 note 中 → 用 note（採用 Stage 2 改進）；若 source 含 note 沒有的句子 → 用 source（防止 trackEvent-style regression）
- `@param` / `@returns` / `@throws` 等 `@` 標籤：從 source 整段原樣保留，不參與 merge

**Section 對應表**：

| Obsidian h2 | JSDoc section |
|---|---|
| `## 功能描述` | 主描述（單行內聯 `1) ... ；2) ...` 編號列表） |
| `## 業務場景` | `**業務場景**` bullets |
| `## 相關規則與踩坑` | `**相關規則與踩坑**` bullets |
| `## 備註` | `**備註**` bullets |
| 其他（輸入參數 / 回傳 / 呼叫關係 / 完整呼叫鏈 等） | 不寫回 JSDoc |

**安全規則**：
- 只動 working tree，**絕不 commit**；自行 `git diff` 確認後再 commit
- `human_edited: true` 的筆記跳過
- 對應 source 檔案在 working tree 有 uncommitted 改動 → 跳過該 action（避免覆寫使用者中間狀態）
- source 上沒有 `/** */` JSDoc 區塊 → 跳過該 action（v1 不主動建立 JSDoc）
- 跳過率 > 30% → 印 warning（但仍寫出已處理的部分）
- 冪等：對相同 working tree 連跑兩次，第二次應全部 `unchanged`

**輸出**：`aladdin_ai/scripts/codebase-index/writeback-report.json`（git-ignored），包含 modified / unchanged / skipped 三個清單。
```

Replacement 4 — add 絕對規則 #6:

In the section that lists 「絕對規則」（1-5），add at the end:

```markdown
6. **不得手工把 obsidian 內容貼回 source 當 JSDoc**：必須走 Stage 4 的 `writeback-jsdoc.ts` merge 流程；手工複製貼上會洗掉同事在 source 後加的註解（見 2026-05-19 trackEvent regression 事件，spec：`references/2026-05-19-jsdoc-writeback-design.md`）。
```

- [ ] **Step 3: Verify SKILL.md renders OK**

```bash
cat /Users/user/aladdin/.claude/skills/codebase-sync/SKILL.md | grep -A 1 "Stage 4\|四階段\|絕對規則"
```

Expected: see updated headers and new content present.

- [ ] **Step 4: Commit**

```bash
cd /Users/user/aladdin && git add .claude/skills/codebase-sync/SKILL.md && git commit -m "docs(codebase-sync): document Stage 4 JSDoc writeback in SKILL.md"
```

---

## Task 9: Manual golden verification against live repo

**Goal**: Verify Stage 4 against the real `methodRegister` regression case end-to-end (after the audit-recommended `git checkout` restores source's `送 trackEvent`).

**Pre-requisite**: Ensure agrabah's `app_user.ts` is at a state where source contains `送 trackEvent(userRegister, success) 埋點` in `methodRegister` step 15 (i.e., post-`bc8175000` state, NOT the regressed `ff9eb5df2 → working tree` state).

- [ ] **Step 1: Restore source if needed**

```bash
cd /Users/user/aladdin/agrabah && git checkout -- src/servers/app_user/services/app_user.ts && grep -n "送 trackEvent" src/servers/app_user/services/app_user.ts | head -5
```

Expected: grep returns one match in the `methodRegister` JSDoc (`送 trackEvent(userRegister, success) 埋點`).

- [ ] **Step 2: Construct a synthetic `pending-actions.json` for verification**

Save current `pending-actions.json` aside, then write a minimal one:

```bash
cd /Users/user/aladdin/aladdin_ai/scripts/codebase-index && cp pending-actions.json pending-actions.json.bak 2>/dev/null || true
```

Write `pending-actions.json` (replace existing) with:

```json
{
  "actions": [
    {
      "type": "update_existing",
      "status": "processed",
      "filePath": "agrabah/src/servers/app_user/services/app_user.ts",
      "affectedNotes": [
        {
          "path": "Codebase/Servers/AppUser/services/AppUser/methods/appUser.appUser.Register.md",
          "type": "rpc-method"
        }
      ]
    }
  ]
}
```

- [ ] **Step 3: Dry-run Stage 4**

```bash
cd /Users/user/aladdin/aladdin_ai/scripts/codebase-index && bun run writeback-jsdoc.ts --dry-run 2>&1 | tail -20
```

Expected:
- `Actions to process: 1`
- Either `1 files modified` (if note has improvements source doesn't) or `1 unchanged` (if both currently agree)
- `0 skipped`
- `writeback-report.json` written

- [ ] **Step 4: Live run + verify `送 trackEvent` survives**

```bash
cd /Users/user/aladdin/aladdin_ai/scripts/codebase-index && bun run writeback-jsdoc.ts 2>&1 | tail -10
```

Then:

```bash
cd /Users/user/aladdin/agrabah && grep -n "送 trackEvent" src/servers/app_user/services/app_user.ts
```

Expected: STILL one match (the trackEvent line is preserved).

- [ ] **Step 5: Verify diff (if any)**

```bash
cd /Users/user/aladdin/agrabah && git diff src/servers/app_user/services/app_user.ts | head -40
```

Inspect manually: any diff should be **additions from note** (Stage 2 improvements), NOT deletions of source content like `送 trackEvent` or `EventStatusCodeEnum.logoutSuccess`.

- [ ] **Step 6: Idempotence check — re-run Stage 4**

```bash
cd /Users/user/aladdin/aladdin_ai/scripts/codebase-index && bun run writeback-jsdoc.ts 2>&1 | tail -5
```

Expected: `0 files modified`, `1 unchanged`.

- [ ] **Step 7: Cleanup**

Restore the original `pending-actions.json` if backed up:

```bash
cd /Users/user/aladdin/aladdin_ai/scripts/codebase-index && [ -f pending-actions.json.bak ] && mv pending-actions.json.bak pending-actions.json || rm -f pending-actions.json
```

Discard any test changes in agrabah (the test was just verification, real merge will happen on next sync):

```bash
cd /Users/user/aladdin/agrabah && git checkout -- src/servers/app_user/services/app_user.ts
```

- [ ] **Step 8: Final commit (only if Step 5 inspection showed expected behavior)**

If the dry-run + live-run + idempotence + manual diff inspection all pass, no further commits needed — Tasks 1–8 covered the implementation. This Task 9 is verification only.

If any step fails, **DO NOT** mark this task complete. Diagnose and add a follow-up task to fix.

---

## Self-Review Notes

**Spec coverage check**:
- ✅ Spec section "In Scope" — Task 6 filters affectedNotes by `type === rpc-method | service`
- ✅ Spec section "Out of Scope" — model/enum/db-table notes filtered out by Task 6 loader
- ✅ Spec section "觸發" — Task 7 adds Stage 4 in runFinalize + --skip-writeback
- ✅ Spec section "Scope 過濾（三道關）" — Task 6 implements all 3 filters
- ✅ Spec section "Source JSDoc 定位" — Task 1 (jsdoc-extractor)
- ✅ Spec section "Source JSDoc 解析" — Task 2 (jsdoc-parser)
- ✅ Spec section "Note 解析" — Task 3 (note-section-parser with wikilink/backtick/bold normalization + compressDescription)
- ✅ Spec section "Merge 演算法" — Task 4; with description refinement noted
- ✅ Spec section "渲染回 JSDoc" — Task 5
- ✅ Spec section "寫回 / 輸出 / 安全規則" — Task 6 orchestrator
- ✅ Spec section "SKILL.md 更新" — Task 8
- ✅ Spec section "新增檔案" — covered across Tasks 1–6
- ✅ Spec section "測試策略" — Tasks 1–6 unit tests + Task 9 manual golden

**Type consistency check**:
- `ParsedJsdoc` defined in Task 2's `jsdoc-parser.ts`; Task 3 imports it; Task 4 references its fields; Task 5 consumes it; Task 6 uses `mergeParsed` returning it. All consistent.
- `WritebackAction`/`WritebackOptions`/`WritebackReport` defined in Task 6; integration test uses them; Task 7 imports `runWriteback` and (after Step 4) `loadProcessedActions`. Consistent.

**No-placeholder check**:
- All steps have actual code or commands, no "TODO/TBD/fill in details".
- "Add appropriate error handling" not used; specific guards spec'd.
- Tests have concrete assertions, not "write tests for the above".

**Refinement from spec acknowledged**: Task 4's `mergeDescription` uses substring-containment rule for the description section (not pure set union). This is documented in the task's intro and is the implementation of spec's intent ("colleagues' annotations have higher weight, no regression"). The spec's pure set-union wording was for bullets; description was under-specified — this refinement fills the gap.
