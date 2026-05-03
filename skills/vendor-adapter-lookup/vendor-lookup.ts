#!/usr/bin/env bun
/**
 * vendor-lookup.ts — Locate 3rd-party vendor adapters and their entry points.
 *
 * Categories scanned:
 *   payment-deposit   src/servers/payment/adapters/deposit/<vendor>_deposit_adapter.ts
 *   payment-withdraw  src/servers/payment/adapters/withdraw/<vendor>_withdraw_adapter.ts
 *   game              src/servers/game/game_vendor_adapters/<vendor>.ts
 *   customer-service  src/servers/customer_service/adapters/<vendor>_adapter.ts
 *   verification-code src/servers/verification_code/adapters/<vendor>_adapter.ts
 *   location          src/servers/location/adapters/<vendor>_adapter.ts
 *
 * Entry points:
 *   - 3rd-party HTTP callbacks:  `async handleRaw\w+(` methods inside services
 *   - Pull jobs:                 src/servers/<server>/jobs/*.ts
 *
 * Subcommands:
 *   list                        List all adapter files grouped by category
 *   list-callbacks              List all handleRaw* methods (callback entry points)
 *   list-jobs                   List all pull job files
 *   locate <vendorKeyword>      Find adapter files + class declarations matching keyword
 *   adapter-methods <file>      List all `async <method>(` declarations in an adapter file
 *   vendor-methods <vendor>     For a vendor name, find all matching adapters + their methods
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { join, basename } from 'path';

// V5: 支援 ALADDIN_ROOT_AT_DATE env 變數
const ALADDIN = process.env.ALADDIN_ROOT_AT_DATE ?? '/Users/user/aladdin';
const AGRABAH = join(ALADDIN, 'agrabah');
const SERVERS = join(AGRABAH, 'src/servers');

interface AdapterCategory {
    category: string;
    dir: string;
    fileFilter: (f: string) => boolean;
    relPath: string;
}

const CATEGORIES: AdapterCategory[] = [
    {
        category: 'payment-deposit',
        dir: join(SERVERS, 'payment/adapters/deposit'),
        fileFilter: (f) => f.endsWith('_deposit_adapter.ts') && f !== 'deposit_adapter.ts',
        relPath: 'src/servers/payment/adapters/deposit',
    },
    {
        category: 'payment-withdraw',
        dir: join(SERVERS, 'payment/adapters/withdraw'),
        fileFilter: (f) => f.endsWith('_withdraw_adapter.ts') && f !== 'withdraw_adapter.ts',
        relPath: 'src/servers/payment/adapters/withdraw',
    },
    {
        category: 'game',
        dir: join(SERVERS, 'game/game_vendor_adapters'),
        // Skip the base class and shared helpers/index entries.
        fileFilter: (f) => f.endsWith('.ts')
            && f !== 'game_vendor_adapter_base.ts'
            && f !== 'index.ts',
        relPath: 'src/servers/game/game_vendor_adapters',
    },
    {
        category: 'customer-service',
        dir: join(SERVERS, 'customer_service/adapters'),
        fileFilter: (f) => f.endsWith('_adapter.ts') && f !== 'base_adapter.ts',
        relPath: 'src/servers/customer_service/adapters',
    },
    {
        category: 'verification-code',
        dir: join(SERVERS, 'verification_code/adapters'),
        fileFilter: (f) => f.endsWith('_adapter.ts') && f !== 'base_adapter.ts',
        relPath: 'src/servers/verification_code/adapters',
    },
    {
        category: 'location',
        dir: join(SERVERS, 'location/adapters'),
        fileFilter: (f) => f.endsWith('_adapter.ts') && f !== 'base_adapter.ts',
        relPath: 'src/servers/location/adapters',
    },
];

interface AdapterFile {
    category: string;
    vendor: string;
    file: string;
    relPath: string;
}

/**
 * Strip suffix conventions to recover a clean vendor slug:
 *   ab_deposit_adapter.ts → ab
 *   cq9.ts → cq9
 *   geetest_adapter.ts → geetest
 */
function deriveVendorSlug(category: string, filename: string): string {
    const base = filename.replace(/\.ts$/, '');
    if (category === 'payment-deposit') { return base.replace(/_deposit_adapter$/, ''); }
    if (category === 'payment-withdraw') { return base.replace(/_withdraw_adapter$/, ''); }
    if (category === 'game') { return base; }
    return base.replace(/_adapter$/, '');
}

