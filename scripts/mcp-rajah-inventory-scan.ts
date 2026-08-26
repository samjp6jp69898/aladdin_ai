#!/usr/bin/env bun
/**
 * mcp-rajah-inventory-scan.ts — 全 rajah 表面盤點（唯讀、不寫 tasks.json）。
 *
 * 跟 mcp-tool-gap-scan.ts 不一樣：那支是「已知 3 個 service 的落差 → 產生可認領任務」，
 * 這支是「rajah/services/*.rajah 全部 101 個檔案、全部 service，各自有沒有任何 MCP tool
 * 覆蓋」的一次性盤點報告，給人看全貌、決定要不要擴大 mcp-tool-gap-scan.ts 的 SCOPE，
 * 不會自動產生任務、不會判斷分類/命名（那些交給 generate agent 逐案處理）。
 *
 * 用法：bun obsidian/scripts/mcp-rajah-inventory-scan.ts [--out=<path>]
 *   預設輸出到 stdout；--out 可指定另外寫一份 markdown 檔案。
 */

import { readFileSync, readdirSync } from 'fs';

const RAJAH_DIR = '/Users/user/aladdin/rajah/services';
const MCPS_DIR = '/Users/user/aladdin/obsidian/mcps';

type Method = { name: string; line: number; isPlaceholder: boolean };
type ServiceBlock = { file: string; service: string; methods: Method[] };

function toCamelCase(s: string): string {
    return s.charAt(0).toLowerCase() + s.slice(1);
}

