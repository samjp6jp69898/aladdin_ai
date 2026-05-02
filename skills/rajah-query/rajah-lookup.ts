#!/usr/bin/env bun
/**
 * rajah-lookup.ts — Definition lookup for Rajah source files (single source of truth).
 *
 * Source paths (do NOT use Codebase/_index notes — they may be stale):
 *   /Users/user/aladdin/rajah/services/*.rajah   service / method / model / enum
 *   /Users/user/aladdin/rajah/messages/*.rajah   RabbitMQ messages
 *   /Users/user/aladdin/rajah/jobs/*.rajah       Cron jobs
 *   /Users/user/aladdin/agrabah/rajah/server_*.json  server -> rajah file mapping
 *
 * Subcommands:
 *   find-method <MethodName>            locate method declaration + service + servers
 *   find-enum <EnumName>                locate enum declaration + values
 *   find-model <ModelName>              locate model declaration + fields
 *   find-service <ServiceName>          locate service block + all methods
 *   list-server <serverName>            list rajah files + services + cross-server clients of a server
 *   list-server-methods <serverName>    list every method declared by a server
 *   who-calls-service <ServiceName>     find which servers depend on this service via rajahClientServiceGroups
 *   find-message <MessageName>          locate message declaration in rajah/messages
 *   find-job <JobName>                  locate job declaration in rajah/jobs
 *
 * Output is always JSON on stdout. file:line is included so the agent can read source directly.
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';

const ALADDIN = '/Users/user/aladdin';
const RAJAH_SERVICES = join(ALADDIN, 'rajah/services');
const RAJAH_MESSAGES = join(ALADDIN, 'rajah/messages');
const RAJAH_JOBS = join(ALADDIN, 'rajah/jobs');
const SERVER_CONFIGS = join(ALADDIN, 'agrabah/rajah');

interface Hit {
    file: string;
    line: number;
    content: string;
}

function readLines(file: string): string[] {
    return readFileSync(file, 'utf-8').split('\n');
}

function listRajahFiles(dir: string): string[] {
    if (!existsSync(dir)) { return []; }
    return readdirSync(dir)
        .filter(f => f.endsWith('.rajah'))
        .map(f => join(dir, f));
}

function listServerJsons(): string[] {
    return readdirSync(SERVER_CONFIGS)
        .filter(f => f.startsWith('server_') && f.endsWith('.json') && !f.endsWith('.gen.json'))
        .map(f => join(SERVER_CONFIGS, f));
}

function serverNameFromJson(path: string): string {
    return path.split('/').pop()!.replace('server_', '').replace('.json', '');
}

function readServerConfig(serverName: string): { rajahServiceFilenames: string[]; rajahClientFilenames: string[]; rajahClientServiceGroups: Record<string, string[]>; base?: string } | null {
    const path = join(SERVER_CONFIGS, `server_${ serverName }.json`);
    if (!existsSync(path)) { return null; }
    const cfg = JSON.parse(readFileSync(path, 'utf-8'));
    if (cfg.base) {
        const base = JSON.parse(readFileSync(join(SERVER_CONFIGS, cfg.base), 'utf-8'));
        cfg.rajahServiceFilenames = [ ...(base.rajahServiceFilenames || []), ...(cfg.rajahServiceFilenames || []) ];
        cfg.rajahClientFilenames = [ ...(base.rajahClientFilenames || []), ...(cfg.rajahClientFilenames || []) ];
        cfg.rajahClientServiceGroups = { ...(base.rajahClientServiceGroups || {}), ...(cfg.rajahClientServiceGroups || {}) };
    }
    return cfg;
}

function searchPattern(files: string[], regex: RegExp): Hit[] {
    const hits: Hit[] = [];
    for (const file of files) {
        const lines = readLines(file);
        for (let i = 0; i < lines.length; i++) {
            if (regex.test(lines[i])) {
                hits.push({ file, line: i + 1, content: lines[i] });
            }
        }
    }
    return hits;
}

function rajahFileBase(filePath: string): string {
    return filePath.split('/').pop()!.replace('.rajah', '');
}

const SERVERS_SRC = join(ALADDIN, 'agrabah/src/servers');

/**
 * Find which server actually HOSTS a service by grepping for `extends <ServiceName>BaseService`
 * across agrabah/src/servers/*\/services/*.ts. This is the authoritative answer.
 */
