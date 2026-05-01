/**
 * Phase 4 Stage 6.3 — Orphan 真孤立分類 + grep 驗證
 *
 * 流程：
 *   1. 從 orphan-notes-report.md 抽 internal RPC + manager-method
 *   2. classifier 過濾：
 *      - internal RPC：全部視為候選（理論上 internal 應有 caller，沒 caller 就值得查）
 *      - manager-method：排除 polymorphic / private convention / base abstract / 短名 helper
 *   3. verifier：對每筆候選做 grep agrabah/src/ 兩種搜：
 *      - method name `\b<methodName>\(` （TS regex）
 *      - 對 RPC：完整 FQN 字面 `<server>.<service>.<Method>` （含字串 metaprogramming）
 *   4. 自動分類為：
 *      - PROPOSE_REMOVE: grep 全 0 命中 → 強候選
 *      - KEEP_LIKELY_DEAD: grep 有命中但 backlink audit 漏抓 → audit 工具改進方向
 *      - NEEDS_HUMAN_VERIFY: 其他（如 method 名太通用，grep 噪音多）
 *   5. 輸出 evaluation report 給 user 看，**不執行實際下架**
 */

import * as fs from 'fs'
import { execSync } from 'child_process'

const ROOT = '/Users/user/aladdin'
const ORPHAN_REPORT = `${ROOT}/obsidian/Codebase/_index/orphan-notes-report.md`
const AGRABAH_SRC = `${ROOT}/agrabah/src`
const OUT_REPORT = `${ROOT}/obsidian/Codebase/_index/orphan-takedown-evaluation.md`
const OUT_JSON = `${ROOT}/obsidian/Codebase/_index/orphan-takedown-candidates.json`

// ---- 1. parse orphan report ----
const orphanLines = fs.readFileSync(ORPHAN_REPORT, 'utf8').split('\n')
type OrphanRow = { fqn: string; type: 'rpc-method' | 'manager-method'; access: string }
const orphans: OrphanRow[] = []
const rowRe = /^\| \[\[([^\]]+)\]\] \| (rpc-method|manager-method) \| (.+?) \|/
for (const line of orphanLines) {
  const m = line.match(rowRe)
  if (!m) continue
  orphans.push({ fqn: m[1], type: m[2] as any, access: m[3].trim() })
}

console.log(`parsed orphans: ${orphans.length}`)

// ---- 2. classifier ----
const internalRpcCandidates = orphans.filter((o) => o.type === 'rpc-method' && o.access === 'internal')

// Manager-method classifier：排除明顯不該下架的
//   - 名稱以 _ 開頭：private 慣例
//   - manager class 為 *VendorAdapter / *Adapter / *Base / *Abstract：polymorphic / base
//   - method 名極短（< 4 字元）：可能是 utility helper，grep 命中率高、干擾大
//   - method 名為 TS / class built-in（constructor / toString / valueOf）— 非真實 method
const POLYMORPHIC_MGR_RE = /(VendorAdapter|Adapter|Base|Abstract)$/
const BUILT_IN_METHOD = new Set(['constructor', 'toString', 'valueOf', 'toJSON'])
const managerMethodCandidates = orphans.filter((o) => {
  if (o.type !== 'manager-method') return false
  // FQN 形式：Manager.<ManagerClass>.<methodName>
  const segs = o.fqn.split('.')
  if (segs.length !== 3 || segs[0] !== 'Manager') return false
  const mgr = segs[1]
  const method = segs[2]
  if (POLYMORPHIC_MGR_RE.test(mgr)) return false
  if (method.startsWith('_')) return false
  if (method.length < 4) return false
  if (BUILT_IN_METHOD.has(method)) return false
  return true
})

console.log(`internal-rpc candidates: ${internalRpcCandidates.length}`)
console.log(`manager-method candidates after filter: ${managerMethodCandidates.length}`)

// ---- 3. verifier ----
type Verdict = 'PROPOSE_REMOVE' | 'KEEP_LIKELY_DEAD' | 'NEEDS_HUMAN_VERIFY'
type Evaluation = {
  fqn: string
  type: string
  access?: string
  manager?: string
  method: string
  methodGrepHits: number
  fqnGrepHits?: number
  verdict: Verdict
  evidence: string
}

