// Fix broken links found by build-backlinks (Stage 4.2).
// Rules: rename target FQN inside [[ ]] of the source note.

import { readFileSync, writeFileSync } from 'node:fs';
import { Glob } from 'bun';

const ROOT = '/Users/user/aladdin/obsidian/Codebase';

interface Fix {
    sourceFqn: string;
    wrongTarget: string;
    correctTarget: string;
}

const FIXES: Fix[] = [
    // appUser.main → appUser.appUser
    { sourceFqn: 'customerService.customerInfo.HandleRawPlayerPayOrder', wrongTarget: 'appUser.main.GetUserPlatformId', correctTarget: 'appUser.appUser.GetUserPlatformId' },

    // GameTag manager → DB.Game.*
    { sourceFqn: 'Manager.GameTagManager.insertGameVendorGameTag', wrongTarget: 'DB._Common.GameVendorGame', correctTarget: 'DB.Game.GameVendorGame' },
    { sourceFqn: 'Manager.GameTagManager.insertOrUpdateGameTag', wrongTarget: 'DB._Common.GameVendorGameTag', correctTarget: 'DB.Game.GameVendorGameTag' },
    { sourceFqn: 'Manager.GameTagManager.insertSystemGameVendorGameTags', wrongTarget: 'DB._Common.GameVendorGameTag', correctTarget: 'DB.Game.GameVendorGameTag' },
    { sourceFqn: 'Manager.GameTagManager.insertGameVendorGameTag', wrongTarget: 'DB._Common.GameVendorGameTag', correctTarget: 'DB.Game.GameVendorGameTag' },
    { sourceFqn: 'Manager.GameTagManager.insertGameVendorGameTag', wrongTarget: 'DB._Common.PlatformGameTag', correctTarget: 'DB.Game.PlatformGameTag' },

    // RoleConfig → DB.Common (just remove underscore)
    { sourceFqn: 'Manager.RoleConfigManager.deleteRoleConfigs', wrongTarget: 'DB._Common.IdRoleAllConfig', correctTarget: 'DB.Common.IdRoleAllConfig' },
    { sourceFqn: 'Manager.RoleConfigManager.deleteRoleConfigs', wrongTarget: 'DB._Common.IdRoleConfig', correctTarget: 'DB.Common.IdRoleConfig' },

    // VipDisplayTagCurrencyLink → DB.Common (just remove underscore)
    { sourceFqn: 'Manager.VipDisplayTagCurrencyLinkManager.updateByDisplayTag', wrongTarget: 'DB._Common.IdVipDisplayTagCurrencyLink', correctTarget: 'DB.Common.IdVipDisplayTagCurrencyLink' },
    { sourceFqn: 'Manager.VipDisplayTagCurrencyLinkManager.queryByDisplayTags', wrongTarget: 'DB._Common.IdVipDisplayTagCurrencyLink', correctTarget: 'DB.Common.IdVipDisplayTagCurrencyLink' },
    { sourceFqn: 'Manager.VipDisplayTagCurrencyLinkManager.queryByDisplayTag', wrongTarget: 'DB._Common.IdVipDisplayTagCurrencyLinkLite', correctTarget: 'DB.Common.IdVipDisplayTagCurrencyLinkLite' },

    // InHouseGame manager → DB.InHouseGame.*
    { sourceFqn: 'Manager.InHouseGameManager.getActiveGames', wrongTarget: 'DB._Common.InHouseGame', correctTarget: 'DB.InHouseGame.InHouseGame' },
    { sourceFqn: 'Manager.InHouseGameManager.getRoundInfo', wrongTarget: 'DB._Common.InHouseGame', correctTarget: 'DB.InHouseGame.InHouseGame' },
    { sourceFqn: 'Manager.InHouseGameManager.getRoundInfo', wrongTarget: 'DB._Common.InHouseGameRound', correctTarget: 'DB.InHouseGame.InHouseGameRound' },
    { sourceFqn: 'Manager.InHouseGameManager.transitionRoundState', wrongTarget: 'DB._Common.InHouseGameRound', correctTarget: 'DB.InHouseGame.InHouseGameRound' },
    { sourceFqn: 'Manager.InHouseGameManager.load', wrongTarget: 'DB._Common.InHouseGameSetting', correctTarget: 'DB.InHouseGame.InHouseGameSetting' },

    // RoomGiftStatistics → DB.Room (server prefix typo)
    { sourceFqn: 'Manager.RoomGiftManager.getRoomGiftStatistics', wrongTarget: 'DB.Common.RoomGiftStatistics', correctTarget: 'DB.Room.RoomGiftStatistics' },

    // LevelUpRecord → DB.MessageBoardBackOffice (server prefix typo)
    { sourceFqn: 'Manager.MessageBoardManager.detectAndRecordLevelUp', wrongTarget: 'DB.MessageBoard.LevelUpRecord', correctTarget: 'DB.MessageBoardBackOffice.LevelUpRecord' },
    { sourceFqn: 'Manager.MessageBoardManager.getLevelUpRecords', wrongTarget: 'DB.MessageBoard.LevelUpRecord', correctTarget: 'DB.MessageBoardBackOffice.LevelUpRecord' },

    // platform.main → platform.platform
    { sourceFqn: 'pushNotification.notificationPlatform.GetNotificationRecords', wrongTarget: 'platform.main.ListUsers', correctTarget: 'platform.platform.ListUsers' },
];

// Find the note file by FQN scan.
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
let notFound = 0;
let already = 0;
let totalEdits = 0;

const seenSources = new Set<string>();

for (const fix of FIXES) {
    if (seenSources.has(fix.sourceFqn + '||' + fix.wrongTarget)) continue;
    seenSources.add(fix.sourceFqn + '||' + fix.wrongTarget);

    const path = await findNoteByFqn(fix.sourceFqn);
    if (!path) {
        console.error(`[fix-broken-links] cannot find note for ${fix.sourceFqn}`);
        notFound++;
        continue;
    }
    let content = readFileSync(path, 'utf-8');
    const wrongPattern = `[[${fix.wrongTarget}]]`;
    const correctPattern = `[[${fix.correctTarget}]]`;
    if (!content.includes(wrongPattern)) {
        console.warn(`[fix-broken-links] ${fix.sourceFqn}: no occurrence of '${wrongPattern}'`);
        already++;
        continue;
    }
    const occurrences = content.split(wrongPattern).length - 1;
    content = content.split(wrongPattern).join(correctPattern);
    writeFileSync(path, content);
    console.log(`[fix-broken-links] ${fix.sourceFqn} : ${fix.wrongTarget} → ${fix.correctTarget} (${occurrences}x)`);
    renamed++;
    totalEdits += occurrences;
}

console.log(`\n[fix-broken-links] renamed: ${renamed}, notFound: ${notFound}, already: ${already}, totalEdits: ${totalEdits}`);
