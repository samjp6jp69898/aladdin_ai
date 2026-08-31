#!/usr/bin/env bun
/**
 * scan-workload.ts — /daily-code-review 的掃描＋分組＋派工計畫產生器
 *
 * 把原本要 manager LLM 手工做的事全部確定性化：
 *   fetch → 掃 origin/dev −origin/pro（commit date 窗口）→ author email 消歧
 *   → 工作量統計 → 分組/合併 → model 指派 → 產 dispatch.json 與逐 agent prompt 檔
 *
 * 用法：
 *   bun scan-workload.ts [YYYYMMDD] [YYYYMMDD] [N] [--no-fetch] [--skip-existing] [--out-root DIR]
 *   - 0 個日期 = 台北時區的昨天；1 個 = 單日；2 個 = 閉區間（自動排序）
 *   - 非 8 位數的數字 = 每批併發 agent 數（預設 5）
 *   - --no-fetch      跳過 git fetch（重跑/測試用）
 *   - --skip-existing 略過「最新一代報告＋critical 檔配對俱全」的 author（中斷後接續用；預設行為是 _rK 重審）
 *   - --out-root DIR  輸出根目錄（預設 /Users/user/aladdin/review；測試時指向暫存目錄）
 *
 * 子指令（唯讀稽核，純 stdout、不寫任何檔）：
 *   bun scan-workload.ts coverage-audit [YYYYMMDD-start] [YYYYMMDD-end] [--out-root DIR] [--no-fetch]
 *     列出窗口內「未被任何 review 目錄涵蓋、但當日 origin/dev 有 commit」的漏批日（含各 repo commit 數）。
 *     start 預設＝最早的 review 目錄日期（無則 20260311）；end 預設＝台北昨天。用於常態偵測排程漏批。
 *
 * stdout 只印簡短摘要（供 manager 直接讀）；完整派工計畫在 {out}/{LABEL}/_dispatch/dispatch.json。
 * 掃不到任何 commit 時印 [DONE] ... 並 exit 0。參數錯誤 exit 2；模板佔位符殘留 exit 3。
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = "/Users/user/aladdin";
const SKILL_DIR = `${ROOT}/aladdin_ai/skills/daily-code-review`;
const REPOS = ["agrabah", "abu", "lago", "rajah"] as const;
const DIM_DIR = `${SKILL_DIR}/dimensions`;
const DIMENSIONS: Record<string, string[]> = {
  "Backend": ["dim-a-architecture.md", "dim-b-database.md", "dim-c-typescript.md", "dim-d-security.md", "dim-e-rajah.md", "dim-g-performance.md"],
  "Frontend": ["dim-a-architecture.md", "dim-c-typescript.md", "dim-d-security.md", "dim-e-rajah.md", "dim-f-frontend.md"],
  "Cross-domain": ["dim-a-architecture.md", "dim-b-database.md", "dim-c-typescript.md", "dim-d-security.md", "dim-e-rajah.md", "dim-f-frontend.md", "dim-g-performance.md"],
};

function usage(msg?: string): never {
  if (msg) console.error(`[ERROR] ${msg}`);
  console.error("Usage: bun scan-workload.ts [YYYYMMDD] [YYYYMMDD] [concurrent] [--no-fetch] [--skip-existing] [--out-root DIR]");
  process.exit(2);
}

// ---------- 參數解析（token shape 分類，與 command 檔規則一致） ----------
const argvRaw = process.argv.slice(2);

// ---------- 子指令：coverage-audit（唯讀，純 stdout，無副作用；常態偵測排程漏批） ----------
if (argvRaw[0] === "coverage-audit") { runCoverageAudit(argvRaw.slice(1)); process.exit(0); }

function runCoverageAudit(rest: string[]): void {
  let start = "", end = "", auditRoot = `${ROOT}/review`, doFetch = true;
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i];
    if (t === "--out-root") auditRoot = rest[++i] ?? usage("coverage-audit: --out-root needs a value");
    else if (t === "--no-fetch") doFetch = false;
    else if (/^\d{8}$/.test(t)) { if (!start) start = t; else if (!end) end = t; else usage("coverage-audit: at most 2 dates"); }
    else usage(`coverage-audit: unknown argument: ${t}`);
  }
  const dash = (d: string) => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
  const toYmd = (dt: Date) => { const p = (n: number) => String(n).padStart(2, "0"); return `${dt.getUTCFullYear()}${p(dt.getUTCMonth() + 1)}${p(dt.getUTCDate())}`; };
  if (!end) {
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei" }).format(new Date());
    const [y, m, d] = today.split("-").map(Number);
    end = toYmd(new Date(Date.UTC(y, m - 1, d) - 86_400_000)); // 台北昨天
  }
  // 已覆蓋日期集合＝展開所有 review 目錄名中的 8 位日期 token（單日與範圍目錄都收）
  const covered = new Set<string>();
  let earliest = "99999999";
  if (fs.existsSync(auditRoot)) {
    for (const entry of fs.readdirSync(auditRoot)) {
      const toks = entry.match(/20\d{6}/g);
      if (toks) for (const tk of toks) { covered.add(tk); if (tk < earliest) earliest = tk; }
    }
  }
  if (!start) start = earliest === "99999999" ? "20260311" : earliest;
  if (start > end) usage(`coverage-audit: start ${start} > end ${end}`);
  // fetch（可 --no-fetch 跳過）＋確認 origin/dev
  const repos: string[] = [];
  for (const r of REPOS) {
    const dir = `${ROOT}/${r}`;
    if (!fs.existsSync(`${dir}/.git`)) continue;
    if (doFetch) { try { execFileSync("git", ["-C", dir, "fetch", "--quiet", "--prune", "origin"], { stdio: ["ignore", "pipe", "pipe"], timeout: 180_000 }); } catch { /* 離線容忍，用本地 origin/dev */ } }
    try { execFileSync("git", ["-C", dir, "rev-parse", "--verify", "--quiet", "origin/dev"], { stdio: ["ignore", "pipe", "pipe"] }); repos.push(r); } catch { /* 無 origin/dev 略過該 repo */ }
  }
  // 每 repo 每日 non-merge、非版號 bump commit 數（proxy：不回溯當時 origin/pro 可達性，為上限估計）
  const bump = /^(v ?\d+\.\d+\.\d+|version|bump)/i;
  const perDate = new Map<string, Map<string, number>>(); // YYYYMMDD -> repo -> count
  for (const r of repos) {
    const out = execFileSync("git", ["-C", `${ROOT}/${r}`, "log", "origin/dev", "--no-merges",
      `--after=${dash(start)} 00:00:00`, `--before=${dash(end)} 23:59:59`,
      "--date=short", "--format=%ad%x00%s"], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, env: { ...process.env, TZ: "Asia/Taipei" } });
    for (const line of out.split("\n")) {
      if (!line) continue;
      const [ad, subj] = line.split("\0");
      if (bump.test(subj ?? "")) continue;
      const key = ad.replace(/-/g, "");
      if (!perDate.has(key)) perDate.set(key, new Map());
      const m = perDate.get(key)!;
      m.set(r, (m.get(r) ?? 0) + 1);
    }
  }
  // 列舉日曆，找「未覆蓋且當日有 commit」的缺口日
  const dow = ["日", "一", "二", "三", "四", "五", "六"];
  const s = Date.UTC(+start.slice(0, 4), +start.slice(4, 6) - 1, +start.slice(6, 8));
  const e = Date.UTC(+end.slice(0, 4), +end.slice(4, 6) - 1, +end.slice(6, 8));
  let gapDays = 0, gapTotal = 0, allTotal = 0;
  const rows: string[] = [];
  for (let t = s; t <= e; t += 86_400_000) {
    const dt = new Date(t);
    const key = toYmd(dt);
    const m = perDate.get(key);
    const dayTotal = m ? [...m.values()].reduce((a, b) => a + b, 0) : 0;
    allTotal += dayTotal;
    if (covered.has(key) || dayTotal === 0) continue;
    gapDays++; gapTotal += dayTotal;
    const detail = m ? [...m.entries()].map(([r, c]) => `${r}:${c}`).join(" ") : "";
    rows.push(`${key} (${dow[dt.getUTCDay()]})  ${String(dayTotal).padStart(4)}  ${detail}`);
  }
  console.log(`[COVERAGE-AUDIT] window=${dash(start)}..${dash(end)} repos=${repos.join(",") || "(none)"} out-root=${auditRoot}`);
  console.log(`[COVERED] ${covered.size} 個 review 目錄日期已覆蓋`);
  console.log(`[PROXY] 計數＝origin/dev 該日 non-merge、非版號 commit（未回溯當時 origin/pro 可達性，為上限估計）`);
  if (rows.length === 0) { console.log(`[RESULT] 無缺口：${dash(start)}..${dash(end)} 每個有 commit 的日子都有 review 覆蓋。`); return; }
  console.log(`[GAPS] ${gapDays} 天未覆蓋且有 commit；缺口 commit ${gapTotal}/${allTotal} ≈ ${allTotal ? (gapTotal / allTotal * 100).toFixed(1) : "0.0"}%`);
  console.log(`日期       週   commit  各repo`);
  for (const r of rows) console.log(r);
}

