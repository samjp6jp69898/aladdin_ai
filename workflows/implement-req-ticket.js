export const meta = {
  name: 'implement-req-ticket',
  description: '依審核通過的需求單 plan 文件，依序在本機 checkout 上實作（explorer→gate reviewer→executor→acceptance reviewer→commit/merge），可一次跑多張單',
  phases: [
    { title: 'Setup' },
  ],
}

const ROOT = '/Users/user/aladdin'
const MAIN_REPOS = ['rajah', 'agrabah', 'abu', 'lago']
const REPO_PREFIXES = MAIN_REPOS // 用來從 plan 內文 grep 出這張單實際涉及哪些 repo

const HARD_RULES = `
硬規則（一律遵守，違反視為事故，不可用任何理由繞過）：
- 絕對禁止 Edit/Write 任何 repo 底下 localizations/*.json（i18n 三語值須由開發者事後從 Google Sheets 匯入，這不是你的工作範圍）。程式碼只能寫 i18n key（如 ui.t('model.xxx')），不得硬編字串、不得直接補 JSON 值。
- 絕對禁止 git push（任何 repo、任何分支、任何情況）。
- Commit message 內容禁止包含 "Co-Authored-By" 相關字樣。
- 只能對你改過的檔案跑 lint（前綴 NODE_OPTIONS=--max-old-space-size=8192），絕對不准跑全量 bun run lint / bun run build。
- 不得用 sleep / 輪詢等待來規避正確性或時序問題，正確性要用結構保證。
- 只能修改 ${ROOT}/{rajah,agrabah,abu,lago} 這幾個真實本機 checkout內、屬於本工單範圍的 repo，不可誤觸範圍外的 repo 或路徑。
- 不得對任何資料庫執行 migrate / DDL / DML；DB migration 只需要新增 migration 檔案本身（比照該 repo 既有 migration 檔案命名與語法慣例），實際套用交給使用者部署時處理。
- 不得啟動任何 server / dev server，不做瀏覽器 e2e（那是部署到 dev 環境後的另一個獨立階段，不在本 workflow 範圍）。
`

function ticketContext(t, baseBranch) {
  return `工單：${t.id}
${t.notionUrl ? `Notion 需求文件網址：${t.notionUrl}` : 'Notion 需求文件網址：（未提供，僅依 plan 文件內容驗證，不做 Notion 原文交叉核對）'}
本地 plan 文件路徑：${t.planPath}（已經過 draft→3 角度 review→synthesize 產出，內含「逐項變更清單」「驗證依據」「候選範圍清單（納入/排除）」「判斷決策記錄」「待人工處理事項」「整體信心評分」等章節，用 Read tool 讀取全文）
所有 repo 的基準分支一律是本機 ${baseBranch} 分支（不是 repo 目前 checkout 出來的分支）。`
}

const EXPLORER_SCHEMA = {
  type: 'object',
  properties: {
    notionFetched: { type: 'boolean' },
    repos: { type: 'array', items: { type: 'string', enum: MAIN_REPOS }, description: '這張工單實際涉及的 repo（從 plan 內文的檔案路徑前綴判斷出來）' },
    driftFindings: { type: 'array', items: { type: 'string' } },
    scopeConcerns: { type: 'array', items: { type: 'string' } },
    recommendation: { type: 'string', enum: ['proceed', 'proceed_with_caveats', 'block'] },
    summary: { type: 'string' },
  },
  required: ['notionFetched', 'repos', 'driftFindings', 'scopeConcerns', 'recommendation', 'summary'],
}

const GATE_SCHEMA = {
  type: 'object',
  properties: {
    decision: { type: 'string', enum: ['GO', 'NO_GO'] },
    reasons: { type: 'string' },
    executorCautions: { type: 'array', items: { type: 'string' } },
  },
  required: ['decision', 'reasons', 'executorCautions'],
}

const EXECUTOR_SCHEMA = {
  type: 'object',
  properties: {
    branchReady: { type: 'boolean' },
    filesChanged: { type: 'array', items: { type: 'string' } },
    itemsImplemented: { type: 'array', items: { type: 'string' } },
    itemsSkipped: { type: 'array', items: { type: 'string' } },
    pendingI18nKeys: { type: 'array', items: { type: 'string' }, description: '本次新增/變更、需要人工從 Google Sheets 匯入的 i18n key 與建議三語值' },
    codegenRan: { type: 'boolean' },
    lintClean: { type: 'boolean' },
    notes: { type: 'string' },
  },
  required: ['branchReady', 'filesChanged', 'itemsImplemented', 'itemsSkipped', 'pendingI18nKeys', 'codegenRan', 'lintClean', 'notes'],
}

