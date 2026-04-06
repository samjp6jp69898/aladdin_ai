---
name: back-testing
description: Bug analysis back-testing — find the actual git commit for a Notion bug ticket, compare it against the solution in debug/, and produce an Obsidian note.
user-invocable: true
context: fork
---

# Bug Analysis Back-Testing

Finds the actual fix git commit for a Notion bug ticket, compares it against the previous analysis solution in `/Users/user/aladdin/debug/`, and produces an Obsidian back-testing note.

## Parameters

`$ARGUMENTS` format: `/back-testing <NotionURL> [git author name] [git author name]`

- **NotionURL** (required): The Notion URL of the bug ticket
- **git author name** (optional): The git commit author name, used to narrow the git log search. Multiple names may be provided if both frontend and backend are involved.

---

## Important Constraints

- **Do not modify any properties on the bug ticket!**
- **Do not use the Skill tool to call other skills!**
- Use the Bash tool to run `bash /Users/user/aladdin/scripts/notion.sh` to read Notion pages

---

## Execution Flow

### Step 1: Read the Notion Bug Ticket

Use the `notion.sh` script to read the Notion URL from `$ARGUMENTS`.

```bash
# Read page properties
bash /Users/user/aladdin/scripts/notion.sh fetch "{NotionURL}"

# Read page body blocks
bash /Users/user/aladdin/scripts/notion.sh fetch-blocks "{NotionURL}"

# Read page comments (page_id taken from the id field in the fetch response JSON)
bash /Users/user/aladdin/scripts/notion.sh comments "{page_id}"
```

Extract the following information from the page:
- **Ticket ID** (FAQ-XXXX)
- **Issue summary** (title)
- **Severity** (P1重點 / P2較高 / P3一般 / P4較低)
- **Status**
- **Assigned engineer** (name, used to look up git author)
- **Version / Fix version**
- **Affected modules**
- **Issue description** (page body content)
- **Version information** (may be in comments)
- **git author name** (usually the "負責技術" field is the commit author)

Also check page comments for version information (e.g. `x.x.xxx`).

#### Resolving Notion User Names

The `people` array returned by the Notion API contains elements with `id` and possibly `name`. If `name` is empty, use `notion.sh get-user` to query:

```bash
bash /Users/user/aladdin/scripts/notion.sh get-user "{user_id}"
# Returns JSON with name and bot/person info
```

- Query every user ID missing a name in fields such as "負責技術" and "經辦人"
- The resolved names are used for: (1) displaying actual names in the summary report, (2) searching git author (typically by email prefix such as `pkh_chienhung` or name)
- **Never display only a user ID in the report — always show the actual name**

Report the extracted information summary to the user.

---

### Step 2: Find the Git Commit

Based on the information extracted in Step 1, search for the fix commit in the relevant git repos.

#### 2a. Determine Search Strategy

Determine the git author and search keywords in the following priority order:

1. **If `$ARGUMENTS` includes a git author name** → use it directly
2. **If Notion "負責技術" has a person name** → use that name to search git author
3. **If a comment contains a version number** → search git tag/log by version number

#### 2b. Search Git Log

Search the following repos (prioritize based on affected modules):

| Repo Path | Description |
|-----------|-------------|
| `/Users/user/aladdin/agrabah` | Backend |
| `/Users/user/aladdin/abu` | Admin frontend |
| `/Users/user/aladdin/lago` | App frontend |
| `/Users/user/aladdin/genie` | Shared utilities |
| `/Users/user/aladdin/rajah` | Protobuf definitions |

Example search commands:

```bash
# Search by author (within last 3 months)
git -C /Users/user/aladdin/agrabah log --oneline --author="author name" --since="2025-12-01" --all | head -50

# Search commit messages by ticket ID
git -C /Users/user/aladdin/agrabah log --oneline --all --grep="FAQ-XXXX" | head -20

# Search by keyword (extracted from issue summary)
git -C /Users/user/aladdin/agrabah log --oneline --all --grep="keyword" --since="2025-12-01" | head -30

# Search by version tag
git -C /Users/user/aladdin/agrabah tag -l "*version*"

# View full diff of a specific commit
git -C /Users/user/aladdin/agrabah show <commit_hash> --stat
git -C /Users/user/aladdin/agrabah show <commit_hash>
```

#### 2c. Confirm Fix Commit

