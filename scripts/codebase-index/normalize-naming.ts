/**
 * Normalize naming convention for rpc-method notes across Codebase/.
 *
 * Target FQN shape (aligned with `context.remote.*.*.*`):
 *   <camelServer>.<camelService>.<PascalMethod>
 *
 * Examples of changes:
 *   Wallet.WalletInternalService.methodChangeUserBalance
 *     → wallet.walletInternal.ChangeUserBalance
 *   AppUserBackOffice.PlatformAppUserService.methodCreateAppUser
 *     → appUserBackOffice.platformAppUser.CreateAppUser
 *   InHouseGameApi.BettingHandlerService.methodPlaceBet
 *     → inHouseGameApi.bettingHandler.PlaceBet
 *
 * Scope of changes per rpc-method note:
 *   1. Rename .md file:         <Old>.md  → <new-fqn>.md
 *   2. Rename service dir:      <XxxService>/ → <Xxx>/ (still PascalCase)
 *   3. Rewrite frontmatter:     fqn / aliases / server / service / method
 *   4. Rewrite every [[old-fqn]] occurrence in every Codebase file
 *
 * Dry-run by default. Pass `--apply` to mutate the filesystem.
 */

import { Glob } from 'bun';
import { readFile, writeFile, rename, rmdir, mkdir, readdir, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import matter from 'gray-matter';

const ROOT = '/Users/user/aladdin/obsidian/Codebase';
const APPLY = process.argv.includes('--apply');

function camelFirst(s: string): string {
    if (!s) return s;
    return s[0].toLowerCase() + s.slice(1);
}

function stripServiceSuffix(s: string): string {
    return s.endsWith('Service') ? s.slice(0, -'Service'.length) : s;
}

function stripMethodPrefix(s: string): string {
    if (s.startsWith('method') && s.length > 'method'.length) {
        const rest = s.slice('method'.length);
        return rest[0].toUpperCase() + rest.slice(1);
    }
    return s[0].toUpperCase() + s.slice(1);
}

interface RpcMethodNote {
    path: string;
    oldFqn: string;
    oldServer: string;
    oldService: string;
    oldMethod: string;
    newFqn: string;
    newServer: string;
    newService: string;
    newMethod: string;
}

interface FqnMapEntry {
    oldFqn: string;
    newFqn: string;
}

async function scanRpcMethodNotes(): Promise<RpcMethodNote[]> {
    const glob = new Glob('**/*.md');
    const results: RpcMethodNote[] = [];

    for await (const rel of glob.scan(ROOT)) {
        const path = join(ROOT, rel);
        const raw = await readFile(path, 'utf-8');
        let parsed;
        try {
            parsed = matter(raw);
        } catch {
            continue;
        }
        const data = parsed.data as Record<string, unknown>;
        if (data.type !== 'rpc-method') continue;
        const oldFqn = String(data.fqn ?? '');
        const parts = oldFqn.split('.');
        if (parts.length !== 3) continue;
        const [oldServer, oldService, oldMethod] = parts;

        const newServer = camelFirst(oldServer);
        const newService = camelFirst(stripServiceSuffix(oldService));
        const newMethod = stripMethodPrefix(oldMethod);
        const newFqn = `${newServer}.${newService}.${newMethod}`;

        if (newFqn === oldFqn) continue;

        results.push({
            path,
            oldFqn,
            oldServer,
            oldService,
            oldMethod,
            newFqn,
            newServer,
            newService,
            newMethod,
        });
    }
    return results;
}

async function buildFqnMap(notes: RpcMethodNote[]): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    for (const n of notes) {
        map.set(n.oldFqn, n.newFqn);
        // Also register common aliases that appear in other notes' [[ ]] links:
        //   - <Server>.<Service>.<NoMethodPrefix>  (eg Wallet.WalletInternalService.ChangeUserBalance)
        //   - <Server>.<ServiceNoSuffix>.<NoMethodPrefix>  (eg Wallet.WalletInternal.ChangeUserBalance)
        const noPrefix = `${n.oldServer}.${n.oldService}.${stripMethodPrefix(n.oldMethod)}`;
        const noSuffix = `${n.oldServer}.${stripServiceSuffix(n.oldService)}.${stripMethodPrefix(n.oldMethod)}`;
        const both = `${n.newServer}.${n.newService}.${n.newMethod}`;
        map.set(noPrefix, n.newFqn);
        map.set(noSuffix, n.newFqn);
        // Also existing legacy with method prefix but no Service suffix
        const legacy1 = `${n.oldServer}.${stripServiceSuffix(n.oldService)}.${n.oldMethod}`;
        map.set(legacy1, n.newFqn);
        // camel server but old service/method
        map.set(`${n.newServer}.${n.oldService}.${n.oldMethod}`, n.newFqn);
    }
    return map;
}

/**
 * Rewrite frontmatter + body without going through matter.stringify
 * (which serializes bare ISO-date-looking strings into Date objects).
 * We do line-level edits on the frontmatter block.
 */
