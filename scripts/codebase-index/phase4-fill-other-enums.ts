/**
 * Phase 4 Stage 6.2 (c)-1 — 其他 enum plain TBD 補完
 *
 * 假設：i18n key convention 為 `enum.<enum-name-kebab>-enum-<value-name-kebab>`
 *   範例：WithdrawAccountFieldEnum.bankBranch → withdraw-account-field-enum-bank-branch
 *
 * 來源：abu/admin/zh-TW.json + abu/platform/zh-TW.json 兩邊查（admin 找不到再查 platform）
 *
 * 動作（依 user A4/A5 拍板）：對所有 enum 筆記中 `| <code> | <name> | [TBD] |` 形式的行：
 *   - i18n 有對應 → 替換 [TBD] 為中文
 *   - i18n 無對應 → 替換 [TBD] 為空白（A5: 「真的沒有翻譯」就不留 TBD）
 *   - 跳過 AgrabahErrorCodeEnum（已被 (b) 處理，4 欄結構不同）
 */

import * as fs from 'fs'
import { execSync } from 'child_process'

const ROOT = '/Users/user/aladdin'
const CODEBASE = `${ROOT}/obsidian/Codebase`

// load i18n
const adminEnum: Record<string, string> = JSON.parse(
  fs.readFileSync(`${ROOT}/abu/admin/localizations/zh-TW.json`, 'utf8')
).enum ?? {}
const platformEnum: Record<string, string> = JSON.parse(
  fs.readFileSync(`${ROOT}/abu/platform/localizations/zh-TW.json`, 'utf8')
).enum ?? {}
const adminEnumEN: Record<string, string> = JSON.parse(
  fs.readFileSync(`${ROOT}/abu/admin/localizations/en-US.json`, 'utf8')
).enum ?? {}

console.log(`abu/admin enum keys: ${Object.keys(adminEnum).length}`)
console.log(`abu/platform enum keys: ${Object.keys(platformEnum).length}`)

function pascalToKebab(s: string): string {
  return s
    .replace(/([a-z\d])([A-Z])/g, '$1-$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1-$2')
    .toLowerCase()
}

function lookup(enumName: string, valueName: string): { source: string; cn: string; en?: string } | null {
  const enumKebab = pascalToKebab(enumName)
  const valueKebab = pascalToKebab(valueName)
  const key = `${enumKebab}-${valueKebab}`
  // 慣例：enum 名通常以 -enum 結尾。若 enumName 已含 Enum 字尾，pascalToKebab 後會是 ...-enum
  // 但有些 enum 名沒以 Enum 結尾（如自定義 type）— 也試一次補 -enum 中綴
  const altKey = enumKebab.endsWith('-enum') ? key : `${enumKebab}-enum-${valueKebab}`

  for (const k of [key, altKey]) {
    if (adminEnum[k]) return { source: 'admin', cn: adminEnum[k], en: adminEnumEN[k] }
    if (platformEnum[k]) return { source: 'platform', cn: platformEnum[k] }
  }
  return null
}

// 找所有 enum 筆記（type: enum）
const enumNotePaths = execSync(
  `grep -rl "^type: enum\\b" ${CODEBASE} --include="*.md" 2>/dev/null || true`
)
  .toString()
  .split('\n')
  .filter(Boolean)

console.log(`enum notes total: ${enumNotePaths.length}`)

// 從筆記檔名抽 enum name (e.g. Common.Enum.AgrabahErrorCodeEnum.md → AgrabahErrorCodeEnum)
function extractEnumName(notePath: string): string | null {
  const file = notePath.split('/').pop()!.replace(/\.md$/, '')
  // 多段點號 — 取最後一段
  const segs = file.split('.')
  return segs[segs.length - 1]
}

const stats = {
  notesWithTBD: 0,
  totalTBDRows: 0,
  fillableAdmin: 0,
  fillablePlatform: 0,
  notFound: 0,
}
const samples: { fillable: any[]; notFound: any[] } = { fillable: [], notFound: [] }

const filesToWrite = new Map<string, string>() // path → new content

for (const notePath of enumNotePaths) {
  // 跳過 AgrabahErrorCodeEnum（已被 (b) 處理）
  if (notePath.includes('AgrabahErrorCodeEnum')) continue

  const enumName = extractEnumName(notePath)
  if (!enumName) continue

  const content = fs.readFileSync(notePath, 'utf8')
  const lines = content.split('\n')

  let hasTBD = false
  let modified = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    // 三欄格式：| <code> | <name> | [TBD] |
    const m = line.match(/^\| (\w+) \| (\w+) \| \[TBD\] \|\s*$/)
    if (!m) continue

    hasTBD = true
    stats.totalTBDRows++
    const code = m[1]
    const valueName = m[2]
    const found = lookup(enumName, valueName)
    if (found) {
      if (found.source === 'admin') stats.fillableAdmin++
      else stats.fillablePlatform++
      if (samples.fillable.length < 8) {
        samples.fillable.push({ enumName, code, valueName, src: found.source, cn: found.cn, en: found.en ?? '-' })
      }
      lines[i] = `| ${code} | ${valueName} | ${found.cn} |`
      modified = true
    } else {
      stats.notFound++
      if (samples.notFound.length < 8) {
        samples.notFound.push({ enumName, code, valueName })
      }
      // A5: 沒有翻譯就清空，不留 [TBD]
      lines[i] = `| ${code} | ${valueName} |  |`
      modified = true
    }
  }
  if (hasTBD) stats.notesWithTBD++
  if (modified) filesToWrite.set(notePath, lines.join('\n'))
}

// ---- 寫回 ----
for (const [path, content] of filesToWrite) {
  fs.writeFileSync(path, content)
}

console.log()
console.log('=== Coverage stats ===')
console.log('files written:', filesToWrite.size)
console.log('enum notes with at least one [TBD]:', stats.notesWithTBD)
console.log('total [TBD] rows in enum notes:', stats.totalTBDRows)
console.log('  filled from admin i18n:', stats.fillableAdmin)
console.log('  filled from platform i18n:', stats.fillablePlatform)
console.log('  not found → cleared to blank:', stats.notFound)
console.log(
  `i18n coverage: ${(((stats.fillableAdmin + stats.fillablePlatform) / stats.totalTBDRows) * 100).toFixed(1)}%`
)
console.log()
console.log('=== fillable sample (前 8) ===')
for (const s of samples.fillable) {
  console.log(`  ${s.enumName}.${s.valueName} (#${s.code}) [${s.src}] → "${s.cn}" / "${s.en}"`)
}
console.log()
console.log('=== not-found sample (前 8) — 給 user 看是哪些 enum ===')
for (const s of samples.notFound) {
  console.log(`  ${s.enumName}.${s.valueName} (#${s.code})`)
}
