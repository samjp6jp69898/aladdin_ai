---
name: daily-code-review
description: Daily code review manager — scans yesterday's commit authors across four projects and dispatches sub agents to conduct code reviews.
user-invocable: true
---

# Daily Code Review Workflow

You are a technical manager who dispatches sub agents. Your responsibility is to scan each project's commits from yesterday, find all authors who made commits, and concurrently dispatch sub agents to conduct independent code reviews for each author.

## Parameters

`$ARGUMENTS` format: `/daily-code-review [date] [concurrent]`

- **date** (optional): Specify the review date, format `YYYYMMDD`. If not provided, defaults to **yesterday** (today - 1 day)
- **concurrent** (optional): Number of sub agents to run per batch, defaults to `8`

Examples:
- `/daily-code-review` → review all authors from yesterday, 5 sub agents per batch
- `/daily-code-review 20260323` → review all authors from 2026-03-23, 8 per batch
- `/daily-code-review 20260323 5` → review all authors from 2026-03-23, 5 per batch

---

## Execution Flow

### Step 0: Parse Parameters

1. Parse parameters from `$ARGUMENTS`:
   - If the first parameter is an 8-digit number → set as `REVIEW_DATE` (format `YYYYMMDD`)
   - If the second parameter is a number → set as `CONCURRENT_COUNT`
2. If `REVIEW_DATE` is not specified, use yesterday's date:
   ```bash
   REVIEW_DATE=$(TZ=Asia/Taipei date -v-1d +%Y%m%d)   # macOS
   # REVIEW_DATE=$(TZ=Asia/Taipei date -d "yesterday" +%Y%m%d)  # Linux
   ```
3. If `CONCURRENT_COUNT` is not specified, default to `5`

---

### Step 1: Confirm Bootstrap Flag

Check whether today's bootstrap flag exists (flag date is **today**, not the review date):

```bash
TODAY=$(TZ=Asia/Taipei date +%Y%m%d)
FLAG_FILE="/Users/user/aladdin/review/.$TODAY.bootstrap_ready"
```

| Situation | Action |
|-----------|--------|
| Flag exists | Continue execution |
| Flag does not exist | Run `sh daily_bootstrap.sh` and wait for it to complete |

---

### Step 2: Scan Four Repos for Author List

Run git log on the following four repos to get all authors who committed on `REVIEW_DATE` (UTC+8 00:00 ~ 23:59):

```bash
# Convert YYYYMMDD to YYYY-MM-DD format
REVIEW_DATE_FMT="${REVIEW_DATE:0:4}-${REVIEW_DATE:4:2}-${REVIEW_DATE:6:2}"

# agrabah
git -C /Users/user/aladdin/agrabah log --format="%an|%ae" \
  --after="${REVIEW_DATE_FMT} 00:00:00" --before="${REVIEW_DATE_FMT} 23:59:59"

# abu
git -C /Users/user/aladdin/abu log --format="%an|%ae" \
  --after="${REVIEW_DATE_FMT} 00:00:00" --before="${REVIEW_DATE_FMT} 23:59:59"

# lago
git -C /Users/user/aladdin/lago log --format="%an|%ae" \
  --after="${REVIEW_DATE_FMT} 00:00:00" --before="${REVIEW_DATE_FMT} 23:59:59"

# rajah
git -C /Users/user/aladdin/rajah log --format="%an|%ae" \
  --after="${REVIEW_DATE_FMT} 00:00:00" --before="${REVIEW_DATE_FMT} 23:59:59"
```

Deduplicate by `author name` (`%an`) and build the complete `ALL_AUTHORS` list.

---

### Step 3: Create Review Directory and Find Pending Authors

1. Confirm the review directory exists; create it if not:
   ```
   /Users/user/aladdin/review/{REVIEW_DATE}/
   ```

2. Scan the directory, list completed review reports (`*_{REVIEW_DATE}.md`), and build a "completed authors" set

3. Filter `ALL_AUTHORS` to remove completed authors, yielding `PENDING_AUTHORS`

4. If `PENDING_AUTHORS` is empty:
   - Output `[DONE] {REVIEW_DATE} all author reviews complete (total N authors)` and **terminate**

---

### Step 4: Concurrently Dispatch Sub Agents for Review

Take authors from `PENDING_AUTHORS` in order; each batch launches up to `CONCURRENT_COUNT` sub agents, with each sub agent responsible for one author.

**Each batch flow:**

1. Take up to `CONCURRENT_COUNT` unprocessed authors
2. **Call multiple Agent tools simultaneously in a single message**, launching these sub agents in parallel (must not be done in series; must not wait for one to complete before launching the next)
3. Wait for all sub agents in this batch to complete
4. Confirm each author's report file has been created
5. If `PENDING_AUTHORS` still has remaining authors, repeat this batch
6. Continue until all authors are complete

**Sub Agent settings:**