function rewriteFrontmatterAndBody(
    raw: string,
    note: RpcMethodNote,
    fqnMap: Map<string, string>,
): string {
    const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!match) return raw;
    const [, fmBlock, bodyOriginal] = match;

    const fmLines = fmBlock.split('\n');
    const out: string[] = [];
    let inAliases = false;
    for (const line of fmLines) {
        if (inAliases) {
            if (/^\s*-\s/.test(line)) continue; // skip old alias entries
            inAliases = false;
        }
        if (/^fqn:\s/.test(line)) {
            out.push(`fqn: ${note.newFqn}`);
            continue;
        }
        if (/^server:\s/.test(line)) {
            out.push(`server: ${note.newServer}`);
            continue;
        }
        if (/^service:\s/.test(line)) {
            out.push(`service: ${note.newService}`);
            continue;
        }
        if (/^method:\s/.test(line)) {
            out.push(`method: ${note.newMethod}`);
            continue;
        }
        if (/^aliases:\s*$/.test(line)) {
            out.push('aliases:');
            out.push(`  - ${note.newMethod}`);
            out.push(`  - ${note.newService}.${note.newMethod}`);
            inAliases = true;
            continue;
        }
        out.push(line);
    }
    const newFm = out.join('\n');

    // Rewrite H1 if it still shows the old fqn
    let body = bodyOriginal;
    const h1Pattern = new RegExp(`^# ${note.oldFqn.replace(/\./g, '\\.')}\\s*$`, 'm');
    body = body.replace(h1Pattern, `# ${note.newFqn}`);

    // Rewrite [[old-fqn]] → [[new-fqn]] everywhere in the body
    body = rewriteLinksInText(body, fqnMap);

    return `---\n${newFm}\n---\n${body}`;
}

