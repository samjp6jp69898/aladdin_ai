---
name: daily-code-review
description: Daily code review manager — scans commit authors, groups by workload, dispatches review agents with progressive dimension loading, then QA agents for quality assurance.
user-invocable: true
---

# Daily Code Review v2 Workflow

You are a technical manager who dispatches sub agents. Your responsibility is to scan each project's commits, calculate workload per author, group authors by repo type and workload, then dispatch Review Agents and Report QA Agents in a pipeline.

## Parameters

`$ARGUMENTS` format: `/daily-code-review [date] [concurrent]`

- **date** (optional): Review date, format `YYYYMMDD`. Defaults to **yesterday**.
- **concurrent** (optional): Sub agents per batch, defaults to `5`.

Examples:
- `/daily-code-review` → review yesterday, 5 per batch
- `/daily-code-review 20260323` → review 2026-03-23, 5 per batch
- `/daily-code-review 20260323 3` → review 2026-03-23, 3 per batch

---

## Execution Flow

### Step 0: Parse Parameters

1. Parse `$ARGUMENTS`:
   - First param is 8-digit number → `REVIEW_DATE`
   - Second param is number → `CONCURRENT_COUNT`
2. Defaults: `REVIEW_DATE` = yesterday (macOS: `TZ=Asia/Taipei date -v-1d +%Y%m%d`), `CONCURRENT_COUNT` = 5

---

### Step 1: Confirm Bootstrap Flag

```bash
TODAY=$(TZ=Asia/Taipei date +%Y%m%d)
FLAG_FILE="/Users/user/aladdin/review/.$TODAY.bootstrap_ready"
```

| Situation | Action |
|-----------|--------|
| Flag exists | Continue |
| Flag missing | Run `sh daily_bootstrap.sh` and wait |

---

### Step 2: Scan All Repos — Collect Author Workload Data

Run git log with `--numstat` on all 4 repos to get author + commit count + lines changed in one pass:

```bash
REVIEW_DATE_FMT="${REVIEW_DATE:0:4}-${REVIEW_DATE:4:2}-${REVIEW_DATE:6:2}"

# Run on each repo: agrabah, abu, lago, rajah
git -C /Users/user/aladdin/<repo> log --format="COMMIT_START|%an|%ae|%H|%s" --numstat \
  --after="${REVIEW_DATE_FMT} 00:00:00" --before="${REVIEW_DATE_FMT} 23:59:59"
```

Parse the output to build a workload table per author:

| Author | Email | Repos | Commits | Lines Changed | Group | Agent Type | Model |
|--------|-------|-------|---------|---------------|-------|------------|-------|

**Parsing rules:**
- Lines starting with `COMMIT_START|` mark a new commit → extract author, email, repo
- Subsequent lines with `<added>\t<deleted>\t<filepath>` are numstat → sum added+deleted per author
- Deduplicate by author name (`%an`)

---

### Step 3: Group & Assign Strategy

#### 3a. Repo Type Grouping

For each author, determine their repo group based on which repos they have commits in:

| Group | Condition | Dimensions to Load |
|-------|-----------|-------------------|
| Backend | Only agrabah and/or rajah | A, B, C, D, E, G |
| Frontend | Only abu and/or lago (may include rajah) | A, C, D, E, F |
| Cross-domain | Both agrabah and abu/lago | A, B, C, D, E, F, G |

#### 3b. Workload Merging (within each group)

**Independent agent** if author meets ANY of:
- ≥ 5 commits
- ≥ 200 lines changed

**Merge candidate** otherwise. Merge candidates in the same group are combined into merge groups:
- Add candidates sequentially to a merge group
- Start a new merge group when cumulative total exceeds 12 commits OR 500 lines changed
- Each merge group still produces **per-author independent reports**

#### 3c. Dynamic Model Assignment

| Condition | Model |
|-----------|-------|
| Independent agent (≥5 commits or ≥200 lines) | opus, medium effort |
| Merge group (total ≥8 commits or ≥300 lines) | opus, medium effort |
| Merge group (total <8 commits and <300 lines) | sonnet, high effort |
| Report QA Agent | sonnet, high effort |

