---
name: daily-code-review
description: Daily code review manager — scans commit authors, groups by workload, dispatches review agents with progressive dimension loading, then QA agents for quality assurance.
user-invocable: true
---

# Daily Code Review v2 Workflow

You are a technical manager who dispatches sub agents. Your responsibility is to scan each project's **`feature/*` branches for commits not yet merged into `origin/pro` whose commit date falls within the requested date window**, calculate workload per author, group authors by repo type and workload, then dispatch Review Agents and Report QA Agents in a pipeline.

## Review Scope

- **Branches reviewed:** only `origin/feature/*` of `agrabah` / `abu` / `lago` / `rajah`. `origin/dev` is NOT reviewed. `origin/pro` is used only as the exclusion baseline.
- **Commits reviewed:** every commit reachable from a `feature/*` branch but not from `origin/pro`, **whose commit date falls within the requested date window** (a single day or an inclusive range). Re-running a date window re-reviews it — there is no cross-run dedup.

## Parameters

`$ARGUMENTS` format: `/daily-code-review [date1] [date2] [concurrent]`

Arguments are position-free — each token is classified by shape:

- **date1 / date2** (optional): 8-digit `YYYYMMDD`. Together they define the review date window (matched against **commit date**):
  - **no date** → default to **yesterday** (single day)
  - **one date** → that single day
  - **two dates** → inclusive range; the earlier date is the start, the later the end (order is normalized — `20260520 20260515` also works)
  - **three or more dates** → print usage and terminate
- **concurrent** (optional): the non-8-digit number — sub agents per batch, defaults to `5`.

Examples:
- `/daily-code-review` → review yesterday, 5 per batch
- `/daily-code-review 20260520` → review 2026-05-20, 5 per batch
- `/daily-code-review 20260515 20260520` → review 2026-05-15 ~ 2026-05-20, 5 per batch
- `/daily-code-review 20260515 20260520 10` → same range, 10 per batch
- `/daily-code-review 20260520 10` → review 2026-05-20, 10 per batch (`10` is not 8 digits → concurrent)

---

## Execution Flow

### Step 0: Parse Parameters

1. Classify each whitespace-separated token in `$ARGUMENTS`:
   - an 8-digit number → a **date**
   - any other number → `CONCURRENT_COUNT`
2. Resolve the **date window** from the collected dates:
   - **0 dates** → `DATE_START = DATE_END =` yesterday (macOS: `TZ=Asia/Taipei date -v-1d +%Y%m%d`)
   - **1 date** → `DATE_START = DATE_END =` that date
   - **2 dates** → `DATE_START =` the earlier date, `DATE_END =` the later date (sort the pair)
   - **≥3 dates** → print `Usage: /daily-code-review [date1] [date2] [concurrent]` and terminate
3. `CONCURRENT_COUNT` defaults to `5` when no non-date number was given.
4. Derive (with `fmt(d)` = `${d:0:4}-${d:4:2}-${d:6:2}`):
   - `DATE_START_FMT = fmt(DATE_START)` and `DATE_END_FMT = fmt(DATE_END)` — `YYYY-MM-DD`, used for git date filtering and the report header
   - `REVIEW_LABEL` = `DATE_START` for a single-day window, otherwise `${DATE_START}-${DATE_END}` (e.g. `20260520` or `20260515-20260520`)

> **`REVIEW_LABEL` only names the outputs** — the report folder `review/{REVIEW_LABEL}/`, the report filenames, and the CSV filename. The **date window `[DATE_START, DATE_END]`** decides which commits are reviewed: commit scope = "`origin/feature/*` branches not yet merged into `origin/pro`, with commit date inside the window" (see Step 2).

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

### Step 1.5: Fetch All Repos (Remote Refs)

The scan in Step 2 reads the `origin/pro` and `origin/feature/*` **remote-tracking refs** directly — it never touches the local working tree or local branches. The only freshness requirement is therefore that each repo's remote-tracking refs are up to date, which a plain `git fetch` guarantees (it is unaffected by `git-lfs` smudge / checkout failures, which only hit the working tree).

For each repo in `agrabah`, `abu`, `lago`, `rajah`:

