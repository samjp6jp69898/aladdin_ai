import { $ } from 'bun';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

// Inline type to avoid circular dependency with git-diff-collector.ts
interface CommitInfo {
    hash: string;
    message: string;
    author: string;
    date: string;
    files: Array<{
        status: 'A' | 'M' | 'D' | 'R';
        path: string;
        oldPath?: string;
        additions: number;
        deletions: number;
    }>;
}

export interface RajahImpact {
    rajahFile: string;           // e.g. "services/wallet.rajah"
    affectedFqns: string[];      // e.g. ['wallet.wallet.GetBalance']
    changeType: 'signature' | 'model' | 'enum' | 'new_method' | 'deleted_method';
    commitHash: string;
    diffSummary: string;
}

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

/**
 * Convert a PascalCase or UPPER_SNAKE service name to camelCase.
 * e.g. "WalletInternal" → "walletInternal", "AgentBackOfficeInternal" → "agentBackOfficeInternal"
 */
function toCamelCase(s: string): string {
    if (!s) return s;
    return s.charAt(0).toLowerCase() + s.slice(1);
}

/**
 * Strip "Service" suffix from service name if present.
 * e.g. "WalletService" → "Wallet", "Wallet" → "Wallet"
 */
function stripServiceSuffix(name: string): string {
    if (name.endsWith('Service')) {
        return name.slice(0, -'Service'.length);
    }
    return name;
}

/**
 * Derive the server name (camelCase) from a rajah file path.
 * "services/wallet.rajah"            → "wallet"
 * "services/agent_back_office.rajah" → "agentBackOffice"
 */