/** 掃單一 rajah 檔案裡全部 service 區塊（同名可重複出現），不限定 service 名稱。 */
function extractAllServiceBlocks(file: string): ServiceBlock[] {
    const text = readFileSync(`${ RAJAH_DIR }/${ file }`, 'utf8');
    const lines = text.split('\n');
    const blocks: ServiceBlock[] = [];

    for (let i = 0; i < lines.length; i++) {
        const m = lines[ i ].match(/^service\s+(\w+)\s*\{/);
        if (!m) continue;
        const serviceName = m[ 1 ];

        let depth = 1;
        let j = i + 1;
        for (; j < lines.length && depth > 0; j++) {
            const opens = (lines[ j ].match(/\{/g) || []).length;
            const closes = (lines[ j ].match(/\}/g) || []).length;
            depth += opens - closes;
        }
        const blockLines = lines.slice(i + 1, j - 1);

        const methods: Method[] = [];
        for (let k = 0; k < blockLines.length; k++) {
            const mm = blockLines[ k ].match(/^\s*method\s+(\w+)\s*\(/);
            if (!mm) continue;
            const methodName = mm[ 1 ];
            methods.push({
                name: methodName,
                line: i + 1 + k + 1,
                isPlaceholder: /^Placeholder[A-Z]/.test(methodName),
            });
        }
        blocks.push({ file, service: serviceName, methods });
        i = j - 1;
    }
    return blocks;
}

/** 掃全部 MCP server 的 tools/*.ts，回傳 serviceName -> { methods: Set, servers: Set } */
function scanAllToolCoverage(): Map<string, { methods: Set<string>; servers: Set<string> }> {
    const coverage = new Map<string, { methods: Set<string>; servers: Set<string> }>();
    const serverDirs = readdirSync(MCPS_DIR, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);

    for (const server of serverDirs) {
        const toolsDir = `${ MCPS_DIR }/${ server }/src/tools`;
        let files: string[];
        try {
            files = readdirSync(toolsDir).filter((f) => f.endsWith('.ts'));
        } catch {
            continue; // 沒有 src/tools（例如純 log 目錄、還沒建好的 server skeleton）
        }
        for (const f of files) {
            const content = readFileSync(`${ toolsDir }/${ f }`, 'utf8');
            // 抓 `.serviceCamel.Method(` 呼叫點；serviceCamel 未知，反過來對每個已知 service 名稱做比對太貴，
            // 改用寬鬆 pattern 抓「一段 camelCase 開頭字串 + 一個 PascalCase method」，再回頭用 service 名單反查。
            for (const mm of content.matchAll(/\.([a-z][A-Za-z0-9]*)\.([A-Z][A-Za-z0-9]*)\(/g)) {
                const camel = mm[ 1 ];
                const method = mm[ 2 ];
                const key = camel; // 先用 camel 存，最後在 main() 統一轉成 PascalCase service 名比對
                if (!coverage.has(key)) coverage.set(key, { methods: new Set(), servers: new Set() });
                coverage.get(key)!.methods.add(method);
                coverage.get(key)!.servers.add(server);
            }
        }
    }
    return coverage;
}

function main() {
    const files = readdirSync(RAJAH_DIR).filter((f) => f.endsWith('.rajah')).sort();
    const allBlocks: ServiceBlock[] = [];
    for (const f of files) allBlocks.push(...extractAllServiceBlocks(f));

    const coverageByCamel = scanAllToolCoverage();

    type Row = { file: string; service: string; total: number; placeholder: number; covered: number; servers: string[] };
    const rows: Row[] = [];

    for (const block of allBlocks) {
        const real = block.methods.filter((m) => !m.isPlaceholder);
        const placeholderCount = block.methods.length - real.length;
        const camel = toCamelCase(block.service);
        const cov = coverageByCamel.get(camel);
        const coveredCount = cov ? real.filter((m) => cov.methods.has(m.name)).length : 0;

        rows.push({
            file: block.file,
            service: block.service,
            total: real.length,
            placeholder: placeholderCount,
            covered: coveredCount,
            servers: cov ? [ ...cov.servers ] : [],
        });
    }

    // 排除 0 method 的空 service（通常是純繼承/宣告用）
    const nonEmpty = rows.filter((r) => r.total > 0);
    const totalMethods = nonEmpty.reduce((s, r) => s + r.total, 0);
    const totalCovered = nonEmpty.reduce((s, r) => s + r.covered, 0);
    const zeroServiceCount = nonEmpty.filter((r) => r.covered === 0).length;

    console.log(`# rajah 全表面盤點（唯讀，不寫 tasks.json）\n`);
    console.log(`掃了 ${ files.length } 個 rajah 檔案、${ rows.length } 個 service 區塊（其中 ${ nonEmpty.length } 個有實際 method）。`);
    console.log(`真實 method（排除 Placeholder）共 ${ totalMethods } 支，目前已有任一 MCP tool 覆蓋 ${ totalCovered } 支（${ (100 * totalCovered / totalMethods).toFixed(1) }%）。`);
    console.log(`完全零覆蓋的 service：${ zeroServiceCount } / ${ nonEmpty.length }。\n`);

    console.log(`## 已有部分/全部覆蓋的 service（現有 3 個 scope 之外，代表以前手刻過 tool、但這支 scan script 沒追蹤落差）\n`);
    console.log(`| rajah 檔案 | service | method 數 | 已覆蓋 | 覆蓋率 | 掛在哪個 MCP server |`);
    console.log(`|---|---|---|---|---|---|`);
    for (const r of nonEmpty.filter((r) => r.covered > 0).sort((a, b) => b.covered - a.covered)) {
        console.log(`| ${ r.file } | ${ r.service } | ${ r.total } | ${ r.covered } | ${ (100 * r.covered / r.total).toFixed(0) }% | ${ r.servers.join(', ') } |`);
    }

    console.log(`\n## 完全零覆蓋的 service，按 rajah 檔案分組（純盤點，不代表都該做，很多是純 app 端/internal/未上線功能）\n`);
    const byFile = new Map<string, Row[]>();
    for (const r of nonEmpty.filter((r) => r.covered === 0)) {
        if (!byFile.has(r.file)) byFile.set(r.file, []);
        byFile.get(r.file)!.push(r);
    }
    for (const [ file, list ] of [ ...byFile.entries() ].sort()) {
        const summary = list.map((r) => `${ r.service }(${ r.total }${ r.placeholder ? `,${ r.placeholder } placeholder` : '' })`).join('、');
        console.log(`- **${ file }**：${ summary }`);
    }
}

main();
