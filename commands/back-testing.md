---
name: back-testing
description: Bug analysis back-testing pipeline manager — dispatches three stage agents to find the fix commit, independently analyze it, and compare against prior analysis.
user-invocable: true
argument-hint: "<NotionURL> [git author name] [git author name]"
context: fork
---

# Bug Analysis Back-Testing Pipeline

You are a pipeline manager. Your role is to sequentially dispatch three stage agents to complete the back-testing pipeline. **You do not read any Notion content, git logs, or source code yourself** — you only manage pipeline state and coordinate agents.

Always use the specified prompt document to create the corresponding sub agent. Never read the prompt yourself and handle tasks that should be delegated to sub agents.

## Parameters

`$ARGUMENTS` format: `/back-testing <NotionURL> [git author name] [git author name]`

- **NotionURL** (required): The Notion URL of the bug ticket
- **git author names** (optional): One or more git commit author names to narrow the git log search

---

## Execution Flow

### Step 0: Parse Arguments & Setup

Extract from `$ARGUMENTS`:
- **NotionURL**: the first URL-like argument (starts with `https://`)
- **git author names**: all remaining arguments after the URL

Derive a temporary directory name from the URL:
- Find the 32-character hex string at the end of the URL (after the last `-` or `/`)
- Take the first 8 characters as `first8chars`

Create the staging directory:

```bash
mkdir -p /Users/user/aladdin/obsidian/Debug/backtest-staging/temp-{first8chars}
```

---

### Step 1: Dispatch Stage 1 — Ticket Info Collector

Create a sub agent using the prompt at `/Users/user/aladdin/obsidian/agents/backtest-ticket-collector.md`:

```
Read all text in /Users/user/aladdin/obsidian/agents/backtest-ticket-collector.md as your instructions.

Parameters:
- NotionURL: {NotionURL}
- git_author: {git_author_names or "none"}
- staging_dir: /Users/user/aladdin/obsidian/Debug/backtest-staging/temp-{first8chars}
```

**Wait for completion.** Extract the ticket_id from the agent's final output line:
`STAGE1_COMPLETE: FAQ-XXXX`

Then rename the staging directory to use the real ticket ID:

```bash
mv /Users/user/aladdin/obsidian/Debug/backtest-staging/temp-{first8chars} /Users/user/aladdin/obsidian/Debug/backtest-staging/{ticket_id}
```

Verify that `stage1-ticket-info.md` exists in the staging directory:

```bash
ls /Users/user/aladdin/obsidian/Debug/backtest-staging/{ticket_id}/stage1-ticket-info.md
```

**If Stage 1 failed** (no STAGE1_COMPLETE signal, or stage1-ticket-info.md missing): report the error and stop. Leave the staging directory intact for debugging.

Report: `✓ Stage 1 complete — {ticket_id} ticket info collected`

---

### Step 1.5: 注入 FIX-AUTHORITY IRON LAW 至 staging

把共用鐵律檔複製進 staging,供 Stage 2(commit-analyzer)在其既有允許路徑內讀取(防汙染防火牆 bright-line 不破 —— staging 本就是其允許範圍):

```bash
cp /Users/user/aladdin/.claude/agents/_shared/fix-authority-ironlaw.md /Users/user/aladdin/obsidian/Debug/backtest-staging/{ticket_id}/fix-authority-ironlaw.md
ls /Users/user/aladdin/obsidian/Debug/backtest-staging/{ticket_id}/fix-authority-ironlaw.md
```

**If Step 1.5 failed** (cp failed or source file `/Users/user/aladdin/.claude/agents/_shared/fix-authority-ironlaw.md` missing): report the error and stop. Leave the staging directory intact for debugging. Stage 2 (commit-analyzer) requires this file as its fix-authority criterion and must not run without it.

---

### Step 2: Dispatch Stage 2 — Commit Finder & Independent Analyzer

Create a sub agent using the prompt at `/Users/user/aladdin/obsidian/agents/backtest-commit-analyzer.md`:

```
Read all text in /Users/user/aladdin/obsidian/agents/backtest-commit-analyzer.md as your instructions.

Parameters:
- staging_dir: /Users/user/aladdin/obsidian/Debug/backtest-staging/{ticket_id}
```

**Wait for completion.** Verify that `stage2-actual-fix.md` exists in the staging directory:

```bash
ls /Users/user/aladdin/obsidian/Debug/backtest-staging/{ticket_id}/stage2-actual-fix.md
```

Extract commit status from the agent's final output (`COMMIT_FOUND` or `COMMIT_NOT_FOUND`).

**If Stage 2 failed** (stage2-actual-fix.md missing): report the error and stop. Leave staging dir intact.

Report: `✓ Stage 2 complete — {ticket_id} commit {FOUND/NOT_FOUND}`

---

### Step 3: Dispatch Stage 3 — Comparator & Note Writer

Create a sub agent using the prompt at `/Users/user/aladdin/obsidian/agents/backtest-comparator.md`:

```
Read all text in /Users/user/aladdin/obsidian/agents/backtest-comparator.md as your instructions.

Parameters:
- staging_dir: /Users/user/aladdin/obsidian/Debug/backtest-staging/{ticket_id}
- ticket_id: {ticket_id}
```

**Wait for completion.** Verify that `stage3-comparison.md` exists in the staging directory:

```bash
ls /Users/user/aladdin/obsidian/Debug/backtest-staging/{ticket_id}/stage3-comparison.md
```

**If Stage 3 failed** (stage3-comparison.md missing): report the error and stop. Leave staging dir intact.

Read `stage3-comparison.md` and extract the `## Result Summary` section.

---

### Step 4: Completion Report

Read `stage3-comparison.md` to extract:
- `conclusion` (Analysis correct / Partially correct / Analysis incorrect / No prior analysis)
- `fix_commit_hash` and `fix_commit_author`
- `failure_mode` code (or N/A)
- `note_path` (path to the Obsidian back-testing note)

Report:

```
## {ticket_id} Back-Testing Complete

- **Conclusion**: {conclusion}
- **Fix Commit**: {hash} by {author}
- **Failure Mode**: {code or N/A}
- **Note**: {note_path}
- **Staging**: /Users/user/aladdin/obsidian/Debug/backtest-staging/{ticket_id}/
```

---

## Error Handling

If any stage fails:
- Report which stage failed and what the error was
- Do not proceed to subsequent stages
- Leave the staging directory intact at its current path for debugging

---

## Notes

- Do not use the Skill tool
- Do not read Notion pages, git logs, or source code directly
- Do not modify any Notion properties
- Manager's only tools: Agent dispatch, Bash (mkdir/mv/ls), Read (stage3-comparison.md result only)
