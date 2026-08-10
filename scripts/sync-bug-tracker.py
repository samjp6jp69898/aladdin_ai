#!/usr/bin/env python3
"""
Sync /analyze-bugs-v3 tracker status from Notion AI分析 field.

Use when another machine has run /analyze-bugs-v3 and this machine's local
tracker memory is out of date. For every row in the tracker whose status is not
`done`, the script:

  1. Extracts the Notion page id from the tracker row.
  2. Queries the Notion page to read the `AI分析` select property.
  3. Cross-checks that the local folder obsidian/Debug/FAQ-<id> contains the
     expected analysis artefact (FAQ-<id>-solution.md).
  4. Updates the tracker in place:
        AI分析 = 分析成功  AND solution.md exists  -> status=done
        AI分析 = 分析失敗                              -> status=failed
        otherwise                                       -> unchanged
     The completion time uses the Notion last_edited_time converted to
     Asia/Taipei (YYYYMMDD HHMM).

Usage:
    python3 sync-bug-tracker.py              # sync every non-done row
    python3 sync-bug-tracker.py --dry-run    # show planned changes only
    python3 sync-bug-tracker.py --only-local # only check rows whose local folder exists

Environment:
    ALD_NOTION_TOKEN overrides the bundled token if set.
"""

from __future__ import annotations

import argparse
import os
import re
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib import error, request

TRACKER_PATH = Path(
    "/Users/user/.claude/projects/-Users-user-aladdin/memory/bug_analysis_tracker.md"
)
DEBUG_DIR = Path("/Users/user/aladdin/obsidian/Debug")
def _load_notion_token() -> str:
    # token 單一來源：環境變數 > /Users/user/aladdin/.env（禁止把明文寫回程式碼）
    tok = os.environ.get("ALD_NOTION_TOKEN", "")
    if not tok:
        try:
            with open("/Users/user/aladdin/.env") as _f:
                for _line in _f:
                    if _line.startswith("ALD_NOTION_TOKEN="):
                        tok = _line.split("=", 1)[1].strip().strip("\"'")
                        break
        except OSError:
            pass
    if not tok.startswith("ntn_"):
        raise SystemExit("ERROR: ALD_NOTION_TOKEN 未設定（請在 /Users/user/aladdin/.env 加 ALD_NOTION_TOKEN=ntn_xxx）")
    return tok


NOTION_TOKEN = _load_notion_token()
NOTION_API = "https://api.notion.com/v1"
NOTION_VERSION = "2025-09-03"
TAIPEI = timezone(timedelta(hours=8))

ROW_RE = re.compile(
    r"^\|\s*(FAQ-\d+)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([a-z_]+)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|\s*$"
)
HEX32_RE = re.compile(r"[0-9a-f]{32}")


def extract_page_id(url: str) -> str | None:
    matches = HEX32_RE.findall(url.replace("-", ""))
    if not matches:
        return None
    raw = matches[-1]
    return f"{raw[0:8]}-{raw[8:12]}-{raw[12:16]}-{raw[16:20]}-{raw[20:32]}"


def fetch_page(page_id: str) -> dict:
    req = request.Request(
        f"{NOTION_API}/pages/{page_id}",
        headers={
            "Authorization": f"Bearer {NOTION_TOKEN}",
            "Notion-Version": NOTION_VERSION,
            "Content-Type": "application/json",
        },
    )
    with request.urlopen(req, timeout=20) as resp:
        import json

        return json.loads(resp.read().decode("utf-8"))


def to_taipei(iso_ts: str) -> str:
    dt = datetime.fromisoformat(iso_ts.replace("Z", "+00:00")).astimezone(TAIPEI)
    return dt.strftime("%Y%m%d %H%M")


def has_solution(ticket: str) -> bool:
    return (DEBUG_DIR / ticket / f"{ticket}-solution.md").exists()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true", help="不寫入，僅顯示差異")
    parser.add_argument(
        "--only-local",
        action="store_true",
        help="只檢查本地已有分析資料夾的單號 (省 API 呼叫)",
    )
    parser.add_argument(
        "--sleep",
        type=float,
        default=0.2,
        help="Notion API 請求間隔秒數 (default 0.2)",
    )
    args = parser.parse_args()

    if not TRACKER_PATH.exists():
        print(f"ERROR: tracker not found: {TRACKER_PATH}", file=sys.stderr)
        return 2

    lines = TRACKER_PATH.read_text(encoding="utf-8").splitlines()

    changes: list[tuple[int, str, str, str, str]] = []  # idx, ticket, old, new, reason
    checked = 0
    skipped = 0

    for idx, line in enumerate(lines):
        m = ROW_RE.match(line)
        if not m:
            continue
        ticket, url, severity, status, added, completed = m.groups()
        if status == "done":
            continue

        if args.only_local and not (DEBUG_DIR / ticket).exists():
            skipped += 1
            continue

        page_id = extract_page_id(url)
        if not page_id:
            print(f"[skip] {ticket}: cannot extract page id from {url}")
            skipped += 1
            continue

        try:
            data = fetch_page(page_id)
        except error.HTTPError as e:
            print(f"[err ] {ticket}: HTTP {e.code} {e.reason}")
            skipped += 1
            time.sleep(args.sleep)
            continue
        except Exception as e:  # noqa: BLE001
            print(f"[err ] {ticket}: {e}")
            skipped += 1
            time.sleep(args.sleep)
            continue
        checked += 1

        props = data.get("properties", {})
        ai_prop = props.get("AI分析", {}).get("select") or {}
        ai_name = ai_prop.get("name") or ""
        last_edited = data.get("last_edited_time") or ""

        new_status = None
        reason = ai_name or "(empty)"
        if ai_name == "分析成功":
            if has_solution(ticket):
                new_status = "done"
            else:
                reason = "分析成功 但缺 solution.md"
        elif ai_name == "分析失敗":
            new_status = "failed"

        if new_status and new_status != status:
            completion = to_taipei(last_edited) if last_edited and new_status == "done" else completed
            new_line = (
                f"| {ticket} | {url.strip()} | {severity.strip()} | {new_status} "
                f"| {added.strip()} | {completion.strip()} |"
            )
            changes.append((idx, ticket, status, new_status, reason))
            if not args.dry_run:
                lines[idx] = new_line
            print(f"[{'DRY' if args.dry_run else 'UPD'}] {ticket}: {status} -> {new_status} ({reason})")
        else:
            print(f"[----] {ticket}: keep {status} (AI分析={reason})")

        time.sleep(args.sleep)

    if changes and not args.dry_run:
        TRACKER_PATH.write_text("\n".join(lines) + "\n", encoding="utf-8")

    print()
    print(f"checked={checked} skipped={skipped} updated={len(changes)} dry_run={args.dry_run}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