function listAdapters(): AdapterFile[] {
    const result: AdapterFile[] = [];
    for (const cat of CATEGORIES) {
        if (!existsSync(cat.dir)) { continue; }
        for (const f of readdirSync(cat.dir)) {
            const full = join(cat.dir, f);
            if (!statSync(full).isFile()) { continue; }
            if (!cat.fileFilter(f)) { continue; }
            result.push({
                category: cat.category,
                vendor: deriveVendorSlug(cat.category, f),
                file: full,
                relPath: join(cat.relPath, f),
            });
        }
    }
    return result;
}

interface ClassDecl {
    name: string;
    extends: string | null;
    line: number;
}

function findClasses(file: string): ClassDecl[] {
    const lines = readFileSync(file, 'utf-8').split('\n');
    const classes: ClassDecl[] = [];
    for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(/^(?:export\s+)?class\s+(\w+)(?:\s+extends\s+(\w+))?/);
        if (m) {
            classes.push({ name: m[1], extends: m[2] || null, line: i + 1 });
        }
    }
    return classes;
}

interface MethodDecl {
    name: string;
    line: number;
    isStandard: boolean;
    signature: string;
}

const STANDARD_VENDOR_METHOD_PREFIXES = [ 'vendor', 'fetch', 'parse', 'callback' ];

