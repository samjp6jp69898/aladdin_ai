// Fix the 12 broken links introduced by Phase 3 sub-agents.

import { readFileSync, writeFileSync } from 'node:fs';
import { Glob } from 'bun';

const ROOT = '/Users/user/aladdin/obsidian/Codebase';

interface Fix { sourceFqn: string; wrongTarget: string; correctTarget: string; }

const FIXES: Fix[] = [
    // Wagering DB notes are at DB.Wagering.X, not DB.WageringBackOffice.X
    { sourceFqn: 'wageringBackOffice.wageringPlatform.UpdateTurnoverMultiplierSetting', wrongTarget: 'DB.WageringBackOffice.TurnoverMultiplierSetting', correctTarget: 'DB.Wagering.TurnoverMultiplierSetting' },
    { sourceFqn: 'wageringBackOffice.wageringPlatform.ListUserWagerings', wrongTarget: 'DB.WageringBackOffice.UserWagerings', correctTarget: 'DB.Wagering.UserWagerings' },
    { sourceFqn: 'wageringBackOffice.wageringPlatform.GetUserUnWageringDetail', wrongTarget: 'DB.WageringBackOffice.UserWagerings', correctTarget: 'DB.Wagering.UserWagerings' },
    { sourceFqn: 'wageringBackOffice.wageringUserPlatform.GetImmediateUserWagering', wrongTarget: 'DB.WageringBackOffice.UserWagerings', correctTarget: 'DB.Wagering.UserWagerings' },
    { sourceFqn: 'wageringBackOffice.wageringUserPlatform.ListUserWageringsByUser', wrongTarget: 'DB.WageringBackOffice.UserWagerings', correctTarget: 'DB.Wagering.UserWagerings' },
    { sourceFqn: 'wageringBackOffice.wageringPlatform.GetUserUnWageringDetail', wrongTarget: 'DB.WageringBackOffice.UserWageringScopes', correctTarget: 'DB.Wagering.UserWageringScopes' },
    { sourceFqn: 'wageringBackOffice.wageringPlatform.UpdateWageringSetting', wrongTarget: 'DB.WageringBackOffice.WageringSetting', correctTarget: 'DB.Wagering.WageringSetting' },

    // AdminUserManager.getUserEssential is inherited from BackOfficeUserManager
    { sourceFqn: 'admin.adminUserCenter.GetUserEssential', wrongTarget: 'Manager.AdminUserManager.getUserEssential', correctTarget: 'Manager.BackOfficeUserManager.getUserEssential' },

    // AppGroupManager is a server-local manager — FQN uses server prefix `appBackOffice.AppGroupManager.X`,
    // not the global `Manager.AppGroupManager.X` form.
    { sourceFqn: 'admin.admin.NewUser', wrongTarget: 'Manager.AdminUserManager.createUser', correctTarget: 'Manager.AdminUserManager.createUser' /* will be created as note below */ },
    { sourceFqn: 'appBackOffice.appPlatform.ListAppGroups', wrongTarget: 'Manager.AppGroupManager.getAppGroups', correctTarget: 'appBackOffice.AppGroupManager.getAppGroups' },
    { sourceFqn: 'appBackOffice.appAdmin.ListPlatformAppGroups', wrongTarget: 'Manager.AppGroupManager.getAppGroups', correctTarget: 'appBackOffice.AppGroupManager.getAppGroups' },
    { sourceFqn: 'appBackOffice.appAdmin.ListAppGroups', wrongTarget: 'Manager.AppGroupManager.getAppGroups', correctTarget: 'appBackOffice.AppGroupManager.getAppGroups' },
];

async function findNoteByFqn(fqn: string): Promise<string | null> {
    const glob = new Glob('**/*.md');
    for await (const rel of glob.scan({ cwd: ROOT })) {
        const full = `${ROOT}/${rel}`;
        const content = readFileSync(full, 'utf-8');
        const match = content.match(/^---\s*[\s\S]*?fqn:\s*(.+?)\s*\n[\s\S]*?---/m);
        if (match && match[1].trim() === fqn) return full;
    }
    return null;
}

let renamed = 0;
let totalEdits = 0;
const seen = new Set<string>();

for (const fix of FIXES) {
    const k = fix.sourceFqn + '||' + fix.wrongTarget;
    if (seen.has(k)) continue;
    seen.add(k);

    const path = await findNoteByFqn(fix.sourceFqn);
    if (!path) {
        console.error(`[fix] cannot find note for ${fix.sourceFqn}`);
        continue;
    }
    let content = readFileSync(path, 'utf-8');
    const wrong = `[[${fix.wrongTarget}]]`;
    const correct = `[[${fix.correctTarget}]]`;
    if (!content.includes(wrong)) {
        console.warn(`[fix] ${fix.sourceFqn}: '${wrong}' not found`);
        continue;
    }
    const occurrences = content.split(wrong).length - 1;
    content = content.split(wrong).join(correct);
    writeFileSync(path, content);
    console.log(`[fix] ${fix.sourceFqn}: ${fix.wrongTarget} → ${fix.correctTarget} (${occurrences}x)`);
    renamed++;
    totalEdits += occurrences;
}

console.log(`\n[fix] renamed: ${renamed}, totalEdits: ${totalEdits}`);