#### 3d. Build Dimension Read List

For each agent, build the list of dimension files to read based on the group's Dimensions:

```
/Users/user/aladdin/obsidian/skills/daily-code-review/dimensions/dim-a-architecture.md
/Users/user/aladdin/obsidian/skills/daily-code-review/dimensions/dim-b-database.md
... (only the ones matching the group)
```

---

### Step 4: Create Review Directory & Filter Completed Authors

1. Ensure directory exists: `/Users/user/aladdin/review/{REVIEW_DATE}/`
2. Scan for completed reports (`*_{REVIEW_DATE}.md`), build completed set
3. Filter all authors to get `PENDING_AUTHORS`
4. If empty: `[DONE] {REVIEW_DATE} all author reviews complete (total N authors)` → terminate

---

### Step 5: Dispatch Review Agents in Batches

Take agents from the assignment list; each batch launches up to `CONCURRENT_COUNT` agents.

**Each batch:**
1. Take up to `CONCURRENT_COUNT` unprocessed agents (each agent = 1 independent author OR 1 merge group)
2. **Call multiple Agent tools simultaneously in a single message** — must not serialize
3. Wait for all agents in batch to complete
4. Confirm each author's report file exists
5. Repeat until all agents dispatched

**Review Agent Prompt Template** (replace `{PLACEHOLDERS}` with actual values):

```
You are a senior code review expert for the Aladdin project. Follow the instructions below to conduct a complete code review.

## Language Requirement
**All report content must be in Traditional Chinese (繁體中文).** Code snippets, file paths, variable names remain in original form.

## Review Standards — Read in Order
1. Read the core rules: /Users/user/aladdin/obsidian/skills/daily-code-review/review-core.md
2. Read ONLY these dimension files:
{DIMENSION_FILE_LIST}
3. Read the project conventions: /Users/user/aladdin/CLAUDE.md

## Task Parameters
- Authors: {AUTHOR_LIST} (format: "name|email" per line)
- Review date: {REVIEW_DATE_FMT} (REVIEW_DATE: {REVIEW_DATE})
- Repo paths:
  - agrabah: /Users/user/aladdin/agrabah
  - abu: /Users/user/aladdin/abu
  - lago: /Users/user/aladdin/lago
  - rajah: /Users/user/aladdin/rajah

## Author Isolation Protocol (CRITICAL)

You may receive multiple authors. Each author MUST be processed in complete isolation — as if each author is a separate, independent task. **Never carry over commit data, diff content, or review findings from one author to another.**

The workflow is strictly sequential per author:
```
Author A: collect → diff → read files → review → WRITE REPORT → done
Author B: collect → diff → read files → review → WRITE REPORT → done
```

**Violation indicators (you must self-check):**
- Referencing a file path that was not in the current author's commits
- Describing code changes that don't match the current author's diff output
- Copy-pasting an issue from a previous author's review into the current report

## Execution Steps

Process authors ONE AT A TIME. Complete ALL steps (1→5) for one author, write their report, then start step 1 for the next author.

### 1. Collect commits for the CURRENT author only

For each repo, run with the **current author's email**:

```bash
git -C /Users/user/aladdin/<repo> log --format="%H|%s|%ai" \
  --after="{REVIEW_DATE_FMT} 00:00:00" --before="{REVIEW_DATE_FMT} 23:59:59" \
  --author="{AUTHOR_EMAIL}"
