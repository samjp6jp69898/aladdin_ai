/**
 * Phase 4 Stage 6.2 (b) — AgrabahErrorCodeEnum 筆記補完
 *
 * 來源：
 *   - i18n source-of-truth: abu/admin/localizations/{zh-TW,en-US}.json error.<code>
 *   - rajah 號段註解: rajah/services/common.rajah enum AgrabahErrorCodeEnum 內 `# <subsystem> <start> ~ <end>`
 *
 * 動作：
 *   1. 在 ## Values 前插入「號段對照」小表
 *   2. 表格頭加「英文說明」欄
 *   3. 對每行：
 *      - 已填中文：保留中文、補英文（i18n 無則 [TBD]）
 *      - TBD 且 i18n 有對應：補中文、補英文
 *      - TBD 且 i18n 無對應：中文保留原 TBD、英文 [TBD]
 *
 * 一次性 script，Phase 4 收尾後可保留作 audit trail。
 */

import * as fs from 'fs'

const ROOT = '/Users/user/aladdin'
const NOTE_PATH = `${ROOT}/obsidian/Codebase/Common/common/enums/Common.Enum.AgrabahErrorCodeEnum.md`

// ---- 1. i18n ----
const adminTW = JSON.parse(fs.readFileSync(`${ROOT}/abu/admin/localizations/zh-TW.json`, 'utf8'))
const adminEN = JSON.parse(fs.readFileSync(`${ROOT}/abu/admin/localizations/en-US.json`, 'utf8'))
const errMapTW: Record<string, string> = adminTW.error ?? {}
const errMapEN: Record<string, string> = adminEN.error ?? {}

// ---- 2. rajah subsystem ranges ----
const rajahSrc = fs.readFileSync(`${ROOT}/rajah/services/common.rajah`, 'utf8')
const enumStart = rajahSrc.indexOf('enum AgrabahErrorCodeEnum')
const enumEnd = rajahSrc.indexOf('\n}', enumStart)
if (enumStart < 0 || enumEnd < 0) throw new Error('AgrabahErrorCodeEnum block not found in rajah')
const enumBody = rajahSrc.slice(enumStart, enumEnd)

// 形如 `# gate 101 ~ 200`、`# others 10001 ~`、`# vip 1001~1100`
const rangeRe = /^\s*#\s*([^\d#][^\n]*?)\s+(\d+)\s*~\s*(\d+)?\s*$/gm
const ranges: { subsystem: string; start: number; end: number | null }[] = []
let m: RegExpExecArray | null
while ((m = rangeRe.exec(enumBody)) !== null) {
  ranges.push({
    subsystem: m[1].trim(),
    start: parseInt(m[2]),
    end: m[3] ? parseInt(m[3]) : null,
  })
}
ranges.sort((a, b) => a.start - b.start)

// ---- 3. 讀筆記 ----
const note = fs.readFileSync(NOTE_PATH, 'utf8')
const lines = note.split('\n')

// 找表格頭
let tableHeaderIdx = -1
for (let i = 0; i < lines.length; i++) {
  if (lines[i].startsWith('| Value | Name | 中文說明 |')) {
    tableHeaderIdx = i
    break
  }
}
if (tableHeaderIdx < 0) throw new Error('Values table header not found')
const tableSeparatorIdx = tableHeaderIdx + 1

// ---- 4. 加英文欄到表頭 ----
lines[tableHeaderIdx] = '| Value | Name | 中文說明 | 英文說明 |'
lines[tableSeparatorIdx] = '|-------|------|----------|----------|'

// ---- 5. 處理每一 row ----
const stats = {
  alreadyFilled: 0, // 中文非 TBD，本次不改中文
  fillFromI18n: 0, // 中文 TBD 且 i18n 有
  keepTBD: 0, // 中文 TBD 且 i18n 無
  enFilled: 0, // 補英文成功
  enMissing: 0, // 英文 i18n 無
}
const rowRe = /^\| (\d+) \| ([\w]+) \| (.+) \|$/

for (let i = tableSeparatorIdx + 1; i < lines.length; i++) {
  const line = lines[i]
  if (!line.startsWith('|')) break // 表格結束
  const rm = line.match(rowRe)
  if (!rm) continue
  const code = rm[1]
  const name = rm[2]
  const cnDesc = rm[3]

  let newCN: string
  if (!cnDesc.startsWith('[TBD:') && !cnDesc.startsWith('[TBD]')) {
    stats.alreadyFilled++
    newCN = cnDesc
  } else if (errMapTW[code]) {
    stats.fillFromI18n++
    newCN = errMapTW[code]
  } else {
    stats.keepTBD++
    newCN = cnDesc
  }

  let newEN: string
  if (errMapEN[code]) {
    stats.enFilled++
    newEN = errMapEN[code]
  } else {
    stats.enMissing++
    newEN = '[TBD]'
  }

  lines[i] = `| ${code} | ${name} | ${newCN} | ${newEN} |`
}

// ---- 6. 在 ## Values 前插入號段對照 ----
const valuesIdx = lines.findIndex((l) => l.match(/^## Values\s*$/))
if (valuesIdx < 0) throw new Error('## Values heading not found')

const rangeBlock: string[] = []
rangeBlock.push('## 號段對照')
rangeBlock.push('')
rangeBlock.push('依 `rajah/services/common.rajah` 中 `enum AgrabahErrorCodeEnum` 的 `# <subsystem> <range>` 註解整理。')
rangeBlock.push('')
rangeBlock.push('| 子系統 | 起始 | 結束 |')
rangeBlock.push('|--------|------|------|')
for (const r of ranges) {
  rangeBlock.push(`| ${r.subsystem} | ${r.start} | ${r.end === null ? '∞' : r.end} |`)
}
rangeBlock.push('')

lines.splice(valuesIdx, 0, ...rangeBlock)

// ---- 7. 寫回 ----
fs.writeFileSync(NOTE_PATH, lines.join('\n'))

// ---- 8. report ----
console.log('=== Phase 4 Stage 6.2 (b) — AgrabahErrorCodeEnum 補完 ===')
console.log('range table rows:', ranges.length)
console.log('alreadyFilled (CN, 不動):', stats.alreadyFilled)
console.log('fillFromI18n (CN, 從 i18n 補):', stats.fillFromI18n)
console.log('keepTBD (CN, i18n 無, 保留 TBD):', stats.keepTBD)
console.log('enFilled (EN, 從 i18n 補):', stats.enFilled)
console.log('enMissing (EN, i18n 無, [TBD]):', stats.enMissing)
console.log('total rows:', stats.alreadyFilled + stats.fillFromI18n + stats.keepTBD)
