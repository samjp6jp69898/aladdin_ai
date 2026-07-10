#!/usr/bin/env bun
/**
 * collect-critical.ts — 聚合 review agent 落檔的 critical-issues 檔，產出 CRITICAL_ISSUES CSV
 *
 * 取代舊流程「manager 在對話中 hold 所有 agent 的 CRITICAL_ISSUE 文字回報，最後手寫 CSV」：
 * 事實源是 {out}/{LABEL}/_critical/*.critical.md（review agent 寫、QA agent 同步 severity），
 * 本腳本只做確定性聚合，重跑冪等（同一筆 issue 不會重複 append）。
 *
 * 用法：
 *   bun collect-critical.ts <LABEL> [--check] [--batch N] [--out-root DIR]
 *   - LABEL     例 20260702 或 20260515-20260520（review/ 下的目錄名）
 *   - --check   只回報完成度（對照 dispatch.json：哪些 author 缺報告檔/缺 critical 檔），不寫 CSV
 *   - --batch N 搭配 --check：只驗第 N 批的 agents（每批驗收用；不加 = 全量，最終閘門用）
 *   - --out-root DIR  review 根目錄（預設 /Users/user/aladdin/review；測試用）
 *
 * critical 檔格式（由 templates/review-agent.tpl.md 規定）：
 *   AUTHOR: <name>
 *   WINDOW: YYYY/MM/DD[-YYYY/MM/DD]
 *   P0 ||| <描述> ||| <位置>        （或單行 none）
 *
 * exit code：0 = 成功；1 = 有 parse 失敗或（--check 時）有未完成項，訊息在 stdout/stderr。
 */
import * as fs from "node:fs";
import * as path from "node:path";

function usage(msg?: string): never {
  if (msg) console.error(`[ERROR] ${msg}`);
  console.error("Usage: bun collect-critical.ts <LABEL> [--check] [--batch N] [--out-root DIR]");
  process.exit(2);
}

let label = "";
let checkOnly = false;
let batchFilter = 0; // 0 = 全量
let outRoot = "/Users/user/aladdin/review";
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const t = argv[i];
  if (t === "--check") checkOnly = true;
  else if (t === "--batch") { batchFilter = parseInt(argv[++i] ?? "", 10); if (!Number.isInteger(batchFilter) || batchFilter < 1) usage("--batch needs a positive integer"); }
  else if (t === "--out-root") outRoot = argv[++i] ?? usage("--out-root needs a value");
  else if (!t.startsWith("--") && !label) label = t;
  else usage(`unknown argument: ${t}`);
}
if (!label) usage("LABEL is required");
if (batchFilter && !checkOnly) usage("--batch only works with --check");
const dir = `${outRoot}/${label}`;
const critDir = `${dir}/_critical`;
if (!fs.existsSync(dir)) usage(`review directory not found: ${dir}`);

// ---------- --check：對照 dispatch.json 回報完成度 ----------
if (checkOnly) {
  const dispatchFile = `${dir}/_dispatch/dispatch.json`;
  if (!fs.existsSync(dispatchFile)) usage(`--check needs ${dispatchFile} (run scan-workload.ts first)`);
  const dispatch = JSON.parse(fs.readFileSync(dispatchFile, "utf8"));
  // --batch N 只驗該批（每批驗收）；不加 = 全量（Step 3 前的最終閘門）。
  // 沒有 --batch 時把「尚未輪到的批次」也列出會誤導 manager 提前派工（審查 BLOCKER-1），所以每批驗收必須帶 --batch。
  let agentsToCheck = dispatch.agents;
  let scope = "ALL";
  if (batchFilter) {
    const b = (dispatch.batches ?? []).find((x: any) => x.batch === batchFilter);
    if (!b) usage(`batch ${batchFilter} not found in dispatch.json (batches: 1..${(dispatch.batches ?? []).length})`);
    agentsToCheck = dispatch.agents.filter((a: any) => b.agent_ids.includes(a.id));
    scope = `batch ${batchFilter}`;
  }
  let pending = 0;
  console.log(`AGENT  AUTHOR                REPORT  CRITICAL`);
  for (const ag of agentsToCheck) {
    for (const a of ag.authors) {
      const r = fs.existsSync(a.report_file);
      const c = fs.existsSync(a.critical_file);
      if (!r || !c) pending++;
      console.log(`${String(ag.id).padEnd(6)} ${String(a.name).padEnd(21)} ${r ? "ok" : "MISSING"}${" ".repeat(r ? 6 : 1)}${c ? "ok" : "MISSING"}`);
    }
  }
  console.log(pending === 0 ? `[CHECK] ${scope}: all done` : `[CHECK] ${scope}: ${pending} author(s) incomplete`);
  process.exit(pending === 0 ? 0 : 1);
}

