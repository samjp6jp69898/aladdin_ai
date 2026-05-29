#!/usr/bin/env node
// build-html.js — combine menu-tree.json + changes.json + template.html → output HTML
//
// Usage:
//   node build-html.js <menu-tree.json> <changes.json> <output.html>
//
// changes.json schema:
//   {
//     "lago":     [{ "name": "_lago.<area>", "label": "...", "tags"?: ["n8"|"ny"|"pk"] }, ...],
//     "other":    [{ "name": "_internal.<slug>", "label": "..." }, ...],
//     "changes":  [{ "ver": "518"|..., "type": "add"|"adj"|"fix"|"internal",
//                    "leaves": ["<leafName>", "admin:<leafName>", "_lago.*", "_internal.*"],
//                    "apps"?: ["platform"|"admin"|"n8"|"ny"|"pk"],  // v3: drives the front-end app filter (multi-select chip)
//                    "title": "...", "subs"?: [...], "tags"?: [...] }, ...]
//   }

const fs = require('fs');
const path = require('path');

const [menuPath, changesPath, outPath] = process.argv.slice(2);
if (!menuPath || !changesPath || !outPath) {
  console.error('Usage: node build-html.js <menu-tree.json> <changes.json> <output.html>');
  process.exit(1);
}

const menuTree = JSON.parse(fs.readFileSync(menuPath, 'utf8'));
const changesData = JSON.parse(fs.readFileSync(changesPath, 'utf8'));

const lagoTree   = changesData.lago    || [];
const otherTree  = changesData.other   || [];
const CHANGES    = changesData.changes || [];

function collectLeaves(nodes, prefix = '') {
  const out = new Set();
  function walk(n) {
    if (n.type === 'item' || !n.children || n.children.length === 0) {
      out.add(prefix + n.name);
    }
    for (const c of (n.children || [])) walk(c);
  }
  for (const n of nodes) walk(n);
  return out;
}

const platformLeaves = collectLeaves(menuTree.platform);
const adminLeaves    = collectLeaves(menuTree.admin, 'admin:');
const lagoLeaves     = new Set(lagoTree.map(x => x.name));
const otherLeaves    = new Set(otherTree.map(x => x.name));
const allLeaves      = new Set([...platformLeaves, ...adminLeaves, ...lagoLeaves, ...otherLeaves]);

const issues = [];
for (const c of CHANGES) {
  if (!Array.isArray(c.leaves) || c.leaves.length === 0) {
    issues.push(`Change has no leaves: ${c.title}`);
    continue;
  }
  for (const l of c.leaves) {
    if (!allLeaves.has(l)) issues.push(`Unknown leaf "${l}" in: ${c.title}`);
  }
}
if (issues.length) {
  console.error('VALIDATION ISSUES:');
  for (const i of issues) console.error('  - ' + i);
  process.exit(1);
}

console.error(`Validated: ${CHANGES.length} changes across ${allLeaves.size} leaves`);
console.error(`  platform: ${platformLeaves.size}, admin: ${adminLeaves.size}, lago: ${lagoLeaves.size}, other: ${otherLeaves.size}`);

const data = {
  platform: menuTree.platform,
  admin: menuTree.admin,
  lago: lagoTree,
  other: otherTree,
  changes: CHANGES,
};

const tpl = fs.readFileSync(path.join(__dirname, 'template.html'), 'utf8');
const html = tpl.replace('/*__DATA__*/', 'window.__DATA__ = ' + JSON.stringify(data) + ';');

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, html);
console.error(`Wrote: ${outPath} (${html.length} bytes)`);
