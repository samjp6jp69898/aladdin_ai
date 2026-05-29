#!/usr/bin/env node
// Parse abu/admin and abu/platform menu.ts files into tree structures, then
// look up the menu.<name> Chinese label from each project's localizations/zh-TW.json.
//
// Usage:
//   node parse-abu-menu.js [output.json]
//   default output: /tmp/changelog/menu-tree.json
//
// Inputs (hardcoded — abu is at fixed location):
//   /Users/user/aladdin/abu/platform/src/menu.ts
//   /Users/user/aladdin/abu/admin/src/menu.ts
//   /Users/user/aladdin/abu/<app>/localizations/zh-TW.json

const fs = require('fs');
const path = require('path');

function parseMenuFile(menuPath) {
  let src = fs.readFileSync(menuPath, 'utf8');

  // Collect identifiers from imports so we can stub them out
  const idents = new Set();
  for (const m of src.matchAll(/import\s+(\w+|\{[^}]+\})\s+from\s+['"][^'"]+['"];?/g)) {
    const what = m[1];
    if (what.startsWith('{')) {
      for (const n of what.slice(1, -1).split(',')) {
        const clean = n.trim().replace(/^type\s+/, '').replace(/\s+as\s+\w+$/, '');
        if (clean) idents.add(clean);
      }
    } else {
      idents.add(what);
    }
  }

  // Strip imports + export + type annotations
  let cleaned = src
    .replace(/^import .*?;?\s*$/gms, '')
    .replace(/^export\s+/gm, '')
    .replace(/:\s*MenuGroup(\[\])?(?=\s*=)/g, '')
    .replace(/\bas\s+const\b/g, '');

  // Also handle the inline `() => import('./...vue')` factory
  cleaned = cleaned.replace(/=>\s*import\s*\(\s*['"][^'"]+['"]\s*\)/g, '=> null');

  // localStorage stub
  cleaned = `const localStorage = { getItem: () => null };\n` + cleaned;

  // Don't redeclare 'group' / 'item' — we provide our own stubs below
  idents.delete('group');
  idents.delete('item');
  idents.delete('MenuGroup');
  idents.delete('MenuItem');
  const stubs = [...idents].map(id => `const ${id} = null;`).join('\n');

  const body = `
    ${stubs}
    const group = (name, icon, perm, mod, route, children) => ({ type: 'group', name, perm: perm || '', route: route || '', children: children || [] });
    const item  = (name, icon, perm, mod, route, comp)   => ({ type: 'item',  name, perm: perm || '', route: route || '' });
    ${cleaned}
    return MainMenuContent;
  `;

  return new Function(body)();
}

const platformTree = parseMenuFile('/Users/user/aladdin/abu/platform/src/menu.ts');
const adminTree    = parseMenuFile('/Users/user/aladdin/abu/admin/src/menu.ts');

// Load localizations once
function loadZh(project) {
  const file = `/Users/user/aladdin/abu/${project}/localizations/zh-TW.json`;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

const zhPlatform = loadZh('platform');
const zhAdmin = loadZh('admin');

function labelFor(zh, name) {
  // menu section
  if (zh.menu && zh.menu[name]) return zh.menu[name];
  return null;
}

function enrichTree(tree, zh) {
  function walk(node, depth, parents) {
    const label = labelFor(zh, node.name) || node.name;
    const result = {
      name: node.name,
      label,
      perm: node.perm,
      route: node.route,
      type: node.type,
      depth,
      children: [],
    };
    if (node.children && node.children.length > 0) {
      for (const c of node.children) {
        result.children.push(walk(c, depth + 1, [...parents, result]));
      }
    }
    return result;
  }
  return tree.map(t => walk(t, 0, []));
}

const platformEnriched = enrichTree(platformTree, zhPlatform);
const adminEnriched    = enrichTree(adminTree, zhAdmin);

// Output JSON
const out = {
  platform: platformEnriched,
  admin: adminEnriched,
};

const outPath = process.argv[2] || '/tmp/changelog/menu-tree.json';
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(out, null, 2));

function countLeaves(nodes) {
  let n = 0;
  for (const x of nodes) {
    if (!x.children || x.children.length === 0) n++;
    else n += countLeaves(x.children);
  }
  return n;
}
console.error(`Wrote: ${outPath}`);
console.error(`Leaf counts — platform: ${countLeaves(platformEnriched)}, admin: ${countLeaves(adminEnriched)}`);