```bash
REPO_DIR=/Users/user/aladdin/<repo>
git -C "$REPO_DIR" fetch --quiet --prune origin
```

`--prune` removes stale `refs/remotes/origin/feature/*` for branches deleted after merge, so they are not scanned.

| Situation | Action |
|-----------|--------|
| `fetch` exit code 0 | OK, continue |
| `fetch` fails | Log the failure with the repo name, continue with the other repos, and note in the final CSV that this repo was skipped. Do NOT abort the review. |

After all 4 repos are fetched, proceed to Step 2.

---

### Step 2: Scan All Repos — Collect Unmerged Commits + Author Workload

For each of the 4 repos, list every commit reachable from an `origin/feature/*` branch but **not** reachable from `origin/pro` **whose commit date is inside the date window**, with `--numstat` for line counts. `git log` walks the commit graph and emits each unique SHA only once across the supplied refs (automatic dedup); a `feature/*` branch already fully merged into `pro` contributes zero commits automatically.

```bash
# Run on each repo: agrabah, abu, lago, rajah
# Refs are expanded inline via command substitution (`$(...)`) so word
# splitting works in both bash and zsh. Do NOT assign for-each-ref output
# to an intermediate variable and then expand `$REFS` — zsh does not
# word-split parameter expansion by default, which would pass the whole
# list as one arg and silently yield zero commits.
git -C /Users/user/aladdin/<repo> log --format="COMMIT_START|%an|%ae|%H|%s" --numstat \
  --after="${DATE_START_FMT} 00:00:00" --before="${DATE_END_FMT} 23:59:59" \
  $(git -C /Users/user/aladdin/<repo> for-each-ref --format='%(refname)' \
    'refs/remotes/origin/feature/*' 2>/dev/null) \
  --not origin/pro
```

- **Date filter** — `--after` / `--before` keep only commits whose **commit date** falls within `[DATE_START, DATE_END]`. For a single-day window `DATE_START_FMT` and `DATE_END_FMT` are the same date.
- If a repo has zero `origin/feature/*` refs, the command has no positive ref → skip that repo (it contributes no commits).
- If the scan yields zero commits across all 4 repos, print `[DONE] {REVIEW_LABEL} no commits in the date window to review.` and terminate.

Parse the output to build a workload table per author:

| Author | Email | Repos | Commits (SHAs) | Lines Changed | Group | Agent Type | Model |
|--------|-------|-------|----------------|---------------|-------|------------|-------|

**Parsing rules:**
- Lines starting with `COMMIT_START|` mark a new commit → extract author (`%an`), email (`%ae`), full SHA (`%H`), and the repo
- Subsequent lines with `<added>\t<deleted>\t<filepath>` are numstat → sum added+deleted per author
- **Deduplicate by `%ae` (email), NOT by `%an`**. The canonical display name is the most recent `%an` observed for that email.
- When collecting an author's commits in later steps, always filter by `%ae`, never by `%an`.
- **Record the full SHA list per author per repo** — these drive each Review Agent's commit list (Step 5).

---

### Step 2.1: Author Identity Disambiguation (MANDATORY)

Before grouping, verify the author table against the known identity-collision hazards in this repo. These have bitten us before — do not skip.

**Case A: Same email used by multiple `%an` values** (usually same person; one `git config` mistake)
```bash
# detect: any email with >1 distinct %an this scan
```
Action: merge into one logical author; use the most recent `%an` as the canonical name; record the alias list in the report header note.

**Case B: Different emails that look similar to another author's name** (DIFFERENT people — the Jeffrey/JeffKuo trap)
Known confusing pairs — treat each as distinct author and NEVER merge:

| `%an` | `%ae` | Note |
|-------|-------|------|
| `Jeffrey` | `pkh_ian.h@photons.com.tw` | NOT the same person as JeffKuo |
| `JeffKuo` | `pkh_jeffrey@photons.com.tw` | email prefix `pkh_jeffrey` ≠ `%an` Jeffrey |
| `ian` | `pkh_ian.lin@photons.com.tw` | shares "ian" prefix with Jeffrey's email — still distinct |
| `Dylan` | `pkh_yotsai@photons.com.tw` | email prefix `yotsai` also appears as a separate `%an` `yotsai` (gmail); confirm both when present |
| `yotsai` | `r8613266@gmail.com` | external gmail, distinct from Dylan |
| `JLee` / `jonathan` | `pkh_aceryue@photons.com.tw` | Case A — same person using two names |
| `Kevin Kung KHH` / `Kevin` | `pkh_kevin@photons.com.tw` | Case A — same person |
| `maxyeh` | `pkh_maxeh666` / `pkh_maxyeh666` | typo'd email — same person; prefer newer address |

**General rule: the `pkh_<name>` email prefix is NOT a reliable identity signal.** Always key off the full `%ae`, and when writing report filenames use the `%an` that actually appears on the commits you are reviewing.

**Report filename rule:** `<%an>_<REVIEW_LABEL>.md`. If two distinct emails happen to produce the same sanitized `%an` (extremely rare in this repo — not currently observed), disambiguate by appending the email local-part: `<%an>.<email-local>_<REVIEW_LABEL>.md`. Before finalizing filenames, run a collision check and alert if any two distinct emails resolve to the same file.

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

### Step 4: Create Review Directory

1. Ensure the directory exists: `/Users/user/aladdin/review/{REVIEW_LABEL}/`
2. Every author from Step 2 has commits inside the date window and must be reviewed — there is **no** "completed author" filter. (Termination on an empty scan is already handled at the end of Step 2.)
3. If a report file `{author}_{REVIEW_LABEL}.md` already exists (e.g. re-running the same date window), do NOT overwrite it — write this run's report with the next free suffix (`{author}_{REVIEW_LABEL}_r2.md`, `_r3.md`, …) and track the actual filename for Steps 6–7.

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
- Review window: {DATE_START_FMT} ~ {DATE_END_FMT} (same date when a single day); REVIEW_LABEL: {REVIEW_LABEL} — for the report header only
- Repo paths:
  - agrabah: /Users/user/aladdin/agrabah
  - abu: /Users/user/aladdin/abu
  - lago: /Users/user/aladdin/lago
  - rajah: /Users/user/aladdin/rajah

## Commits to Review

Review EXACTLY these commit SHAs — one block per author. Do NOT scan branches or filter by date yourself; these SHAs are the complete and only set for each author.

{COMMITS_TO_REVIEW}

Each block has the form:
### Author: <name> <email>
- <repo>: <sha> <sha> ...
(repos with no commits for that author are omitted)

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

### 1. Take the provided commit list for the CURRENT author

Read this author's block under "## Commits to Review" above. Those SHAs — grouped by repo — are the ONLY commits you may review for this author. **Do not run `git log` to discover commits and do not filter by date.** Skip any repo with no SHAs listed for this author.

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

Write the report to: /Users/user/aladdin/review/{REVIEW_LABEL}/{AUTHOR_NAME}_{REVIEW_LABEL}.md

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
- You can downgrade and upgrade severity if needed
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

Write to: `/Users/user/aladdin/review/{REVIEW_LABEL}/CRITICAL_ISSUES_{REVIEW_LABEL}.csv`

**CSV Format:**

Header (write once if creating new file):
```
問題描述,程式碼位置（檔案＋行數）,Author,Date
```

Rules:
- Delimiter: comma `,`
- If field contains comma, double-quote, or newline: wrap in double-quotes, escape internal double-quotes by doubling
- Author field: author name (e.g. `ashliu`, `pkh_tom`)
- Date field: the review window — a single-day run uses `YYYY/MM/DD` (e.g. `2026/05/20`); a date-range run uses `YYYY/MM/DD-YYYY/MM/DD` (e.g. `2026/05/15-2026/05/20`)
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
5. **Bootstrap flag**: Flag date = today (script execution date), independent of the review window. The `date1` / `date2` arguments select which commits are reviewed (commit date inside the window); `REVIEW_LABEL` only names the output folder / files
6. **QA is mandatory**: Every batch must go through QA before the next batch starts (but QA and the next batch's Review Agents can run in parallel if there are remaining batches)
