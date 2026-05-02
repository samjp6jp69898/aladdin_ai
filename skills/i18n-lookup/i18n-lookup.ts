#!/usr/bin/env bun
/**
 * i18n-lookup.ts — Look up translations across all 7 frontend projects.
 *
 * Source paths (do NOT use Codebase/_index notes — the source is the JSON itself):
 *   /Users/user/aladdin/abu/{admin,platform}/localizations/{zh-TW,zh-CN,en-US}.json
 *   /Users/user/aladdin/lago/{agent-backend,landing-page,n8-gaming,ny-gaming,pk-gaming}/localizations/{zh-TW,zh-CN,en-US}.json
 *
 * Subcommands:
 *   error <code>                Look up error code translation. <code> is integer.
 *                               Reports source: genie ErrorCode (1~25) vs AgrabahErrorCodeEnum (101+).
 *   enum <EnumName>             Look up all values of an enum. Auto-converts EnumName to kebab.
 *   enum <EnumName> <value>     Look up a specific enum value. e.g. enum TransactionStatusEnum success
 *   model <field-kebab>         Look up a model/field translation key under .model.
 *   key <section>.<keyName>     Generic lookup: any top-level section + key. e.g. key common.all
 *   list-projects               List all 7 frontend projects + which locales they have.
 *
 * Output is JSON. For each translation found, includes:
 *   { project, locale, value, file, jqPath }
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';

const ALADDIN = '/Users/user/aladdin';
const LOCALES = [ 'zh-TW', 'zh-CN', 'en-US' ];

interface Project {
    name: string;
    root: string;
    localizations: string;
}

const PROJECTS: Project[] = [
    { name: 'abu-admin', root: 'abu/admin', localizations: 'abu/admin/localizations' },
    { name: 'abu-platform', root: 'abu/platform', localizations: 'abu/platform/localizations' },
    { name: 'lago-agent-backend', root: 'lago/agent-backend', localizations: 'lago/agent-backend/localizations' },
    { name: 'lago-landing-page', root: 'lago/landing-page', localizations: 'lago/landing-page/localizations' },
    { name: 'lago-n8-gaming', root: 'lago/n8-gaming', localizations: 'lago/n8-gaming/localizations' },
    { name: 'lago-ny-gaming', root: 'lago/ny-gaming', localizations: 'lago/ny-gaming/localizations' },
    { name: 'lago-pk-gaming', root: 'lago/pk-gaming', localizations: 'lago/pk-gaming/localizations' },
];

const cache = new Map<string, any>();

function loadJson(file: string): any {
    if (cache.has(file)) { return cache.get(file); }
    if (!existsSync(file)) { return null; }
    const json = JSON.parse(readFileSync(file, 'utf-8'));
    cache.set(file, json);
    return json;
}

interface Hit {
    project: string;
    locale: string;
    value: any;
    file: string;
    jqPath: string;
}

function lookupSection(section: string, key: string): Hit[] {
    const hits: Hit[] = [];
    for (const p of PROJECTS) {
        for (const locale of LOCALES) {
            const file = join(ALADDIN, p.localizations, `${ locale }.json`);
            const json = loadJson(file);
            if (!json) { continue; }
            const sectionData = json[section];
            if (!sectionData || typeof sectionData !== 'object') { continue; }
            if (key in sectionData) {
                hits.push({
                    project: p.name,
                    locale,
                    value: sectionData[key],
                    file,
                    jqPath: `.${ section }["${ key }"]`,
                });
            }
        }
    }
    return hits;
}

/**
 * PascalCase → kebab-case. Handles consecutive uppercase (e.g. "URL") by treating
 * each uppercase boundary as a word break.
 */
function toKebab(name: string): string {
    return name
        .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
        .toLowerCase();
}

// ─── Subcommand: error ───
function lookupError(code: string) {
    const hits = lookupSection('error', code);
    const codeNum = parseInt(code, 10);
    let source: string;
    if (Number.isNaN(codeNum)) {
        source = 'unknown (non-numeric)';
    } else if (codeNum === 0) {
        source = 'genie ErrorCode.success';
    } else if (codeNum >= 1 && codeNum <= 25) {
        source = `genie ErrorCode (file: /Users/user/aladdin/genie/src/common/error_code.ts)`;
    } else if (codeNum >= 100) {
        source = `AgrabahErrorCodeEnum (file: /Users/user/aladdin/rajah/services/common.rajah, see enum AgrabahErrorCodeEnum)`;
    } else {
        source = `unknown range (${ codeNum })`;
    }

    console.log(JSON.stringify({
        code,
        source,
        translationsFound: hits.length,
        hits,
    }, null, 2));
}

