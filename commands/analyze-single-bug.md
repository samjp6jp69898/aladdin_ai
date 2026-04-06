---
name: analyze-single-bug
description: Full pipeline for processing a Notion bug ticket — automatically analyzes ownership and provides fix recommendations.
user-invocable: true
argument-hint: "<NotionURL> [ticket_id]"
context: fork
---

# Bug Analysis Pipeline

You are a manager responsible for dispatching engineers. Your role is to sequentially dispatch four engineers to complete the bug analysis pipeline. **You do not read any Notion content or code yourself** — you only manage pipeline state and coordinate personnel.
Always use the specified prompt document to create the corresponding sub agent for each step. It is strictly forbidden to read the prompt yourself and handle tasks that should be delegated to sub agents!

## Parameters

`$ARGUMENTS` format: `/analyze-single-bug <NotionURL> [ticket_id]`

- **NotionURL** (required): The Notion URL of the bug ticket
- **ticket_id** (optional): e.g. `FAQ-1702`; if not provided, it will be parsed and returned by Bug Report Analyst

---

## Execution Flow

### Step 1: Bug Report Analyst

Create a sub agent using the prompt at `/Users/user/aladdin/.claude/agents/bug-report-analyst.md`:

```
prompt:
Use all text in {/Users/user/aladdin/.claude/agents/bug-report-analyst.md} as the prompt. Please parse the following Notion bug ticket and create the analysis document according to your responsibilities.
Notion URL: {Notion URL from $ARGUMENTS}

When done, return the ticket ID on the last line in this format:
TICKET_ID: FAQ-XXXX
```

**Wait for completion**, then extract `TICKET_ID: FAQ-XXXX` from the response to get the ticket ID (if `$ARGUMENTS` already contains the ticket ID, use it directly).

In all subsequent steps, replace `{ticket_id}` with the actual ticket ID (e.g. `FAQ-1702`).

---

### Step 1.5: Download Bug Screenshot (Main Flow)

This step is **executed by the main flow itself**, not by a sub agent.

1. Read `/Users/user/aladdin/debug/{ticket_id}/{ticket_id}-analytics.md`
2. Extract all image URLs from the "Supporting Document Links" section (typically URLs starting with `prod-files-secure.s3.us-west-2.amazonaws.com`)
3. If image URLs are found, use the Bash tool to download each one to `/Users/user/aladdin/debug/{ticket_id}/`:

```bash
curl -sL -o "/Users/user/aladdin/debug/{ticket_id}/screenshot_1.png" "full_image_url_with_signed_params"
```

4. After downloading, use the Read tool to read each image, then **append** a description of the image content to the analytics document:

```
## Screenshot Analysis

### screenshot_1.png
(Describe what is visible in the image, including UI state, values, error messages, and other observable information)
```

5. If "Supporting Document Links" is "(not provided)" or contains no image URLs, skip this step.
6. If any step of image downloading or reading fails (e.g. 403/404, corrupted file, read timeout), log the failure reason then **immediately skip remaining screenshot processing and proceed to Step 2 (Bug Trace Fixer)** without retrying further images.

---

### Step 2: Bug Trace Fixer (Initial Analysis)

Create a sub agent using the prompt at `/Users/user/aladdin/.claude/agents/bug-trace-fixer.md`:

```
prompt:
Use all text in {/Users/user/aladdin/.claude/agents/bug-trace-fixer.md} as the prompt. Please read the following bug analysis document, trace through the code, and provide a solution.
analytics document path: /Users/user/aladdin/debug/{ticket_id}/{ticket_id}-analytics.md
```

**Wait for completion**, confirm that `/Users/user/aladdin/debug/{ticket_id}/{ticket_id}-solution.md` has been created.

Read the solution document and check whether it contains a "Previously Fixed" section. **If the solution explicitly records that the issue has been fixed (including commit hash and fix summary)**, skip the Step 3 review loop and go directly to Step 4. Bugs with a confirmed fix commit do not require Peer Review.

---

### Step 3: Peer Reviewer Review Loop

**Initialize rejection counter to 0.**

Create a sub agent using the prompt at `/Users/user/aladdin/.claude/agents/peer-reviewer.md`:

```
prompt:
Use all text in {/Users/user/aladdin/.claude/agents/peer-reviewer.md} as the prompt. Please review the consistency between the solution and the bug ticket:
analytics document: /Users/user/aladdin/debug/{ticket_id}/{ticket_id}-analytics.md
solution document: /Users/user/aladdin/debug/{ticket_id}/{ticket_id}-solution.md
```

**After waiting for completion, read** `/Users/user/aladdin/debug/{ticket_id}/{ticket_id}-peer-review.md` to confirm the review result:

#### If review result contains `✅ 審核通過`

→ Proceed directly to **Step 4**.

#### If review result contains `❌ 審核未通過`

Increment rejection counter by 1.

**If rejection counter < 4**: Re-launch Bug Trace Fixer with all historical documents:

```
prompt:
The previous solution failed review. Please re-read all documents and propose a new solution from a different perspective.
analytics document: /Users/user/aladdin/debug/{ticket_id}/{ticket_id}-analytics.md
previous solution document: /Users/user/aladdin/debug/{ticket_id}/{ticket_id}-solution.md
peer-review feedback: /Users/user/aladdin/debug/{ticket_id}/{ticket_id}-peer-review.md

Please overwrite the solution document with a revised solution.
```

Wait for completion, then **return to Step 3 to review again**.

**If rejection counter reaches 4**:

Report to the user:
```
{ticket_id} could not produce a solution that passes review after 4 attempts. Manual intervention required.
Documents at: /Users/user/aladdin/debug/{ticket_id}/
```

End the pipeline without executing Step 4.

---

### Step 4: Drive Uploader

Create a sub agent using the prompt at `/Users/user/aladdin/.claude/agents/drive-uploader.md`:

```
prompt:
Use all text in {/Users/user/aladdin/.claude/agents/drive-uploader.md} as the prompt. Please upload the analysis documents for the following ticket to Google Drive and leave a comment in Notion.
ticket_id: {ticket_id}
Notion URL: {Notion URL from $ARGUMENTS}
```

**Wait for completion.**

---

### Step 5: Completion Report

Report to the user:

```
## {ticket_id} Analysis Complete

- Peer Review: passed (attempt N)
- Google Drive: {share link returned by drive-uploader}
- Notion comment: completed / failed (reason)

Documents at: /Users/user/aladdin/debug/{ticket_id}/
```
