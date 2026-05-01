/**
 * Phase 4 Stage 6.2 (a) — Manager `_overview.md` / `_manager.md` 反推 server
 *
 * 對每個含 `primary_servers: [TBD]` / `used_by_servers: [TBD]` 的 manager 筆記：
 *   1. grep `\[\[Manager.<X>.` 在 Codebase/Servers/ 下出現過的檔案路徑
 *   2. 從路徑抽 server 目錄名（PascalCase），first-letter-lowercase 得 camelCase server name
 *   3. 用該 set 填 primary_servers + used_by_servers（沿用既有筆記慣例 — 兩者相同）
 *   4. 若 set 為空，填 `[]` 而非保留 [TBD]（明確表達「目前未在 Codebase/Servers/ 下找到呼叫」）
 *
 * 一次性 script，作 audit trail。
 */

import * as fs from 'fs'
import * as path from 'path'
import { execSync } from 'child_process'

const MANAGERS_ROOT = '/Users/user/aladdin/obsidian/Codebase/Managers'
const SERVERS_ROOT = '/Users/user/aladdin/obsidian/Codebase/Servers'

// 找出含 [TBD] 的 _overview.md / _manager.md
function findTBDFiles(): string[] {
  const out = execSync(
    `grep -lE "primary_servers: \\[TBD\\]|used_by_servers: \\[TBD\\]" ` +
      `${MANAGERS_ROOT}/*/_overview.md ${MANAGERS_ROOT}/*/_manager.md 2>/dev/null || true`
  ).toString()
  return out.split('\n').filter(Boolean)
}

// 從 manager dir name 反推 callers
// 涵蓋四種 wikilink 寫法：
//   [[Manager.X.method]]、[[Manager.X]]、[[X.method]]、[[X]]
function findCallers(managerName: string): string[] {
  // 用 ERE: \[\[(Manager\.)?X(\.|\]|\|)
  const pattern = `\\[\\[(Manager\\.)?${managerName}(\\.|\\]|\\|)`
  let out: string
  try {
    out = execSync(
      `grep -rlE -- ${JSON.stringify(pattern)} ${SERVERS_ROOT}/ 2>/dev/null || true`
    ).toString()
  } catch {
    out = ''
  }
  const serverDirs = new Set<string>()
  for (const filePath of out.split('\n').filter(Boolean)) {
    const rel = filePath.slice(SERVERS_ROOT.length + 1)
    const firstSeg = rel.split('/')[0]
    if (firstSeg) serverDirs.add(firstSeg)
  }
  // PascalCase → camelCase（first letter lowercase）
  return [...serverDirs]
    .map((d) => d.charAt(0).toLowerCase() + d.slice(1))
    .sort()
}

const stats = {
  filesProcessed: 0,
  primaryFilled: 0,
  usedByFilled: 0,
  emptySet: 0, // 該 manager 在 Codebase/Servers/ 下找不到任何 [[Manager.X. 引用
}

for (const filePath of findTBDFiles()) {
  const managerName = path.basename(path.dirname(filePath))
  const callers = findCallers(managerName)
  const arrLiteral = `[${callers.join(', ')}]`

  let content = fs.readFileSync(filePath, 'utf8')
  let changed = false

  if (/^primary_servers: \[TBD\]/m.test(content)) {
    content = content.replace(/^primary_servers: \[TBD\]/m, `primary_servers: ${arrLiteral}`)
    stats.primaryFilled++
    changed = true
  }
  if (/^used_by_servers: \[TBD\]/m.test(content)) {
    content = content.replace(/^used_by_servers: \[TBD\]/m, `used_by_servers: ${arrLiteral}`)
    stats.usedByFilled++
    changed = true
  }

  if (changed) {
    fs.writeFileSync(filePath, content)
    stats.filesProcessed++
    if (callers.length === 0) stats.emptySet++
    console.log(
      `  ${managerName.padEnd(30)} → ${callers.length === 0 ? '(empty)' : callers.join(', ')}`
    )
  }
}

console.log()
console.log('=== Stats ===')
console.log('files processed:', stats.filesProcessed)
console.log('primary_servers filled:', stats.primaryFilled)
console.log('used_by_servers filled:', stats.usedByFilled)
console.log('empty server set (no callers found):', stats.emptySet)
