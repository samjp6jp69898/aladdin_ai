#!/usr/bin/env bun
/**
 * Helper: 批次將 note 的 frontmatter `last_scanned` 欄位 bump 到指定日期（預設今天）。
 *
 * 用法：
 *   bun bump-last-scanned.ts <note1.md> [note2.md] ...
 *   bun bump-last-scanned.ts --date=2026-05-14 <note1.md> ...
 *   echo -e "/path/to/note1.md\n/path/to/note2.md" | bun bump-last-scanned.ts --stdin
 *
 * 規則：
 *   - 跳過 frontmatter 含 `human_edited: true` 的筆記
 *   - 若 last_scanned 已為目標日期則不寫入（冪等）
 *   - 報表：bumped / skipped(human_edited) / skipped(same_date) / errors
 */
import * as fs from "node:fs";

const today = new Date().toISOString().slice(0, 10);
let targetDate = today;
const paths: string[] = [];
let stdinMode = false;

for (const arg of process.argv.slice(2)) {
    if (arg.startsWith("--date=")) targetDate = arg.slice("--date=".length);
    else if (arg === "--stdin") stdinMode = true;
    else paths.push(arg);
}

if (stdinMode) {
    const stdin = fs.readFileSync(0, "utf-8");
    for (const line of stdin.split("\n")) {
        const t = line.trim();
        if (t) paths.push(t);
    }
}

if (paths.length === 0) {
    console.error("Usage: bun bump-last-scanned.ts [--date=YYYY-MM-DD] <note.md> [...]");
    console.error("       cat list.txt | bun bump-last-scanned.ts --stdin");
    process.exit(1);
}

let bumped = 0;
let skippedHuman = 0;
let skippedSame = 0;
let errors: string[] = [];

for (const p of paths) {
    try {
        if (!fs.existsSync(p)) {
            errors.push(`NOT_FOUND: ${p}`);
            continue;
        }
        const content = fs.readFileSync(p, "utf-8");
        const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
        if (!fmMatch) {
            errors.push(`NO_FRONTMATTER: ${p}`);
            continue;
        }
        const fm = fmMatch[1];
        if (/^human_edited:\s*true/m.test(fm)) {
            skippedHuman++;
            continue;
        }
        if (new RegExp(`^last_scanned:\\s*${targetDate}\\s*$`, "m").test(fm)) {
            skippedSame++;
            continue;
        }
        let newContent: string;
        if (/^last_scanned:/m.test(fm)) {
            newContent = content.replace(
                /^last_scanned:.*$/m,
                `last_scanned: ${targetDate}`,
            );
        } else {
            const newFm = `${fm}\nlast_scanned: ${targetDate}`;
            newContent = content.replace(fmMatch[0], `---\n${newFm}\n---`);
        }
        fs.writeFileSync(p, newContent);
        bumped++;
    } catch (e: any) {
        errors.push(`ERROR(${e.message}): ${p}`);
    }
}

console.log(`Bumped:        ${bumped}`);
console.log(`Skipped human: ${skippedHuman}`);
console.log(`Skipped same:  ${skippedSame}`);
if (errors.length > 0) {
    console.log(`Errors:        ${errors.length}`);
    for (const e of errors.slice(0, 20)) console.log(`  ${e}`);
    if (errors.length > 20) console.log(`  ... and ${errors.length - 20} more`);
}