After finding candidate commits, use `git show` to inspect the actual changes and confirm the commit truly fixes this bug.

**Confirmation criteria:**
- Changed files relate to the affected modules in the bug
- Commit message or diff content corresponds to the issue description
- Timeline is reasonable (commit date is after the bug was reported)

If a fix commit is found, record:
- commit hash
- author
- commit message
- list of changed files
- summary of fix approach

**If no fix commit can be found**, report to the user and ask if there are additional clues, then skip to Step 4 (still produce a note, marked as back-testing failed).

---

### Step 3: Independent Fix Summary (Reverse Verification)

**Only execute this step after Step 2 has confirmed a fix commit.**

**Key principle: Before reading the solution, independently complete your understanding of the commit.** This avoids confirmation bias — if you read the solution first, you will unconsciously look for evidence in the commit that supports the solution.

#### 3a. Write the "Actual Fix Summary" Independently

Based on the commit found in Step 2, and **without looking at the solution**, independently answer:

1. **Nature of the issue**: Is this a code bug / business requirement confirmation / copy improvement / other?
2. **Ownership**: Was the fix in the frontend or backend? (or both)
3. **Root cause**: One or two sentences describing the fundamental cause
4. **Files changed and direction**: List which files were modified and what each one changed

Record the above as the "Actual Fix Summary" for comparison in Step 3c.

---

### Step 3b: Read the Previous Analysis Documents

**Only after completing 3a**, read the previous analysis:

Search for the folder or files matching the ticket ID in `/Users/user/aladdin/debug/`:

```bash
ls -la /Users/user/aladdin/debug/FAQ-XXXX/ 2>/dev/null
ls /Users/user/aladdin/debug/ | grep "FAQ-XXXX"
```

Files to review (in priority order):
1. `debug/FAQ-XXXX/FAQ-XXXX-solution.md` — main solution
2. `debug/FAQ-XXXX/FAQ-XXXX-peer-review.md` — review result
3. `debug/FAQ-XXXX/FAQ-XXXX-analytics.md` — analysis report

---

### Step 3c: Structured Comparison (Six Dimensions)

Compare the "Actual Fix Summary" from 3a against the solution from 3b across **each dimension**:

| Dimension | Match | Notes |
|-----------|-------|-------|
| **Issue nature determination** | ✅/❌ | Did the solution correctly identify this as a bug / non-bug / requirement confirmation? |
| **Ownership** | ✅/❌ | Was the frontend/backend attribution correct? |
| **Root cause module** | ✅/❌ | Did it find the correct module/component? |
| **Root cause specific logic** | ✅/❌/⚠️ | Was the specific error cause correct? (⚠️ = right direction but details off) |
| **Changed files** | ✅/❌/⚠️ | Were the listed files consistent with actual? (⚠️ = partial match) |
| **Change direction** | ✅/❌/⚠️ | Was the proposed fix approach consistent with actual? (⚠️ = right idea but different method) |

**Overall conclusion based on six dimensions:**

| Conclusion | Criteria |
|------------|----------|
| **Analysis correct** | At least 5 of 6 ✅ (issue nature + ownership must both be ✅) |
| **Partially correct** | Issue nature ✅ + ownership ✅, but root cause or change direction has deviations |
| **Analysis incorrect** | Issue nature ❌ or ownership ❌ or root cause module ❌ |
| **No prior analysis** | No analysis documents for this ticket found in debug/ |

---

### Step 3d: Failure Mode Classification

**Only execute when conclusion is "Analysis incorrect" or "Partially correct".**

Select the **one best-matching failure mode** from the following:

| Failure Mode | Code | Description |
|--------------|------|-------------|
| **Frontend/backend attribution reversed** | `wrong-side` | Attributed to frontend but actually a backend issue, or vice versa |
| **Non-bug misclassified as bug** | `not-a-bug` | Normal business logic, requirement confirmation, or design decision misidentified as a code bug |
| **Wrong root cause layer** | `wrong-root-cause` | Found the related module but misjudged the specific cause |
| **Incomplete analysis** | `incomplete` | Direction correct but missed key changes or impact scope |
| **Over-engineered** | `over-engineered` | Actually a simple problem, but the analysis proposed an overly complex solution |

---

### Step 3e: If the Author Used a Different Approach

If the actual fix approach differs from the previously analyzed recommendation, record:
- What the previous analysis recommended
- What the author actually did
- Why the author's approach is better (or the trade-offs of each)

