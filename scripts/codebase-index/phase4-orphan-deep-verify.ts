/**
 * Phase 4 Stage 6.3+ — Orphan PROPOSE_REMOVE 候選 deep verification
 *
 * 對 Stage 6.3 標 PROPOSE_REMOVE 的 78 個候選做擴大範圍最終確認：
 *   - 範圍：agrabah/src + agrabah/tests + agrabah/public_services（如有）+ rajah/{services,jobs,messages}
 *   - 方式：一次 in-memory load 所有目標檔案，對 78 個 fqn 用 JS regex match
 *   - 輸出：升級版 evaluation report，每個 PROPOSE_REMOVE 加：
 *     - source_file:source_line（從筆記讀，方便 user 直接 jump）
 *     - extended grep hits（agrabah 全 + rajah 全）
 *     - 最終 verdict：CONFIRMED_REMOVE / RAJAH_DEFINED_BUT_NO_CALLER / OTHERS
 */

import * as fs from 'fs'
import * as path from 'path'
import { Glob } from 'bun'

const ROOT = '/Users/user/aladdin'
const CANDIDATES_JSON = `${ROOT}/obsidian/Codebase/_index/orphan-takedown-candidates.json`
const OUT_REPORT = `${ROOT}/obsidian/Codebase/_index/orphan-takedown-evaluation.md`
const OUT_JSON = `${ROOT}/obsidian/Codebase/_index/orphan-takedown-candidates.json`

// ---- 1. load candidates ----
type Eval = {
  fqn: string
  type: string
  access?: string
  manager?: string
  method: string
  methodGrepHits: number
  fqnGrepHits?: number
  verdict: string
  evidence: string
  // deep-verify 新增欄位
  sourceFile?: string
  sourceLine?: number
  extendedHits?: { agrabahSrc: number; agrabahTests: number; rajah: number }
  finalVerdict?: 'CONFIRMED_REMOVE' | 'RAJAH_DEFINED_BUT_NO_CALLER' | 'FOUND_IN_TESTS_ONLY' | 'FOUND_OUTSIDE_SRC'
}

const data = JSON.parse(fs.readFileSync(CANDIDATES_JSON, 'utf8'))
const evaluations: Eval[] = data.evaluations
const proposeRemove = evaluations.filter((e) => e.verdict === 'PROPOSE_REMOVE')
console.log(`PROPOSE_REMOVE candidates: ${proposeRemove.length}`)

// ---- 2. 從筆記抽 source_file / source_line ----
function findNotePathByFqn(fqn: string): string | null {
  // RPC method note path: Codebase/Servers/<Server>/services/<Service>/methods/<fqn>.md
  // Manager method note path: Codebase/Managers/<ClassName>/methods/<fqn>.md
  const codebaseRoot = `${ROOT}/obsidian/Codebase`
  if (fqn.startsWith('Manager.')) {
    const segs = fqn.split('.')
    const cls = segs[1]
    return `${codebaseRoot}/Managers/${cls}/methods/${fqn}.md`
  }
  // RPC: e.g. event.eventInternal.TrackServerEvent
  // 路徑為 Codebase/Servers/<PascalServer>/services/<PascalService>/methods/<fqn>.md
  // 但 Server 名 / Service 名 PascalCase 從 fqn 推斷（first-letter-uppercase）
  const segs = fqn.split('.')
  if (segs.length === 3) {
    const server = segs[0].charAt(0).toUpperCase() + segs[0].slice(1)
    const service = segs[1].charAt(0).toUpperCase() + segs[1].slice(1)
    return `${codebaseRoot}/Servers/${server}/services/${service}/methods/${fqn}.md`
  }
  return null
}

function readSourceFromNote(notePath: string): { sourceFile?: string; sourceLine?: number } {
  if (!fs.existsSync(notePath)) return {}
  const content = fs.readFileSync(notePath, 'utf8')
  // frontmatter source_file: xxx \n source_line: 123
  const sf = content.match(/^source_file:\s*(.+)$/m)
  const sl = content.match(/^source_line:\s*(\d+)$/m)
  return {
    sourceFile: sf?.[1].trim(),
    sourceLine: sl ? parseInt(sl[1]) : undefined,
  }
}

