#!/usr/bin/env bun
/**
 * dep-scan.ts — /dep-audit 的確定性掃描核心。
 *
 * 做四件事，全部不靠模型推理：
 *   1. 盤點 projects.json 內每個專案「實際安裝」的套件版本（node_modules 優先，缺則讀 lockfile）
 *   2. 對每個 (name, version) 查 OSV.dev 漏洞（GitHub Advisory / CVE 的公開聚合來源）
 *   3. 對有漏洞的組合查 npm registry，算出「能清掉全部漏洞的最小版本」與「同 major 內是否有解」
 *   4. 對建議目標版本做靜態相容性預檢（engines / peerDependencies / 反向 peer / deprecated）
 *
 * 分析單位是 (套件, 版本) 而非套件：同一套件在同一專案可能同時裝了多個版本
 * （實例：agrabah 直接宣告 protobufjs 8.0.2，另有 protobufjs-cli 拉進來的巢狀 7.5.2），
 * 兩者的漏洞集合、修補版本、可行動方式完全不同，合併會產生誤導性建議。
 *
 * 輸出 audit-reports/dep-audit-<label>/scan.json，供 build-report.ts 與 /dep-audit 指令使用。
 * 本腳本唯讀，不會修改任何 repo 檔案。
 *
 * 用法：
 *   bun dep-scan.ts scan [--label <label>] [--project <id>]... [--no-cache] [--offline]
 *   bun dep-scan.ts pkg <name> [<version>]      # 單一套件即席查詢，不寫檔
 */

import { existsSync, readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";

// ---------------------------------------------------------------- semver
// 刻意不自幹 semver：升版建議算錯的代價遠高於多一個相依。
// 從各 repo 已安裝的 node_modules 借用官方 semver；一個都找不到就硬失敗（不做靜默 fallback）。
const SEMVER_CANDIDATES = [
  "agrabah", "abu/platform", "abu/admin", "rajah", "genie", "jafar", "jasmine",
  "lago/pk-gaming", "lago/ny-gaming", "lago/n8-gaming", "lago/agent-backend",
];
function loadSemver(root: string): any {
  for (const c of SEMVER_CANDIDATES) {
    const p = join(root, c, "node_modules", "semver", "package.json");
    if (existsSync(p)) {
      try { return createRequire(p)(join(root, c, "node_modules", "semver")); } catch { /* 換下一個候選 */ }
    }
  }
  console.error(
    "[FATAL] 找不到可用的 semver 套件。\n" +
    "  修法：在任一主 repo 跑 bun install（例：cd /Users/user/aladdin/agrabah && bun install），再重跑本腳本。\n" +
    "  原因：版本比較與 peer range 判定一律用官方 semver，不接受自製近似實作。",
  );
  process.exit(2);
}

// ---------------------------------------------------------------- types
type Occurrence = {
  project: string;
  direct: boolean;          // 該專案 package.json 有宣告，且此版本落在宣告範圍內
  depKind: "prod" | "dev" | "transitive";
  range: string | null;
  source: string;           // node_modules | bun.lock | package-lock.json
};
type Vuln = {
  id: string; aliases: string[]; severity: string; cvss: string | null;
  summary: string; published: string | null; fixedIn: string[]; url: string;
};
type Node = { name: string; version: string; peers: Record<string, string>; deps: Record<string, string> };

const SEV_ORDER = ["UNKNOWN", "LOW", "MODERATE", "HIGH", "CRITICAL"];
const sevRank = (s: string) => Math.max(0, SEV_ORDER.indexOf(s));

// ---------------------------------------------------------------- cli
const argv = process.argv.slice(2);
const cmd = argv[0] ?? "scan";
const flag = (n: string) => argv.includes(n);
const flagVal = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const flagAll = (n: string) => argv.reduce<string[]>((a, v, i) => (v === n && argv[i + 1] ? [...a, argv[i + 1]] : a), []);

const SKILL_DIR = dirname(new URL(import.meta.url).pathname);
const CFG = JSON.parse(readFileSync(join(SKILL_DIR, "projects.json"), "utf8"));
const ROOT: string = CFG.root;
const semver = loadSemver(ROOT);

const NO_CACHE = flag("--no-cache");
const OFFLINE = flag("--offline");
const CACHE_DIR = join(ROOT, "audit-reports", ".dep-audit-cache");

// ---------------------------------------------------------------- cache + http
function cacheGet(key: string, ttlMs: number): any | null {
  if (NO_CACHE) return null;
  const p = join(CACHE_DIR, key.replace(/[^\w.@-]/g, "_") + ".json");
  if (!existsSync(p)) return null;
  if (Date.now() - statSync(p).mtimeMs > ttlMs) return null;
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; }
}
function cacheSet(key: string, val: any) {
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(join(CACHE_DIR, key.replace(/[^\w.@-]/g, "_") + ".json"), JSON.stringify(val));
}
async function http(url: string, init?: RequestInit, tries = 3): Promise<any> {
  if (OFFLINE) throw new Error("offline mode");
  let lastErr: any;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { ...init, signal: AbortSignal.timeout(45_000) });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
      return await r.json();
    } catch (e) {
      lastErr = e;
      await new Promise((res) => setTimeout(res, 800 * (i + 1)));
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------- 盤點
/** node_modules 遞迴走訪：保留同名套件的「所有」版本，另收 deps/peers 供反查 */
function walkNodeModules(nmDir: string) {
  const found = new Map<string, Set<string>>();
  const nodes: Node[] = [];
  const add = (n: string, v: string) => {
    if (!semver.valid(v)) return;
    if (!found.has(n)) found.set(n, new Set());
    found.get(n)!.add(v);
  };
  const visit = (dir: string, depth: number) => {
    if (depth > 6 || !existsSync(dir)) return;
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const e of entries) {
      if (e === ".bin" || e === ".cache") continue;
      const full = join(dir, e);
      if (e.startsWith("@")) { visit(full, depth); continue; }   // scope 目錄不算一層
      const pj = join(full, "package.json");
      if (existsSync(pj)) {
        try {
          const d = JSON.parse(readFileSync(pj, "utf8"));
          if (d.name && d.version) {
            add(d.name, d.version);
            nodes.push({
              name: d.name, version: d.version,
              peers: d.peerDependencies ?? {},
              deps: { ...(d.dependencies ?? {}), ...(d.optionalDependencies ?? {}) },
            });
          }
        } catch { /* 壞掉的 package.json 略過 */ }
      }
      const nested = join(full, "node_modules");
      if (existsSync(nested)) visit(nested, depth + 1);
    }
  };
  visit(nmDir, 0);
  return { found, nodes };
}