function safeGrepCount(pattern: string, isRegex: boolean): number {
  // grep -c counts lines per file; we want total. Use grep -r ... | wc -l.
  // Quote pattern via JSON.stringify; stay inside agrabah/src to avoid noise.
  const flag = isRegex ? '-rE' : '-rF'
  try {
    const cmd = `grep ${flag} -- ${JSON.stringify(pattern)} ${AGRABAH_SRC} 2>/dev/null | wc -l`
    return parseInt(execSync(cmd).toString().trim()) || 0
  } catch {
    return 0
  }
}

const evaluations: Evaluation[] = []

// internal RPC verification
for (const c of internalRpcCandidates) {
  const segs = c.fqn.split('.') // <server>.<service>.<Method>
  if (segs.length < 3) continue
  const method = segs[segs.length - 1]
  const fqnLiteral = c.fqn // exact match
  const fqnGrep = safeGrepCount(fqnLiteral, false)

  // 也試 method name `(\w*\.)?<Method>\(` 的 PascalCase call
  const methodGrep = safeGrepCount(`\\b${method}\\(`, true)

  let verdict: Verdict
  let evidence: string
  if (fqnGrep === 0 && methodGrep === 0) {
    verdict = 'PROPOSE_REMOVE'
    evidence = 'no grep hits in agrabah/src'
  } else if (fqnGrep > 0) {
    verdict = 'KEEP_LIKELY_DEAD'
    evidence = `fqn literal '${fqnLiteral}' grep hits: ${fqnGrep} (audit didn't index these callers)`
  } else if (methodGrep > 0 && methodGrep <= 5) {
    verdict = 'NEEDS_HUMAN_VERIFY'
    evidence = `method name '${method}' grep hits: ${methodGrep} (likely caller but not via FQN — string-based RPC?)`
  } else {
    verdict = 'NEEDS_HUMAN_VERIFY'
    evidence = `method name '${method}' grep hits: ${methodGrep} (high noise — common name)`
  }
  evaluations.push({
    fqn: c.fqn,
    type: 'internal-rpc',
    access: c.access,
    method,
    methodGrepHits: methodGrep,
    fqnGrepHits: fqnGrep,
    verdict,
    evidence,
  })
}

// manager-method verification
for (const c of managerMethodCandidates) {
  const segs = c.fqn.split('.') // Manager.<Class>.<method>
  const mgr = segs[1]
  const method = segs[2]

  // 對 manager method，搜兩種：
  //   1. `.<method>(`  — 任何屬性 access 的呼叫
  //   2. `<ClassName>.<method>(` — static call
  const dotMethodGrep = safeGrepCount(`\\.${method}\\(`, true)
  const staticGrep = safeGrepCount(`${mgr}.${method}(`, false)

  let verdict: Verdict
  let evidence: string
  if (dotMethodGrep === 0 && staticGrep === 0) {
    verdict = 'PROPOSE_REMOVE'
    evidence = 'no grep hits in agrabah/src'
  } else if (staticGrep > 0) {
    verdict = 'KEEP_LIKELY_DEAD'
    evidence = `static call '${mgr}.${method}' grep hits: ${staticGrep}`
  } else if (dotMethodGrep > 0 && dotMethodGrep <= 3) {
    verdict = 'NEEDS_HUMAN_VERIFY'
    evidence = `'.${method}(' grep hits: ${dotMethodGrep} (could be different class)`
  } else {
    verdict = 'NEEDS_HUMAN_VERIFY'
    evidence = `'.${method}(' grep hits: ${dotMethodGrep} (high noise — common method name)`
  }

  evaluations.push({
    fqn: c.fqn,
    type: 'manager-method',
    manager: mgr,
    method,
    methodGrepHits: dotMethodGrep,
    fqnGrepHits: staticGrep,
    verdict,
    evidence,
  })
}