for (const e of proposeRemove) {
  const np = findNotePathByFqn(e.fqn)
  if (np) {
    const src = readSourceFromNote(np)
    e.sourceFile = src.sourceFile
    e.sourceLine = src.sourceLine
  }
}

// ---- 3. 一次 in-memory load 所有 target files ----
console.log('Loading agrabah/src + agrabah/tests + rajah/* into memory...')

type FileBundle = { tag: 'agrabahSrc' | 'agrabahTests' | 'rajah'; path: string; content: string }
const bundles: FileBundle[] = []

const scans: { tag: FileBundle['tag']; root: string; pattern: string }[] = [
  { tag: 'agrabahSrc', root: `${ROOT}/agrabah/src`, pattern: '**/*.ts' },
  { tag: 'agrabahTests', root: `${ROOT}/agrabah/tests`, pattern: '**/*.ts' },
  { tag: 'rajah', root: `${ROOT}/rajah/services`, pattern: '**/*.rajah' },
  { tag: 'rajah', root: `${ROOT}/rajah/jobs`, pattern: '**/*.rajah' },
  { tag: 'rajah', root: `${ROOT}/rajah/messages`, pattern: '**/*.rajah' },
]

for (const s of scans) {
  const g = new Glob(s.pattern)
  for (const rel of g.scanSync({ cwd: s.root })) {
    const p = `${s.root}/${rel}`
    try {
      bundles.push({ tag: s.tag, path: p, content: fs.readFileSync(p, 'utf8') })
    } catch {
      // ignore
    }
  }
}

console.log(`loaded ${bundles.length} files`)

// 統計每 tag 大小
const bySize: Record<string, number> = {}
for (const b of bundles) {
  bySize[b.tag] = (bySize[b.tag] ?? 0) + b.content.length
}
console.log(
  `agrabahSrc: ${(bySize.agrabahSrc / 1e6).toFixed(1)} MB`,
  `agrabahTests: ${(bySize.agrabahTests / 1e6).toFixed(1)} MB`,
  `rajah: ${(bySize.rajah / 1e6).toFixed(1)} MB`,
)

// ---- 4. deep verify ----
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function countHits(re: RegExp, content: string): number {
  let n = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(content)) !== null) {
    n++
    if (m.index === re.lastIndex) re.lastIndex++ // safety
  }
  return n
}

for (const e of proposeRemove) {
  const method = e.method
  // 兩種 pattern：
  //   1. method name `\b<methodName>\(` — TS call
  //   2. fqn literal `<fqn>` — 字串 / RPC 路徑
  //      manager: 用 `<ClassName>.<method>` static call
  // 涵蓋 generic 用法：`fetchAllByPaging<T>(...)` 與一般 `getStats(...)`
  const methodRe = new RegExp(`\\b${escapeRegex(method)}\\s*[<(]`, 'g')
  const fqnLit = e.type === 'manager-method' ? `${e.manager}.${e.method}` : e.fqn
  const fqnRe = new RegExp(escapeRegex(fqnLit), 'g')

  const hits = { agrabahSrc: 0, agrabahTests: 0, rajah: 0 }
  for (const b of bundles) {
    methodRe.lastIndex = 0
    fqnRe.lastIndex = 0
    const mHits = countHits(methodRe, b.content)
    const fHits = countHits(fqnRe, b.content)
    hits[b.tag] += Math.max(mHits, fHits) // method/fqn 取大者作 representative count
  }
  e.extendedHits = hits

  // 最終 verdict 邏輯
  const totalHits = hits.agrabahSrc + hits.agrabahTests + hits.rajah
  if (totalHits === 0) {
    e.finalVerdict = 'CONFIRMED_REMOVE'
  } else if (hits.agrabahSrc === 0 && hits.agrabahTests === 0 && hits.rajah > 0) {
    e.finalVerdict = 'RAJAH_DEFINED_BUT_NO_CALLER'
  } else if (hits.agrabahSrc === 0 && hits.agrabahTests > 0) {
    e.finalVerdict = 'FOUND_IN_TESTS_ONLY'
  } else {
    e.finalVerdict = 'FOUND_OUTSIDE_SRC'
  }
}

