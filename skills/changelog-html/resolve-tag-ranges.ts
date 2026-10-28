#!/usr/bin/env bun
// resolve-tag-ranges.ts — TG `/changelog` 的 tag 範圍解析（確定性，非 LLM）。
//
// Usage:
//   bun resolve-tag-ranges.ts --out <ranges.json> [--menu-src <dir>] [--src-root <dir>] <repo> <branch> <tag> [<repo> <branch> <tag> ...]
//   bun resolve-tag-ranges.ts --cleanup-src <dir>     # 移除 --src-root 建立的 worktree
//
// 每組 <repo> <branch> <tag> 代表「該 repo 在 origin/<branch> 上，從 <tag> 之後到分支最新」的變更。
// 檢查：repo 合法、tag 前綴與 repo 相符、origin/<branch> 存在、tag 存在、tag 是 origin/<branch> 的祖先。
// 範圍：git log --no-merges <tag>..origin/<branch> -- <paths>，paths 依 tag 前綴決定子專案
//   agrabah_*            → 整個 repo
//   abu_<platform|admin>_* → <sub>/ + common/
//   lago_<sub>_*         → <sub>/ + common/
//   rajah（任何前綴）     → 整個 repo（rajah 沒有子專案目錄）
// --menu-src：把 abu 的 menu.ts + zh-TW.json 依該 app 所在分支 git archive 出來，給 parse-abu-menu.js 用。
// --src-root：一律查 origin、不動本機 repo 的工作目錄（使用者 2026-10-28 定案，取代 checkout）。對輸入中每個
//   不同的分支 B 建一個 root <dir>/<B 轉檔名>/，內含四個 repo 從 origin 建的 detached worktree（該 repo 有
//   origin/B 就用它，否則用該 repo 在輸入中第一組的分支，都沒有則 origin/main）。每組 range 帶 srcRoot，
//   下游以 ALADDIN_ROOT_AT_DATE=<srcRoot> 跑 call-graph-scanner / rajah-lookup / i18n-lookup / db-lookup。
//
// stdout 一律輸出一份 JSON：{ ok: true, ranges, repos, srcRoots } 或 { ok: false, errors }。
// repos：依 repo 合併去重後的 commit（同 repo 多組範圍常重疊：lago 各子專案共用 common/、rajah 多組 tag），
//   每個 commit 帶 ranges（屬於 ranges 陣列的哪幾組），下游以此取 apps 聯集，避免同一 commit 重複列出。
// exit code：0 成功 / 2 輸入或 git 檢查不通過 / 1 非預期錯誤。

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'

// 測試時可用 CHANGELOG_REPO_ROOT 指到 clone 出來的 repo，避免動到真實工作目錄。
const ALADDIN = process.env.CHANGELOG_REPO_ROOT ?? '/Users/user/aladdin'
export const REPOS = ['agrabah', 'abu', 'lago', 'rajah'] as const
export type Repo = (typeof REPOS)[number]

export const USAGE = '格式：/changelog <repo> <branch> <tag> [<repo> <branch> <tag> ...]\n例：/changelog agrabah main agrabah_1.10.249 abu main abu_platform_1.10.111 rajah main agrabah_1.10.249'

export type Triple = { repo: Repo; branch: string; tag: string; project: 'agrabah' | 'abu' | 'lago'; sub: string | null; paths: string[] }

const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._\/-]*$/

function scopeForTag(tag: string): { project: Triple['project']; sub: string | null } | null {
  if (/^agrabah_\d+(\.\d+)+$/.test(tag)) return { project: 'agrabah', sub: null }
  const abu = /^abu_(platform|admin)_\d+(\.\d+)+$/.exec(tag)
  if (abu) return { project: 'abu', sub: abu[1]! }
  const lago = /^lago_([a-z0-9-]+)_\d+(\.\d+)+$/.exec(tag)
  if (lago) return { project: 'lago', sub: lago[1]! }
  return null
}

const label = (i: number, t: string[]) => `第 ${i + 1} 組「${t.join(' ')}」`

