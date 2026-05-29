#!/usr/bin/env node
// merge-impact.js — merge 12 worker output files into changes-with-impact.json
//
// Usage:
//   node merge-impact.js <workdir> <changes-source.json>
// Example:
//   node merge-impact.js /tmp/changelog/v2 /tmp/changelog/v2/changes-source.json
//
// Inputs (must exist in <workdir>):
//   impact-agrabah-<VER>.json
//   impact-rajah-<VER>.json
//   impact-abu-<VER>.json
//   impact-lago-<VER>.json
//   (12 files total: 4 repos × N versions)
//
// Output:
//   <workdir>/changes-with-impact.json
//   - same shape as changes-source.json with `impact` field added to each change
//   - sentences keep worker tags `**[後端 agrabah]**` etc — Stage 6 rewriter will normalize

const fs = require('fs');
const path = require('path');

const [workdir, sourcePath] = process.argv.slice(2);
if (!workdir || !sourcePath) {
  console.error('Usage: node merge-impact.js <workdir> <changes-source.json>');
  process.exit(1);
}

const REPOS = ['agrabah', 'rajah', 'abu', 'lago'];
const REPO_LABEL = {
  agrabah: '後端 agrabah',
  rajah:   'RPC 契約 rajah',
  abu:     '後台前端 abu',
  lago:    '玩家端 lago',
};

const source = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));

// Auto-discover versions from source changes
const VERS = Array.from(new Set(source.changes.map(c => c.ver)));
console.error('Discovered versions:', VERS.join(', '));

const impactByIdx = {};
const missing = [];
for (const v of VERS) {
  for (const r of REPOS) {
    const f = path.join(workdir, `impact-${r}-${v}.json`);
    if (!fs.existsSync(f)) { missing.push(`impact-${r}-${v}.json`); continue; }
    const data = JSON.parse(fs.readFileSync(f, 'utf8'));
    for (const item of data.results) {
      if (!impactByIdx[item.idx]) impactByIdx[item.idx] = {};
      impactByIdx[item.idx][r] = item.impact;
    }
  }
}
if (missing.length) {
  console.error('MISSING worker outputs:');
  for (const m of missing) console.error('  - ' + m);
  process.exit(1);
}

function isNotFound(s) {
  return /找不到對應 commit/.test(s) || /在 \w+ 找不到/.test(s) || /可能屬於其他 repo/.test(s);
}
function isNA(s) {
  return /^N\/?A\b/i.test(s.trim());
}

function mergeImpact(repoImpacts) {
  const meaningful = [];
  const naSeen = new Set();
  for (const r of REPOS) {
    const arr = repoImpacts[r] || [];
    for (const s of arr) {
      const cleaned = s.trim();
      if (isNotFound(cleaned)) continue;
      if (isNA(cleaned)) {
        const reason = cleaned.replace(/^N\/?A\s*[—\-]\s*/i, '').replace(/^N\/?A\b/i, '').trim();
        const key = reason || 'N/A';
        if (!naSeen.has(key)) naSeen.add(key);
        continue;
      }
      meaningful.push({ repo: r, sentence: cleaned });
    }
  }
  if (meaningful.length > 0) {
    return meaningful.map(m => `**[${REPO_LABEL[m.repo]}]** ${m.sentence}`);
  }
  if (naSeen.size > 0) {
    return ['N/A — ' + Array.from(naSeen).slice(0, 2).join('；')];
  }
  return ['（4 個 repo 皆無對應 commit；推測為純文件 / 配置 / i18n 變更）'];
}

let stats = { total: 0, real: 0, na: 0, empty: 0 };
for (const c of source.changes) {
  c.impact = mergeImpact(impactByIdx[c.idx] || {});
  stats.total++;
  if (c.impact[0].startsWith('N/A')) stats.na++;
  else if (c.impact[0].startsWith('（')) stats.empty++;
  else stats.real++;
}

const outPath = path.join(workdir, 'changes-with-impact.json');
fs.writeFileSync(outPath, JSON.stringify(source, null, 2));
console.error('Written:', outPath);
console.error('Stats:', stats);