function rewriteLinksInText(text: string, fqnMap: Map<string, string>): string {
    return text.replace(/\[\[([^\]|#]+?)(#[^\]|]+)?(\|[^\]]+)?\]\]/g, (full, target, anchor, alias) => {
        const mapped = fqnMap.get(target.trim());
        if (!mapped) return full;
        return `[[${mapped}${anchor ?? ''}${alias ?? ''}]]`;
    });
}

async function applyNoteRewrite(note: RpcMethodNote, fqnMap: Map<string, string>): Promise<string> {
    const raw = await readFile(note.path, 'utf-8');
    const newContent = rewriteFrontmatterAndBody(raw, note, fqnMap);

    // Target directory (canonical layout):
    //   Servers/<Server>/services/<NewServiceDir>/methods/<newFqn>.md
    const newServiceDir = stripServiceSuffix(note.oldService);
    const serverDir = join(ROOT, 'Servers', note.oldServer);
    const canonicalDir = join(serverDir, 'services', newServiceDir, 'methods');
    const newBase = `${note.newFqn}.md`;
    const newPath = join(canonicalDir, newBase);

    if (APPLY) {
        await mkdir(canonicalDir, { recursive: true });
        await writeFile(note.path, newContent);
        if (newPath !== note.path) {
            await rename(note.path, newPath);
        }
    }
    return newPath;
}

async function moveServiceOverviewFiles(notes: RpcMethodNote[]): Promise<number> {
    // Part C layout places "*._service.md" flat under Servers/<Server>/.
    // Move them into Servers/<Server>/services/<NewServiceDir>/_service.md so
    // every service has one canonical overview.
    const servers = new Set<string>();
    for (const n of notes) servers.add(n.oldServer);

    let moved = 0;
    for (const server of servers) {
        const serverDir = join(ROOT, 'Servers', server);
        const glob = new Glob('*._service.md');
        for await (const rel of glob.scan({ cwd: serverDir, onlyFiles: true })) {
            const oldPath = join(serverDir, rel);
            const serviceNameWithSuffix = rel.split('.').slice(1, -2).join('.');
            const newServiceDir = stripServiceSuffix(serviceNameWithSuffix);
            if (!newServiceDir) continue;
            const canonicalDir = join(serverDir, 'services', newServiceDir);
            const newPath = join(canonicalDir, '_service.md');
            if (APPLY) {
                await mkdir(canonicalDir, { recursive: true });
                // Rewrite fqn/server/service in frontmatter line-by-line
                const raw = await readFile(oldPath, 'utf-8');
                const camelServer = camelFirst(server);
                const camelService = camelFirst(newServiceDir);
                const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
                let updated = raw;
                if (m) {
                    const [, fmBlock, body] = m;
                    const newFm = fmBlock.split('\n').map(line => {
                        if (/^fqn:\s/.test(line)) return `fqn: ${camelServer}.${camelService}`;
                        if (/^server:\s/.test(line)) return `server: ${camelServer}`;
                        if (/^service:\s/.test(line)) return `service: ${camelService}`;
                        return line;
                    }).join('\n');
                    updated = `---\n${newFm}\n---\n${body}`;
                }
                await writeFile(oldPath, updated);
                await rename(oldPath, newPath);
            }
            moved++;
        }
    }
    return moved;
}

async function renameServiceDirs(notes: RpcMethodNote[]): Promise<Map<string, string>> {
    // Service dir renames:   <Xxx>Service  → <Xxx>  (strip Service suffix)
    // Only rename dirs that actually contain rpc-method notes we've touched.
    const dirMap = new Map<string, string>();
    for (const note of notes) {
        // Typical path: Servers/<Server>/services/<ServiceNameService>/methods/<file>.md
        const p = note.path;
        const idx = p.indexOf('/services/');
        if (idx === -1) continue;
        const afterServices = p.slice(idx + '/services/'.length);
        const serviceDirName = afterServices.split('/')[0];
        if (!serviceDirName.endsWith('Service')) continue;

        const oldDir = p.slice(0, idx + '/services/'.length) + serviceDirName;
        const newDir = p.slice(0, idx + '/services/'.length) + stripServiceSuffix(serviceDirName);
        if (dirMap.has(oldDir) || oldDir === newDir) continue;
        dirMap.set(oldDir, newDir);
    }
    if (APPLY) {
        for (const [oldDir, newDir] of dirMap) {
            if (!existsSync(oldDir)) continue;
            // If target already exists (usually an empty/stub dir from an earlier attempt),
            // delete it first when safe (only .DS_Store or empty).
            if (existsSync(newDir)) {
                const entries = await readdir(newDir);
                const nonJunk = entries.filter(e => e !== '.DS_Store');
                if (nonJunk.length > 0) {
                    console.warn(`  skip: target dir not empty ${newDir} (${nonJunk.length} non-junk entries)`);
                    continue;
                }
                for (const e of entries) {
                    await unlink(join(newDir, e));
                }
                await rmdir(newDir);
            }
            await rename(oldDir, newDir);
        }
    }
    return dirMap;
}

async function rewriteLinksAcrossAllNotes(fqnMap: Map<string, string>): Promise<number> {
    const glob = new Glob('**/*.md');
    let changedFiles = 0;
    for await (const rel of glob.scan(ROOT)) {
        const path = join(ROOT, rel);
        const raw = await readFile(path, 'utf-8');
        const updated = rewriteLinksInText(raw, fqnMap);
        if (updated !== raw) {
            changedFiles++;
            if (APPLY) {
                await writeFile(path, updated);
            }
        }
    }
    return changedFiles;
}

function adjustPathForDirRename(path: string, dirMap: Map<string, string>): string {
    for (const [oldDir, newDir] of dirMap) {
        if (path.startsWith(oldDir + '/')) {
            return newDir + path.slice(oldDir.length);
        }
    }
    return path;
}

async function main() {
    console.log(`\n=== normalize-naming.ts (${APPLY ? 'APPLY' : 'DRY-RUN'}) ===\n`);

    const notes = await scanRpcMethodNotes();
    console.log(`Found ${notes.length} rpc-method notes needing rename.`);

    const fqnMap = await buildFqnMap(notes);
    console.log(`FQN map has ${fqnMap.size} entries (includes legacy alias variants).`);

    // Preview first 5 renames
    console.log(`\n-- Sample renames (first 5) --`);
    for (const n of notes.slice(0, 5)) {
        console.log(`  ${n.oldFqn}\n  → ${n.newFqn}`);
    }

    // Step 1: rename service directories (only mutates FS when APPLY)
    const dirMap = await renameServiceDirs(notes);
    console.log(`\nService dirs to rename: ${dirMap.size}`);
    if (dirMap.size > 0) {
        const sample = [...dirMap.entries()].slice(0, 3);
        for (const [o, n] of sample) {
            console.log(`  ${o.replace(ROOT, '')} → ${n.replace(ROOT, '')}`);
        }
    }

    // Step 2: adjust note paths if their parent dir got renamed.
    // Only apply path adjustment when we actually renamed dirs on disk.
    if (APPLY) {
        for (const n of notes) {
            n.path = adjustPathForDirRename(n.path, dirMap);
        }
    }

    // Step 3: rewrite each rpc-method note (frontmatter + body) and rename file
    let noteOk = 0;
    for (const n of notes) {
        try {
            await applyNoteRewrite(n, fqnMap);
            noteOk++;
        } catch (e) {
            console.error(`Failed to rewrite ${n.path}:`, e);
        }
    }
    console.log(`\nRewrote ${noteOk}/${notes.length} rpc-method notes.`);

    // Step 4: move _service.md overview files from Part C flat layout into canonical dirs
    const movedOverviews = await moveServiceOverviewFiles(notes);
    console.log(`\n_service.md overviews moved into canonical dirs: ${movedOverviews}`);

    // Step 5: rewrite [[old-fqn]] links across ALL notes (not just rpc-method)
    // In dry-run mode rewriteLinksAcrossAllNotes will count without writing.
    const changedLinkFiles = await rewriteLinksAcrossAllNotes(fqnMap);
    console.log(`\nFiles with [[link]] updates${APPLY ? '' : ' (dry-run)'}: ${changedLinkFiles}`);

    console.log(`\n${APPLY ? '✔ Applied all changes.' : '(dry-run only; re-run with --apply to mutate)'}`);
}

await main();
