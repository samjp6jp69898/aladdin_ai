import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from "fs";

const TRACKER = "/Users/user/.claude/projects/-Users-user-aladdin/memory/backtest_tracker.md";
const NOTES_DIR = "/Users/user/aladdin/obsidian/backTesting";
const TEMP_DIR = "/Users/user/aladdin/obsidian/skills/back-testing-stats/temp";

const raw = readFileSync(TRACKER, "utf8");
const lines = raw.split("\n");

interface Row {
  id: string;
  severity: string;
  status: string;      // 回測狀態
  conclusion: string;  // 回測結論
  finishedAt: string;  // 完成時間
}

const rows: Row[] = [];
for (const line of lines) {
  if (!line.trim().startsWith("|")) continue;
  const cells = line.split("|").map((c) => c.trim());
  // cells[0] is '' (leading), so first real cell is cells[1]
  const id = cells[1];
  if (!id || !id.startsWith("FAQ-")) continue;
  rows.push({
    id,
    severity: cells[3] ?? "",
    status: cells[6] ?? "",
    conclusion: cells[7] ?? "",
    finishedAt: cells[9] ?? "",
  });
}

// classify partial A/B via obsidian note Failure Mode section
let noteFiles: string[] = [];
try { noteFiles = readdirSync(NOTES_DIR); } catch { noteFiles = []; }

function classifyPartial(id: string): "A" | "B" {
  // find {id}-*.md
  const match = noteFiles.find((f) => f.startsWith(id + "-") && f.endsWith(".md"));
  if (!match) return "B";
  let content = "";
  try { content = readFileSync(NOTES_DIR + "/" + match, "utf8"); } catch { return "B"; }
  // extract ## Failure Mode section
  const idx = content.indexOf("## Failure Mode");
  if (idx === -1) return "B";
  // section runs until next "## " heading
  const after = content.slice(idx + "## Failure Mode".length);
  const nextHeading = after.indexOf("\n## ");
  const section = nextHeading === -1 ? after : after.slice(0, nextHeading);
  return section.includes("alternative-path") ? "A" : "B";
}

const CONC = {
  correct: "✅ 分析正確",
  partial: "✅ 部分正確",
  wrong: "❌ 分析錯誤",
  unable: "⚠️ 無法比對",
  no_fix: "➖ 不需修復",
};

interface Bucket {
  total: number;
  done: number;
  correct: number;
  partial: number;
  partial_A: number;
  partial_B: number;
  wrong: number;
  unable: number;
  no_fix: number;
}
function emptyBucket(): Bucket {
  return { total: 0, done: 0, correct: 0, partial: 0, partial_A: 0, partial_B: 0, wrong: 0, unable: 0, no_fix: 0 };
}

const overall = emptyBucket();
let failed = 0;
let in_progress = 0;
const sev: Record<string, Bucket> = {
  "P1重點": emptyBucket(),
  "P2較高": emptyBucket(),
  "P3一般": emptyBucket(),
  "P4較低": emptyBucket(),
};

// for trend (done rows with finishedAt, sorted)
interface DoneRow { id: string; conclusion: string; partialType?: "A" | "B"; finishedAt: string; }
const doneRows: DoneRow[] = [];

for (const r of rows) {
  overall.total++;
  const b = sev[r.severity];
  if (b) b.total++;

  if (r.status === "done") {
    overall.done++;
    if (b) b.done++;
    let partialType: "A" | "B" | undefined;
    switch (r.conclusion) {
      case CONC.correct: overall.correct++; if (b) b.correct++; break;
      case CONC.partial: {
        overall.partial++; if (b) b.partial++;
        partialType = classifyPartial(r.id);
        if (partialType === "A") { overall.partial_A++; if (b) b.partial_A++; }
        else { overall.partial_B++; if (b) b.partial_B++; }
        break;
      }
      case CONC.wrong: overall.wrong++; if (b) b.wrong++; break;
      case CONC.unable: overall.unable++; if (b) b.unable++; break;
      case CONC.no_fix: overall.no_fix++; if (b) b.no_fix++; break;
    }
    if (r.finishedAt && /\d{8}/.test(r.finishedAt)) {
      doneRows.push({ id: r.id, conclusion: r.conclusion, partialType, finishedAt: r.finishedAt });
    }
  } else if (r.status === "failed") {
    failed++;
  } else {
    in_progress++; // pending / in_progress / others
  }
}

function pct(n: number, d: number): string {
  if (d === 0) return "—";
  return ((n / d) * 100).toFixed(1) + "%";
}
function rates(b: Bucket) {
  const eff = b.done - b.no_fix;
  return {
    eff,
    strict: eff ? (b.correct / eff) * 100 : null,
    equiv: eff ? ((b.correct + b.partial_A) / eff) * 100 : null,
    total: eff ? ((b.correct + b.partial) / eff) * 100 : null,
  };
}

const oRates = rates(overall);