const ACCEPTANCE_SCHEMA = {
  type: 'object',
  properties: {
    decision: { type: 'string', enum: ['PASS', 'FAIL'] },
    issues: { type: 'array', items: { type: 'string' } },
    verifiedItems: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
  },
  required: ['decision', 'issues', 'verifiedItems', 'summary'],
}

const WRAPUP_SCHEMA = {
  type: 'object',
  properties: {
    merged: { type: 'boolean' },
    commits: {
      type: 'array',
      items: {
        type: 'object',
        properties: { repo: { type: 'string' }, hash: { type: 'string' } },
        required: ['repo', 'hash'],
      },
    },
    notes: { type: 'string' },
  },
  required: ['merged', 'commits', 'notes'],
}

const SYNC_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    perRepo: { type: 'array', items: { type: 'string' } },
    blockers: { type: 'array', items: { type: 'string' } },
  },
  required: ['ok', 'perRepo', 'blockers'],
}

function buildSyncPrompt(baseBranch) {
  return `你要在真實的本機 repo checkout（不是隔離 worktree）上，把以下 4 個 repo 同步到最新的 ${baseBranch} 分支，作為後續需求單實作的共同起點：
${MAIN_REPOS.map(r => `${ROOT}/${r}`).join('\n')}

對每個 repo 依序執行：
1. \`git -C ${ROOT}/{repo} status --short\`：若有任何未提交變更（非空輸出），立刻停止並回報 blocker，不要對這個 repo 做任何進一步操作（這可能是使用者尚未提交的工作，不可覆蓋）。
2. 若乾淨：\`git -C ${ROOT}/{repo} fetch origin ${baseBranch} --quiet\`
3. \`git -C ${ROOT}/{repo} checkout ${baseBranch}\`（若本機目前不在這個分支上，這一步會切過去，屬預期行為，切之前已經在步驟1確認過工作目錄乾淨）
4. \`git -C ${ROOT}/{repo} merge --ff-only origin/${baseBranch}\`（只允許 fast-forward，若因為本地領先或分歧導致失敗，如實回報，不要用非 ff 手段強推）
5. 記錄該 repo 目前 ${baseBranch} 分支的 HEAD commit hash（\`git -C ${ROOT}/{repo} rev-parse HEAD\`）

${HARD_RULES}

輸出：ok（4 個 repo 是否全部同步成功）、perRepo（每個 repo 一行 "{repo}:{HEAD短hash}" 的紀錄）、blockers（任何被擋下的原因，例如某 repo 有未提交變更或 ff-only 失敗）。只要有任何一個 repo 出現 blocker，ok 必須是 false。`
}

function buildExplorerPrompt(t, baseBranch) {
  return `你是「explorer」。任務：在真的動手實作之前，核對本地 plan 文件（與 Notion 需求文件，若有提供）是否與「現在 ${baseBranch} 分支上的真實程式碼」吻合（plan 撰寫後 ${baseBranch} 可能已經往前推進，也可能被同一輪次裡在你之前完成的其他工單改動過）。

${ticketContext(t, baseBranch)}

步驟：
1. 用 Read tool 讀取 \`${t.planPath}\` 全文（含「逐項變更清單」「驗證依據」「候選範圍清單」「判斷決策記錄」「待人工處理事項」）。
2. 判斷這張工單實際涉及哪些 repo：對 ${REPO_PREFIXES.join('/')} 這幾個名稱，檢查 plan 內文的「檔案:行號」是否以 "{repo}/" 開頭來源出現，只列出真的有變更項目落在該 repo 的（不要只因為 plan 提到某 repo 名稱就納入，要有實際檔案路徑佐證）。
3. ${t.notionUrl ? `\`bash ${ROOT}/scripts/notion.sh fetch-blocks "${t.notionUrl}"\` 讀取需求文件原文（若指令失敗，記錄下來但不要因此卡住，改依 plan 文件內對需求的轉述繼續調查，並在 scopeConcerns 註明「Notion 原文未能讀取」）。` : '（本次未提供 Notion 網址，略過此步驟。）'}
4. 對 plan「逐項變更清單」列出的每一個「檔案:行號」，用 \`git -C ${ROOT}/{repo} show ${baseBranch}:{相對路徑}\` 讀取該檔案在本機 ${baseBranch} 分支上的真實內容（**禁止直接用 Read tool 讀 repo 工作目錄的檔案**——本機有些 repo 目前不在 ${baseBranch} 分支，Read 會讀到錯的分支內容，一律用 git show ${baseBranch}: 才能保證看到的是真正的現況），核對 plan 描述的「現況」是否仍然吻合。
5. 標記任何「plan 描述的現況」與「git show 出來的真實現況」不符的落差（drift），包含行號偏移、程式邏輯已被改過、檔案已不存在等。
6. ${t.notionUrl ? '獨立核對 plan 的處理範圍是否忠實對應 Notion 需求文件原文，有沒有漏掉或誤解需求文字的地方。' : ''}
7. 不需要對「待人工處理事項」「判斷決策記錄」裡已經明確裁決/排除的項目重新質疑，除非你發現新的、原 plan 沒查到的事實。

${HARD_RULES}
你是唯讀調查，不修改任何檔案、不切分支、不 commit。`
}