/** 純語法檢查（不碰 git），dispatcher 收到指令當下就同步跑，立即回覆格式錯誤。 */
export function parseTriples(tokens: string[]): { ok: true; triples: Triple[] } | { ok: false; errors: string[] } {
  if (tokens.length === 0) return { ok: false, errors: [`缺少參數。\n${USAGE}`] }
  if (tokens.length % 3 !== 0) {
    return { ok: false, errors: [`參數共 ${tokens.length} 個，不是 3 的倍數（每組必須是 <repo> <branch> <tag>）。\n${USAGE}`] }
  }
  const errors: string[] = []
  const triples: Triple[] = []
  for (let i = 0; i < tokens.length / 3; i++) {
    const t = tokens.slice(i * 3, i * 3 + 3)
    const [repo, branch, tag] = t as [string, string, string]
    if (!(REPOS as readonly string[]).includes(repo)) {
      errors.push(`${label(i, t)}：repo「${repo}」不合法，只接受 ${REPOS.join(' / ')}`)
      continue
    }
    if (!SAFE_REF.test(branch)) {
      errors.push(`${label(i, t)}：branch「${branch}」含不合法字元`)
      continue
    }
    const scope = scopeForTag(tag)
    if (!scope) {
      errors.push(`${label(i, t)}：tag「${tag}」格式不符，應為 agrabah_<版號> / abu_<platform|admin>_<版號> / lago_<子專案>_<版號>`)
      continue
    }
    if (repo !== 'rajah' && scope.project !== repo) {
      errors.push(`${label(i, t)}：tag「${tag}」屬於 ${scope.project}，與 repo「${repo}」不符`)
      continue
    }
    const paths = repo === 'rajah' || scope.sub === null ? [] : [`${scope.sub}/`, 'common/']
    triples.push({ repo: repo as Repo, branch, tag, ...scope, paths })
  }
  const seen = new Set<string>()
  for (const tr of triples) {
    const key = `${tr.repo} ${tr.tag}`
    if (seen.has(key)) errors.push(`「${key}」重複出現`)
    seen.add(key)
  }
  return errors.length ? { ok: false, errors } : { ok: true, triples }
}