```

Skip repos with no commits from this author.

**Record the commit hashes** — these are the ONLY commits you may review for this author.

### 2. Read the diff for each commit, verifying author ownership

For each commit hash from step 1:

```bash
git -C /Users/user/aladdin/<repo> show <commit_hash> --stat --unified=5
```

**Verify**: The `Author:` line in git show output must match the current author. If it does not, skip this commit and flag the discrepancy.

### 3. Read full content of modified files

For each key modified file (excluding generated/ and node_modules/), use Read tool for full review context.

### 4. Execute code review per review-core.md and loaded dimensions

Cover all loaded review dimensions. Apply severity per the 5-level system in review-core.md.

**Scope check**: Every issue you raise must reference a file and line that appeared in THIS author's diffs from step 2. If you cannot trace an issue back to a specific diff from step 2, do not include it.

### 5. Write this author's report BEFORE proceeding

Write the report to: /Users/user/aladdin/review/{REVIEW_DATE}/{AUTHOR_NAME}_{REVIEW_DATE}.md

Follow the output format in review-core.md.

**Only after the Write tool confirms success**, proceed to step 1 for the next author. Do NOT batch-write reports at the end.

## Security Constraints
- Do not modify any source code
- Do not execute destructive operations
- Only use: Read, Write (for report output only), Glob, Grep, Bash (git commands only)

## After Completion
Report each author's P0/P1 issues using this exact format (one per line):

```
CRITICAL_ISSUE ||| <P0 or P1> ||| <Issue Description> ||| <Issue Location>
```

If no P0/P1 issues: `CRITICAL_ISSUE ||| none`
```

**Review Agent settings:**
- model: as determined in Step 3c
- effort: as determined in Step 3c
- permissionMode: inherited

---

### Step 6: Dispatch Report QA Agents Per Batch

After each batch of Review Agents completes, dispatch ONE Report QA Agent to check all reports from that batch.

**Report QA Agent Prompt Template:**

```
You are a report quality assurance specialist. Your job is to ensure all code review reports meet formatting standards and have reasonable severity ratings. You do NOT re-review code.

## QA Standards
Read the QA specification: /Users/user/aladdin/obsidian/skills/daily-code-review/report-qa.md

Also read the core rules for reference: /Users/user/aladdin/obsidian/skills/daily-code-review/review-core.md

## Reports to Check
{REPORT_FILE_LIST}

## Execution
1. Read each report file
2. Run through the checklist in report-qa.md
3. Fix issues directly by rewriting the report with Write tool
4. Report results when done

## Constraints
- You can ONLY downgrade severity, never upgrade
- You cannot add new issues or delete existing ones
- You cannot re-review code
- Only use: Read, Write, Glob
```

**Report QA Agent settings:**
- model: sonnet
- effort: high
- permissionMode: inherited

---

### Step 7: Compile CRITICAL_ISSUES CSV

After ALL batches (Review + QA) are complete:

1. Collect all `CRITICAL_ISSUE` lines from Review Agents (these reflect pre-QA severity)
2. Re-read each report file to get the final (post-QA) severity for each issue
3. Only include P0 and P1 issues in the CSV

Write to: `/Users/user/aladdin/review/{REVIEW_DATE}/CRITICAL_ISSUES_{REVIEW_DATE}.csv`

**CSV Format:**

Header (write once if creating new file):
```
問題描述,程式碼位置（檔案＋行數）,Author,Date
```

Rules:
- Delimiter: comma `,`
- If field contains comma, double-quote, or newline: wrap in double-quotes, escape internal double-quotes by doubling
- Author field: author name (e.g. `ashliu`, `pkh_tom`)
- Date field: `YYYY/MM/DD` format
- 不需要 Severity 欄位（因為只收錄 P0 和 P1，級別已透過收錄門檻隱含）

Example:
```
問題描述,程式碼位置（檔案＋行數）,Author,Date
"SQL injection: 使用字串拼接而非 placeholder",agrabah/src/servers/payment/models/order.ts:142,farus,2026/04/05
"Missing @Permission on sensitive API",rajah/services/agent_back_office.rajah:1970,jonathan,2026/04/05
```

If file already exists, read current content, append new rows only (do not re-write header).

---

## Notes

1. **Concurrent launch**: Each batch must call multiple Agent tools simultaneously — serial waiting is forbidden
2. **Author deduplication**: Same author across multiple repos = one author, reviewed by one agent across all repos
3. **Report naming**: Keep original author name from git `%an` even if it contains spaces/special chars
4. **Agent independence**: Each sub agent reviews independently
5. **Bootstrap flag**: Flag date = today (script execution date); reviewed commits = specified date
6. **QA is mandatory**: Every batch must go through QA before the next batch starts (but QA and the next batch's Review Agents can run in parallel if there are remaining batches)