---

### Step 4: Produce Obsidian Back-Testing Note

Create an Obsidian note in `/Users/user/aladdin/obsidian/backTesting/`.

**File naming**: `FAQ-XXXX-brief-description.md` (brief description taken from bug title, special characters removed)

**Note format:**

```markdown
# FAQ-XXXX Brief Description

**Ticket ID**: FAQ-XXXX ｜ **Severity**: PX ｜ **Status**: back-testing conclusion icon

## Affected Modules

Use [[bidirectional links]] to mark specific file names / component names / manager names.
Link standard: what keywords would you search for next time you encounter a similar issue? Link those.
- e.g. [[payment_manager]], [[BetSlipSummary]]
- Do not link overly broad categories (no [[debug]], [[agrabah]], [[lago]])
- Do not create empty stub files just for linking

## Issue Description
(Brief description of the symptom)

## Root Cause
(One or two sentences explaining the fundamental cause)

## Fix
(commit hash, author, what was changed)

## Structured Comparison

| Dimension | Match | Notes |
|-----------|-------|-------|
| Issue nature determination | ✅/❌ | (Did solution correctly judge bug/non-bug?) |
| Ownership | ✅/❌ | (Frontend/backend attribution) |
| Root cause module | ✅/❌ | (Was the correct module found?) |
| Root cause specific logic | ✅/❌/⚠️ | (Was the specific error cause correct?) |
| Changed files | ✅/❌/⚠️ | (Were the listed files correct?) |
| Change direction | ✅/❌/⚠️ | (Was the proposed fix approach correct?) |

## Back-Testing Result
Back-testing conclusion icon, one-sentence conclusion

## Failure Mode (only for analysis incorrect / partially correct)
`wrong-side` / `not-a-bug` / `wrong-root-cause` / `incomplete` / `over-engineered`
One sentence explaining why it falls into this category.

## Analysis Lesson (only when analysis failed)
Record why the analysis direction was wrong and how to avoid it next time
```

**Back-testing conclusion icons:**
- Analysis correct → status: `✅`
- Partially correct → status: `✅` (but the structured comparison table will show which dimensions had deviations)
- Analysis incorrect → status: `❌`
- No prior analysis / fix commit not found → status: `⚠️`

Use `notion.sh` to update the AI analysis attribute to "回測完成":

```bash
bash /Users/user/aladdin/scripts/notion.sh update-prop "{page_id}" "AI分析" select "回測完成"
```

---

### Step 5: Completion Report

Report the back-testing result to the user:

```
## FAQ-XXXX Back-Testing Complete

- **Conclusion**: ✅ Analysis correct / ❌ Analysis incorrect / ⚠️ Unable to compare
- **Fix Commit**: <hash> by <author>
- **Comparison Summary**: Issue nature X | Ownership X | Root cause module X | Root cause logic X | Files X | Direction X
- **Failure Mode**: code (if applicable)
- **Note location**: /Users/user/aladdin/obsidian/backTesting/FAQ-XXXX-brief-description.md

### Summary
(A paragraph describing the fix approach and comparison result)
```

---

## Notes

1. **Do not use the Skill tool** to call other skills (e.g. analyze-single-bug); execute all steps directly
2. **Three-step reverse verification**: (1) Find the git commit first, (2) Independently write the "Actual Fix Summary", (3) Only then read the solution for comparison. **Never read the solution first** — it creates confirmation bias, causing you to unconsciously look for evidence in the commit that supports the solution
3. **The structured comparison must fill in every dimension** — a single overall conclusion is not enough. The six-dimension table is a required field in the back-testing note
4. **Failure mode classification must select a code** (`wrong-side` / `not-a-bug` / `wrong-root-cause` / `incomplete` / `over-engineered`) for use in subsequent statistical analysis
5. **Obsidian bidirectional links** should link specific file names / component names / manager names — do not link broad categories
6. **Git search strategy**: First search commit messages by ticket ID → then by author + time range → then by keyword. Search multiple repos
7. **If multiple repos have related commits**, record all of them — do not look at only one
8. Commands are executed manually by the developer; AI must never request or execute any non-git-query commands
9. **Prefer Obsidian CLI for knowledge base queries**: When searching historical back-testing notes or related knowledge, prefer `obsidian search query="keyword" --vault /Users/user/aladdin/aladdin`; only fall back to Grep when the CLI is unavailable