function git(repo: Repo, args: string[]): string {
  return execFileSync('git', ['-C', `${ALADDIN}/${repo}`, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function gitOk(repo: Repo, args: string[]): boolean {
  return spawnSync('git', ['-C', `${ALADDIN}/${repo}`, ...args], { stdio: 'ignore' }).status === 0
}

type Commit = { sha: string; author: string; date: string; subject: string }
export type Range = Triple & { tagSha: string; headSha: string; commits: Commit[]; srcRoot?: string }
export type RepoCommits = Record<string, { commits: (Commit & { ranges: number[] })[] }>

const refExists = (repo: Repo, branch: string) => gitOk(repo, ['rev-parse', '--verify', '-q', `refs/remotes/origin/${branch}^{commit}`])

/** 每個不同分支建一組四 repo 的 detached worktree（見檔頭 --src-root）。中途失敗會先清掉已建的再丟出。 */
function buildSrcRoots(ranges: Range[], srcRoot: string): Record<string, string> {
  const roots: Record<string, string> = {}
  for (const branch of new Set(ranges.map(r => r.branch))) roots[branch] = `${srcRoot}/${branch.replace(/\//g, '__')}`
  // 輸入中有的 repo 已在 resolve() 開頭 fetch 過；沒出現的 repo 也要給 call-graph 讀，補 fetch 一次。
  for (const repo of REPOS) if (!ranges.some(r => r.repo === repo)) git(repo, ['fetch', 'origin', '--quiet'])
  try {
    for (const [branch, root] of Object.entries(roots)) {
      for (const repo of REPOS) {
        const ref = [branch, ranges.find(r => r.repo === repo)?.branch, 'main'].find(b => b && refExists(repo, b))!
        git(repo, ['worktree', 'add', '-q', '--detach', `${root}/${repo}`, `refs/remotes/origin/${ref}`])
      }
    }
  } catch (err) {
    cleanupSrc(srcRoot)
    throw err
  }
  for (const r of ranges) r.srcRoot = roots[r.branch]
  return roots
}

export function cleanupSrc(srcRoot: string): void {
  if (!existsSync(srcRoot)) return
  for (const dir of readdirSync(srcRoot)) {
    for (const repo of REPOS) {
      if (existsSync(`${srcRoot}/${dir}/${repo}`)) spawnSync('git', ['-C', `${ALADDIN}/${repo}`, 'worktree', 'remove', '--force', `${srcRoot}/${dir}/${repo}`], { stdio: 'ignore' })
    }
  }
  for (const repo of REPOS) spawnSync('git', ['-C', `${ALADDIN}/${repo}`, 'worktree', 'prune'], { stdio: 'ignore' })
}

type Resolved = { ok: true; ranges: Range[]; repos: RepoCommits; srcRoots: Record<string, string> } | { ok: false; errors: string[] }

function resolve(triples: Triple[], menuSrc: string | null, srcRoot: string | null): Resolved {
  for (const repo of new Set(triples.map(t => t.repo))) git(repo, ['fetch', 'origin', '--tags', '--quiet'])

  const errors: string[] = []
  const ranges: Range[] = []
  triples.forEach((t, i) => {
    const l = label(i, [t.repo, t.branch, t.tag])
    if (!gitOk(t.repo, ['rev-parse', '--verify', '-q', `refs/remotes/origin/${t.branch}^{commit}`])) {
      errors.push(`${l}：分支 origin/${t.branch} 不存在`)
      return
    }
    if (!gitOk(t.repo, ['rev-parse', '--verify', '-q', `refs/tags/${t.tag}^{commit}`])) {
      errors.push(`${l}：tag ${t.tag} 在 ${t.repo} 不存在`)
      return
    }
    if (!gitOk(t.repo, ['merge-base', '--is-ancestor', `refs/tags/${t.tag}`, `refs/remotes/origin/${t.branch}`])) {
      const where = git(t.repo, ['branch', '-r', '--contains', `refs/tags/${t.tag}`, '--format=%(refname:short)'])
        .split('\n')
        .map(s => s.replace(/^origin\//, ''))
        .filter(s => s && s !== 'origin' && s !== 'HEAD' && !s.startsWith('mr/'))
      errors.push(`${l}：tag 不在 ${t.branch} 上（tag 所在分支：${where.length ? where.slice(0, 5).join('、') : '無'}）`)
      return
    }
    const log = git(t.repo, ['log', '--no-merges', '--date=short', '--format=%h%x09%an%x09%ad%x09%s', `refs/tags/${t.tag}..refs/remotes/origin/${t.branch}`, '--', ...t.paths])
    ranges.push({
      ...t,
      tagSha: git(t.repo, ['rev-parse', '--short', `refs/tags/${t.tag}^{commit}`]),
      headSha: git(t.repo, ['rev-parse', '--short', `refs/remotes/origin/${t.branch}`]),
      commits: log
        ? log.split('\n').map(line => {
            const [sha, author, date, ...rest] = line.split('\t')
            return { sha: sha!, author: author!, date: date!, subject: rest.join('\t') }
          })
        : [],
    })
  })
  if (errors.length) return { ok: false, errors }

  if (menuSrc) {
    // 每個 abu app 的菜單取自該 app 在本次輸入中的分支；沒指定的 app 取第一組 abu 的分支，都沒有 abu 則取 main。
    const abuRanges = ranges.filter(r => r.repo === 'abu')
    if (!abuRanges.length) git('abu', ['fetch', 'origin', '--quiet'])
    mkdirSync(menuSrc, { recursive: true })
    for (const app of ['platform', 'admin']) {
      const branch = (abuRanges.find(r => r.sub === app) ?? abuRanges[0])?.branch ?? 'main'
      const archive = spawnSync('git', ['-C', `${ALADDIN}/abu`, 'archive', `refs/remotes/origin/${branch}`, `${app}/src/menu.ts`, `${app}/localizations/zh-TW.json`], { maxBuffer: 64 * 1024 * 1024 })
      if (archive.status !== 0) throw new Error(`git archive abu ${branch} ${app} 失敗：${archive.stderr}`)
      execFileSync('tar', ['-x', '-C', menuSrc], { input: archive.stdout })
    }
  }
  const repos: RepoCommits = {}
  ranges.forEach((r, i) => {
    const bucket = (repos[r.repo] ??= { commits: [] })
    for (const c of r.commits) {
      const existing = bucket.commits.find(x => x.sha === c.sha)
      if (existing) existing.ranges.push(i)
      else bucket.commits.push({ ...c, ranges: [i] })
    }
  })
  const srcRoots = srcRoot ? buildSrcRoots(ranges, srcRoot) : {}
  return { ok: true, ranges, repos, srcRoots }
}

if (import.meta.main) {
  const argv = process.argv.slice(2)
  const take = (flag: string) => {
    const i = argv.indexOf(flag)
    if (i === -1) return null
    const [v] = argv.splice(i, 2).slice(1)
    return v ?? null
  }
  const out = take('--out')
  const menuSrc = take('--menu-src')
  const srcRoot = take('--src-root')
  const cleanup = take('--cleanup-src')
  if (cleanup) {
    cleanupSrc(cleanup)
    process.exit(0)
  }
  try {
    const parsed = parseTriples(argv)
    const result = parsed.ok ? resolve(parsed.triples, menuSrc, srcRoot) : parsed
    if (result.ok && out) writeFileSync(out, JSON.stringify(result, null, 2))
    console.log(JSON.stringify(result, null, 2))
    process.exit(result.ok ? 0 : 2)
  } catch (err) {
    console.log(JSON.stringify({ ok: false, errors: [`非預期錯誤：${(err as Error).message}`] }))
    process.exit(1)
  }
}
