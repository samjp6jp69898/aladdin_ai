import { Glob } from 'bun';
import { parseNote, type ParsedNote } from './lib/note-parser.ts';
import { writeFile } from 'node:fs/promises';

const ROOT = '/Users/user/aladdin/obsidian/Codebase';

interface RpcEdge {
    caller: string;       // FQN of calling method
    callerServer: string; // server prefix
    callee: string;       // FQN of called method
    calleeServer: string; // server prefix
}

function extractServer(fqn: string): string {
    const parts = fqn.split('.');
    return parts[0];
}

async function main() {
    const glob = new Glob('**/*.md');
    const notes = new Map<string, ParsedNote>();

    for await (const rel of glob.scan(ROOT)) {
        const note = await parseNote(`${ROOT}/${rel}`);
        if (note) notes.set(note.fqn, note);
    }

    const edges: RpcEdge[] = [];

    for (const note of notes.values()) {
        if (note.type !== 'rpc-method' && note.type !== 'manager-method') continue;
        const callerServer = extractServer(note.fqn);
        for (const callee of note.calls.rpcCrossServer) {
            const calleeServer = extractServer(callee);
            if (callerServer === calleeServer) continue;
            edges.push({
                caller: note.fqn,
                callerServer,
                callee,
                calleeServer,
            });
        }
    }

    const lines: string[] = [
        '# Cross-Server RPC Call Graph',
        '',
        `Generated: ${new Date().toISOString()}`,
        `Total cross-server RPC edges (within indexed scope): **${edges.length}**`,
        '',
        '> 列出所有跨服務 RPC 呼叫邊。僅涵蓋目前 Codebase/ 已建立的 server 與 manager;呼叫到尚未索引的 server 會顯示為斷裂連結(見 `broken-links-report.md`)。',
        '',
        '## 統計：按 Caller Server',
        '',
    ];

    const byCaller = new Map<string, RpcEdge[]>();
    for (const e of edges) {
        if (!byCaller.has(e.callerServer)) byCaller.set(e.callerServer, []);
        byCaller.get(e.callerServer)!.push(e);
    }
    const callerServers = [...byCaller.keys()].sort();
    lines.push('| Caller Server | Outgoing RPC Count |');
    lines.push('|---------------|--------------------|');
    for (const s of callerServers) {
        lines.push(`| ${s} | ${byCaller.get(s)!.length} |`);
    }
    lines.push('');

    lines.push('## 統計：按 Callee Server');
    lines.push('');
    const byCallee = new Map<string, RpcEdge[]>();
    for (const e of edges) {
        if (!byCallee.has(e.calleeServer)) byCallee.set(e.calleeServer, []);
        byCallee.get(e.calleeServer)!.push(e);
    }
    const calleeServers = [...byCallee.keys()].sort();
    lines.push('| Callee Server | Incoming RPC Count |');
    lines.push('|---------------|--------------------|');
    for (const s of calleeServers) {
        lines.push(`| ${s} | ${byCallee.get(s)!.length} |`);
    }
    lines.push('');

    lines.push('## 完整邊表');
    lines.push('');
    lines.push('| Caller | Callee | Caller Server → Callee Server |');
    lines.push('|--------|--------|-------------------------------|');
    edges.sort((a, b) => a.caller.localeCompare(b.caller) || a.callee.localeCompare(b.callee));
    for (const e of edges) {
        lines.push(`| [[${e.caller}]] | [[${e.callee}]] | ${e.callerServer} → ${e.calleeServer} |`);
    }
    lines.push('');

    // Sample chain (2+ hops)
    lines.push('## 2 層呼叫鏈樣本');
    lines.push('');
    lines.push('> 從 payment 出發，追蹤到 wallet 再到 downstream 的範例');
    lines.push('');
    const samples: string[][] = [];
    // Find: Payment -> Wallet
    for (const e1 of edges) {
        if (e1.callerServer !== 'Payment' || e1.calleeServer !== 'Wallet') continue;
        // Check if callee has downstream links (within notes)
        const callee = notes.get(e1.callee);
        if (!callee) continue;
        // downstream via manager or RPC
        const mgrDownstream = callee.calls.managerMethods.filter(m => notes.has(m));
        const rpcDownstream = callee.calls.rpcCrossServer.filter(m => notes.has(m));
        const allDown = [...mgrDownstream, ...rpcDownstream];
        for (const down of allDown) {
            samples.push([e1.caller, e1.callee, down]);
        }
    }
    if (samples.length === 0) {
        lines.push('（尚無跨 Milestone 內追蹤鏈樣本）');
    } else {
        for (const chain of samples.slice(0, 5)) {
            lines.push('```');
            for (let i = 0; i < chain.length; i++) {
                lines.push(`${'  '.repeat(i)}↳ ${chain[i]}`);
            }
            lines.push('```');
            lines.push('');
        }
    }

    await writeFile(`${ROOT}/_index/cross-server-rpc-graph.md`, lines.join('\n'));
    console.log(`Wrote cross-server-rpc-graph.md (${edges.length} edges)`);
}

await main();