// ---------- 聚合 _critical/*.critical.md → CSV ----------
if (!fs.existsSync(critDir)) usage(`critical directory not found: ${critDir} (review agents not dispatched yet?)`);

const esc = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
interface Row { desc: string; loc: string; author: string; date: string }
const rows: Row[] = [];
const parseErrors: string[] = [];
const files = fs.readdirSync(critDir).filter((f) => f.endsWith(".critical.md")).sort();
if (files.length === 0) console.error(`[WARN] no *.critical.md files in ${critDir}`);

for (const f of files) {
  const full = `${critDir}/${f}`;
  const lines = fs.readFileSync(full, "utf8").split("\n");
  let author = "", window = "";
  let sawIssueOrNone = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("AUTHOR:")) { author = line.slice(7).trim(); continue; }
    if (line.startsWith("WINDOW:")) { window = line.slice(7).trim(); continue; }
    if (line.toLowerCase() === "none") { sawIssueOrNone = true; continue; } // 大小寫寬容（審查 MINOR-2）
    const m = line.match(/^(P0|P1)\s*\|\|\|\s*(.+?)\s*\|\|\|\s*(.+)$/);
    if (m) {
      sawIssueOrNone = true;
      if (!author || !window) { parseErrors.push(`${f}: issue line before AUTHOR/WINDOW header`); continue; }
      rows.push({ desc: m[2], loc: m[3], author, date: window });
    } else {
      parseErrors.push(`${f}: unparseable line: ${line.slice(0, 80)}`);
    }
  }
  if (!author || !window) parseErrors.push(`${f}: missing AUTHOR/WINDOW header`);
  else if (!sawIssueOrNone) parseErrors.push(`${f}: no issue lines and no 'none'`);
}

// 冪等 append：讀既有 CSV 的資料行做去重。
// 設計決策（審查 MINOR-1）：去重鍵不含 severity——同 author、desc 與 loc 逐字相同的兩行視為同一 issue
// （CSV 本就無 Severity 欄，P0/P1 以收錄門檻隱含）。要改這點需在 CSV 加 Severity 欄，屬紅區語意變更，先問使用者。
const csvFile = `${dir}/CRITICAL_ISSUES_${label}.csv`;
const HEADER = "問題描述,程式碼位置（檔案＋行數）,Author,Date";
const existing = new Set<string>();
let hasFile = fs.existsSync(csvFile);
if (hasFile) for (const line of fs.readFileSync(csvFile, "utf8").split("\n")) if (line.trim() && line !== HEADER) existing.add(line.trim());

const newLines: string[] = [];
let dup = 0;
for (const r of rows) {
  const line = [esc(r.desc), esc(r.loc), esc(r.author), esc(r.date)].join(",");
  if (existing.has(line)) { dup++; continue; }
  existing.add(line);
  newLines.push(line);
}
if (!hasFile) fs.writeFileSync(csvFile, HEADER + "\n" + newLines.map((l) => l + "\n").join(""));
else if (newLines.length) fs.appendFileSync(csvFile, newLines.map((l) => l + "\n").join(""));

console.log(`[CSV] ${csvFile}`);
console.log(`[STATS] critical files: ${files.length} | issues found: ${rows.length} | appended: ${newLines.length} | duplicates skipped: ${dup}`);
if (parseErrors.length) {
  console.error(`[PARSE_ERRORS] ${parseErrors.length} — 請人工檢查下列檔案（格式規定見 templates/review-agent.tpl.md 第 6 步）：`);
  for (const e of parseErrors) console.error(`  - ${e}`);
  process.exit(1);
}
