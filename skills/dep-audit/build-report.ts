#!/usr/bin/env bun
/**
 * build-report.ts — 把 /dep-audit 三份產物合成單檔 HTML 報告。
 *
 *   scan.json      （必要，dep-scan.ts 產出的確定性事實）
 *   research.json  （選用，模型產出的網路研究：可利用性、breaking changes、遷移步驟、來源）
 *   verify.json    （選用，模型產出的 worktree 實測：baseline vs after 逐項結果）
 *
 * 三者以 "package@version" 為 join key。缺 research / verify 時報告照出，
 * 但該欄位會明確顯示「未研究 / 未實測」——不驗證的東西絕不呈現為已驗證。
 *
 * 用法：bun build-report.ts <label> [--out <path>]
 * 輸出：audit-reports/dep-audit-<label>/dependency-audit-<label>.html
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";

const SKILL_DIR = dirname(new URL(import.meta.url).pathname);
const CFG = JSON.parse(readFileSync(join(SKILL_DIR, "projects.json"), "utf8"));
const ROOT: string = CFG.root;

const argv = process.argv.slice(2);
const label = argv[0];
if (!label || label.startsWith("--")) { console.error("用法：bun build-report.ts <label> [--out <path>]"); process.exit(2); }
const outFlag = argv.indexOf("--out");

const DIR = join(ROOT, "audit-reports", `dep-audit-${label}`);
const scanPath = join(DIR, "scan.json");
if (!existsSync(scanPath)) { console.error(`[FATAL] 找不到 ${scanPath}；請先跑 dep-scan.ts scan --label ${label}`); process.exit(2); }

const scan = JSON.parse(readFileSync(scanPath, "utf8"));
const readOpt = (n: string) => (existsSync(join(DIR, n)) ? JSON.parse(readFileSync(join(DIR, n), "utf8")) : null);
const research = readOpt("research.json");
const verify = readOpt("verify.json");

const researchBy = new Map<string, any>((research?.items ?? []).map((i: any) => [i.key, i]));
const verifyBy = new Map<string, any[]>();
for (const r of verify?.runs ?? []) { const l = verifyBy.get(r.key) ?? []; l.push(r); verifyBy.set(r.key, l); }
const projMeta = new Map<string, any>((scan.projects ?? []).map((p: any) => [p.id, p]));
const projCfg = new Map<string, any>((CFG.projects ?? []).map((p: any) => [p.id, p]));

// ---------------------------------------------------------------- helpers
const esc = (s: any) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const SEVS = ["CRITICAL", "HIGH", "MODERATE", "LOW", "UNKNOWN"];
const PRIO_ORDER = ["P0", "P1", "P2", "P3", "未分級"];
const PRIO_LABEL: Record<string, string> = {
  P0: "P0 · 立即處理", P1: "P1 · 本週期內", P2: "P2 · 排入排程", P3: "P3 · 觀察即可", "未分級": "未分級",
};
// 沒有 research 時的保底分級：CRITICAL/HIGH 且為直接依賴 → P1，其餘 P2/P3。
// 這只是預設值，真正的分級要由 /dep-audit Step 3 依可利用性判定後寫進 research.json。
function fallbackPriority(f: any): string {
  if (f.maxSeverity === "CRITICAL") return f.anyDirect ? "P1" : "P2";
  if (f.maxSeverity === "HIGH") return f.anyDirect ? "P2" : "P3";
  return "P3";
}
const keyOf = (f: any) => `${f.package}@${f.version}`;

function verdictBadge(v: string | undefined) {
  const map: Record<string, [string, string]> = {
    SAFE: ["ok", "實測通過"],
    SAFE_WITH_CHANGES: ["warn", "需改碼後通過"],
    BLOCKED: ["bad", "實測受阻"],
    NOT_VERIFIED: ["none", "未實測"],
  };
  const [cls, text] = map[v ?? "NOT_VERIFIED"] ?? ["none", esc(v)];
  return `<span class="badge b-${cls}">${text}</span>`;
}
function stepRow(s: any) {
  const cls = s.status === "PASS" ? "ok" : s.status === "FAIL" ? "bad" : "none";
  return `<tr><td>${esc(s.name)}</td><td><span class="badge b-${cls}">${esc(s.status)}</span></td>` +
    `<td class="num">${s.durationSec != null ? esc(s.durationSec) + "s" : "—"}</td><td>${esc(s.note ?? "")}</td></tr>`;
}

// ---------------------------------------------------------------- 資料整理
const findings = (scan.findings ?? []).map((f: any) => {
  const k = keyOf(f);
  const r = researchBy.get(k) ?? null;
  const runs = verifyBy.get(k) ?? [];
  return { ...f, _key: k, _r: r, _runs: runs, _prio: r?.priority ?? fallbackPriority(f) };
});
findings.sort((a: any, b: any) =>
  PRIO_ORDER.indexOf(a._prio) - PRIO_ORDER.indexOf(b._prio) ||
  SEVS.indexOf(a.maxSeverity) - SEVS.indexOf(b.maxSeverity) ||
  Number(b.anyDirect) - Number(a.anyDirect) ||
  a.package.localeCompare(b.package));

const totalVerified = findings.filter((f: any) => f._runs.some((r: any) => r.verdict === "SAFE" || r.verdict === "SAFE_WITH_CHANGES")).length;
const totalBlocked = findings.filter((f: any) => f._runs.some((r: any) => r.verdict === "BLOCKED")).length;
const crossMajor = findings.filter((f: any) => f.recommendation?.crossMajor).length;
const noFix = findings.filter((f: any) => !f.recommendation?.target).length;
const allProjects = [...new Set(findings.flatMap((f: any) => f.projects))].sort();

const sevCounts: Record<string, number> = {};
for (const s of SEVS) sevCounts[s] = findings.filter((f: any) => f.maxSeverity === s).length;
const sevTotal = findings.length || 1;

// ---------------------------------------------------------------- 卡片
function card(f: any) {
  const r = f._r, rec = f.recommendation ?? {}, c = f.compat ?? {};
  const target = r?.targetDecision ?? rec.target;

  const vulnRows = (f.vulns ?? []).map((v: any) => `
      <tr>
        <td><a href="${esc(v.url)}" target="_blank" rel="noopener">${esc(v.id)}</a>
            ${v.aliases?.length ? `<div class="sub">${esc(v.aliases.join(", "))}</div>` : ""}</td>
        <td><span class="sev s-${esc(v.severity)}">${esc(v.severity)}</span></td>
        <td class="mono sub">${esc(v.cvss ?? "—")}</td>
        <td>${esc(v.summary)}</td>
        <td class="mono">${esc(v.fixedIn?.join(", ") || "無修補版")}</td>
      </tr>`).join("");

  const occRows = (f.occurrences ?? []).map((o: any) => {
    const pm = projMeta.get(o.project) ?? {};
    return `<tr><td>${esc(o.project)}</td><td>${pm.audience === "public" ? "對外" : "內部"}</td>
      <td>${o.direct ? `<span class="badge b-warn">直接</span> <span class="mono sub">${esc(o.range)}</span>` : `<span class="badge b-none">間接</span>`}</td>
      <td>${esc(o.depKind)}</td><td class="sub mono">${esc(o.source)}</td></tr>`;
  }).join("");

  const depRows = (f.dependents ?? []).map((d: any) => `
      <tr><td>${esc(d.project)}</td><td class="mono">${esc(d.via)}</td><td class="mono">${esc(d.range)}</td>
      <td>${esc(d.kind)}</td>
      <td>${d.targetStillSatisfies === false ? '<span class="badge b-bad">目標版超出範圍</span>'
        : d.targetStillSatisfies === true ? '<span class="badge b-ok">目標版仍相容</span>' : "—"}</td></tr>`).join("");

  const blocking = (c.blockingPeers ?? []);
  const staticCompat = `
    <table class="kv">
      <tr><th>升版幅度</th><td>${esc(rec.bumpType ?? "—")}${rec.crossMajor ? ' <span class="badge b-warn">跨 major</span>' : ""}</td></tr>
      <tr><th>同 major 內可解</th><td>${rec.sameMajorFix ? `<span class="badge b-ok">是 → ${esc(rec.sameMajorFix)}</span>` : '<span class="badge b-warn">否，必須跨 major</span>'}</td></tr>
      <tr><th>registry 最新版</th><td class="mono">${esc(rec.latest ?? "—")}</td></tr>
      <tr><th>engines</th><td class="mono">${c.engines ? esc(JSON.stringify(c.engines)) : "未宣告"} ${c.engineNodeOk === false ? '<span class="badge b-bad">本機 Node 不符</span>' : c.engineNodeOk === true ? '<span class="badge b-ok">本機 Node 相符</span>' : ""}</td></tr>
      <tr><th>目標版 peerDependencies</th><td class="mono">${c.peerDependencies ? esc(JSON.stringify(c.peerDependencies)) : "無"}</td></tr>
      <tr><th>已棄用</th><td>${c.deprecated ? `<span class="badge b-bad">${esc(c.deprecated)}</span>` : "否"}</td></tr>
      <tr><th>反向 peer 阻擋</th><td>${blocking.length
        ? `<span class="badge b-bad">${blocking.length} 項</span><div class="sub">${blocking.map((b: any) => `${esc(b.dependent)} 要求 <code>${esc(b.range)}</code>（${esc(b.project)}）`).join("<br>")}</div>`
        : '<span class="badge b-ok">無</span>'}</td></tr>
    </table>`;

  const researchBlock = r ? `
    <div class="grid2">
      <div><h5>可利用性（在我們的用法下）</h5><p>${esc(r.exploitability)}</p>
        ${r.usageEvidence?.length ? `<div class="sub mono">${r.usageEvidence.map((e: string) => esc(e)).join("<br>")}</div>` : ""}</div>
      <div><h5>選定版本理由</h5><p><span class="mono big">${esc(target)}</span></p><p>${esc(r.targetReason)}</p></div>
    </div>
    <h5>Breaking changes</h5>${r.breakingChanges?.length ? `<ul>${r.breakingChanges.map((x: string) => `<li>${esc(x)}</li>`).join("")}</ul>` : '<p class="sub">研究後未發現影響本專案的 breaking change。</p>'}
    <h5>已知回歸 / 社群回報問題</h5>${r.knownRegressions?.length ? `<ul>${r.knownRegressions.map((x: string) => `<li>${esc(x)}</li>`).join("")}</ul>` : '<p class="sub">未查到與此版本相關的公開回歸回報。</p>'}
    <h5>升級步驟</h5>${r.migrationSteps?.length ? `<ol>${r.migrationSteps.map((x: string) => `<li>${esc(x)}</li>`).join("")}</ol>` : '<p class="sub">直接改版號重裝即可，無額外步驟。</p>'}
    ${r.risks?.length ? `<h5>殘留風險</h5><ul>${r.risks.map((x: string) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
    <h5>資料來源</h5><ul class="src">${(r.sources ?? []).map((s: any) => `<li><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a></li>`).join("") || '<li class="sub">未記錄來源</li>'}</ul>`
    : `<p class="empty"><b>未做網路研究</b>——本項的 breaking change 與可利用性尚未查證。
       上方「建議版本」只是<b>能清掉全部漏洞的最小版本</b>之機器計算結果，不代表已確認可安全升級。</p>`;

  const verifyBlock = f._runs.length ? f._runs.map((run: any) => `
    <div class="run">
      <div class="run-head">${verdictBadge(run.verdict)}
        <span class="mono">${esc(run.project)}：${esc(run.from)} → ${esc(run.to)}</span></div>
      ${run.verdictNote ? `<p>${esc(run.verdictNote)}</p>` : ""}
      <div class="grid2">
        <div><h6>基準線（未升版）</h6><table class="steps"><tbody>${(run.baseline ?? []).map(stepRow).join("") || '<tr><td colspan="4" class="sub">未跑</td></tr>'}</tbody></table></div>
        <div><h6>升版後</h6><table class="steps"><tbody>${(run.after ?? []).map(stepRow).join("") || '<tr><td colspan="4" class="sub">未跑</td></tr>'}</tbody></table></div>
      </div>
      ${run.codeChangesNeeded?.length ? `<h6>升版需連帶修改的程式碼</h6><ul>${run.codeChangesNeeded.map((x: string) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
    </div>`).join("")
    : `<p class="empty"><b>未在 worktree 實測</b>——本項的「相容」目前僅為文件與 metadata 推論，沒有實跑證據。</p>`;

  return `
  <article class="card" data-sev="${esc(f.maxSeverity)}" data-prio="${esc(f._prio)}"
           data-direct="${f.anyDirect ? "1" : "0"}" data-projects="${esc(f.projects.join(" "))}">
    <header class="card-head">
      <div class="ch-l">
        <span class="prio p-${esc(f._prio)}">${esc(f._prio)}</span>
        <span class="pkg mono">${esc(f.package)}</span>
        <span class="ver mono">${esc(f.version)}</span>
        <span class="arrow">→</span>
        <span class="ver tgt mono">${esc(target ?? "無修補版")}</span>
      </div>
      <div class="ch-r">
        <span class="sev s-${esc(f.maxSeverity)}">${esc(f.maxSeverity)}</span>
        <span class="badge b-none">${f.vulns.length} 個漏洞</span>
        ${f.anyDirect ? '<span class="badge b-warn">直接依賴</span>' : '<span class="badge b-none">間接依賴</span>'}
        ${f.audiences.includes("public") ? '<span class="badge b-bad">影響對外站台</span>' : ""}
        ${f._runs.length ? verdictBadge(f._runs[0].verdict) : '<span class="badge b-none">未實測</span>'}
      </div>
    </header>
    <div class="card-sub">影響專案：<span class="mono">${esc(f.projects.join(", "))}</span>
      ${r?.priorityReason ? ` · <span class="sub">${esc(r.priorityReason)}</span>` : ""}</div>
    <details>
      <summary>展開細節</summary>
      <div class="body">
        <h4>1 · 漏洞清單</h4>
        <table class="tbl"><thead><tr><th>Advisory</th><th>嚴重度</th><th>CVSS</th><th>摘要</th><th>修補版本</th></tr></thead><tbody>${vulnRows}</tbody></table>

        <h4>2 · 暴露面</h4>
        <table class="tbl"><thead><tr><th>專案</th><th>對外</th><th>依賴方式</th><th>類別</th><th>版本來源</th></tr></thead><tbody>${occRows}</tbody></table>
        ${depRows ? `<h5>被誰拉進來的</h5><table class="tbl"><thead><tr><th>專案</th><th>父套件</th><th>要求範圍</th><th>方式</th><th>目標版是否仍相容</th></tr></thead><tbody>${depRows}</tbody></table>` : ""}

        <h4>3 · 相容性靜態預檢（registry metadata，機器判定）</h4>
        ${staticCompat}

        <h4>4 · 網路研究（人工／模型查證）</h4>
        ${researchBlock}

        <h4>5 · Worktree 實測</h4>
        ${verifyBlock}
      </div>
    </details>
  </article>`;
}

// ---------------------------------------------------------------- HTML
const groups = PRIO_ORDER.map((p) => ({ p, items: findings.filter((f: any) => f._prio === p) })).filter((g) => g.items.length);

const html = `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>套件漏洞與升級相容性報告 ${esc(label)}</title>
<style>
:root{
  color-scheme:light;
  --surface:#fcfcfb; --plane:#f9f9f7; --ink:#0b0b0b; --ink2:#52514e; --muted:#898781;
  --grid:#e1e0d9; --axis:#c3c2b7; --border:rgba(11,11,11,.10);
  --critical:#d03b3b; --serious:#ec835a; --warning:#fab219; --good:#0ca30c;
}
@media (prefers-color-scheme:dark){:root:where(:not([data-theme=light])){
  color-scheme:dark;
  --surface:#1a1a19; --plane:#0d0d0d; --ink:#fff; --ink2:#c3c2b7; --muted:#898781;
  --grid:#2c2c2a; --axis:#383835; --border:rgba(255,255,255,.10);
}}
:root[data-theme=dark]{
  color-scheme:dark;
  --surface:#1a1a19; --plane:#0d0d0d; --ink:#fff; --ink2:#c3c2b7; --muted:#898781;
  --grid:#2c2c2a; --axis:#383835; --border:rgba(255,255,255,.10);
}
*{box-sizing:border-box}
body{margin:0;background:var(--plane);color:var(--ink);
  font:14px/1.6 system-ui,-apple-system,"Segoe UI","PingFang TC","Noto Sans TC",sans-serif}
.wrap{max-width:1180px;margin:0 auto;padding:32px 20px 80px}
h1{font-size:24px;margin:0 0 4px} h2{font-size:17px;margin:36px 0 12px}
h4{font-size:13px;margin:22px 0 8px;color:var(--ink2);letter-spacing:.04em}
h5{font-size:12px;margin:16px 0 6px;color:var(--ink2)} h6{font-size:12px;margin:10px 0 4px;color:var(--muted)}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.sub{color:var(--muted);font-size:12px} .num{text-align:right;font-variant-numeric:tabular-nums}
a{color:inherit}
.meta{color:var(--ink2);font-size:13px;margin-bottom:24px}

/* KPI */
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:18px 0}
.kpi{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:14px 16px}
.kpi .v{font-size:28px;line-height:1.15;font-weight:600}
.kpi .l{font-size:12px;color:var(--ink2);margin-top:2px}
.kpi.crit .v{color:var(--critical)} .kpi.high .v{color:var(--serious)} .kpi.ok .v{color:var(--good)}

