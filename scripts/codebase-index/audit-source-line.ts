#!/usr/bin/env bun
//
// Audit 工具：掃 obsidian/Codebase/Servers/<server>/services/<svc>/methods/<note>.md
// 比對每篇 rpc-method 筆記的 frontmatter source_line 是否真的指向
// source 中對應的 `async methodXxx(...)` 聲明。
//
// 用法：
//   bun audit-source-line.ts              # 列出所有漂移，不修改
//   bun audit-source-line.ts --fix        # 自動修正 frontmatter source_line
//   bun audit-source-line.ts --json       # 輸出 JSON 報告
//
import * as fs from "node:fs";
import * as path from "node:path";
import matter from "gray-matter";

const OBSIDIAN_ROOT = "/Users/user/aladdin/obsidian";
const AGRABAH_REPO = "/Users/user/aladdin/agrabah";
const SERVERS_DIR = path.join(OBSIDIAN_ROOT, "Codebase/Servers");

const args = process.argv.slice(2);
const FIX = args.includes("--fix");
const JSON_OUT = args.includes("--json");

interface AuditEntry {
    note: string;
    methodName: string;
    sourceFile: string;
    declared: number;
    declaredText: string;
    actualLine: number | null;
    actualText: string | null;
    status: "ok" | "drifted" | "missing-method" | "missing-source";
}

const entries: AuditEntry[] = [];

function walkMethods(dir: string): string[] {
    const out: string[] = [];
    if (!fs.existsSync(dir)) return out;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) out.push(...walkMethods(full));
        else if (ent.isFile() && ent.name.endsWith(".md")) out.push(full);
    }
    return out;
}

const notePaths: string[] = [];
for (const serverEnt of fs.readdirSync(SERVERS_DIR, { withFileTypes: true })) {
    if (!serverEnt.isDirectory()) continue;
    const servicesDir = path.join(SERVERS_DIR, serverEnt.name, "services");
    if (!fs.existsSync(servicesDir)) continue;
    for (const svcEnt of fs.readdirSync(servicesDir, { withFileTypes: true })) {
        if (!svcEnt.isDirectory()) continue;
        const svcDir = path.join(servicesDir, svcEnt.name);
        for (const ent of fs.readdirSync(svcDir, { withFileTypes: true })) {
            if (ent.isFile() && ent.name.endsWith(".md")) {
                notePaths.push(path.join(svcDir, ent.name));
            }
        }
        const methodsDir = path.join(svcDir, "methods");
        if (fs.existsSync(methodsDir) && fs.statSync(methodsDir).isDirectory()) {
            notePaths.push(...walkMethods(methodsDir));
        }
    }
}

const sourceCache = new Map<string, string[]>();
function getSourceLines(absPath: string): string[] | null {
    if (sourceCache.has(absPath)) return sourceCache.get(absPath)!;
    if (!fs.existsSync(absPath)) return null;
    const lines = fs.readFileSync(absPath, "utf-8").split("\n");
    sourceCache.set(absPath, lines);
    return lines;
}

for (const notePath of notePaths) {
    const content = fs.readFileSync(notePath, "utf-8");
    const fm = matter(content).data;
    if (!fm.source_file || !fm.source_line) continue;
    const noteType = fm.type;
    if (noteType !== "rpc-method" && noteType !== "service-overview") continue;
    const methodName = fm.method as string | undefined;
    if (!methodName && noteType === "rpc-method") continue;

    const sourceRel = (fm.source_file as string).replace(/^agrabah\//, "");
    const sourceAbs = path.resolve(AGRABAH_REPO, sourceRel);
    const lines = getSourceLines(sourceAbs);
    if (!lines) {
        entries.push({
            note: notePath, methodName: methodName || "(service)",
            sourceFile: sourceRel,
            declared: fm.source_line as number, declaredText: "",
            actualLine: null, actualText: null,
            status: "missing-source",
        });
        continue;
    }

    const declared = fm.source_line as number;
    const declaredText = lines[declared - 1] ?? "";

    let expected: RegExp;
    if (noteType === "service-overview") {
        expected = /\bexport\s+(default\s+)?class\b|\bclass\s+\w+/;
    } else {
        const escaped = methodName!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        expected = new RegExp("async\\s+method" + escaped + "\\s*\\(");
    }

    const ok = expected.test(declaredText);
    if (ok) {
        entries.push({
            note: notePath, methodName: methodName || "(service)",
            sourceFile: sourceRel,
            declared, declaredText: declaredText.trim(),
            actualLine: declared, actualText: declaredText.trim(),
            status: "ok",
        });
        continue;
    }

    let actualLine: number | null = null;
    let actualText: string | null = null;
    for (let i = 0; i < lines.length; i++) {
        if (expected.test(lines[i])) {
            actualLine = i + 1;
            actualText = lines[i].trim();
            break;
        }
    }

    entries.push({
        note: notePath, methodName: methodName || "(service)",
        sourceFile: sourceRel,
        declared, declaredText: declaredText.trim().slice(0, 100),
        actualLine, actualText: actualText?.slice(0, 100) ?? null,
        status: actualLine ? "drifted" : "missing-method",
    });
}

const byStatus: Record<string, AuditEntry[]> = {};
for (const e of entries) (byStatus[e.status] ||= []).push(e);

if (JSON_OUT) {
    console.log(JSON.stringify({ entries, summary: Object.fromEntries(Object.entries(byStatus).map(([k, v]) => [k, v.length])) }, null, 2));
} else {
    console.log("Total notes audited: " + entries.length);
    for (const [s, arr] of Object.entries(byStatus)) console.log("  " + s + ": " + arr.length);
    if (byStatus.drifted) {
        console.log("\n=== DRIFTED (first 15) ===");
        for (const e of byStatus.drifted.slice(0, 15)) {
            console.log("  " + e.note.split("/").slice(-2).join("/") + ": line " + e.declared + " -> " + e.actualLine + "  [" + e.methodName + "]");
        }
        if (byStatus.drifted.length > 15) console.log("  ... and " + (byStatus.drifted.length - 15) + " more");
    }
    if (byStatus["missing-method"]) {
        console.log("\n=== MISSING METHOD (first 10) ===");
        for (const e of byStatus["missing-method"].slice(0, 10)) {
            console.log("  " + e.note.split("/").slice(-2).join("/") + ": method " + e.methodName + " not in " + e.sourceFile.split("/").pop());
        }
        if (byStatus["missing-method"].length > 10) console.log("  ... and " + (byStatus["missing-method"].length - 10) + " more");
    }
}

if (FIX) {
    let fixed = 0;
    for (const e of byStatus.drifted || []) {
        const content = fs.readFileSync(e.note, "utf-8");
        const parsed = matter(content);
        parsed.data.source_line = e.actualLine;
        const newContent = matter.stringify(parsed.content, parsed.data);
        fs.writeFileSync(e.note, newContent, "utf-8");
        fixed++;
    }
    console.log("\n[FIX] Updated " + fixed + " note frontmatter source_line entries.");
}
