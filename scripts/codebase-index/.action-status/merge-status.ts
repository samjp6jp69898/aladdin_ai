#!/usr/bin/env bun
// Merge per-action status files into pending-actions.json
// Reads .action-status/<idx>.json files written by parallel agents
// Writes back to pending-actions.json with status + processedAt

import { readdir } from "node:fs/promises";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const PENDING = resolve(ROOT, "pending-actions.json");
const STATUS_DIR = resolve(ROOT, ".action-status");

const arr = JSON.parse(await Bun.file(PENDING).text());
const files = (await readdir(STATUS_DIR)).filter(f => /^\d+\.json$/.test(f));

const merged: Array<{ idx: number; status: string; reason?: string }> = [];
const missing: number[] = [];
const nowIso = new Date().toISOString();

for (const f of files) {
  const data = JSON.parse(await Bun.file(resolve(STATUS_DIR, f)).text());
  const idx = data.idx;
  if (typeof idx !== "number" || !arr[idx]) {
    console.error(`Invalid idx in ${f}: ${idx}`);
    continue;
  }
  arr[idx].status = data.status;
  arr[idx].processedAt = nowIso;
  if (data.reason) arr[idx].reason = data.reason;
  if (data.notesUpdated) arr[idx].notesUpdated = data.notesUpdated;
  if (data.notesCreated) arr[idx].notesCreated = data.notesCreated;
  if (data.notesSkipped) arr[idx].notesSkipped = data.notesSkipped;
  merged.push({ idx, status: data.status, reason: data.reason });
}

// Find pending entries that need AI but no status file
for (let i = 0; i < arr.length; i++) {
  const a = arr[i];
  if (a.status === "pending" && a.type !== "delete_file" && a.type !== "uncovered" && a.type !== "rename_file") {
    missing.push(i);
  }
}

await Bun.write(PENDING, JSON.stringify(arr, null, 2));

console.log(`Merged ${merged.length} action status updates.`);
console.log("\nProcessed:");
const p = merged.filter(m => m.status === "processed");
const s = merged.filter(m => m.status === "skipped");
console.log(`  processed: ${p.length}`);
console.log(`  skipped: ${s.length}`);
if (missing.length) {
  console.log(`\n⚠ Missing status (still pending, needs AI): ${missing.length}`);
  console.log(`  indices: ${missing.join(", ")}`);
}