/** bun.lock 是 JSONC：容忍註解與尾逗號 */
function parseBunLock(file: string): Map<string, Set<string>> {
  const raw = readFileSync(file, "utf8")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/,(\s*[}\]])/g, "$1");
  const out = new Map<string, Set<string>>();
  const d = JSON.parse(raw);
  for (const val of Object.values<any>(d.packages ?? {})) {
    const spec = Array.isArray(val) ? val[0] : null;
    if (typeof spec !== "string") continue;
    const at = spec.lastIndexOf("@");
    if (at <= 0) continue;
    const name = spec.slice(0, at), version = spec.slice(at + 1);
    if (!semver.valid(version)) continue;           // 過濾 ../genie 這類本地路徑依賴
    if (!out.has(name)) out.set(name, new Set());
    out.get(name)!.add(version);
  }
  return out;
}

function parseNpmLock(file: string): Map<string, Set<string>> {
  const d = JSON.parse(readFileSync(file, "utf8"));
  const out = new Map<string, Set<string>>();
  for (const [k, v] of Object.entries<any>(d.packages ?? {})) {
    if (!k.startsWith("node_modules/")) continue;
    const name = k.slice(k.lastIndexOf("node_modules/") + "node_modules/".length);
    if (!v?.version || !semver.valid(v.version)) continue;
    if (!out.has(name)) out.set(name, new Set());
    out.get(name)!.add(v.version);
  }
  return out;
}

function inventory(proj: any) {
  const dir = join(ROOT, proj.path);
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const prod = pkg.dependencies ?? {}, dev = pkg.devDependencies ?? {};
  const nm = join(dir, "node_modules");

  let installed = new Map<string, Set<string>>();
  let nodes: Node[] = [];
  let source = "NONE";
  if (existsSync(nm) && readdirSync(nm).length > 0) {
    const w = walkNodeModules(nm);
    installed = w.found; nodes = w.nodes; source = "node_modules";
  } else if (existsSync(join(dir, "bun.lock"))) {
    installed = parseBunLock(join(dir, "bun.lock")); source = "bun.lock";
  } else if (existsSync(join(dir, "package-lock.json"))) {
    installed = parseNpmLock(join(dir, "package-lock.json")); source = "package-lock.json";
  }
  return { pkg, prod, dev, installed, nodes, source };
}