// build cumulative trend series, sorted ascending by finishedAt (YYYYMMDD HHMM)
function ts(s: string): string {
  // normalize "20260602 1651" -> "202606021651"
  return s.replace(/\s+/g, "");
}
doneRows.sort((a, b) => ts(a.finishedAt).localeCompare(ts(b.finishedAt)));

const trend: { idx: number; id: string; strict: number; equiv: number; total: number }[] = [];
let cCorrect = 0, cPartialA = 0, cPartial = 0, cDone = 0;
doneRows.forEach((d, i) => {
  cDone++;
  if (d.conclusion === CONC.correct) cCorrect++;
  else if (d.conclusion === CONC.partial) { cPartial++; if (d.partialType === "A") cPartialA++; }
  // note: for trend, denominator uses done_so_far (per spec 4a — includes no_fix)
  trend.push({
    idx: i + 1,
    id: d.id,
    strict: (cCorrect / cDone) * 100,
    equiv: ((cCorrect + cPartialA) / cDone) * 100,
    total: ((cCorrect + cPartial) / cDone) * 100,
  });
});

// timestamp for filename
const now = new Date();
const p2 = (n: number) => String(n).padStart(2, "0");
const stamp = `${now.getFullYear()}${p2(now.getMonth() + 1)}${p2(now.getDate())}-${p2(now.getHours())}${p2(now.getMinutes())}`;

// ---- emit console summary as JSON for the assistant ----
const summary = {
  overall, failed, in_progress, oRates,
  sev: Object.fromEntries(Object.entries(sev).map(([k, b]) => [k, { ...b, rates: rates(b) }])),
  trendLen: trend.length,
  stamp,
};
console.log("===JSON_START===");
console.log(JSON.stringify(summary, null, 2));
console.log("===JSON_END===");

// ---- generate HTML ----
const sevColors: Record<string, string> = {
  "P1重點": "#e53935", "P2較高": "#fb8c00", "P3一般": "#fdd835", "P4較低": "#1e88e5",
};

function sevRow(name: string): string {
  const b = sev[name];
  const r = rates(b);
  const color = sevColors[name];
  if (b.done === 0) {
    return `<tr><td><span class="sev-tag" style="background:${color}">${name}</span></td>
      <td>${b.total}</td><td>—</td><td>—</td><td>—</td><td>—</td><td>—</td><td>—</td>
      <td>—</td><td class="bold">—</td><td>—</td></tr>`;
  }
  return `<tr><td><span class="sev-tag" style="background:${color}">${name}</span></td>
    <td>${b.total}</td><td>${b.correct}</td><td>${b.partial_A}</td><td>${b.partial_B}</td>
    <td>${b.wrong}</td><td>${b.unable}</td><td>${b.no_fix}</td>
    <td>${pct(b.correct, r.eff)}</td>
    <td class="bold">${pct(b.correct + b.partial_A, r.eff)}</td>
    <td>${pct(b.correct + b.partial, r.eff)}</td></tr>`;
}

function bar(label: string, count: number, denom: number, color: string): string {
  const w = denom ? (count / denom) * 100 : 0;
  return `<div class="bar-row">
    <div class="bar-label">${label}</div>
    <div class="bar-track"><div class="bar-fill" style="width:${w.toFixed(1)}%;background:${color}"></div></div>
    <div class="bar-val">${count} (${pct(count, denom)})</div>
  </div>`;
}