// ---- 4. report ----
const summary = {
  totalCandidates: evaluations.length,
  byVerdict: {
    PROPOSE_REMOVE: evaluations.filter((e) => e.verdict === 'PROPOSE_REMOVE').length,
    KEEP_LIKELY_DEAD: evaluations.filter((e) => e.verdict === 'KEEP_LIKELY_DEAD').length,
    NEEDS_HUMAN_VERIFY: evaluations.filter((e) => e.verdict === 'NEEDS_HUMAN_VERIFY').length,
  },
  byType: {
    'internal-rpc': evaluations.filter((e) => e.type === 'internal-rpc').length,
    'manager-method': evaluations.filter((e) => e.type === 'manager-method').length,
  },
}

console.log('=== Summary ===')
console.log(JSON.stringify(summary, null, 2))

fs.writeFileSync(
  OUT_JSON,
  JSON.stringify(
    {
      timestamp: new Date().toISOString(),
      summary,
      evaluations,
    },
    null,
    2,
  ),
)

// markdown report — 分 section by verdict / type
const md: string[] = []
md.push('# Orphan Takedown Evaluation Report')
md.push('')
md.push(`Generated: ${new Date().toISOString()}`)
md.push('')
md.push('> Phase 4 Stage 6.3 產出。對 orphan-notes-report.md 中的 internal RPC + 篩選後 manager-method 候選，')
md.push('> 用 grep agrabah/src 全範圍兩種搜（method name + FQN literal / static call）做最終驗證。')
md.push('> **此報告僅評估，不執行下架** — 由 user 決定是否實際刪除/標 deprecated。')
md.push('')
md.push('## Summary')
md.push('')
md.push('| 指標 | 數值 |')
md.push('|------|------|')
md.push(`| 候選總數 | ${summary.totalCandidates} |`)
md.push(`| internal-rpc 候選 | ${summary.byType['internal-rpc']} |`)
md.push(`| manager-method 候選（過濾 polymorphic/_/<4字後）| ${summary.byType['manager-method']} |`)
md.push(`| **PROPOSE_REMOVE**（grep 0 命中，強候選下架） | ${summary.byVerdict.PROPOSE_REMOVE} |`)
md.push(`| KEEP_LIKELY_DEAD（grep 有命中但 audit 漏抓 — audit 改進方向） | ${summary.byVerdict.KEEP_LIKELY_DEAD} |`)
md.push(`| NEEDS_HUMAN_VERIFY（method name grep 命中，可能 false dead） | ${summary.byVerdict.NEEDS_HUMAN_VERIFY} |`)
md.push('')

md.push('## PROPOSE_REMOVE — 強候選下架（請逐筆人工確認後決定）')
md.push('')
md.push('| FQN | Type | Method | Evidence |')
md.push('|-----|------|--------|----------|')
for (const e of evaluations.filter((e) => e.verdict === 'PROPOSE_REMOVE')) {
  md.push(`| [[${e.fqn}]] | ${e.type} | ${e.method} | ${e.evidence} |`)
}
md.push('')

md.push('## KEEP_LIKELY_DEAD — audit 漏抓 caller')
md.push('')
md.push('這類筆記 grep 顯示**有 caller**但 backlink 沒抓到。意味著 audit-call-chain 還有遺漏的呼叫 pattern（如 string-based RPC、metaprogramming）。屬 audit 工具改進方向，而非真孤立。')
md.push('')
md.push('| FQN | Type | Hits | Evidence |')
md.push('|-----|------|------|----------|')
for (const e of evaluations.filter((e) => e.verdict === 'KEEP_LIKELY_DEAD')) {
  md.push(`| [[${e.fqn}]] | ${e.type} | ${e.fqnGrepHits ?? '-'} | ${e.evidence} |`)
}
md.push('')

md.push('## NEEDS_HUMAN_VERIFY — 需人工判斷')
md.push('')
md.push('method name grep 有命中但無法判斷是否真為對應方法（同名方法或屬性 access）。')
md.push('')
md.push('| FQN | Type | grep hits | Evidence |')
md.push('|-----|------|-----------|----------|')
for (const e of evaluations.filter((e) => e.verdict === 'NEEDS_HUMAN_VERIFY')) {
  md.push(`| [[${e.fqn}]] | ${e.type} | ${e.methodGrepHits} | ${e.evidence} |`)
}
md.push('')

fs.writeFileSync(OUT_REPORT, md.join('\n'))
console.log(`report → ${OUT_REPORT}`)
console.log(`json → ${OUT_JSON}`)
