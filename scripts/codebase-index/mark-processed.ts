#!/usr/bin/env bun
/**
 * Helper: 將 pending-actions.json 中指定的 action 標記為 processed/skipped。
 *
 * 用法：
 *   bun mark-processed.ts <commitHash> <filePath> [status]
 *   status 預設為 "processed"，可選 "skipped"
 *
 * 子代理處理完一個 action 後就呼叫此腳本一次。
 */
import * as fs from "node:fs";
import * as path from "node:path";

const PENDING = path.resolve(import.meta.dirname, "pending-actions.json");

const [, , commitHashArg, filePath, status = "processed"] = process.argv;
if (!commitHashArg || !filePath) {
  console.error("Usage: bun mark-processed.ts <commitHashOrPrefix> <filePath> [status]");
  console.error("  commitHash 可傳完整 40 字元或 7 字元短前綴（自動 prefix 匹配）");
  process.exit(1);
}
if (!["processed", "skipped"].includes(status)) {
  console.error(`Invalid status: ${status}. Must be "processed" or "skipped".`);
  process.exit(1);
}

const raw = fs.readFileSync(PENDING, "utf-8");
const data = JSON.parse(raw);
const isArray = Array.isArray(data);
const entries: [string, any][] = isArray
  ? data.map((v: any, i: number) => [String(i), v])
  : Object.entries(data);

const usePrefix = commitHashArg.length < 40;
const candidateHashes = new Set<string>();
let matched = 0;
for (const [, action] of entries) {
  const hashMatch = usePrefix
    ? typeof action.commitHash === "string" && action.commitHash.startsWith(commitHashArg)
    : action.commitHash === commitHashArg;
  if (hashMatch && action.filePath === filePath) {
    candidateHashes.add(action.commitHash);
    action.status = status;
    action.processedAt = new Date().toISOString();
    matched++;
  }
}

if (matched === 0) {
  console.error(`No matching action: ${commitHashArg} ${filePath}`);
  process.exit(1);
}
if (usePrefix && candidateHashes.size > 1) {
  console.error(
    `Ambiguous prefix ${commitHashArg} matched ${candidateHashes.size} commits: ${[...candidateHashes].join(", ")}. Use full hash.`,
  );
  process.exit(1);
}

const out = isArray ? entries.map(([, v]) => v) : Object.fromEntries(entries);
fs.writeFileSync(PENDING, JSON.stringify(out, null, 2));
const shownHash = [...candidateHashes][0]?.slice(0, 7) ?? commitHashArg;
console.log(`Marked ${matched} action(s) as ${status}: ${shownHash} ${filePath}`);