// ---- 5. summary ----
const finalSummary = {
  totalProposeRemove: proposeRemove.length,
  CONFIRMED_REMOVE: proposeRemove.filter((e) => e.finalVerdict === 'CONFIRMED_REMOVE').length,
  RAJAH_DEFINED_BUT_NO_CALLER: proposeRemove.filter((e) => e.finalVerdict === 'RAJAH_DEFINED_BUT_NO_CALLER').length,
  FOUND_IN_TESTS_ONLY: proposeRemove.filter((e) => e.finalVerdict === 'FOUND_IN_TESTS_ONLY').length,
  FOUND_OUTSIDE_SRC: proposeRemove.filter((e) => e.finalVerdict === 'FOUND_OUTSIDE_SRC').length,
}
console.log()
console.log('=== Final verdict on PROPOSE_REMOVE ===')
console.log(JSON.stringify(finalSummary, null, 2))

// ---- 6. write enriched JSON ----
data.deepVerifySummary = finalSummary
data.deepVerifyTimestamp = new Date().toISOString()
fs.writeFileSync(OUT_JSON, JSON.stringify(data, null, 2))

// ---- 7. write enriched markdown report ----
const md: string[] = []
md.push('# Orphan Takedown Evaluation Report')
md.push('')
md.push(`Generated: ${data.timestamp}`)
md.push(`Deep-verify: ${data.deepVerifyTimestamp}`)
md.push('')
md.push('> Phase 4 Stage 6.3 + deep-verify 產出。對 orphan-notes-report.md 中的 internal RPC + 篩選後 manager-method 候選，')
md.push('> 用 grep agrabah/src 全範圍兩種搜（method name + FQN literal / static call）做最終驗證。')
md.push('> Stage 6.3+ 對 78 PROPOSE_REMOVE 做 deep-verify：擴大範圍到 agrabah/src + agrabah/tests + rajah/{services,jobs,messages}。')
md.push('> **此報告僅評估，不執行下架** — 由 user 決定是否實際刪除/標 deprecated。')
md.push('')
md.push('> **已知 false positive**：表中 `Manager.<X>.constructor` 是 class 建構式（不是 method），請忽略。')
md.push('> （classifier 已 patch 排除 `constructor`/`toString`/`valueOf`/`toJSON`，下次重跑會自動過濾。）')
md.push('')
md.push('## Summary')
md.push('')
md.push('| 指標 | 數值 |')
md.push('|------|------|')
md.push(`| 候選總數 | ${data.summary.totalCandidates} |`)
md.push(`| internal-rpc 候選 | ${data.summary.byType['internal-rpc']} |`)
md.push(`| manager-method 候選 | ${data.summary.byType['manager-method']} |`)
md.push(`| **PROPOSE_REMOVE**（grep 0 命中於 agrabah/src） | ${data.summary.byVerdict.PROPOSE_REMOVE} |`)
md.push(`| KEEP_LIKELY_DEAD | ${data.summary.byVerdict.KEEP_LIKELY_DEAD} |`)
md.push(`| NEEDS_HUMAN_VERIFY | ${data.summary.byVerdict.NEEDS_HUMAN_VERIFY} |`)
md.push('')
md.push('## Deep-Verify on PROPOSE_REMOVE (擴大到 agrabah/全 + rajah/全)')
md.push('')
md.push('| 最終 verdict | 數量 | 說明 |')
md.push('|-------------|------|------|')
md.push(`| **CONFIRMED_REMOVE** | ${finalSummary.CONFIRMED_REMOVE} | agrabah 全 + rajah 全皆 0 命中，**強烈建議下架** |`)
md.push(`| RAJAH_DEFINED_BUT_NO_CALLER | ${finalSummary.RAJAH_DEFINED_BUT_NO_CALLER} | rajah 有定義但無 TS caller — 可能是已停用 API |`)
md.push(`| FOUND_IN_TESTS_ONLY | ${finalSummary.FOUND_IN_TESTS_ONLY} | 僅 tests 有引用 — 真實業務 caller 不存在 |`)
md.push(`| FOUND_OUTSIDE_SRC | ${finalSummary.FOUND_OUTSIDE_SRC} | src 外有命中（agrabahTests/rajah 等）— 需人工 review |`)
md.push('')