function findServiceHostServers(serviceName: string): { server: string; file: string; line: number }[] {
    if (!existsSync(SERVERS_SRC)) { return []; }
    const result: { server: string; file: string; line: number }[] = [];
    const baseClass = `${ serviceName }BaseService`;
    for (const server of readdirSync(SERVERS_SRC)) {
        const servicesDir = join(SERVERS_SRC, server, 'services');
        if (!existsSync(servicesDir)) { continue; }
        const walk = (d: string) => {
            for (const entry of readdirSync(d, { withFileTypes: true })) {
                const full = join(d, entry.name);
                if (entry.isDirectory()) { walk(full); continue; }
                if (!entry.name.endsWith('.ts')) { continue; }
                const lines = readLines(full);
                for (let i = 0; i < lines.length; i++) {
                    const re = new RegExp(`class\\s+\\w+\\s+extends\\s+${ baseClass }\\b`);
                    if (re.test(lines[i])) {
                        result.push({ server, file: full, line: i + 1 });
                    }
                }
            }
        };
        walk(servicesDir);
    }
    return result;
}

/**
 * Returns servers grouped by how they reference a rajah file:
 *   hostsOrDefines: rajahServiceFilenames — server hosts this rajah's services OR imports its enums/models
 *   clientImports: rajahClientFilenames — server only imports for cross-server gRPC calls
 *
 * NOTE: For service host info, prefer findServiceHostServers (authoritative) over this function.
 */
function serversUsingRajahService(rajahBase: string): { hostsOrDefines: string[]; clientImports: string[] } {
    const hostsOrDefines: string[] = [];
    const clientImports: string[] = [];
    for (const sj of listServerJsons()) {
        const sn = serverNameFromJson(sj);
        const cfg = readServerConfig(sn);
        if (!cfg) { continue; }
        if ((cfg.rajahServiceFilenames || []).includes(rajahBase)) {
            hostsOrDefines.push(sn);
        }
        if ((cfg.rajahClientFilenames || []).includes(rajahBase)) {
            clientImports.push(sn);
        }
    }
    return { hostsOrDefines: hostsOrDefines.sort(), clientImports: clientImports.sort() };
}

function readBlock(file: string, startLine: number): { endLine: number; body: string[] } {
    const lines = readLines(file);
    let depth = 0;
    let started = false;
    const body: string[] = [];
    for (let i = startLine - 1; i < lines.length; i++) {
        body.push(lines[i]);
        for (const ch of lines[i]) {
            if (ch === '{') { depth++; started = true; }
            else if (ch === '}') { depth--; }
        }
        if (started && depth === 0) {
            return { endLine: i + 1, body };
        }
    }
    return { endLine: lines.length, body };
}