function listAdapterMethods(file: string): MethodDecl[] {
    const lines = readFileSync(file, 'utf-8').split('\n');
    const methods: MethodDecl[] = [];
    for (let i = 0; i < lines.length; i++) {
        // matches `    [private|public|protected]? [async]? methodName(`
        const m = lines[i].match(/^\s+(?:(?:private|public|protected|static|override)\s+)*(?:async\s+)?(\w+)\s*\(/);
        if (!m) { continue; }
        const name = m[1];
        if ([ 'if', 'for', 'while', 'switch', 'catch', 'return', 'throw', 'constructor', 'get', 'set' ].includes(name)) { continue; }
        // Skip arrow / const declarations
        if (lines[i].trim().match(/^(const|let|var)\b/)) { continue; }
        // Require leading indentation (must be inside a class body)
        if (!lines[i].match(/^\s+/)) { continue; }
        const isStandard = STANDARD_VENDOR_METHOD_PREFIXES.some(p => name.startsWith(p));
        methods.push({ name, line: i + 1, isStandard, signature: lines[i].trim() });
    }
    return methods;
}

// ─── Subcommand: list ───
function list() {
    const adapters = listAdapters();
    const grouped: Record<string, AdapterFile[]> = {};
    for (const a of adapters) {
        if (!grouped[a.category]) { grouped[a.category] = []; }
        grouped[a.category].push(a);
    }
    const result = CATEGORIES.map(c => ({
        category: c.category,
        dir: c.relPath,
        vendorCount: (grouped[c.category] || []).length,
        vendors: (grouped[c.category] || []).map(a => a.vendor).sort(),
    }));
    console.log(JSON.stringify({
        totalAdapters: adapters.length,
        categories: result,
    }, null, 2));
}

// ─── Subcommand: list-callbacks ───
function listCallbacks() {
    const out = Bun.spawnSync([
        'grep', '-rnE', 'async\\s+handleRaw\\w+\\s*\\(',
        SERVERS, '--include=*.ts',
    ], { stdout: 'pipe', stderr: 'pipe' });
    const lines = out.stdout.toString().trim().split('\n').filter(Boolean);

    interface CallbackHit {
        server: string;
        file: string;
        line: number;
        method: string;
        signature: string;
    }
    const hits: CallbackHit[] = [];
    for (const raw of lines) {
        const m = raw.match(/^(.+?):(\d+):(.*)$/);
        if (!m) { continue; }
        const file = m[1];
        const line = parseInt(m[2]);
        const content = m[3];
        const methodMatch = content.match(/async\s+(handleRaw\w+)\s*\(/);
        if (!methodMatch) { continue; }
        const serverMatch = file.match(/servers\/([^/]+)\//);
        hits.push({
            server: serverMatch ? serverMatch[1] : 'unknown',
            file: file.replace(AGRABAH + '/', ''),
            line,
            method: methodMatch[1],
            signature: content.trim(),
        });
    }
    // Group by server
    const byServer: Record<string, CallbackHit[]> = {};
    for (const h of hits) {
        if (!byServer[h.server]) { byServer[h.server] = []; }
        byServer[h.server].push(h);
    }
    console.log(JSON.stringify({
        totalCallbacks: hits.length,
        serverCount: Object.keys(byServer).length,
        callbacksByServer: Object.entries(byServer).map(([ server, list ]) => ({
            server,
            count: list.length,
            callbacks: list,
        })),
    }, null, 2));
}

// ─── Subcommand: list-jobs ───
function listJobs() {
    const out = Bun.spawnSync([
        'find', SERVERS, '-type', 'f', '-path', '*/jobs/*.ts',
    ], { stdout: 'pipe', stderr: 'pipe' });
    const files = out.stdout.toString().trim().split('\n').filter(Boolean);

    interface JobFile {
        server: string;
        file: string;
        relPath: string;
        vendorRelated: boolean;
    }
    const jobs: JobFile[] = [];
    for (const f of files) {
        const serverMatch = f.match(/servers\/([^/]+)\//);
        const content = readFileSync(f, 'utf-8');
        // Use substring match (no \b): in JS regex `_` is a word char, so `\bvendor\b` would
        // miss identifiers like `game_vendor_game_records` or `GameVendorAdapter`. This is a
        // fuzzy heuristic anyway — caller is told to verify by reading the file.
        const vendorRelated = /vendor|adapter|external/i.test(content);
        jobs.push({
            server: serverMatch ? serverMatch[1] : 'unknown',
            file: f,
            relPath: f.replace(AGRABAH + '/', ''),
            vendorRelated,
        });
    }
    const byServer: Record<string, JobFile[]> = {};
    for (const j of jobs) {
        if (!byServer[j.server]) { byServer[j.server] = []; }
        byServer[j.server].push(j);
    }
    console.log(JSON.stringify({
        totalJobs: jobs.length,
        vendorRelatedJobs: jobs.filter(j => j.vendorRelated).length,
        serverCount: Object.keys(byServer).length,
        jobsByServer: Object.entries(byServer).map(([ server, list ]) => ({
            server,
            count: list.length,
            jobs: list,
        })),
    }, null, 2));
}

// ─── Subcommand: locate ───
function locate(keyword: string) {
    const adapters = listAdapters();
    const lower = keyword.toLowerCase();
    const matches = adapters.filter(a => a.vendor.toLowerCase().includes(lower));
    const enriched = matches.map(m => {
        const classes = findClasses(m.file);
        return {
            category: m.category,
            vendor: m.vendor,
            file: m.relPath,
            absFile: m.file,
            classes,
        };
    });
    console.log(JSON.stringify({
        keyword,
        matchCount: enriched.length,
        matches: enriched,
    }, null, 2));
}

// ─── Subcommand: adapter-methods ───
function adapterMethods(file: string) {
    let abs = file;
    if (!abs.startsWith('/')) { abs = join(AGRABAH, file); }
    if (!existsSync(abs)) {
        console.log(JSON.stringify({ error: `file not found: ${ abs }` }));
        return;
    }
    const classes = findClasses(abs);
    const methods = listAdapterMethods(abs);
    console.log(JSON.stringify({
        file: abs,
        classes,
        methodCount: methods.length,
        standardMethodCount: methods.filter(m => m.isStandard).length,
        methods,
    }, null, 2));
}

// ─── Subcommand: vendor-methods ───
function vendorMethods(vendor: string) {
    const adapters = listAdapters();
    const lower = vendor.toLowerCase();
    const matches = adapters.filter(a => a.vendor.toLowerCase() === lower || a.vendor.toLowerCase().includes(lower));
    const result = matches.map(m => {
        const classes = findClasses(m.file);
        const methods = listAdapterMethods(m.file);
        return {
            category: m.category,
            vendor: m.vendor,
            file: m.relPath,
            classes,
            methodCount: methods.length,
            methods,
        };
    });
    console.log(JSON.stringify({
        vendor,
        adapterCount: result.length,
        adapters: result,
    }, null, 2));
}

// ─── Main dispatcher ───
const args = process.argv.slice(2);
const cmd = args[0];

switch (cmd) {
    case 'list': list(); break;
    case 'list-callbacks': listCallbacks(); break;
    case 'list-jobs': listJobs(); break;
    case 'locate': locate(args[1]); break;
    case 'adapter-methods': adapterMethods(args[1]); break;
    case 'vendor-methods': vendorMethods(args[1]); break;
    default:
        console.error('Usage: bun vendor-lookup.ts <subcommand> <args>');
        console.error('Subcommands: list, list-callbacks, list-jobs, locate, adapter-methods, vendor-methods');
        console.error('Examples:');
        console.error('  bun vendor-lookup.ts list');
        console.error('  bun vendor-lookup.ts list-callbacks');
        console.error('  bun vendor-lookup.ts list-jobs');
        console.error('  bun vendor-lookup.ts locate ab');
        console.error('  bun vendor-lookup.ts adapter-methods src/servers/payment/adapters/deposit/ab_deposit_adapter.ts');
        console.error('  bun vendor-lookup.ts vendor-methods cq9');
        process.exit(1);
}
