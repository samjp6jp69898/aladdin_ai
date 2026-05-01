// Audit note coverage: cross-check source entities against Codebase notes.
// Usage: bun run audit-note-coverage.ts
//
// Scans:
//   - RPC methods    : agrabah/src/servers/<server>/services/*.ts  (class XxxService extends ...BaseService → async methodXxx)
//   - Manager methods: agrabah/src/managers/*.ts                   (class XxxManager → async methodName, excluding _ / # prefix)
//   - Enums          : rajah/**/*.rajah                            (^enum Name {)
//   - Models         : rajah/**/*.rajah                            (^model Name {)
//   - DB ORM classes : agrabah/src/database_types/**/*.ts          (^export class Db\w+)
//
// Note: enums/models live in rajah service definitions (canonical IDL); the generated TS files
// are downstream artifacts containing many auto-generated wrappers we do not document.
//
// Cross-checks against obsidian/Codebase/**/*.md frontmatter (fqn, type, aliases).
// Output: obsidian/Codebase/_index/audit-coverage-report.json

import { Glob } from 'bun';
import { readFileSync, writeFileSync } from 'node:fs';
import { parseNote } from './lib/note-parser.ts';

const AGRABAH_ROOT = '/Users/user/aladdin/agrabah';
const SRC_ROOT = `${AGRABAH_ROOT}/src`;
const RAJAH_ROOT = '/Users/user/aladdin/rajah';
const CODEBASE_DIR = '/Users/user/aladdin/obsidian/Codebase';
const OUT_PATH = `${CODEBASE_DIR}/_index/audit-coverage-report.json`;

type EntityType = 'rpc-method' | 'manager-method' | 'enum' | 'model' | 'db-orm';

interface SourceEntity {
    type: EntityType;
    fqn: string;          // canonical fqn used for match-by-fqn (rpc / manager). For enum/model/db-orm a placeholder using bareName.
    bareName: string;     // last identifier — used for fuzzy matching enum/model/db-orm against note aliases
    sourceFile: string;   // path relative to repo root (always begins with `agrabah/`)
    sourceLine: number;
}

// ---- Source collectors -------------------------------------------------------

async function collectRpcMethods(): Promise<SourceEntity[]> {
    const out: SourceEntity[] = [];
    const glob = new Glob('servers/*/services/*.ts');
    for await (const rel of glob.scan(SRC_ROOT)) {
        const full = `${SRC_ROOT}/${rel}`;
        const content = readFileSync(full, 'utf-8');
        const lines = content.split('\n');

        const serverMatch = rel.match(/^servers\/([^/]+)\//);
        if (!serverMatch) continue;
        const server = serverMatch[1];

        // Track current Service class (only those extending *BaseService).
        let currentService: string | null = null;
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];

            // Service class declaration. Only count classes that extend something ending with "BaseService".
            const svcDecl = line.match(/^export\s+class\s+(\w+)Service\s+extends\s+\w*BaseService/)
                || line.match(/^class\s+(\w+)Service\s+extends\s+\w*BaseService/);
            if (svcDecl) {
                const cls = svcDecl[1];
                currentService = cls.charAt(0).toLowerCase() + cls.slice(1);
                continue;
            }
            // Any other top-level class declaration ends the current service scope.
            if (/^(?:export\s+)?class\s+\w+/.test(line) && !/Service\s+extends\s+\w*BaseService/.test(line)) {
                currentService = null;
            }

            if (!currentService) continue;
            const m = line.match(/^\s+(?:public\s+|protected\s+|private\s+|static\s+)*async\s+method(\w+)\s*\(/);
            if (!m) continue;
            const method = m[1];
            const fqn = `${server}.${currentService}.${method}`;
            out.push({
                type: 'rpc-method',
                fqn,
                bareName: method,
                sourceFile: `agrabah/src/${rel}`,
                sourceLine: i + 1,
            });
        }
    }
    return out;
}