/* 嚴重度分布 */
.dist{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:16px;margin-bottom:8px}
.bar{display:flex;height:22px;border-radius:5px;overflow:hidden;background:var(--grid);gap:2px}
.bar span{display:block}
.legend{display:flex;flex-wrap:wrap;gap:16px;margin-top:10px;font-size:12px;color:var(--ink2)}
.legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:6px;vertical-align:-1px}

/* 篩選列 */
.filters{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:20px 0 12px;
  background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:10px 12px}
.filters label{font-size:12px;color:var(--ink2)}
select,button.f{font:inherit;font-size:12px;padding:5px 9px;border-radius:7px;
  border:1px solid var(--axis);background:var(--plane);color:var(--ink);cursor:pointer}

/* 卡片 */
.card{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:14px 16px;margin-bottom:10px}
.card-head{display:flex;flex-wrap:wrap;justify-content:space-between;gap:10px;align-items:center}
.ch-l{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.ch-r{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.pkg{font-weight:600;font-size:15px} .ver{color:var(--ink2)} .ver.tgt{color:var(--good);font-weight:600}
.arrow{color:var(--muted)}
.card-sub{font-size:12px;color:var(--ink2);margin-top:6px}
details{margin-top:10px} summary{cursor:pointer;font-size:12px;color:var(--muted);padding:4px 0}
.body{border-top:1px solid var(--grid);padding-top:6px;margin-top:4px}

/* 標籤 */
.sev{font-size:11px;font-weight:600;padding:2px 8px;border-radius:20px;color:#fff}
.s-CRITICAL{background:var(--critical)} .s-HIGH{background:var(--serious);color:#241004}
.s-MODERATE{background:var(--warning);color:#241a02} .s-LOW{background:var(--axis);color:var(--ink)}
.s-UNKNOWN{background:var(--grid);color:var(--ink2)}
.badge{font-size:11px;padding:2px 8px;border-radius:20px;border:1px solid var(--axis);color:var(--ink2)}
.b-ok{border-color:var(--good);color:var(--good)} .b-warn{border-color:var(--warning);color:var(--ink2)}
.b-bad{border-color:var(--critical);color:var(--critical)} .b-none{border-color:var(--axis);color:var(--muted)}
.prio{font-size:11px;font-weight:700;padding:2px 7px;border-radius:5px;border:1px solid var(--axis);color:var(--ink2)}
.p-P0{background:var(--critical);color:#fff;border-color:var(--critical)}
.p-P1{border-color:var(--serious);color:var(--serious)}
.p-P2{border-color:var(--warning)}

/* 表格 */
table{border-collapse:collapse;width:100%;font-size:12.5px}
.tbl th,.tbl td,.steps th,.steps td{border-bottom:1px solid var(--grid);padding:6px 8px;text-align:left;vertical-align:top}
.tbl th{color:var(--muted);font-weight:500;font-size:11px}
.kv th{text-align:left;color:var(--muted);font-weight:500;width:200px;padding:5px 8px 5px 0;vertical-align:top;font-size:12px}
.kv td{padding:5px 0;border-bottom:1px solid var(--grid)}
.scroll{overflow-x:auto}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:20px}
@media(max-width:760px){.grid2{grid-template-columns:1fr}}
.run{border:1px solid var(--grid);border-radius:8px;padding:10px 12px;margin:8px 0}
.run-head{display:flex;gap:10px;align-items:center;margin-bottom:6px}
.empty{color:var(--muted);font-size:12.5px;background:var(--plane);border:1px dashed var(--axis);
  border-radius:8px;padding:10px 12px}
ul,ol{margin:6px 0;padding-left:20px} li{margin:3px 0}
ul.src{list-style:none;padding-left:0} ul.src li{margin:4px 0;font-size:12px}
code{font-family:ui-monospace,Menlo,monospace;background:var(--plane);padding:1px 4px;border-radius:4px}
.big{font-size:16px;font-weight:600}
.note{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:14px 16px;font-size:12.5px;color:var(--ink2)}
.note li{margin:5px 0}
</style>
</head>
<body>
<div class="wrap">

<h1>套件漏洞與升級相容性報告</h1>
<div class="meta">
  批次 <span class="mono">${esc(label)}</span> ·
  掃描時間 ${esc(new Date(scan.generatedAt).toLocaleString("zh-TW", { timeZone: "Asia/Taipei" }))} ·
  資料來源 ${esc(scan.tool?.source)} ·
  掃描 ${esc(scan.projects?.length)} 個專案 / ${esc(scan.scanned?.uniquePairs)} 組唯一套件版本
</div>

<div class="kpis">
  <div class="kpi"><div class="v">${findings.length}</div><div class="l">有漏洞的套件版本</div></div>
  <div class="kpi crit"><div class="v">${sevCounts.CRITICAL}</div><div class="l">CRITICAL</div></div>
  <div class="kpi high"><div class="v">${sevCounts.HIGH}</div><div class="l">HIGH</div></div>
  <div class="kpi"><div class="v">${crossMajor}</div><div class="l">需跨 major 升版</div></div>
  <div class="kpi"><div class="v">${noFix}</div><div class="l">無可用修補版</div></div>
  <div class="kpi ok"><div class="v">${totalVerified}</div><div class="l">已實測可升</div></div>
</div>

<div class="dist">
  <div class="bar">
    ${SEVS.filter((s) => sevCounts[s]).map((s) => {
      const color = { CRITICAL: "var(--critical)", HIGH: "var(--serious)", MODERATE: "var(--warning)", LOW: "var(--axis)", UNKNOWN: "var(--grid)" }[s];
      return `<span style="width:${(sevCounts[s] / sevTotal * 100).toFixed(2)}%;background:${color}" title="${s} ${sevCounts[s]}"></span>`;
    }).join("")}
  </div>
  <div class="legend">
    ${SEVS.filter((s) => sevCounts[s]).map((s) => {
      const color = { CRITICAL: "var(--critical)", HIGH: "var(--serious)", MODERATE: "var(--warning)", LOW: "var(--axis)", UNKNOWN: "var(--grid)" }[s];
      return `<span><i style="background:${color}"></i>${s} · ${sevCounts[s]}</span>`;
    }).join("")}
  </div>
</div>

<h2>處理清單</h2>
<div class="filters">
  <label>嚴重度 <select id="fSev"><option value="">全部</option>${SEVS.map((s) => `<option>${s}</option>`).join("")}</select></label>
  <label>專案 <select id="fProj"><option value="">全部</option>${allProjects.map((p: string) => `<option>${esc(p)}</option>`).join("")}</select></label>
  <label>依賴方式 <select id="fDir"><option value="">全部</option><option value="1">只看直接依賴</option><option value="0">只看間接依賴</option></select></label>
  <button class="f" id="fExpand">全部展開</button>
  <button class="f" id="fReset">清除篩選</button>
  <span class="sub" id="fCount"></span>
</div>

${groups.map((g) => `<h4 class="group">${esc(PRIO_LABEL[g.p])}（${g.items.length}）</h4>${g.items.map(card).join("")}`).join("")}

<h2>專案盤點</h2>
<div class="scroll"><table class="tbl">
<thead><tr><th>專案</th><th>類型</th><th>對象</th><th>版本來源</th><th class="num">套件數</th><th class="num">版本數</th><th class="num">直接依賴</th><th>驗證方式</th></tr></thead>
<tbody>${(scan.projects ?? []).map((p: any) => {
  const c = projCfg.get(p.id) ?? {};
  return `<tr><td class="mono">${esc(p.id)}</td><td>${esc(p.kind)}</td>
    <td>${p.audience === "public" ? '<span class="badge b-bad">對外</span>' : "內部"}</td>
    <td class="mono sub">${esc(p.source)}</td>
    <td class="num">${esc(p.packageCount)}</td><td class="num">${esc(p.versionCount)}</td><td class="num">${esc(p.directCount)}</td>
    <td class="sub">${(c.verify ?? []).map((v: any) => esc(v.name)).join(" + ") || "—"}
      ${c.verifyNote ? `<details><summary>驗證強度說明</summary><div>${esc(c.verifyNote)}</div></details>` : ""}</td></tr>`;
}).join("")}</tbody></table></div>

<h2>方法論與已知限制</h2>
<div class="note">
<ul>
  <li><b>漏洞資料</b>來自 OSV.dev（GitHub Advisory / CVE 的公開聚合），比對的是各專案 <b>實際安裝</b>的版本（node_modules 優先，缺則讀 lockfile），不是 package.json 的宣告範圍。</li>
  <li><b>分析單位是 (套件, 版本)</b>：同一套件在同專案可能同時裝有多個版本，其漏洞集合與修補路徑不同，故分列。</li>
  <li><b>「建議版本」</b>＝ registry 上能清掉該組合<b>全部</b> advisory 的最小穩定版，且優先取同 major。這是機器計算，不代表已驗證相容。</li>
  <li><b>相容性靜態預檢</b>只看 registry metadata（engines / peerDependencies / 反向 peer / deprecated），查不出執行期行為變更。</li>
  <li><b>標示「未實測」的項目沒有實跑證據</b>；標示「實測通過」者，實際跑了哪些指令、基準線是否本來就綠，見各卡片第 5 節與上方專案盤點的驗證強度說明。</li>
  <li>本報告<b>不涵蓋</b>：非 npm 生態的相依（Docker base image、系統套件）、私有 registry 套件、以及尚未公開揭露的漏洞。</li>
  ${verify?.notVerified?.length ? `<li><b>本次未實測項目</b>：${verify.notVerified.map((n: any) => `${esc(n.key)}（${esc(n.reason)}）`).join("；")}</li>` : ""}
  ${research?.notResearched?.length ? `<li><b>本次未做網路研究項目</b>：${research.notResearched.map((n: any) => `${esc(n.key)}（${esc(n.reason)}）`).join("；")}</li>` : ""}
</ul>
${(!research || !verify || research?.notResearched?.length || verify?.notVerified?.length) ? `
<h5 style="margin-top:16px">怎麼補齊標示「未研究 / 未實測」的項目</h5>
<p>在 Claude Code 用<b>同一個批次標籤</b>重跑，既有結果會保留、只補未做的項目（掃描走本機快取，很快）：</p>
<pre style="background:var(--plane);border:1px solid var(--axis);border-radius:6px;padding:10px;overflow-x:auto;font-size:12px;margin:6px 0"><code>/dep-audit ${esc(label)} --scope P2                       # 補做 P2 以上全部項目
/dep-audit ${esc(label)} --only <span class="sub">套件@版本</span>              # 只補特定項目，例：--only handlebars@4.7.8
/dep-audit ${esc(label)} --only <span class="sub">套件@版本</span> --skip-verify # 只補研究，不做 worktree 實測</code></pre>
<p class="sub">重跑會覆蓋本 HTML 檔（同標籤）。想保留這一版就先另存，或換一個標籤重跑。</p>` : ""}
</div>

</div>
<script>
const cards=[...document.querySelectorAll('.card')];
const fSev=document.getElementById('fSev'),fProj=document.getElementById('fProj'),
      fDir=document.getElementById('fDir'),fCount=document.getElementById('fCount');
function apply(){
  let n=0;
  for(const c of cards){
    const ok=(!fSev.value||c.dataset.sev===fSev.value)
          &&(!fProj.value||c.dataset.projects.split(' ').includes(fProj.value))
          &&(!fDir.value||c.dataset.direct===fDir.value);
    c.style.display=ok?'':'none'; if(ok)n++;
  }
  fCount.textContent='顯示 '+n+' / '+cards.length+' 項';
  // 只針對優先序分組標題；卡片內的小節標題也是 h4，誤選會把它們一起隱藏
  for(const h of document.querySelectorAll('h4.group')){
    let s=h.nextElementSibling,any=false;
    while(s&&s.classList.contains('card')){if(s.style.display!=='none')any=true;s=s.nextElementSibling;}
    h.style.display=any?'':'none';
  }
}
[fSev,fProj,fDir].forEach(e=>e.addEventListener('change',apply));
document.getElementById('fReset').onclick=()=>{fSev.value=fProj.value=fDir.value='';apply()};
let expanded=false;
document.getElementById('fExpand').onclick=e=>{
  expanded=!expanded;
  document.querySelectorAll('details').forEach(d=>d.open=expanded);
  e.target.textContent=expanded?'全部收合':'全部展開';
};
apply();
</script>
</body>
</html>`;

const outPath = outFlag >= 0 && argv[outFlag + 1] ? argv[outFlag + 1] : join(DIR, `dependency-audit-${label}.html`);
writeFileSync(outPath, html);
console.log(`REPORT_OK ${outPath}`);
console.log(`  項目 ${findings.length}（CRITICAL ${sevCounts.CRITICAL} / HIGH ${sevCounts.HIGH}）` +
  ` · 已研究 ${researchBy.size} · 已實測 ${totalVerified} · 實測受阻 ${totalBlocked}`);
if (!research) console.log("  [提醒] 缺 research.json——報告中所有項目都會標示「未做網路研究」。");
if (!verify) console.log("  [提醒] 缺 verify.json——報告中所有項目都會標示「未實測」。");