function buildGatePrompt(t, baseBranch, explorerReport) {
  return `你是「gate reviewer」，獨立於剛才的 explorer，做「執行前最終裁決」：這份 plan 現在是否可以安全放行進入實作。

${ticketContext(t, baseBranch)}

Explorer 的調查報告（JSON，含它判斷出的實際涉及 repo）：
${JSON.stringify(explorerReport, null, 2)}

步驟：
1. Read \`${t.planPath}\` 全文。
2. ${t.notionUrl ? `\`bash ${ROOT}/scripts/notion.sh fetch-blocks "${t.notionUrl}"\` 獨立核對需求文件原文（不要只信任 explorer 的轉述）。` : '（本次未提供 Notion 網址，僅依 plan 文件本身判斷。）'}
3. 檢視 explorer 回報的 driftFindings / scopeConcerns：任何一項如果會實質推翻 plan 的根因判斷或建議做法，判定 NO_GO；如果只是行號小偏移、不影響方案本身，可以 GO 但在 executorCautions 提醒 executor 對照真實行號。
4. 檢查 plan 本身有沒有違反硬規則之處（例如建議直接寫 localizations/*.json、rajah 流水號重用等）——若 plan 本身沒有這類問題可放行；若 plan 建議的做法本身違反硬規則，判定 NO_GO 並說明。
5. 做出最終 GO / NO_GO 決定。

${HARD_RULES}
你是唯讀審查，不修改任何檔案。`
}

function buildExecutorPrompt(t, baseBranch, explorerReport, gate, retryContext) {
  const repos = explorerReport.repos
  const retrySection = retryContext
    ? `\n這是第 2 次嘗試。上一輪 acceptance reviewer 判定 FAIL，理由如下，請針對這些問題修正（分支與既有變更沿用上一輪留下的狀態，不要重新開始）：\n${JSON.stringify(retryContext, null, 2)}\n`
    : ''
  return `你是「executor」，任務是嚴格依照 plan 文件的「逐項變更清單」實作，只做已經在 plan 內被裁決為「納入」且有明確「建議」的項目；plan 裡標記為「待業主/PM確認」「待人工處理事項」「排除」的項目一律不做。

${ticketContext(t, baseBranch)}
本次涉及 repo（由 explorer 判斷）：${repos.join(', ')}

Gate reviewer 的裁決（JSON，決策必為 GO 你才會被派工）：
${JSON.stringify(gate, null, 2)}

Explorer 找到的落差（實作時對照真實行號用）：
${JSON.stringify(explorerReport.driftFindings, null, 2)}
${retrySection}
步驟：

### Step 0：分支就緒（每個受影響 repo 都要做）
對 ${repos.join(', ')} 各自執行：
\`\`\`
git -C ${ROOT}/{repo} rev-parse --verify impl/${t.id} 2>/dev/null
\`\`\`
- 若已存在（上一輪重試留下的分支）：\`git -C ${ROOT}/{repo} checkout impl/${t.id}\`，沿用現有的未提交變更繼續修。
- 若不存在：
  \`\`\`
  git -C ${ROOT}/{repo} fetch origin ${baseBranch} --quiet
  git -C ${ROOT}/{repo} checkout ${baseBranch}
  git -C ${ROOT}/{repo} merge --ff-only origin/${baseBranch}
  git -C ${ROOT}/{repo} checkout -b impl/${t.id} ${baseBranch}
  \`\`\`
執行後用 \`git -C ${ROOT}/{repo} branch --show-current\` 確認輸出恰好是 \`impl/${t.id}\`，不符合就停止並在 notes 說明，不要繼續改任何檔案。

### Step 1：讀 plan 全文
Read \`${t.planPath}\`，逐項確認要改的檔案、行號、建議做法、理由。

### Step 2：實作
- 用 Edit/Write 修改 ${repos.map(r => `${ROOT}/${r}/...`).join('、')} 底下的檔案（實際行號請以 Step 0 分支上的真實檔案內容為準，plan 的行號可能有小偏移）。
- 若修改了 rajah 的 \`.rajah\` 檔案：讀 \`${ROOT}/rajah/CLAUDE.md\` 確認正確的 codegen 指令與執行方式（不要憑記憶亂猜腳本名稱），對受影響的下游 repo（本工單範圍內的）重新產生程式碼，產生出的 \`.gen.*\` 檔案一併視為本次變更的一部分。
- 若涉及 DB migration：只新增 migration 檔案本身（抄該 repo 既有 migration 的命名格式與語法慣例），不執行任何 migrate 指令、不連接任何資料庫。
- i18n key 只寫 key 本身（程式碼引用），絕對不寫 localizations/*.json 的三語值；把新增/變更的 key 與你建議的三語值記入 pendingI18nKeys。
- plan 裡任何標記為「待業主/PM確認」「視覺選擇待確認」等需要人工裁定的子項，一律不實作，記入 itemsSkipped 並註明原因。

### Step 3：Lint
對每個你改過檔案的 repo，若該 repo有 eslint 設定：
\`\`\`
cd ${ROOT}/{repo} && NODE_OPTIONS=--max-old-space-size=8192 bunx eslint <你改過的檔案路徑...> 2>&1 | tail -60
\`\`\`
修掉你造成的 error（warning 可不處理）。絕對不要跑全量 lint。

### Step 4：不要 commit
**本階段不 commit**——commit 由驗收通過後的下一階段執行。保持修改為未提交狀態（可以 git add，不要 git commit）。

${HARD_RULES}

輸出結構化報告：branchReady（Step 0 是否成功切到 impl/${t.id}）、filesChanged（相對於各 repo root 的路徑清單）、itemsImplemented（對應 plan 逐項變更清單的項次編號，如 "1a","2b"）、itemsSkipped（連同原因）、pendingI18nKeys、codegenRan（是否跑過 rajah codegen）、lintClean（是否已無你造成的 lint error）、notes。`
}

function buildAcceptancePrompt(t, baseBranch, executorReport) {
  const repos = executorReport.branchReady ? undefined : undefined // repos 從 executorReport 無法拿到，改用下面直接掃描
  return `你是「acceptance reviewer」，獨立於 executor，任務是「按照需求文件驗收」剛才的實作是否真的滿足這張需求單、是否忠實對應 plan、有沒有踩到任何硬規則。

${ticketContext(t, baseBranch)}

Executor 回報（JSON，**這是它自己的說法，你必須自己重新查證，不可照單全收**）：
${JSON.stringify(executorReport, null, 2)}

步驟：
1. ${t.notionUrl ? `\`bash ${ROOT}/scripts/notion.sh fetch-blocks "${t.notionUrl}"\` 獨立重讀需求文件原文。` : '（本次未提供 Notion 網址，僅依 plan 文件核對。）'}
2. Read \`${t.planPath}\` 全文。
3. 對每個受影響 repo（自行對 ${MAIN_REPOS.join('/')} 逐一檢查 \`git -C ${ROOT}/{repo} branch --show-current\` 是否為 \`impl/${t.id}\`，是的話才是本工單受影響的 repo）：確認分支正確，然後 \`git -C ${ROOT}/{repo} diff\`（工作目錄尚未 commit 的變更）+ \`git -C ${ROOT}/{repo} status --short\` 看實際改了什麼。
4. 逐一核對 plan「逐項變更清單」中標記「納入」的項目是否真的被實作、實作方式是否符合 plan 的建議與判斷決策記錄；executor 略過的項目（itemsSkipped）是否都是合理的（i18n / 待業主確認 / plan 本身排除），沒有偷工。
5. 檢查有沒有觸犯硬規則：\`git -C ${ROOT}/{repo} diff --name-only\` 不可出現任何 \`localizations/\` 底下的 json 檔案；沒有任何 migrate/DDL 被執行的跡象；沒有 git push 的跡象。
6. 若該 repo 有 eslint，對變更檔案再跑一次 \`NODE_OPTIONS=--max-old-space-size=8192 bunx eslint <檔案...>\` 自行確認 lint 乾淨,不要只信任 executor 的 lintClean 宣稱。
7. ${t.notionUrl ? '對照 Notion 需求文件原文，確認這次實作真的解決了業主描述的問題（不是只改對了 plan 但沒對齊需求文字）。' : ''}

${HARD_RULES}
你是唯讀審查，不修改任何檔案、不 commit。

輸出：decision（PASS 或 FAIL）、issues（FAIL 時列出具體問題，PASS 時可留空陣列）、verifiedItems（你實際核對過且確認通過的項次編號）、summary。`
}

function buildWrapupPrompt(t, baseBranch, outcome, executorReport) {
  if (outcome === 'pass') {
    return `驗收已通過，你要把 ${t.id} 的實作 commit 並合併回本機 ${baseBranch} 分支。

${ticketContext(t, baseBranch)}

Executor 最終回報：
${JSON.stringify(executorReport, null, 2)}

對 ${MAIN_REPOS.join('/')} 逐一檢查（\`git -C ${ROOT}/{repo} branch --show-current\`），只要目前分支是 \`impl/${t.id}\` 的才是本工單受影響的 repo，依序：
1. \`git -C ${ROOT}/{repo} add -A\`
2. \`git -C ${ROOT}/{repo} status --short\`：若這個 repo 其實沒有任何變更，跳過 commit，不要製造空 commit。
3. 有變更才 commit：\`git -C ${ROOT}/{repo} commit -m "feat({module}): {簡述} [${t.id}]"\`（module/簡述依實際改動內容填寫，**訊息內絕對不可包含 Co-Authored-By 字樣**）
4. \`git -C ${ROOT}/{repo} checkout ${baseBranch}\`
5. \`git -C ${ROOT}/{repo} merge --ff-only impl/${t.id}\`（應該永遠是 fast-forward，因為分支是從 ${baseBranch} 分出且沒有其他人同時在改；若失敗如實回報，不要用非 ff 手段強推，也不要刪除 impl/${t.id} 分支）

${HARD_RULES}
絕對禁止 git push。

輸出：merged（是否全部受影響 repo 都成功 fast-forward 合併回 ${baseBranch}）、commits（每個實際有 commit 的 repo 一筆 {repo, hash}）、notes。`
  }
  return `${t.id} 在驗收前就被擋下（gate NO_GO 或連續 2 次驗收 FAIL），需要把受影響 repo 的本機 checkout 收回安全狀態，但**保留** impl/${t.id} 分支供人工檢視，不要 merge、不要 checkout ${baseBranch}（因為工作目錄還有未 commit 的修改，強行切分支可能造成困惑或衝突）。

${ticketContext(t, baseBranch)}

對 ${MAIN_REPOS.join('/')} 逐一檢查，只要目前分支是 \`impl/${t.id}\` 的就回報：
1. \`git -C ${ROOT}/{repo} branch --show-current\`
2. \`git -C ${ROOT}/{repo} status --short\`
只回報現況（分支名稱、是否有未提交變更），不做任何修改、不 commit、不切分支、不刪分支。

輸出：merged=false、commits=[]、notes（列出每個 repo 目前的分支與髒污狀態，方便使用者接手檢查）。`
}

async function runTicket(t, baseBranch) {
  phase(t.id)
  log(`${t.id}：開始 explorer 調查`)
  const explorerReport = await agent(buildExplorerPrompt(t, baseBranch), { schema: EXPLORER_SCHEMA, agentType: 'general-purpose', effort: 'high', phase: t.id })
  if (!explorerReport) return { ticket: t.id, status: 'blocked', stage: 'explorer', reason: 'explorer agent 未回傳結果' }
  if (explorerReport.recommendation === 'block') {
    return { ticket: t.id, status: 'blocked', stage: 'explorer', reason: explorerReport.summary, driftFindings: explorerReport.driftFindings }
  }
  if (!explorerReport.repos || explorerReport.repos.length === 0) {
    return { ticket: t.id, status: 'blocked', stage: 'explorer', reason: 'explorer 沒有判斷出任何涉及的 repo，無法繼續' }
  }

  log(`${t.id}：explorer 完成（涉及 repo：${explorerReport.repos.join(', ')}），派 gate reviewer 做執行前裁決`)
  const gate = await agent(buildGatePrompt(t, baseBranch, explorerReport), { schema: GATE_SCHEMA, agentType: 'general-purpose', effort: 'high', phase: t.id })
  if (!gate) return { ticket: t.id, status: 'blocked', stage: 'gate', reason: 'gate reviewer agent 未回傳結果' }
  if (gate.decision !== 'GO') {
    await agent(buildWrapupPrompt(t, baseBranch, 'fail', null), { schema: WRAPUP_SCHEMA, agentType: 'general-purpose', phase: t.id })
    return { ticket: t.id, status: 'blocked', stage: 'gate', reason: gate.reasons }
  }

  log(`${t.id}：gate GO，開始實作`)
  let executorReport = null
  let acceptance = null
  let attempt = 0
  while (attempt < 2) {
    executorReport = await agent(
      buildExecutorPrompt(t, baseBranch, explorerReport, gate, attempt > 0 ? acceptance : null),
      { schema: EXECUTOR_SCHEMA, agentType: 'general-purpose', effort: 'high', phase: t.id },
    )
    if (!executorReport) break
    log(`${t.id}：executor 第 ${attempt + 1} 次嘗試完成，派驗收 reviewer`)
    acceptance = await agent(buildAcceptancePrompt(t, baseBranch, executorReport), { schema: ACCEPTANCE_SCHEMA, agentType: 'general-purpose', effort: 'high', phase: t.id })
    if (acceptance && acceptance.decision === 'PASS') break
    attempt++
  }

  if (!executorReport) return { ticket: t.id, status: 'blocked', stage: 'executor', reason: 'executor agent 未回傳結果' }
  if (!acceptance || acceptance.decision !== 'PASS') {
    await agent(buildWrapupPrompt(t, baseBranch, 'fail', executorReport), { schema: WRAPUP_SCHEMA, agentType: 'general-purpose', phase: t.id })
    return { ticket: t.id, status: 'blocked', stage: 'acceptance', reason: acceptance ? acceptance.issues : 'acceptance reviewer 未回傳結果', executorReport, repos: explorerReport.repos }
  }

  log(`${t.id}：驗收 PASS，commit 並合併回 ${baseBranch}`)
  const wrapup = await agent(buildWrapupPrompt(t, baseBranch, 'pass', executorReport), { schema: WRAPUP_SCHEMA, agentType: 'general-purpose', effort: 'high', phase: t.id })
  if (!wrapup || !wrapup.merged) {
    return { ticket: t.id, status: 'blocked', stage: 'wrapup', reason: wrapup ? wrapup.notes : 'wrapup agent 未回傳結果', executorReport, repos: explorerReport.repos }
  }

  return {
    ticket: t.id,
    status: 'done',
    commits: wrapup.commits,
    itemsImplemented: executorReport.itemsImplemented,
    itemsSkipped: executorReport.itemsSkipped,
    pendingI18nKeys: executorReport.pendingI18nKeys,
  }
}

// args: { tickets: [{ id, planPath, notionUrl? }], baseBranch? }
const baseBranch = (args && args.baseBranch) || 'dev'
const tickets = (args && args.tickets) || []
if (tickets.length === 0) {
  throw new Error('args.tickets 是空的——至少要傳一張工單 { id, planPath, notionUrl? }')
}

phase('Setup')
log(`同步 rajah/agrabah/abu/lago 四個 repo 到最新 ${baseBranch} 分支`)
const sync = await agent(buildSyncPrompt(baseBranch), { schema: SYNC_SCHEMA, agentType: 'general-purpose', effort: 'high' })

const results = []
if (!sync || !sync.ok) {
  results.push({ ticket: null, status: 'blocked', stage: 'sync', reason: sync ? sync.blockers : 'sync agent 未回傳結果' })
} else {
  log(`同步完成：${JSON.stringify(sync.perRepo)}`)
  for (const t of tickets) {
    const result = await runTicket(t, baseBranch)
    results.push(result)
    if (result.status !== 'done') {
      log(`${t.id} 被擋下（${result.stage}），停止後續工單`)
      break
    }
    log(`${t.id} 完成並已合併回 ${baseBranch}`)
  }
}

return { baseBranch, results }