// ─── Subcommand: find-method ───
function findMethod(methodName: string) {
    const files = listRajahFiles(RAJAH_SERVICES);
    // method declaration: indented "method Foo(" or "raw Foo("
    const regex = new RegExp(`^\\s+(method|raw)\\s+${ methodName }\\s*\\(`);
    const hits = searchPattern(files, regex);

    const results = hits.map(h => {
        const lines = readLines(h.file);
        // walk back to nearest "service Xxx {"
        let serviceName: string | null = null;
        for (let i = h.line - 1; i >= 0; i--) {
            const m = lines[i].match(/^service\s+(\w+)\s*\{/);
            if (m) { serviceName = m[1]; break; }
        }
        const rajahBase = rajahFileBase(h.file);
        const hostImpls = serviceName ? findServiceHostServers(serviceName) : [];
        return {
            file: h.file,
            line: h.line,
            signature: h.content.trim(),
            kind: h.content.trim().startsWith('raw') ? 'raw' : 'method',
            service: serviceName,
            rajahFile: rajahBase,
            hostedBy: hostImpls,
            serverRefs: serversUsingRajahService(rajahBase),
        };
    });

    console.log(JSON.stringify({ method: methodName, count: results.length, results }, null, 2));
}

// ─── Subcommand: find-enum / find-model ───
function findBlock(name: string, kind: 'enum' | 'model') {
    const files = [ ...listRajahFiles(RAJAH_SERVICES), ...listRajahFiles(RAJAH_MESSAGES), ...listRajahFiles(RAJAH_JOBS) ];
    // top-level: ^enum Name { OR ^enum Name (multi-line opening)
    const regex = new RegExp(`^${ kind }\\s+${ name }\\b`);
    const hits = searchPattern(files, regex);
    const results = hits.map(h => {
        const block = readBlock(h.file, h.line);
        const rajahBase = rajahFileBase(h.file);
        return {
            file: h.file,
            line: h.line,
            endLine: block.endLine,
            declaration: h.content.trim(),
            body: block.body.join('\n'),
            rajahFile: rajahBase,
            servers: serversUsingRajahService(rajahBase),
        };
    });
    console.log(JSON.stringify({ [kind]: name, count: results.length, results }, null, 2));
}

// ─── Subcommand: find-service ───
function findService(serviceName: string) {
    const files = listRajahFiles(RAJAH_SERVICES);
    const regex = new RegExp(`^service\\s+${ serviceName }\\s*\\{`);
    const hits = searchPattern(files, regex);

    const results = hits.map(h => {
        const block = readBlock(h.file, h.line);
        const methods: { kind: string; name: string; line: number; signature: string }[] = [];
        for (let i = 0; i < block.body.length; i++) {
            const m = block.body[i].match(/^\s+(method|raw)\s+(\w+)\s*\(/);
            if (m) {
                methods.push({ kind: m[1], name: m[2], line: h.line + i, signature: block.body[i].trim() });
            }
        }
        const rajahBase = rajahFileBase(h.file);
        return {
            file: h.file,
            line: h.line,
            endLine: block.endLine,
            rajahFile: rajahBase,
            hostedBy: findServiceHostServers(serviceName),
            serverRefs: serversUsingRajahService(rajahBase),
            methodCount: methods.length,
            methods,
        };
    });

    console.log(JSON.stringify({ service: serviceName, count: results.length, results }, null, 2));
}

// ─── Subcommand: list-server ───
function listServer(serverName: string) {
    const cfg = readServerConfig(serverName);
    if (!cfg) { console.log(JSON.stringify({ error: `server_${ serverName }.json not found` })); return; }

    const ownServices: { rajahFile: string; services: string[] }[] = [];
    for (const base of (cfg.rajahServiceFilenames || [])) {
        const path = join(RAJAH_SERVICES, `${ base }.rajah`);
        if (!existsSync(path)) { continue; }
        const services: string[] = [];
        const lines = readLines(path);
        for (const line of lines) {
            const m = line.match(/^service\s+(\w+)\s*\{/);
            if (m) { services.push(m[1]); }
        }
        ownServices.push({ rajahFile: base, services });
    }

    console.log(JSON.stringify({
        server: serverName,
        configFile: `agrabah/rajah/server_${ serverName }.json`,
        rajahServiceFilenames: cfg.rajahServiceFilenames || [],
        rajahClientFilenames: cfg.rajahClientFilenames || [],
        rajahClientServiceGroups: cfg.rajahClientServiceGroups || {},
        ownServices,
    }, null, 2));
}

// ─── Subcommand: list-server-methods ───
function listServerMethods(serverName: string) {
    const cfg = readServerConfig(serverName);
    if (!cfg) { console.log(JSON.stringify({ error: `server_${ serverName }.json not found` })); return; }

    const services: { rajahFile: string; service: string; line: number; methods: { kind: string; name: string; line: number; signature: string }[] }[] = [];

    for (const base of (cfg.rajahServiceFilenames || [])) {
        const path = join(RAJAH_SERVICES, `${ base }.rajah`);
        if (!existsSync(path)) { continue; }
        const lines = readLines(path);
        for (let i = 0; i < lines.length; i++) {
            const m = lines[i].match(/^service\s+(\w+)\s*\{/);
            if (!m) { continue; }
            const block = readBlock(path, i + 1);
            const methods: { kind: string; name: string; line: number; signature: string }[] = [];
            for (let j = 0; j < block.body.length; j++) {
                const mm = block.body[j].match(/^\s+(method|raw)\s+(\w+)\s*\(/);
                if (mm) {
                    methods.push({ kind: mm[1], name: mm[2], line: i + 1 + j, signature: block.body[j].trim() });
                }
            }
            services.push({ rajahFile: base, service: m[1], line: i + 1, methods });
        }
    }

    const total = services.reduce((s, sv) => s + sv.methods.length, 0);
    console.log(JSON.stringify({ server: serverName, totalMethods: total, services }, null, 2));
}

// ─── Subcommand: who-calls-service ───
function whoCallsService(serviceName: string) {
    const callers: { server: string; groupKey: string; allServicesInGroup: string[] }[] = [];
    for (const sj of listServerJsons()) {
        const sn = serverNameFromJson(sj);
        const cfg = readServerConfig(sn);
        if (!cfg) { continue; }
        const groups = cfg.rajahClientServiceGroups || {};
        for (const [ groupKey, services ] of Object.entries(groups)) {
            if (Array.isArray(services) && services.includes(serviceName)) {
                callers.push({ server: sn, groupKey, allServicesInGroup: services as string[] });
            }
        }
    }
    console.log(JSON.stringify({
        service: serviceName,
        callerCount: callers.length,
        callers,
        usage: `In caller code, the gRPC path looks like context.remote.<groupKey>.${ serviceName }.<method>`,
    }, null, 2));
}

// ─── Subcommand: find-message / find-job ───
function findMessageOrJob(name: string, kind: 'message' | 'job') {
    const dir = kind === 'message' ? RAJAH_MESSAGES : RAJAH_JOBS;
    const files = listRajahFiles(dir);
    const regex = new RegExp(`^model\\s+${ name }\\b`);
    const hits = searchPattern(files, regex);
    const results = hits.map(h => {
        const block = readBlock(h.file, h.line);
        return {
            file: h.file,
            line: h.line,
            endLine: block.endLine,
            body: block.body.join('\n'),
        };
    });
    console.log(JSON.stringify({ [kind]: name, count: results.length, results }, null, 2));
}

// ─── Main dispatcher ───
const args = process.argv.slice(2);
const cmd = args[0];

switch (cmd) {
    case 'find-method': findMethod(args[1]); break;
    case 'find-enum': findBlock(args[1], 'enum'); break;
    case 'find-model': findBlock(args[1], 'model'); break;
    case 'find-service': findService(args[1]); break;
    case 'list-server': listServer(args[1]); break;
    case 'list-server-methods': listServerMethods(args[1]); break;
    case 'who-calls-service': whoCallsService(args[1]); break;
    case 'find-message': findMessageOrJob(args[1], 'message'); break;
    case 'find-job': findMessageOrJob(args[1], 'job'); break;
    default:
        console.error('Usage: bun rajah-lookup.ts <subcommand> <args>');
        console.error('Subcommands: find-method, find-enum, find-model, find-service,');
        console.error('             list-server, list-server-methods, who-calls-service,');
        console.error('             find-message, find-job');
        process.exit(1);
}