// ---------------------------------------------------------------- OSV
/** 某版本是否落在此 advisory 的受影響範圍 */
function isAffected(vuln: any, name: string, version: string): boolean {
  if (!semver.valid(version)) return false;
  for (const aff of vuln.affected ?? []) {
    if (aff.package?.ecosystem !== "npm" || aff.package?.name !== name) continue;
    if (Array.isArray(aff.versions) && aff.versions.length) {
      if (aff.versions.includes(version)) return true;
      continue;   // 有列舉清單時以清單為準
    }
    for (const r of aff.ranges ?? []) {
      if (r.type !== "SEMVER" && r.type !== "ECOSYSTEM") continue;
      let hit = false;
      for (const ev of r.events ?? []) {
        if (ev.introduced !== undefined) {
          const intro = ev.introduced === "0" ? "0.0.0" : ev.introduced;
          if (semver.valid(intro) && semver.gte(version, intro)) hit = true;
        } else if (ev.fixed !== undefined && hit) {
          if (semver.valid(ev.fixed) && semver.gte(version, ev.fixed)) hit = false;
        } else if (ev.last_affected !== undefined && hit) {
          if (semver.valid(ev.last_affected) && semver.gt(version, ev.last_affected)) hit = false;
        }
      }
      if (hit) return true;
    }
  }
  return false;
}

function fixedVersionsOf(vuln: any, name: string): string[] {
  const out = new Set<string>();
  for (const aff of vuln.affected ?? []) {
    if (aff.package?.ecosystem !== "npm" || aff.package?.name !== name) continue;
    for (const r of aff.ranges ?? []) for (const ev of r.events ?? []) if (ev.fixed) out.add(ev.fixed);
  }
  return [...out].filter((v) => semver.valid(v)).sort(semver.compare);
}

function normalizeVuln(v: any, name: string): Vuln {
  const cvss = (v.severity ?? []).map((s: any) => s.score).find((s: string) => s?.startsWith("CVSS")) ?? null;
  return {
    id: v.id,
    aliases: v.aliases ?? [],
    severity: (v.database_specific?.severity ?? "UNKNOWN").toUpperCase(),
    cvss,
    summary: v.summary ?? "",
    published: v.published ?? null,
    fixedIn: fixedVersionsOf(v, name),
    url: `https://osv.dev/vulnerability/${v.id}`,
  };
}

async function osvBatch(pairs: { name: string; version: string }[]) {
  const ids = new Map<string, Set<string>>();   // "name@ver" -> vuln ids
  for (let i = 0; i < pairs.length; i += 400) {
    const chunk = pairs.slice(i, i + 400);
    const res = await http("https://api.osv.dev/v1/querybatch", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ queries: chunk.map((p) => ({ package: { name: p.name, ecosystem: "npm" }, version: p.version })) }),
    });
    (res?.results ?? []).forEach((r: any, j: number) => {
      const vs = (r?.vulns ?? []).map((v: any) => v.id);
      if (vs.length) ids.set(`${chunk[j].name}@${chunk[j].version}`, new Set(vs));
    });
    process.stderr.write(`  OSV batch ${Math.min(i + 400, pairs.length)}/${pairs.length}\r`);
  }
  process.stderr.write("\n");
  return ids;
}

async function osvDetail(id: string): Promise<any> {
  const c = cacheGet(`osv-${id}`, 24 * 3600e3);
  if (c) return c;
  const d = await http(`https://api.osv.dev/v1/vulns/${id}`);
  if (d) cacheSet(`osv-${id}`, d);
  return d;
}

// ---------------------------------------------------------------- registry
async function registry(name: string): Promise<any> {
  const c = cacheGet(`reg-${name}`, 6 * 3600e3);
  if (c) return c;
  const d = await http(`https://registry.npmjs.org/${name.replace("/", "%2f")}`, {
    headers: { Accept: "application/vnd.npm.install-v1+json" },
  });
  if (d) cacheSet(`reg-${name}`, d);
  return d;
}
/** 單版本完整 metadata（peerDependencies / engines / deprecated 只在這裡拿得到） */
async function registryFull(name: string, version: string): Promise<any> {
  const c = cacheGet(`regv-${name}-${version}`, 30 * 24 * 3600e3);
  if (c) return c;
  const d = await http(`https://registry.npmjs.org/${name.replace("/", "%2f")}/${version}`);
  if (d) cacheSet(`regv-${name}-${version}`, d);
  return d;
}