function rajahFileToServerName(rajahFile: string): string {
    // Take basename without extension
    const base = rajahFile.replace(/^.*[\\/]/, '').replace(/\.rajah$/, '');
    // Convert snake_case to camelCase
    return base.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

/**
 * Determine if this rajah file is a "common" shared definition file
 * (common.rajah, service_common.rajah, *_common.rajah).
 */
function isCommonFile(rajahFile: string): boolean {
    const base = rajahFile.replace(/^.*[\\/]/, '').replace(/\.rajah$/, '');
    return base === 'common' || base === 'service_common' || base.endsWith('_common');
}

/**
 * Build the service FQN camelCase key from a service declaration name.
 * In rajah, service is PascalCase. We need camelCase without "Service" suffix.
 * e.g. "AgentBackOfficeInternal" → "agentBackOfficeInternal"
 *      "Wallet"                  → "wallet"
 */
function serviceNameToFqnKey(serviceName: string): string {
    return toCamelCase(stripServiceSuffix(serviceName));
}

/**
 * Build method FQN: <serverCamel>.<serviceCamel>.<MethodPascal>
 */
function buildMethodFqn(serverName: string, serviceName: string, methodName: string): string {
    return `${serverName}.${serviceNameToFqnKey(serviceName)}.${methodName}`;
}

/**
 * Build model FQN: <NamespacePascal>.Model.<ModelName>
 * Namespace is derived from the rajah filename (PascalCase of the base name).
 */
function buildModelFqn(serverName: string, modelName: string): string {
    // Capitalize first letter of serverName for namespace
    const ns = serverName.charAt(0).toUpperCase() + serverName.slice(1);
    return `${ns}.Model.${modelName}`;
}

/**
 * Build enum FQN: <NamespacePascal>.Enum.<EnumName>
 */
function buildEnumFqn(serverName: string, enumName: string): string {
    const ns = serverName.charAt(0).toUpperCase() + serverName.slice(1);
    return `${ns}.Enum.${enumName}`;
}

// ──────────────────────────────────────────────
// Diff parsing
// ──────────────────────────────────────────────

interface DiffEntry {
    type: 'added' | 'removed' | 'context';
    line: string;
}

function parseDiffLines(diff: string): DiffEntry[] {
    const entries: DiffEntry[] = [];
    for (const raw of diff.split('\n')) {
        if (raw.startsWith('+') && !raw.startsWith('+++')) {
            entries.push({ type: 'added', line: raw.slice(1) });
        } else if (raw.startsWith('-') && !raw.startsWith('---')) {
            entries.push({ type: 'removed', line: raw.slice(1) });
        } else {
            entries.push({ type: 'context', line: raw.startsWith(' ') ? raw.slice(1) : raw });
        }
    }
    return entries;
}

/**
 * Given diff entries, find the nearest `service Xxx {` that precedes a given index.
 * This tells us which service a changed method belongs to.
 */
function findEnclosingService(entries: DiffEntry[], targetIdx: number): string | null {
    // Walk backwards through context + added lines to find 'service XXX {'
    for (let i = targetIdx - 1; i >= 0; i--) {
        const e = entries[i];
        // Only consider context lines for enclosing service (we want the full file context)
        const m = e.line.match(/^\s*(?:@\w+(?:\s+"[^"]*")?\s+)*service\s+(\w+)\s*\{/);
        if (m) return m[1];
    }
    return null;
}

interface ParsedDiffResult {
    addedMethods: Array<{ service: string; method: string }>;
    deletedMethods: Array<{ service: string; method: string }>;
    modifiedMethods: Array<{ service: string; method: string }>;
    addedModels: string[];
    modifiedModels: string[];
    addedEnums: string[];
    modifiedEnums: string[];
    isNewFile: boolean;
}

function parseDiff(diff: string): ParsedDiffResult {
    if (!diff.trim()) {
        return {
            addedMethods: [],
            deletedMethods: [],
            modifiedMethods: [],
            addedModels: [],
            modifiedModels: [],
            addedEnums: [],
            modifiedEnums: [],
            isNewFile: false,
        };
    }

    const entries = parseDiffLines(diff);

    // Detect new file
    const isNewFile = diff.includes('\n--- /dev/null') || diff.startsWith('--- /dev/null');

    const addedMethods: Array<{ service: string; method: string }> = [];
    const deletedMethods: Array<{ service: string; method: string }> = [];
    const modifiedMethods: Array<{ service: string; method: string }> = [];
    const addedModels: string[] = [];
    const modifiedModels: string[] = [];
    const addedEnums: string[] = [];
    const modifiedEnums: string[] = [];

    // Track which services / models / enums have modifications so we can report
    // signature changes on existing methods
    const modifiedServiceMethods = new Set<string>(); // "ServiceName.MethodName"

    for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        const line = e.line.trim();

        // Detect method lines: "method MethodName(...) ..."
        const methodMatch = line.match(/^method\s+(\w+)\s*\(/);
        if (methodMatch) {
            const methodName = methodMatch[1];
            const enclosingService = findEnclosingService(entries, i);
            if (!enclosingService) continue;

            const key = `${enclosingService}.${methodName}`;

            if (e.type === 'added') {
                // Check if there's a corresponding deletion → it's a modification
                if (modifiedServiceMethods.has(key)) {
                    // Already recorded as modified from a deletion side
                } else {
                    addedMethods.push({ service: enclosingService, method: methodName });
                }
            } else if (e.type === 'removed') {
                // Mark as deleted; if we later see an added version, it's actually modified
                deletedMethods.push({ service: enclosingService, method: methodName });
                modifiedServiceMethods.add(key);
            }
            continue;
        }

        // Detect model changes: "model ModelName {"
        const modelMatch = line.match(/^model\s+(\w+)\s*\{/);
        if (modelMatch) {
            const modelName = modelMatch[1];
            if (e.type === 'added') {
                addedModels.push(modelName);
            }
            // Any change inside a model block counts as model modification
            continue;
        }

        // Detect enum changes: "enum EnumName {"
        const enumMatch = line.match(/^enum\s+(\w+)\s*\{/);
        if (enumMatch) {
            const enumName = enumMatch[1];
            if (e.type === 'added') {
                addedEnums.push(enumName);
            }
            continue;
        }
    }

    // Reconcile: methods that appear in both added and deleted lists = signature change
    const deletedKeys = new Set(deletedMethods.map(m => `${m.service}.${m.method}`));
    const addedKeys = new Set(addedMethods.map(m => `${m.service}.${m.method}`));

    const finalAdded: typeof addedMethods = [];
    const finalDeleted: typeof deletedMethods = [];

    for (const m of addedMethods) {
        const key = `${m.service}.${m.method}`;
        if (deletedKeys.has(key)) {
            // Signature changed
            modifiedMethods.push(m);
        } else {
            finalAdded.push(m);
        }
    }

    for (const m of deletedMethods) {
        const key = `${m.service}.${m.method}`;
        if (!addedKeys.has(key)) {
            finalDeleted.push(m);
        }
        // If in both, it's already handled as modifiedMethods above
    }

    // Detect model field modifications: any +/- line inside a model block
    // We re-scan for model blocks where inner lines changed
    let inBlock: { kind: 'model' | 'enum'; name: string } | null = null;
    let braceDepth = 0;
    const changedModels = new Set<string>();
    const changedEnums = new Set<string>();

    for (const e of entries) {
        const line = e.line;

        const modelMatch = line.trim().match(/^model\s+(\w+)\s*\{/);
        const enumMatch = line.trim().match(/^enum\s+(\w+)\s*\{/);

        if (!inBlock) {
            if (modelMatch) {
                inBlock = { kind: 'model', name: modelMatch[1] };
                braceDepth = 1;
            } else if (enumMatch) {
                inBlock = { kind: 'enum', name: enumMatch[1] };
                braceDepth = 1;
            }
        } else {
            // Count braces
            for (const ch of line) {
                if (ch === '{') braceDepth++;
                else if (ch === '}') braceDepth--;
            }

            if (braceDepth <= 0) {
                inBlock = null;
                braceDepth = 0;
            } else if (e.type === 'added' || e.type === 'removed') {
                // There's a change inside this block
                if (inBlock.kind === 'model') {
                    changedModels.add(inBlock.name);
                } else {
                    changedEnums.add(inBlock.name);
                }
            }
        }
    }

    // Populate modifiedModels and modifiedEnums from changed blocks
    // (exclude brand-new ones which are already in addedModels/addedEnums)
    const addedModelSet = new Set(addedModels);
    const addedEnumSet = new Set(addedEnums);

    for (const m of changedModels) {
        if (!addedModelSet.has(m)) {
            modifiedModels.push(m);
        }
    }
    for (const en of changedEnums) {
        if (!addedEnumSet.has(en)) {
            modifiedEnums.push(en);
        }
    }

    return {
        addedMethods: finalAdded,
        deletedMethods: finalDeleted,
        modifiedMethods,
        addedModels,
        modifiedModels,
        addedEnums,
        modifiedEnums,
        isNewFile,
    };
}

// ──────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────

export async function resolveRajahImpacts(
    commits: CommitInfo[],
    rajahRepoPath: string,
    agrabahRepoPath: string
): Promise<RajahImpact[]> {
    const impacts: RajahImpact[] = [];

    for (const commit of commits) {
        // Filter to only rajah service files
        const rajahFiles = commit.files.filter(f =>
            f.path.startsWith('services/') && f.path.endsWith('.rajah')
        );

        for (const fileChange of rajahFiles) {
            const rajahFile = fileChange.path;

            // Skip common/shared definition files — they affect all servers
            if (isCommonFile(rajahFile)) continue;

            const serverName = rajahFileToServerName(rajahFile);

            // Fetch the diff for this specific file
            const diff = await $`git diff ${commit.hash}~1..${commit.hash} -- ${rajahFile}`
                .cwd(rajahRepoPath)
                .text()
                .catch(() => '');

            if (!diff.trim()) continue;

            const parsed = parseDiff(diff);

            const diffSummary = buildDiffSummary(parsed, fileChange);

            // Build impacts for each change type

            // New methods
            if (parsed.addedMethods.length > 0 || parsed.isNewFile) {
                const fqns = parsed.addedMethods.map(m =>
                    buildMethodFqn(serverName, m.service, m.method)
                );
                if (fqns.length > 0) {
                    impacts.push({
                        rajahFile,
                        affectedFqns: fqns,
                        changeType: 'new_method',
                        commitHash: commit.hash,
                        diffSummary,
                    });
                }
            }

            // Deleted methods
            if (parsed.deletedMethods.length > 0) {
                const fqns = parsed.deletedMethods.map(m =>
                    buildMethodFqn(serverName, m.service, m.method)
                );
                impacts.push({
                    rajahFile,
                    affectedFqns: fqns,
                    changeType: 'deleted_method',
                    commitHash: commit.hash,
                    diffSummary,
                });
            }

            // Modified method signatures
            if (parsed.modifiedMethods.length > 0) {
                const fqns = parsed.modifiedMethods.map(m =>
                    buildMethodFqn(serverName, m.service, m.method)
                );
                impacts.push({
                    rajahFile,
                    affectedFqns: fqns,
                    changeType: 'signature',
                    commitHash: commit.hash,
                    diffSummary,
                });
            }

            // Changed models
            const allModels = [...parsed.addedModels, ...parsed.modifiedModels];
            if (allModels.length > 0) {
                const fqns = allModels.map(m => buildModelFqn(serverName, m));
                impacts.push({
                    rajahFile,
                    affectedFqns: fqns,
                    changeType: 'model',
                    commitHash: commit.hash,
                    diffSummary,
                });
            }

            // Changed enums
            const allEnums = [...parsed.addedEnums, ...parsed.modifiedEnums];
            if (allEnums.length > 0) {
                const fqns = allEnums.map(e => buildEnumFqn(serverName, e));
                impacts.push({
                    rajahFile,
                    affectedFqns: fqns,
                    changeType: 'enum',
                    commitHash: commit.hash,
                    diffSummary,
                });
            }
        }
    }

    return impacts;
}

function buildDiffSummary(parsed: ParsedDiffResult, fileChange: { additions: number; deletions: number }): string {
    const parts: string[] = [];
    if (parsed.addedMethods.length) {
        parts.push(`+${parsed.addedMethods.length} method(s)`);
    }
    if (parsed.deletedMethods.length) {
        parts.push(`-${parsed.deletedMethods.length} method(s)`);
    }
    if (parsed.modifiedMethods.length) {
        parts.push(`~${parsed.modifiedMethods.length} signature(s)`);
    }
    if (parsed.addedModels.length) {
        parts.push(`+${parsed.addedModels.length} model(s)`);
    }
    if (parsed.modifiedModels.length) {
        parts.push(`~${parsed.modifiedModels.length} model(s)`);
    }
    if (parsed.addedEnums.length) {
        parts.push(`+${parsed.addedEnums.length} enum(s)`);
    }
    if (parsed.modifiedEnums.length) {
        parts.push(`~${parsed.modifiedEnums.length} enum(s)`);
    }
    if (parts.length === 0) {
        parts.push(`+${fileChange.additions}/-${fileChange.deletions} lines`);
    }
    return parts.join(', ');
}

/**
 * Map a rajah file path to the corresponding agrabah service directory paths.
 *
 * Convention:
 *   services/wallet.rajah            → ["src/servers/wallet/services/"]
 *   services/wallet_back_office.rajah → ["src/servers/wallet_back_office/services/"]
 *   services/common.rajah             → []  (shared, no single server)
 *   services/service_common.rajah     → []
 *   services/activity_common.rajah    → []  (*_common suffix)
 */
export function mapRajahToAgrabahFiles(
    rajahFile: string,
    agrabahRepoPath: string
): string[] {
    if (isCommonFile(rajahFile)) {
        return [];
    }

    // Extract base name (without extension)
    const base = rajahFile.replace(/^.*[\\/]/, '').replace(/\.rajah$/, '');

    // The agrabah server directory uses the same snake_case name as the rajah file base
    const serverDir = agrabahRepoPath
        ? join(agrabahRepoPath, 'src', 'servers', base, 'services') + '/'
        : `src/servers/${base}/services/`;

    // If agrabahRepoPath is provided, check if the directory actually exists
    if (agrabahRepoPath && !existsSync(join(agrabahRepoPath, 'src', 'servers', base, 'services'))) {
        // Return the path regardless — caller can decide what to do with missing paths
    }

    return [serverDir];
}