// ─── Subcommand: enum ───
function lookupEnum(enumName: string, valueName?: string) {
    const enumKebab = toKebab(enumName);

    if (valueName) {
        const valueKebab = toKebab(valueName);
        const fullKey = `${ enumKebab }-${ valueKebab }`;
        const hits = lookupSection('enum', fullKey);

        // If exact match misses, search for keys ending with the same enum-value tail
        // (handles cases where translation lives under a business-prefixed key like
        // `game-transaction-status-enum-success`).
        const fallbackHits: Hit[] = [];
        if (hits.length === 0) {
            const tail = `${ enumKebab }-${ valueKebab }`;
            for (const p of PROJECTS) {
                for (const locale of LOCALES) {
                    const file = join(ALADDIN, p.localizations, `${ locale }.json`);
                    const json = loadJson(file);
                    if (!json?.enum) { continue; }
                    for (const k of Object.keys(json.enum)) {
                        if (k.endsWith(tail) && k !== tail) {
                            fallbackHits.push({
                                project: p.name,
                                locale,
                                value: json.enum[k],
                                file,
                                jqPath: `.enum["${ k }"]`,
                            });
                        }
                    }
                }
            }
        }

        console.log(JSON.stringify({
            enum: enumName,
            value: valueName,
            kebabKey: fullKey,
            translationsFound: hits.length,
            hits,
            fallbackSuffixHitsFound: fallbackHits.length,
            fallbackSuffixHits: fallbackHits,
        }, null, 2));
        return;
    }

    // No value — list all keys starting with enumKebab + '-'
    const prefix = `${ enumKebab }-`;
    const grouped: Record<string, Hit[]> = {};
    for (const p of PROJECTS) {
        for (const locale of LOCALES) {
            const file = join(ALADDIN, p.localizations, `${ locale }.json`);
            const json = loadJson(file);
            if (!json?.enum) { continue; }
            for (const k of Object.keys(json.enum)) {
                if (!k.startsWith(prefix)) { continue; }
                if (!grouped[k]) { grouped[k] = []; }
                grouped[k].push({
                    project: p.name,
                    locale,
                    value: json.enum[k],
                    file,
                    jqPath: `.enum["${ k }"]`,
                });
            }
        }
    }
    const valueKeys = Object.keys(grouped).sort();
    console.log(JSON.stringify({
        enum: enumName,
        kebabPrefix: prefix,
        valuesFound: valueKeys.length,
        values: valueKeys.map(k => ({
            kebabKey: k,
            valueName: k.slice(prefix.length),
            translations: grouped[k],
        })),
    }, null, 2));
}

// ─── Subcommand: model ───
function lookupModel(fieldKey: string) {
    const hits = lookupSection('model', fieldKey);
    console.log(JSON.stringify({
        section: 'model',
        key: fieldKey,
        translationsFound: hits.length,
        hits,
    }, null, 2));
}

// ─── Subcommand: key ───
function lookupKey(input: string) {
    const dotIdx = input.indexOf('.');
    if (dotIdx < 0) {
        console.error('Usage: key <section>.<keyName>  e.g. key common.all');
        process.exit(1);
    }
    const section = input.slice(0, dotIdx);
    const key = input.slice(dotIdx + 1);
    const hits = lookupSection(section, key);
    console.log(JSON.stringify({
        section,
        key,
        translationsFound: hits.length,
        hits,
    }, null, 2));
}

// ─── Subcommand: list-projects ───
function listProjects() {
    // A project is "plaintext" if it has the standard top-level sections (error/enum/...).
    // lago projects ship base64-obfuscated keys + obfuscated values, so this skill cannot
    // resolve their translations — flag them explicitly so callers know.
    const KNOWN_SECTIONS = new Set([ 'error', 'enum', 'model', 'common', 'menu', 'permission', 'route', 'country', 'user' ]);
    const result = PROJECTS.map(p => {
        const dir = join(ALADDIN, p.localizations);
        const locales = existsSync(dir)
            ? readdirSync(dir).filter(f => f.endsWith('.json')).map(f => f.replace('.json', ''))
            : [];
        let topSections: string[] = [];
        const tw = join(dir, 'zh-TW.json');
        if (existsSync(tw)) {
            try { topSections = Object.keys(JSON.parse(readFileSync(tw, 'utf-8'))); } catch {}
        }
        const plaintext = topSections.some(s => KNOWN_SECTIONS.has(s));
        return {
            project: p.name,
            dir: p.localizations,
            locales,
            topSections,
            plaintext,
            note: plaintext ? null : 'OBFUSCATED — keys/values are base64-encoded and further obfuscated; this skill cannot resolve translations for this project.',
        };
    });
    const plaintextCount = result.filter(p => p.plaintext).length;
    console.log(JSON.stringify({
        projects: result,
        summary: {
            total: result.length,
            plaintext: plaintextCount,
            obfuscated: result.length - plaintextCount,
            note: 'This skill only resolves translations for plaintext projects (abu-admin, abu-platform). Lago projects are obfuscated.',
        },
    }, null, 2));
}

// ─── Main dispatcher ───
const args = process.argv.slice(2);
const cmd = args[0];

switch (cmd) {
    case 'error': lookupError(args[1]); break;
    case 'enum': lookupEnum(args[1], args[2]); break;
    case 'model': lookupModel(args[1]); break;
    case 'key': lookupKey(args[1]); break;
    case 'list-projects': listProjects(); break;
    default:
        console.error('Usage: bun i18n-lookup.ts <subcommand> <args>');
        console.error('Subcommands: error, enum, model, key, list-projects');
        console.error('Examples:');
        console.error('  bun i18n-lookup.ts error 211');
        console.error('  bun i18n-lookup.ts enum TransactionStatusEnum');
        console.error('  bun i18n-lookup.ts enum TransactionStatusEnum success');
        console.error('  bun i18n-lookup.ts model account-name');
        console.error('  bun i18n-lookup.ts key common.all');
        console.error('  bun i18n-lookup.ts list-projects');
        process.exit(1);
}