// CONFIRMED_REMOVE section — 帶 source_file:line
md.push('## CONFIRMED_REMOVE — 強烈建議下架（agrabah + rajah 全 0 命中）')
md.push('')
md.push('| FQN | Type | Source 位置 |')
md.push('|-----|------|------------|')
for (const e of proposeRemove.filter((x) => x.finalVerdict === 'CONFIRMED_REMOVE')) {
  const loc = e.sourceFile ? `\`${e.sourceFile}:${e.sourceLine ?? '?'}\`` : '_(note 無 source_file frontmatter)_'
  md.push(`| [[${e.fqn}]] | ${e.type} | ${loc} |`)
}
md.push('')

// RAJAH_DEFINED_BUT_NO_CALLER
md.push('## RAJAH_DEFINED_BUT_NO_CALLER — rajah 有定義但 TS 無 caller')
md.push('')
md.push('rajah 中宣告但 TS 中無實際呼叫者。可能是 rajah 已停止使用、僅 contract 還在；下架前須確認 rajah 是否需同步移除。')
md.push('')
md.push('| FQN | Type | rajah hits | Source 位置 |')
md.push('|-----|------|-----------|------------|')
for (const e of proposeRemove.filter((x) => x.finalVerdict === 'RAJAH_DEFINED_BUT_NO_CALLER')) {
  const loc = e.sourceFile ? `\`${e.sourceFile}:${e.sourceLine ?? '?'}\`` : '_(note 無 source_file)_'
  md.push(`| [[${e.fqn}]] | ${e.type} | ${e.extendedHits!.rajah} | ${loc} |`)
}
md.push('')

// FOUND_IN_TESTS_ONLY
md.push('## FOUND_IN_TESTS_ONLY — 僅 tests 有引用')
md.push('')
md.push('tests 有引用但 src 無真實 caller — 業務上已不被使用，但 test 引用可能是「測試 method 仍存在」式守護。下架時須同步刪除對應 test。')
md.push('')
md.push('| FQN | Type | tests hits | Source 位置 |')
md.push('|-----|------|-----------|------------|')
for (const e of proposeRemove.filter((x) => x.finalVerdict === 'FOUND_IN_TESTS_ONLY')) {
  const loc = e.sourceFile ? `\`${e.sourceFile}:${e.sourceLine ?? '?'}\`` : '_(note 無 source_file)_'
  md.push(`| [[${e.fqn}]] | ${e.type} | ${e.extendedHits!.agrabahTests} | ${loc} |`)
}
md.push('')

// FOUND_OUTSIDE_SRC（含 6.3 deep-verify 後升級到非 CONFIRMED_REMOVE 的）
md.push('## FOUND_OUTSIDE_SRC — src 外有命中（需人工 review）')
md.push('')
md.push('Stage 6.3 grep agrabah/src 報 0 命中，但擴大範圍 grep 在 src 外（tests + rajah）仍找到。')
md.push('意味著：src 中也許有間接呼叫被原 audit 漏抓，或者 method 是 cross-repo 的接口。需人工 review。')
md.push('')
md.push('| FQN | Type | src | tests | rajah | Source 位置 |')
md.push('|-----|------|-----|-------|-------|------------|')
for (const e of proposeRemove.filter((x) => x.finalVerdict === 'FOUND_OUTSIDE_SRC')) {
  const loc = e.sourceFile ? `\`${e.sourceFile}:${e.sourceLine ?? '?'}\`` : '_(note 無 source_file)_'
  const h = e.extendedHits!
  md.push(`| [[${e.fqn}]] | ${e.type} | ${h.agrabahSrc} | ${h.agrabahTests} | ${h.rajah} | ${loc} |`)
}
md.push('')

// 仍保留 KEEP_LIKELY_DEAD / NEEDS_HUMAN_VERIFY 原 section
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
console.log(`enriched report → ${OUT_REPORT}`)
console.log(`enriched json → ${OUT_JSON}`)