let dates: string[] = [];
let concurrent = 5;
let noFetch = false;
let skipExisting = false;
let outRoot = `${ROOT}/review`;
for (let i = 0; i < argvRaw.length; i++) {
  const t = argvRaw[i];
  if (t === "--no-fetch") noFetch = true;
  else if (t === "--skip-existing") skipExisting = true;
  else if (t === "--out-root") { outRoot = argvRaw[++i] ?? usage("--out-root needs a value"); }
  else if (/^\d{8}$/.test(t)) dates.push(t);
  else if (/^\d+$/.test(t)) concurrent = parseInt(t, 10);
  else usage(`unknown argument: ${t}`);
}
if (dates.length > 2) usage("at most 2 dates");
if (concurrent < 1) usage("concurrent must be >= 1");

function taipeiYesterday(): string {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei" }).format(new Date()); // YYYY-MM-DD
  const [y, m, d] = today.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d) - 86_400_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${t.getUTCFullYear()}${p(t.getUTCMonth() + 1)}${p(t.getUTCDate())}`;
}
if (dates.length === 0) dates = [taipeiYesterday()];
dates.sort();
const DATE_START = dates[0];
const DATE_END = dates[dates.length - 1];
const fmtDash = (d: string) => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
const fmtSlash = (d: string) => `${d.slice(0, 4)}/${d.slice(4, 6)}/${d.slice(6, 8)}`;
const LABEL = DATE_START === DATE_END ? DATE_START : `${DATE_START}-${DATE_END}`;
const CSV_DATE = DATE_START === DATE_END ? fmtSlash(DATE_START) : `${fmtSlash(DATE_START)}-${fmtSlash(DATE_END)}`;

// ---------- Step 1: fetch（失敗的 repo 記錄後跳過，不中斷） ----------
const skippedRepos: string[] = [];
const activeRepos: string[] = [];
for (const r of REPOS) {
  const dir = `${ROOT}/${r}`;
  if (!fs.existsSync(`${dir}/.git`)) { skippedRepos.push(`${r}(missing repo)`); continue; }
  if (!noFetch) {
    try {
      execFileSync("git", ["-C", dir, "fetch", "--quiet", "--prune", "origin"], { stdio: ["ignore", "pipe", "pipe"], timeout: 180_000 });
    } catch {
      skippedRepos.push(`${r}(fetch failed)`);
      continue;
    }
  }
  try {
    execFileSync("git", ["-C", dir, "rev-parse", "--verify", "--quiet", "origin/dev"], { stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    skippedRepos.push(`${r}(no origin/dev)`);
    continue;
  }
  activeRepos.push(r);
}

// ---------- Step 2: 掃描（NUL 分隔避免 commit subject 含 | 的切割錯誤） ----------
interface CommitRec { repo: string; ct: number; an: string; ae: string; sha: string; lines: number }
const commits: CommitRec[] = [];
const repoCommitCount: Record<string, number> = {};
for (const r of activeRepos) {
  const out = execFileSync("git", [
    "-C", `${ROOT}/${r}`, "log",
    "--format=COMMIT_START%x00%ct%x00%an%x00%ae%x00%H",
    "--numstat",
    `--after=${fmtDash(DATE_START)} 00:00:00`,
    `--before=${fmtDash(DATE_END)} 23:59:59`,
    "origin/dev", "--not", "origin/pro",
  ], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, env: { ...process.env, TZ: "Asia/Taipei" } }); // 窗界與 label 同用台北時區（審查 MINOR-5）
  let cur: CommitRec | null = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("COMMIT_START\0")) {
      const p = line.split("\0"); // [marker, ct, an, ae, sha]
      cur = { repo: r, ct: Number(p[1]), an: p[2], ae: p[3].toLowerCase(), sha: p[4], lines: 0 };
      commits.push(cur);
      repoCommitCount[r] = (repoCommitCount[r] ?? 0) + 1;
    } else if (cur && /^\d+\t\d+\t/.test(line)) {
      const [a, d] = line.split("\t");
      cur.lines += Number(a) + Number(d); // 二進位檔行是 "-\t-\t..."，不匹配此 regex，自動略過
    }
  }
}
if (commits.length === 0) {
  console.log(`[DONE] ${LABEL} no commits in the date window to review.${skippedRepos.length ? ` (skipped repos: ${skippedRepos.join(", ")})` : ""}`);
  process.exit(0);
}

// ---------- Step 2.1: email 消歧（單一來源 author-identities.json） ----------
const ident = JSON.parse(fs.readFileSync(`${SKILL_DIR}/author-identities.json`, "utf8"));
const emailAlias = new Map<string, string>();
for (const g of ident.merge_emails ?? []) {
  const canon = String(g.emails[0]).toLowerCase();
  for (const e of g.emails) emailAlias.set(String(e).toLowerCase(), canon);
}
const canonEmail = (e: string) => emailAlias.get(e) ?? e;

interface Author {
  email: string; name: string; nameCt: number;
  repos: Map<string, string[]>; // repo -> SHA list（git log 輸出序：新→舊）
  commitCount: number; lines: number;
  aliases: Set<string>;
  group?: string; reportBase?: string;
}
const authors = new Map<string, Author>();
for (const c of commits) {
  const key = canonEmail(c.ae);
  let a = authors.get(key);
  if (!a) { a = { email: key, name: c.an, nameCt: c.ct, repos: new Map(), commitCount: 0, lines: 0, aliases: new Set() }; authors.set(key, a); }
  if (c.ct >= a.nameCt) { a.name = c.an; a.nameCt = c.ct; } // canonical 顯示名 = 最近一次 commit 的 %an
  a.aliases.add(c.an);
  if (!a.repos.has(c.repo)) a.repos.set(c.repo, []);
  a.repos.get(c.repo)!.push(c.sha);
  a.commitCount += 1;
  a.lines += c.lines;
}

// ---------- Step 3a: repo type 分組 ----------
for (const a of authors.values()) {
  const be = a.repos.has("agrabah");
  const fe = a.repos.has("abu") || a.repos.has("lago");
  a.group = be && fe ? "Cross-domain" : fe ? "Frontend" : "Backend"; // rajah-only 歸 Backend
}

// ---------- Step 4 前置: 報告檔名（sanitize → 同名碰撞消解 → 既存檔處理） ----------
const outDir = `${outRoot}/${LABEL}`;
const sanitize = (s: string) => s.replace(/[\/\\:*?"<>|\s]+/g, "_").replace(/^_+|_+$/g, "") || "unknown";
const byName = new Map<string, Author[]>();
for (const a of [...authors.values()].sort((x, y) => x.email.localeCompare(y.email))) {
  const n = sanitize(a.name);
  if (!byName.has(n)) byName.set(n, []);
  byName.get(n)!.push(a);
}
const skippedAuthors: string[] = [];
for (const [n, list] of byName) {
  list.forEach((a, i) => {
    let base = `${n}_${LABEL}`;
    if (list.length > 1 && i > 0) base = `${n}.${a.email.split("@")[0]}_${LABEL}`; // 極罕見：不同 email 同 sanitized 名
    // 「完成」= 最新一代（base、base_r2、base_r3…中最大代）的報告 + critical 檔配對俱全。
    // 只看原始 base 會讓 crash-recovery 後在 _rK 完成的 author 被每次 --skip-existing 重複改派、永不收斂（復核 finding）；
    // 只有報告沒 critical（agent 在兩次 Write 之間中斷）視為未完成，不得跳過，走下一代重審（審查 MAJOR-3）。
    let latest = base;
    let k = 2;
    while (fs.existsSync(`${outDir}/${base}_r${k}.md`)) { latest = `${base}_r${k}`; k++; }
    if (fs.existsSync(`${outDir}/${latest}.md`)) {
      if (skipExisting && fs.existsSync(`${outDir}/_critical/${latest}.critical.md`)) {
        skippedAuthors.push(`${a.name} <${a.email}>`); authors.delete(a.email); return;
      }
      base = `${base}_r${k}`; // k 是第一個空缺代
    }
    a.reportBase = base;
  });
}
if (authors.size === 0) {
  console.log(`[DONE] ${LABEL} all ${skippedAuthors.length} author(s) already have reports (--skip-existing). Nothing to dispatch.`);
  process.exit(0);
}

// ---------- Step 3b/3c: 工作量合併 + model 指派 ----------
interface AgentPlan { id: number; model: "opus" | "sonnet"; group: string; authors: Author[]; promptFile?: string }
const isIndependent = (a: Author) => a.commitCount >= 5 || a.lines >= 200;
const agents: AgentPlan[] = [];
for (const g of ["Backend", "Frontend", "Cross-domain"]) {
  const members = [...authors.values()].filter((a) => a.group === g).sort((x, y) => y.lines - x.lines);
  for (const a of members.filter(isIndependent)) agents.push({ id: 0, model: "opus", group: g, authors: [a] });
  let bucket: Author[] = [], bc = 0, bl = 0;
  const flush = () => {
    if (!bucket.length) return;
    agents.push({ id: 0, model: bc >= 8 || bl >= 300 ? "opus" : "sonnet", group: g, authors: bucket });
    bucket = []; bc = 0; bl = 0;
  };
  for (const a of members.filter((a) => !isIndependent(a))) {
    if (bucket.length && (bc + a.commitCount > 12 || bl + a.lines > 500)) flush(); // 預判：加入會超標就先開新組
    bucket.push(a); bc += a.commitCount; bl += a.lines;
  }
  flush();
}
agents.forEach((ag, i) => (ag.id = i + 1));
const batches: number[][] = [];
for (let i = 0; i < agents.length; i += concurrent) batches.push(agents.slice(i, i + concurrent).map((a) => a.id));

// ---------- 產出：dispatch.json + prompt 檔 ----------
fs.mkdirSync(`${outDir}/_dispatch`, { recursive: true });
fs.mkdirSync(`${outDir}/_critical`, { recursive: true });
// 重規劃（如 --skip-existing）後 agent/batch 數會變，先清舊 prompt 檔以免孤兒誤導（審查 MINOR-4）
for (const f of fs.readdirSync(`${outDir}/_dispatch`)) {
  if (/^(agent-\d+|qa-batch-\d+)\.md$/.test(f)) fs.unlinkSync(`${outDir}/_dispatch/${f}`);
}

function render(tplPath: string, vars: Record<string, string>): string {
  const tpl = fs.readFileSync(tplPath, "utf8");
  const outStr = tpl.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? vars[k] : m));
  const leftover = outStr.match(/\{\{\w+\}\}/g);
  if (leftover) { console.error(`[ERROR] template ${path.basename(tplPath)} has unfilled placeholders: ${leftover.join(", ")}`); process.exit(3); }
  return outStr;
}

const reportPath = (a: Author) => `${outDir}/${a.reportBase}.md`;
const criticalPath = (a: Author) => `${outDir}/_critical/${a.reportBase}.critical.md`;

for (const ag of agents) {
  const dimList = DIMENSIONS[ag.group].map((f) => `   - ${DIM_DIR}/${f}`).join("\n");
  const table = ag.authors.map((a) => `| ${a.name} | ${a.email} | ${reportPath(a)} | ${criticalPath(a)} |`).join("\n");
  const blocks = ag.authors.map((a) => {
    const lines = [...a.repos.entries()].map(([r, shas]) => `- ${r}: ${shas.join(" ")}`).join("\n");
    return `### Author: ${a.name} ${a.email}\n${lines}`;
  }).join("\n\n");
  const prompt = render(`${SKILL_DIR}/templates/review-agent.tpl.md`, {
    REVIEW_LABEL: LABEL, DATE_START_FMT: fmtDash(DATE_START), DATE_END_FMT: fmtDash(DATE_END), CSV_DATE,
    DIMENSION_FILE_LIST: dimList, AUTHOR_FILE_TABLE: table, COMMITS_TO_REVIEW: blocks,
  });
  ag.promptFile = `${outDir}/_dispatch/agent-${ag.id}.md`;
  fs.writeFileSync(ag.promptFile, prompt);
}
const qaFiles: string[] = [];
batches.forEach((ids, bi) => {
  const rows = ids.flatMap((id) => agents[id - 1].authors.map((a) => `| ${reportPath(a)} | ${criticalPath(a)} |`)).join("\n");
  const prompt = render(`${SKILL_DIR}/templates/qa-agent.tpl.md`, { REVIEW_LABEL: LABEL, BATCH_NUM: String(bi + 1), QA_FILE_TABLE: rows });
  const f = `${outDir}/_dispatch/qa-batch-${bi + 1}.md`;
  fs.writeFileSync(f, prompt);
  qaFiles.push(f);
});