async function collectManagerMethods(): Promise<SourceEntity[]> {
    const out: SourceEntity[] = [];
    const glob = new Glob('managers/*.ts');
    for await (const rel of glob.scan(SRC_ROOT)) {
        const full = `${SRC_ROOT}/${rel}`;
        const content = readFileSync(full, 'utf-8');
        const lines = content.split('\n');

        let currentManager: string | null = null;
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];

            // Manager class declaration: `[export] class XxxManager (extends ...)?(<...>)? {`.
            const mgrDecl = line.match(/^(?:export\s+)?class\s+(\w+Manager)\b/);
            if (mgrDecl) {
                currentManager = mgrDecl[1];
                continue;
            }
            // Any other top-level class declaration ends manager scope.
            if (/^(?:export\s+)?class\s+\w+/.test(line) && !line.includes('Manager')) {
                currentManager = null;
            }

            if (!currentManager) continue;
            // Match: `    async name(` or `    async name<T>(`. Exclude `_` and `#` prefixes (private convention).
            const m = line.match(/^\s+(?:public\s+|protected\s+|static\s+)*async\s+([a-zA-Z][\w]*)\s*[(<]/);
            if (!m) continue;
            const name = m[1];
            if (name.startsWith('_')) continue;
            const fqn = `Manager.${currentManager}.${name}`;
            out.push({
                type: 'manager-method',
                fqn,
                bareName: name,
                sourceFile: `agrabah/src/${rel}`,
                sourceLine: i + 1,
            });
        }
    }
    return out;
}

async function collectEnums(): Promise<SourceEntity[]> {
    const out: SourceEntity[] = [];
    const seen = new Set<string>();
    const glob = new Glob('**/*.rajah');
    for await (const rel of glob.scan(RAJAH_ROOT)) {
        const full = `${RAJAH_ROOT}/${rel}`;
        const content = readFileSync(full, 'utf-8');
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
            const m = lines[i].match(/^enum\s+(\w+)\s*\{/);
            if (!m) continue;
            const name = m[1];
            if (seen.has(name)) continue;
            seen.add(name);
            out.push({
                type: 'enum',
                fqn: `?.Enum.${name}`,
                bareName: name,
                sourceFile: `rajah/${rel}`,
                sourceLine: i + 1,
            });
        }
    }
    return out;
}

async function collectModels(): Promise<SourceEntity[]> {
    const out: SourceEntity[] = [];
    const seen = new Set<string>();
    const glob = new Glob('**/*.rajah');
    for await (const rel of glob.scan(RAJAH_ROOT)) {
        const full = `${RAJAH_ROOT}/${rel}`;
        const content = readFileSync(full, 'utf-8');
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
            const m = lines[i].match(/^model\s+(\w+)\s*\{/);
            if (!m) continue;
            const name = m[1];
            if (seen.has(name)) continue;
            seen.add(name);
            out.push({
                type: 'model',
                fqn: `?.Model.${name}`,
                bareName: name,
                sourceFile: `rajah/${rel}`,
                sourceLine: i + 1,
            });
        }
    }
    return out;
}

async function collectDbOrm(): Promise<SourceEntity[]> {
    const out: SourceEntity[] = [];
    const seen = new Set<string>();
    const glob = new Glob('database_types/**/*.ts');
    for await (const rel of glob.scan(SRC_ROOT)) {
        const full = `${SRC_ROOT}/${rel}`;
        const content = readFileSync(full, 'utf-8');
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
            const m = lines[i].match(/^export\s+class\s+(Db\w+)/);
            if (!m) continue;
            const name = m[1];
            if (seen.has(name)) continue;
            seen.add(name);
            out.push({
                type: 'db-orm',
                fqn: `?.${name}`,
                bareName: name,
                sourceFile: `agrabah/src/${rel}`,
                sourceLine: i + 1,
            });
        }
    }
    return out;
}

// ---- Note inventory ----------------------------------------------------------

interface NoteInventory {
    fqnByType: Record<EntityType, Set<string>>;
    bareByType: Record<EntityType, Set<string>>;
}