const eff = oRates.eff;
const html = `<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>回測統計報告 ${stamp}</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang TC", "Microsoft JhengHei", sans-serif;
    background: #f5f5f5; color: #222; margin: 0; padding: 32px; }
  .wrap { max-width: 1080px; margin: 0 auto; }
  h1 { font-size: 24px; margin: 0 0 4px; }
  .sub { color: #888; font-size: 13px; margin-bottom: 24px; }
  .container { background: #fff; border-radius: 12px; box-shadow: 0 1px 4px rgba(0,0,0,.08);
    padding: 24px; margin-bottom: 24px; }
  .container h2 { font-size: 17px; margin: 0 0 18px; }
  .cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin-bottom: 24px; }
  .card { border-radius: 12px; padding: 20px; text-align: center; }
  .card.main { background: linear-gradient(135deg,#43a047,#66bb6a); color:#fff; }
  .card.strict { background:#f0f0f0; }
  .card.total { background:#e3f2fd; }
  .card .big { font-size: 38px; font-weight: 700; line-height: 1.1; }
  .card .cap { font-size: 13px; margin-top: 6px; opacity: .9; }
  .card .note { font-size: 11px; margin-top: 4px; opacity: .7; }
  .bar-row { display: grid; grid-template-columns: 120px 1fr 130px; align-items: center; gap: 12px; margin: 8px 0; }
  .bar-label { font-size: 13px; }
  .bar-track { background:#eee; border-radius: 6px; height: 18px; overflow: hidden; }
  .bar-fill { height: 100%; border-radius: 6px; }
  .bar-val { font-size: 12px; color:#555; text-align: right; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  th, td { padding: 8px 10px; text-align: center; border-bottom: 1px solid #eee; }
  th { background:#fafafa; font-weight: 600; }
  td.bold, th.bold { font-weight: 700; }
  .sev-tag { color:#fff; padding: 2px 8px; border-radius: 10px; font-size: 12px; }
  .chart-box { position: relative; height: 420px; }
</style>
</head>
<body>
<div class="wrap">
  <h1>回測統計報告</h1>
  <div class="sub">生成時間 ${stamp} ・ 回測總計 ${overall.total} tickets ・ 有效樣本 ${eff}（排除 ${overall.no_fix} 張不需修復）</div>

  <!-- Section 1 -->
  <div class="container">
    <h2>總覽</h2>
    <div class="cards">
      <div class="card main">
        <div class="big">${oRates.equiv != null ? oRates.equiv.toFixed(1) + "%" : "—"}</div>
        <div class="cap">完全成功率（含等效）</div>
        <div class="note">主要指標 ・ 已完成 ${overall.done} / 有效 ${eff}</div>
      </div>
      <div class="card strict">
        <div class="big">${oRates.strict != null ? oRates.strict.toFixed(1) + "%" : "—"}</div>
        <div class="cap">嚴格正確率</div>
        <div class="note">僅完全對齊 commit ${overall.correct} 張</div>
      </div>
      <div class="card total">
        <div class="big">${oRates.total != null ? oRates.total.toFixed(1) + "%" : "—"}</div>
        <div class="cap">總成功率</div>
        <div class="note">含部分正確 B 不完整</div>
      </div>
    </div>
    ${bar("✅ 分析正確", overall.correct, eff, "#43a047")}
    ${bar("✅ 部分正確 A 等效", overall.partial_A, eff, "#81c784")}
    ${bar("✅ 部分正確 B 不完整", overall.partial_B, eff, "#ffb74d")}
    ${bar("❌ 分析錯誤", overall.wrong, eff, "#e53935")}
    ${bar("⚠️ 無法比對", overall.unable, eff, "#90a4ae")}
    ${bar("➖ 不需修復", overall.no_fix, overall.done, "#cfd8dc")}
    <div class="sub" style="margin-top:14px;margin-bottom:0">
      百分比分母為有效樣本 ${eff}（done ${overall.done} − 不需修復 ${overall.no_fix}）；「不需修復」列分母為 done ${overall.done}，不計入正確率。
    </div>
  </div>

  <!-- Section 2 -->
  <div class="container">
    <h2>各嚴重性等級成功率</h2>
    <table>
      <thead>
        <tr>
          <th>嚴重性</th><th>總數</th><th>正確</th><th>部分A</th><th>部分B</th>
          <th>錯誤</th><th>無法比對</th><th>不需修復</th>
          <th>嚴格率</th><th class="bold">含等效率</th><th>總成功率</th>
        </tr>
      </thead>
      <tbody>
        ${sevRow("P1重點")}
        ${sevRow("P2較高")}
        ${sevRow("P3一般")}
        ${sevRow("P4較低")}
      </tbody>
    </table>
  </div>

  <!-- Section 3 -->
  <div class="container">
    <h2>累積成功率趨勢</h2>
    <div class="chart-box"><canvas id="trend"></canvas></div>
  </div>
</div>

<script>
const TREND = ${JSON.stringify(trend)};
const labels = TREND.map(t => t.idx);
const ids = TREND.map(t => t.id);
new Chart(document.getElementById('trend'), {
  type: 'line',
  data: {
    labels,
    datasets: [
      { label: '嚴格正確率', data: TREND.map(t=>t.strict), borderColor:'#9e9e9e', borderDash:[6,4], borderWidth:1.5, pointRadius:0, tension:.2 },
      { label: '完全成功率(含等效)', data: TREND.map(t=>t.equiv), borderColor:'#43a047', borderWidth:3, pointRadius:0, tension:.2 },
      { label: '總成功率', data: TREND.map(t=>t.total), borderColor:'#1e88e5', borderWidth:2, pointRadius:0, tension:.2 },
    ]
  },
  options: {
    responsive: true, maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { display: true },
      title: { display: true, text: '累積成功率趨勢' },
      tooltip: {
        callbacks: {
          title: (items) => '#' + items[0].label + ' ' + ids[items[0].dataIndex],
          label: (item) => item.dataset.label + ': ' + item.parsed.y.toFixed(1) + '%',
        }
      }
    },
    scales: {
      y: { min: 0, max: 100, title: { display: true, text: '成功率 (%)' } },
      x: { title: { display: true, text: '完成順序' } }
    }
  }
});
</script>
</body>
</html>`;

if (!existsSync(TEMP_DIR)) mkdirSync(TEMP_DIR, { recursive: true });
const outPath = `${TEMP_DIR}/back-testing-stats-${stamp}.html`;
writeFileSync(outPath, html, "utf8");
console.log("HTML_PATH=" + outPath);