const dispatch = {
  review_label: LABEL, date_start: fmtDash(DATE_START), date_end: fmtDash(DATE_END), csv_date: CSV_DATE,
  concurrent, generated_at: new Date().toISOString(),
  skipped_repos: skippedRepos, skipped_authors: skippedAuthors,
  repo_commit_counts: repoCommitCount,
  agents: agents.map((ag) => ({
    id: ag.id, model: ag.model, group: ag.group, prompt_file: ag.promptFile,
    authors: ag.authors.map((a) => ({
      name: a.name, email: a.email, aliases: [...a.aliases],
      commit_count: a.commitCount, lines_changed: a.lines,
      report_file: reportPath(a), critical_file: criticalPath(a),
      commits: Object.fromEntries(a.repos),
    })),
  })),
  batches: batches.map((ids, i) => ({ batch: i + 1, agent_ids: ids, qa_prompt_file: qaFiles[i] })),
};
fs.writeFileSync(`${outDir}/_dispatch/dispatch.json`, JSON.stringify(dispatch, null, 2));

// ---------- stdout 摘要（manager 只需要讀這個） ----------
const indepCount = agents.filter((a) => a.authors.length === 1 && isIndependent(a.authors[0])).length;
console.log(`[SCAN] window=${fmtDash(DATE_START)}..${fmtDash(DATE_END)} label=${LABEL} concurrent=${concurrent}`);
console.log(`[REPOS] ${activeRepos.map((r) => `${r}:${repoCommitCount[r] ?? 0}`).join(" ")}${skippedRepos.length ? `  skipped: ${skippedRepos.join(", ")}` : ""}`);
if (skippedAuthors.length) console.log(`[SKIPPED_AUTHORS] ${skippedAuthors.length} already reported: ${skippedAuthors.join("; ")}`);
console.log(`[AUTHORS] ${authors.size} → ${agents.length} agents in ${batches.length} batch(es)`);
console.log(`AGENT  MODEL   BATCH  GROUP         AUTHORS (commits/lines)`);
for (const ag of agents) {
  const b = batches.findIndex((ids) => ids.includes(ag.id)) + 1;
  const who = ag.authors.map((a) => `${a.name}(${a.commitCount}/${a.lines})`).join(", ");
  console.log(`${String(ag.id).padEnd(6)} ${ag.model.padEnd(7)} ${String(b).padEnd(6)} ${ag.group.padEnd(13)} ${who}`);
}
console.log(`[OUT] ${outDir}/_dispatch/dispatch.json`);
console.log(`[NEXT] For each batch in order: dispatch each agent with its prompt file (see dispatch.json agents[].prompt_file), wait for the batch, then dispatch its QA prompt file. Finally run collect-critical.ts.`);
