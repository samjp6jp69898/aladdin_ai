#!/usr/bin/env bun
/**
 * Helper: 列出 pending-actions.json 中符合 filePath prefix 的 pending action。
 *
 * 用法：
 *   bun list-batch.ts <prefix1> [prefix2 ...]
 * 範例：
 *   bun list-batch.ts src/servers/agent/ src/servers/agent_app/ src/servers/agent_back_office/
 */
import * as fs from "node:fs";
import * as path from "node:path";

const PENDING = path.resolve(import.meta.dirname, "pending-actions.json");
const prefixes = process.argv.slice(2);
if (prefixes.length === 0) {
  console.error("Usage: bun list-batch.ts <prefix1> [prefix2 ...]");
  process.exit(1);
}

const raw = fs.readFileSync(PENDING, "utf-8");
const data = JSON.parse(raw);
const arr = Array.isArray(data) ? data : Object.values(data);

const matched = arr.filter(
  (a: any) =>
    (!a.status || a.status === "pending") &&
    a.type !== "uncovered" &&
    prefixes.some((p) => (a.filePath || "").startsWith(p)),
);

console.log(`# Found ${matched.length} pending action(s)\n`);
console.log(`# 註：以下 commit 為完整 40 字元 hash，可直接餵給 \`bun mark-processed.ts\`\n`);
for (const a of matched) {
  console.log(`## [${a.type}] ${a.filePath}`);
  console.log(`  commit: ${a.commitHash}`);
  console.log(`  Message: ${a.commitMessage}`);
  console.log(`  +${a.additions ?? "?"}/-${a.deletions ?? "?"}  affectedNotes=${(a.affectedNotes || []).length}`);
  if (a.newMethodHints?.length) {
    console.log(`  newMethodHints: ${a.newMethodHints.map((h: any) => h.fqn || h.method || JSON.stringify(h)).join(", ")}`);
  }
  if (a.affectedNotes?.length) {
    for (const n of a.affectedNotes) {
      console.log(`    - ${n.fqn}  ${n.path}`);
    }
  }
  console.log("");
}