async function buildNoteInventory(): Promise<NoteInventory> {
    const fqnByType: Record<EntityType, Set<string>> = {
        'rpc-method': new Set(),
        'manager-method': new Set(),
        'enum': new Set(),
        'model': new Set(),
        'db-orm': new Set(),
    };
    const bareByType: Record<EntityType, Set<string>> = {
        'rpc-method': new Set(),
        'manager-method': new Set(),
        'enum': new Set(),
        'model': new Set(),
        'db-orm': new Set(),
    };

    const glob = new Glob('**/*.md');
    for await (const rel of glob.scan(CODEBASE_DIR)) {
        const full = `${CODEBASE_DIR}/${rel}`;
        const note = await parseNote(full);
        if (!note) continue;
        const t = note.type as EntityType;
        if (!fqnByType[t]) continue;

        fqnByType[t].add(note.fqn);
        const lastSeg = note.fqn.split('.').pop() ?? note.fqn;
        bareByType[t].add(lastSeg);

        const aliases = note.frontmatter.aliases;
        if (Array.isArray(aliases)) {
            for (const a of aliases) {
                if (typeof a === 'string') bareByType[t].add(a);
            }
        }
    }
    return { fqnByType, bareByType };
}

// ---- Cross-compare -----------------------------------------------------------

interface MissingEntry {
    type: EntityType;
    fqn: string;
    bareName: string;
    sourceFile: string;
    sourceLine: number;
}

interface Summary {
    total: number;
    covered: number;
    missing: number;
}

interface Report {
    timestamp: string;
    summary: {
        rpcMethods: Summary;
        managerMethods: Summary;
        enums: Summary;
        models: Summary;
        dbOrmClasses: Summary;
    };
    missing: MissingEntry[];
}

function audit(entities: SourceEntity[], inv: NoteInventory, type: EntityType, matchByFqn: boolean): { summary: Summary; missing: MissingEntry[] } {
    const fqnSet = inv.fqnByType[type];
    const bareSet = inv.bareByType[type];
    const missing: MissingEntry[] = [];
    let covered = 0;
    for (const e of entities) {
        let isCovered = false;
        if (matchByFqn && fqnSet.has(e.fqn)) isCovered = true;
        if (!isCovered && bareSet.has(e.bareName)) isCovered = true;
        if (isCovered) {
            covered++;
        } else {
            missing.push({
                type: e.type,
                fqn: e.fqn,
                bareName: e.bareName,
                sourceFile: e.sourceFile,
                sourceLine: e.sourceLine,
            });
        }
    }
    return {
        summary: { total: entities.length, covered, missing: entities.length - covered },
        missing,
    };
}

// ---- Main --------------------------------------------------------------------

async function main() {
    console.log('[audit] Collecting source entities...');
    const [rpc, mgr, enums, models, dbOrm] = await Promise.all([
        collectRpcMethods(),
        collectManagerMethods(),
        collectEnums(),
        collectModels(),
        collectDbOrm(),
    ]);
    console.log(`[audit] Source counts → rpc=${rpc.length} manager=${mgr.length} enum=${enums.length} model=${models.length} db-orm=${dbOrm.length}`);

    console.log('[audit] Building note inventory...');
    const inv = await buildNoteInventory();
    console.log(`[audit] Note counts → rpc=${inv.fqnByType['rpc-method'].size} manager=${inv.fqnByType['manager-method'].size} enum=${inv.fqnByType['enum'].size} model=${inv.fqnByType['model'].size} db-orm=${inv.fqnByType['db-orm'].size}`);

    const rpcRes = audit(rpc, inv, 'rpc-method', true);
    const mgrRes = audit(mgr, inv, 'manager-method', true);
    const enumRes = audit(enums, inv, 'enum', false);
    const modelRes = audit(models, inv, 'model', false);
    const dbRes = audit(dbOrm, inv, 'db-orm', false);

    const report: Report = {
        timestamp: new Date().toISOString(),
        summary: {
            rpcMethods: rpcRes.summary,
            managerMethods: mgrRes.summary,
            enums: enumRes.summary,
            models: modelRes.summary,
            dbOrmClasses: dbRes.summary,
        },
        missing: [
            ...rpcRes.missing,
            ...mgrRes.missing,
            ...enumRes.missing,
            ...modelRes.missing,
            ...dbRes.missing,
        ],
    };

    writeFileSync(OUT_PATH, JSON.stringify(report, null, 2));
    console.log(`[audit] Report written → ${OUT_PATH}`);
    console.log('[audit] Summary:');
    console.log(JSON.stringify(report.summary, null, 2));
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