const stable = (vs: string[]) => vs.filter((v) => semver.valid(v) && !semver.prerelease(v)).sort(semver.compare);

// ---------------------------------------------------------------- 主流程
async function runScan() {
  const label = flagVal("--label") ?? new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10).replace(/-/g, "");
  const only = flagAll("--project");
  const projects = CFG.projects.filter((p: any) => (only.length ? only.includes(p.id) : true));
  if (!projects.length) {
    console.error(`[FATAL] --project 沒有匹配任何專案；可用 id：${CFG.projects.map((p: any) => p.id).join(", ")}`);
    process.exit(2);
  }

  // 1. 盤點：key 是 "name@version"，一個版本一筆
  const occ = new Map<string, Occurrence[]>();
  const graphIndex = new Map<string, Node[]>();
  const projMeta: any[] = [];
  const audienceOf = new Map<string, string>(projects.map((p: any) => [p.id, p.audience]));

  for (const p of projects) {
    const dir = join(ROOT, p.path);
    if (!existsSync(join(dir, "package.json"))) { console.error(`[WARN] 跳過 ${p.id}：${dir}/package.json 不存在`); continue; }
    const inv = inventory(p);
    if (inv.source === "NONE") { console.error(`[WARN] 跳過 ${p.id}：既無 node_modules 也無 lockfile，無法判定實際版本`); continue; }
    graphIndex.set(p.id, inv.nodes);
    let total = 0;
    for (const [name, versions] of inv.installed) {
      const declRange = inv.prod[name] ?? inv.dev[name] ?? null;
      const declKind: "prod" | "dev" | null = name in inv.prod ? "prod" : name in inv.dev ? "dev" : null;
      for (const version of versions) {
        total++;
        // direct 的判準是「宣告範圍涵蓋此版本」——agrabah 宣告 protobufjs 8.0.2 時，
        // 巢狀的 7.5.2 必須被歸為 transitive，否則會建議去改一個根本沒宣告 7.x 的 package.json。
        let inRange = false;
        if (declRange) { try { inRange = semver.satisfies(version, declRange, { includePrerelease: true }); } catch { inRange = false; } }
        const key = `${name}@${version}`;
        const list = occ.get(key) ?? [];
        list.push({
          project: p.id,
          direct: inRange,
          depKind: inRange && declKind ? declKind : "transitive",
          range: inRange ? declRange : null,
          source: inv.source,
        });
        occ.set(key, list);
      }
    }
    projMeta.push({
      id: p.id, path: p.path, kind: p.kind, audience: p.audience, source: inv.source,
      packageCount: inv.installed.size, versionCount: total,
      directCount: Object.keys(inv.prod).length + Object.keys(inv.dev).length,
    });
    console.error(`  盤點 ${p.id.padEnd(20)} ${String(inv.installed.size).padStart(4)} 套件 / ${String(total).padStart(4)} 版本（來源：${inv.source}）`);
  }

  // 2. OSV
  const pairs = [...occ.keys()].map((k) => ({ name: k.slice(0, k.lastIndexOf("@")), version: k.slice(k.lastIndexOf("@") + 1) }));
  console.error(`\n查詢 OSV：${pairs.length} 個唯一 (套件, 版本) 組合`);
  const hitIds = await osvBatch(pairs);

  const allIds = new Set<string>();
  for (const s of hitIds.values()) for (const id of s) allIds.add(id);
  console.error(`命中 ${hitIds.size} 個組合、${allIds.size} 個 advisory，拉取詳情…`);
  const details = new Map<string, any>();
  const idList = [...allIds];
  for (let i = 0; i < idList.length; i += 10) {
    const batch = await Promise.all(idList.slice(i, i + 10).map((id) => osvDetail(id).catch(() => null)));
    batch.forEach((d, j) => { if (d) details.set(idList[i + j], d); });
    process.stderr.write(`  advisory ${Math.min(i + 10, idList.length)}/${idList.length}\r`);
  }
  process.stderr.write("\n");

  // 3+4. 逐 (套件, 版本) 分析
  const findings: any[] = [];
  for (const [key, idSet] of hitIds) {
    const name = key.slice(0, key.lastIndexOf("@"));
    const version = key.slice(key.lastIndexOf("@") + 1);
    const occs = occ.get(key) ?? [];
    const rawVulns = [...idSet].map((id) => details.get(id)).filter(Boolean);
    if (!rawVulns.length) continue;
    const vulns = rawVulns.map((v) => normalizeVuln(v, name)).sort((a, b) => sevRank(b.severity) - sevRank(a.severity));
    const maxSeverity = vulns.reduce((m, v) => (sevRank(v.severity) > sevRank(m) ? v.severity : m), "UNKNOWN");

    const reg = await registry(name).catch(() => null);
    const all = stable(Object.keys(reg?.versions ?? {}));
    const latest = reg?.["dist-tags"]?.latest ?? null;

    const clean = (v: string) => rawVulns.every((rv) => !isAffected(rv, name, v));
    const candidates = all.filter((v) => semver.gt(v, version));
    const minimalFix = candidates.find(clean) ?? null;
    const sameMajorFix = candidates.find((v) => semver.major(v) === semver.major(version) && clean(v)) ?? null;
    const target = sameMajorFix ?? minimalFix;   // 優先同 major：相容風險最低
    const unfixed = minimalFix ? [] : vulns.filter((v) => !v.fixedIn.length).map((v) => v.id);

    // 誰把它拉進來的（間接漏洞不知父套件就無法行動：要嘛升父套件、要嘛下 overrides）
    const dependents = new Map<string, any>();
    for (const o of occs) {
      if (o.direct) continue;
      for (const n of graphIndex.get(o.project) ?? []) {
        if (n.name === name) continue;
        // peer 也算：protobufjs 在 rajah 就是被 protobufjs-cli 以 peerDependency 拉進來的，
        // 只看 dependencies 會得到「沒人依賴它」的假象。
        const range = n.deps?.[name] ?? n.peers?.[name];
        if (!range) continue;
        const k = `${o.project}|${n.name}`;
        if (!dependents.has(k)) {
          dependents.set(k, {
            project: o.project, via: `${n.name}@${n.version}`, range,
            kind: n.deps?.[name] ? "dependency" : "peerDependency",
            targetStillSatisfies: target ? (() => { try { return semver.satisfies(target, range, { includePrerelease: true }); } catch { return null; } })() : null,
          });
        }
      }
    }

    // 相容性靜態預檢
    let compat: any = { target, checked: false };
    if (target) {
      const full = await registryFull(name, target).catch(() => null);
      const rp = new Map<string, any>();
      for (const o of occs) {
        for (const n of graphIndex.get(o.project) ?? []) {
          const range = n.peers?.[name];
          if (!range) continue;
          let ok: boolean | null = null;
          try { ok = semver.satisfies(target, range, { includePrerelease: true }); } catch { ok = null; }
          const k = `${o.project}|${n.name}|${range}`;
          if (!rp.has(k)) rp.set(k, { project: o.project, dependent: `${n.name}@${n.version}`, range, satisfiedByTarget: ok });
        }
      }
      let engineNodeOk: boolean | null = null;
      if (full?.engines?.node) { try { engineNodeOk = semver.satisfies(process.version, full.engines.node); } catch { engineNodeOk = null; } }
      compat = {
        target, checked: true,
        bumpType: semver.diff(version, target) ?? "unknown",
        engines: full?.engines ?? null,
        engineNodeOk, localNode: process.version,
        peerDependencies: full?.peerDependencies ?? null,
        deprecated: full?.deprecated ?? null,
        reversePeers: [...rp.values()],
        blockingPeers: [...rp.values()].filter((r) => r.satisfiedByTarget === false),
      };
    }

    findings.push({
      package: name, version,
      occurrences: occs,
      projects: [...new Set(occs.map((o) => o.project))],
      dependents: [...dependents.values()],
      anyDirect: occs.some((o) => o.direct),
      directIn: occs.filter((o) => o.direct).map((o) => ({ project: o.project, range: o.range, depKind: o.depKind })),
      audiences: [...new Set(occs.map((o) => audienceOf.get(o.project)).filter(Boolean))],
      maxSeverity, vulns,
      registry: {
        latest,
        latestSameMajor: all.filter((v) => semver.major(v) === semver.major(version)).pop() ?? null,
        totalStableVersions: all.length,
      },
      recommendation: {
        minimalFix, sameMajorFix, target,
        bumpType: target ? semver.diff(version, target) : null,
        crossMajor: target ? semver.major(target) !== semver.major(version) : null,
        latest, unfixed,
      },
      compat,
    });
  }

  findings.sort((a, b) =>
    sevRank(b.maxSeverity) - sevRank(a.maxSeverity) ||
    Number(b.anyDirect) - Number(a.anyDirect) ||
    b.projects.length - a.projects.length ||
    a.package.localeCompare(b.package));

  const summary = { CRITICAL: 0, HIGH: 0, MODERATE: 0, LOW: 0, UNKNOWN: 0 } as Record<string, number>;
  for (const f of findings) summary[f.maxSeverity] = (summary[f.maxSeverity] ?? 0) + 1;

  const out = {
    label,
    generatedAt: new Date().toISOString(),
    tool: { node: process.version, bun: (globalThis as any).Bun?.version ?? null, source: "OSV.dev + registry.npmjs.org" },
    projects: projMeta,
    scanned: { uniquePairs: pairs.length, vulnerablePairs: hitIds.size, advisories: allIds.size },
    summary,
    findings,
  };

  const dir = join(ROOT, "audit-reports", `dep-audit-${label}`);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "scan.json");
  writeFileSync(file, JSON.stringify(out, null, 2));

  // stdout：給人看的摘要（模型讀這段就能決定要不要深挖）
  console.log(`\nSCAN_OK ${file}`);
  console.log(`專案 ${projMeta.length} 個 / 唯一套件版本 ${pairs.length} 組 / 有漏洞組合 ${findings.length} 個`);
  console.log(`嚴重度分布：CRITICAL=${summary.CRITICAL} HIGH=${summary.HIGH} MODERATE=${summary.MODERATE} LOW=${summary.LOW} UNKNOWN=${summary.UNKNOWN}\n`);
  console.log("套件@現版".padEnd(34) + "嚴重".padEnd(10) + "建議".padEnd(12) + "幅度".padEnd(8) + "直接 阻擋peer 專案");
  console.log("-".repeat(126));
  for (const f of findings) {
    const r = f.recommendation;
    console.log(
      `${f.package}@${f.version}`.slice(0, 33).padEnd(34) +
      f.maxSeverity.padEnd(10) +
      String(r.target ?? "無修補").padEnd(12) +
      String(r.bumpType ?? "-").padEnd(8) +
      String(f.anyDirect ? "YES" : "-").padEnd(5) +
      String(f.compat?.blockingPeers?.length ?? 0).padEnd(9) +
      f.projects.join(","),
    );
  }
  console.log("\n下一步：依 /dep-audit 指令 Step 2 起做分級、網路研究與 worktree 實測。");
}