Sub agents must use model: opus 4.6 Medium effort  
And permissionMode: inherited  
When launching a sub agent, **the prompt must include the following instructions — must not be omitted or summarized**:

**Sub Agent Prompt Template** (replace `{}` with actual values):

```
You are a senior code review expert for the Aladdin project. Please follow the instructions below to conduct a complete review of the specified author's code changes.

## Review Standards
Please first read the complete review standards document:
/Users/user/aladdin/obsidian/skills/daily-code-review/DAILY_REVIEW_PROMPT.md

Please first read the project conventions document:
/Users/user/aladdin/CLAUDE.md

## Task Parameters
- Author: {AUTHOR_NAME} ({AUTHOR_EMAIL})
- Review date: {REVIEW_DATE_FMT} (REVIEW_DATE: {REVIEW_DATE})
- Repo paths:
  - agrabah: /Users/user/aladdin/agrabah
  - abu: /Users/user/aladdin/abu
  - lago: /Users/user/aladdin/lago
  - rajah: /Users/user/aladdin/rajah

## Execution Steps

### 1. Collect all commits by this author on this date

Run the following command on each of the four repos to find all commits by this author:

```bash
git -C /Users/user/aladdin/agrabah log --format="%H|%s|%ai" \
  --after="{REVIEW_DATE_FMT} 00:00:00" --before="{REVIEW_DATE_FMT} 23:59:59" \
  --author="{AUTHOR_EMAIL}"

git -C /Users/user/aladdin/abu log --format="%H|%s|%ai" \
  --after="{REVIEW_DATE_FMT} 00:00:00" --before="{REVIEW_DATE_FMT} 23:59:59" \
  --author="{AUTHOR_EMAIL}"

git -C /Users/user/aladdin/lago log --format="%H|%s|%ai" \
  --after="{REVIEW_DATE_FMT} 00:00:00" --before="{REVIEW_DATE_FMT} 23:59:59" \
  --author="{AUTHOR_EMAIL}"

git -C /Users/user/aladdin/rajah log --format="%H|%s|%ai" \
  --after="{REVIEW_DATE_FMT} 00:00:00" --before="{REVIEW_DATE_FMT} 23:59:59" \
  --author="{AUTHOR_EMAIL}"
```

If a repo has no commits from this author, skip it.

### 2. Read the complete diff for each commit

```bash
git -C /Users/user/aladdin/<repo> show <commit_hash> --stat --unified=5
```

### 3. Read the full content of modified files

For each key modified file in the diff (excluding generated/ and node_modules/), use the Read tool to read the full content for review context.

### 4. Execute a complete code review per DAILY_REVIEW_PROMPT.md

Cover all review dimensions (architecture & design, TypeScript quality, database SQL, security, etc.).

### 5. Create the review report

Organize by project: lago / abu / agrabah / rajah as separate sections.

Write the review result to:
/Users/user/aladdin/review/{REVIEW_DATE}/{AUTHOR_NAME}_{REVIEW_DATE}.md

Follow the output format specified in DAILY_REVIEW_PROMPT.md.
## Security Constraints
- Do not modify any code or make any changes to the codebase
- Do not execute any destructive operations (rm -rf, etc.)
- Only use Read, Write (for report output only), Glob, Grep, Bash (git commands only)

## After Completion
When done, tell the main agent that {AUTHOR_NAME}'s review is complete, and report any critical issues found in the report in the following format:
Issue Description | Issue Location (file / method name / line number)
```

---

### Step 5: Compile Completion Report

After all authors' reviews are complete, output the following summary:

## Daily Code Review Completion Report

Before ending their tasks, each sub agent will compile the serious issues found for that author and report them to you. Compile them into the following CSV format:

Issue Description | Issue Location (file / method name / line number) | author | date (YYYY/MM/DD)

Then **append** this data to the bottom of the following CSV file at its **complete absolute path**:

```
/Users/user/aladdin/review/{REVIEW_DATE}/CRITICAL_ISSUES_{REVIEW_DATE}.csv
```

**Important: The CSV file must be stored under the review date directory `/Users/user/aladdin/review/{REVIEW_DATE}/` — it must not be stored anywhere else.**

If the file does not exist, create a new file and write the header row. After the CSV update is complete, the Main Agent's task is finished.

## Notes

1. **Concurrent launch**: Each batch must call multiple Agent tools simultaneously in a single message to achieve true parallel execution — serial waiting is not allowed
2. **Author deduplication**: If the same author committed to multiple repos, they are still treated as one author, and a single sub agent reviews across all repos
3. **Report path naming**: If an author name contains spaces or special characters, keep the original name (as output by `%an` in git log)
4. **Sub agent independence**: Each sub agent independently reviews one author and does not interfere with others
5. **Bootstrap flag**: The flag date is the **current date** (the day the script runs); the commits reviewed are from the **specified date**
