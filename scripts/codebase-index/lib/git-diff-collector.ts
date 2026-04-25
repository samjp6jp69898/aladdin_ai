import { $ } from 'bun';

export interface CommitInfo {
    hash: string;
    message: string;
    author: string;
    date: string;
    files: FileChange[];
}

export interface FileChange {
    status: 'A' | 'M' | 'D' | 'R';
    path: string;
    oldPath?: string; // only for renames
    additions: number;
    deletions: number;
}

export interface CollectorOptions {
    repoPath: string;
    since?: string;
    until?: string;
    commits?: string[];
}

// Parse name-status output into a map of path -> { status, oldPath }
function parseNameStatus(output: string): Map<string, { status: 'A' | 'M' | 'D' | 'R'; oldPath?: string }> {
    const result = new Map<string, { status: 'A' | 'M' | 'D' | 'R'; oldPath?: string }>();
    for (const line of output.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const parts = trimmed.split('\t');
        const rawStatus = parts[0];
        if (rawStatus.startsWith('R')) {
            // Rename: parts[1] = oldPath, parts[2] = newPath
            const oldPath = parts[1];
            const newPath = parts[2];
            if (oldPath && newPath) {
                result.set(newPath, { status: 'R', oldPath });
            }
        } else if (rawStatus === 'A' || rawStatus === 'M' || rawStatus === 'D') {
            const filePath = parts[1];
            if (filePath) {
                result.set(filePath, { status: rawStatus as 'A' | 'M' | 'D' });
            }
        }
    }
    return result;
}

// Parse numstat output into a map of path -> { additions, deletions }
function parseNumstat(output: string): Map<string, { additions: number; deletions: number }> {
    const result = new Map<string, { additions: number; deletions: number }>();
    for (const line of output.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const parts = trimmed.split('\t');
        if (parts.length < 3) continue;
        const additions = parseInt(parts[0], 10);
        const deletions = parseInt(parts[1], 10);
        const filePath = parts[2];
        if (!filePath) continue;
        // For renames, git numstat shows "oldPath => newPath" or just newPath depending on flags
        // With -M flag numstat shows the new path directly
        result.set(filePath, {
            additions: isNaN(additions) ? 0 : additions,
            deletions: isNaN(deletions) ? 0 : deletions,
        });
    }
    return result;
}

async function fetchCommitDetails(repoPath: string, hash: string): Promise<CommitInfo | null> {
    try {
        // Use null byte (\x00) as field separator to avoid conflicts with commit message content
        const logOutput = await $`git log -1 --pretty=format:%H%x00%s%x00%an%x00%aI ${hash}`
            .cwd(repoPath)
            .text();

        const parts = logOutput.split('\x00');
        if (parts.length < 4) return null;

        const [commitHash, message, author, date] = parts;

        // Get file status (name-status with rename detection)
        const nameStatusOutput = await $`git diff-tree --no-commit-id -r --name-status --diff-filter=ADMR -M ${hash}`
            .cwd(repoPath)
            .text();

        // Get additions/deletions (numstat with rename detection)
        const numstatOutput = await $`git diff-tree --no-commit-id -r --numstat --diff-filter=ADMR -M ${hash}`
            .cwd(repoPath)
            .text();

        const statusMap = parseNameStatus(nameStatusOutput);
        const numstatMap = parseNumstat(numstatOutput);

        const files: FileChange[] = [];
        for (const [filePath, statusInfo] of statusMap.entries()) {
            const stats = numstatMap.get(filePath) ?? { additions: 0, deletions: 0 };
            const fileChange: FileChange = {
                status: statusInfo.status,
                path: filePath,
                additions: stats.additions,
                deletions: stats.deletions,
            };
            if (statusInfo.oldPath) {
                fileChange.oldPath = statusInfo.oldPath;
            }
            files.push(fileChange);
        }

        return {
            hash: commitHash.trim(),
            message: message.trim(),
            author: author.trim(),
            date: date.trim(),
            files,
        };
    } catch {
        return null;
    }
}

export async function collectCommits(opts: CollectorOptions): Promise<CommitInfo[]> {
    const { repoPath, since, until, commits } = opts;
    let hashes: string[] = [];

    if (commits && commits.length > 0) {
        hashes = commits;
    } else {
        try {
            const args: string[] = ['log', '--pretty=format:%H'];
            if (since) args.push(`--since=${since}`);
            if (until) args.push(`--until=${until}`);

            const logOutput = await $`git ${args}`.cwd(repoPath).text();
            hashes = logOutput
                .split('\n')
                .map(h => h.trim())
                .filter(h => h.length > 0);
        } catch {
            return [];
        }
    }

    const results: CommitInfo[] = [];
    for (const hash of hashes) {
        const info = await fetchCommitDetails(repoPath, hash);
        if (info) results.push(info);
    }
    return results;
}

export async function getDiffContent(repoPath: string, hash: string, filePath: string): Promise<string> {
    try {
        const output = await $`git diff ${hash}~1..${hash} -- ${filePath}`
            .cwd(repoPath)
            .text();
        return output;
    } catch {
        return '';
    }
}