// ---------------------------------------------------------------- pkg 子指令
async function runPkg() {
  const name = argv[1];
  if (!name) { console.error("用法：bun dep-scan.ts pkg <name> [<version>]"); process.exit(2); }
  const reg = await registry(name);
  if (!reg) { console.log(`registry 查無此套件：${name}`); return; }
  const all = stable(Object.keys(reg.versions ?? {}));
  const version = argv[2] ?? reg["dist-tags"]?.latest;
  console.log(`${name}  dist-tags=${JSON.stringify(reg["dist-tags"])}  共 ${all.length} 個穩定版`);
  const res = await http("https://api.osv.dev/v1/query", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ package: { name, ecosystem: "npm" }, version }),
  });
  const vulns = res?.vulns ?? [];
  console.log(`\n${name}@${version} → ${vulns.length} 筆 advisory`);
  for (const v of vulns) {
    const n = normalizeVuln(v, name);
    console.log(`  ${n.severity.padEnd(9)} ${n.id.padEnd(22)} fixed=${n.fixedIn.join(",") || "(無)"}  ${n.summary.slice(0, 70)}`);
  }
  if (vulns.length) {
    const cleanV = all.filter((v) => semver.gt(v, version)).find((cand) => vulns.every((rv: any) => !isAffected(rv, name, cand)));
    console.log(`\n最小可清版本：${cleanV ?? "（現有版本皆無法清除全部漏洞）"}`);
  }
}

// ---------------------------------------------------------------- entry
if (cmd === "scan") await runScan();
else if (cmd === "pkg") await runPkg();
else { console.error(`未知子指令：${cmd}\n用法：bun dep-scan.ts scan|pkg`); process.exit(2); }
