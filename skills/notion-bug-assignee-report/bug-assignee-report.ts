/**
 * Notion Bug List — 一人一列、跨嚴重性等級分布的樞紐表（pivot），技術/非技術區分，依 FF / 巨星 / 未分類拆成三份 CSV。
 *
 * 篩選：狀態 = 仍有問題 OR 待處理（兩個 select 值）
 * 列：當前指派（people）以 person id 為主鍵；未指派獨立成「（未指派）」列
 * 欄：嚴重性（select，值如 P1重點 / P2較高 / P3一般 / P4較低；未填歸「（未分級）」）
 *     —— 每個等級一欄，依 P 後數字由小到大排序（P0 最優先），未分級殿後；末欄「小計」= 該人跨等級總量
 * 分類：以 tech-users.csv 的 notion_user_id 比對 → 技術人員 / 非技術人員 / 未指派
 *       （刻意用 id 而非姓名比對：Notion 端顯示名常帶前後空白，靠姓名會誤判）
 * 品牌拆分：以「影響端口」(multi_select) 判斷 → 值含「巨星」(如 巨星-前端/平台/系統) 歸巨星；
 *       否則若「問題摘要」(title) 含「巨星」字樣亦歸巨星；其餘歸 FF；
 *       「影響端口」為空或僅勾「未分配」歸未分類。三組各自輸出一份 CSV。
 *
 * 用法：
 *   bun /Users/user/aladdin/aladdin_ai/skills/notion-bug-assignee-report/bug-assignee-report.ts [--out <path>] [--no-push]
 *
 * 選項：
 *   --out <path>   CSV 基準路徑，實際會拆成三份（預設基準：/Users/user/aladdin/tmp/bug-status-by-assignee.csv）：
 *                  bug-status-by-assignee-FF.csv / -巨星.csv / -未分類.csv
 *   --no-push      跳過 Telegram 推送，只產出 CSV（供本機除錯/測試用；預設一律推送）
 *
 * 輸出：三份 CSV 依序印到 stdout，並各自寫入對應路徑；預設同時把三份 CSV 當文件推送到 Telegram
 *       （token 讀 /Users/user/aladdin/aladdin_ai/.env.local 的 TELEGRAM_BOT_TOKEN，固定 chat_id 為 Landon）。
 *       任一品牌推送失敗會另發一則 ⚠️ 文字通知，不會靜默；最終若有失敗則以非 0 結束碼結束。
 * 欄位：當前指派人員,類別,<各嚴重性等級…>,小計
 *       每份檔案末尾附跨人員彙總「技術人員小計 / 非技術人員小計 / 未指派小計 / 總計」（各欄亦為等級分布）。
 *
 * 口徑：人次加總 = ticket 去重總數（此 DB 每張單最多一位指派人，無多重指派重複計算）。
 *       同一人跨多個等級的 ticket，於同一列各等級欄分別計數，小計為其加總。
 * 注意：Notion 即時資料，兩次查詢間總數可能微幅變動屬正常。
 */

import { readFileSync } from 'fs';

const DATA_SOURCE_ID = '21c87d78-618a-817f-ae71-000baa9ab11b';
const NOTION_API = 'https://api.notion.com/v1';
const WANTED_STATUSES = ['仍有問題', '待處理'] as const;
const TECH_USERS_CSV = '/Users/user/aladdin/aladdin_ai/commands/create-mr/references/tech-users.csv';
const DEFAULT_OUT = '/Users/user/aladdin/tmp/bug-status-by-assignee.csv';
const ENV_FILE = '/Users/user/aladdin/aladdin_ai/.env.local';
const TG_CHAT_ID = '5022865804'; // Landon
const TG_TIMEOUT_MS = 60_000; // 曾發生睡眠喚醒後連線卡住不回應，避免卡死整支腳本

// ── 參數 ──
function parseOut(): string {
    const args = process.argv.slice(2);
    const i = args.indexOf('--out');
    if (i >= 0 && args[i + 1]) return args[i + 1];
    return DEFAULT_OUT;
}
const shouldPush = !process.argv.slice(2).includes('--no-push');

// ── Notion：token 只從 .env 讀，不寫死（與 notion.sh / notion-bug-query-v2.ts 同一把 ALD_NOTION_TOKEN）──
function loadNotionToken(): string {
    const content = readFileSync(ENV_FILE, 'utf-8');
    const line = content.split('\n').find(l => l.startsWith('ALD_NOTION_TOKEN='));
    const token = line?.slice('ALD_NOTION_TOKEN='.length).trim();
    if (!token) throw new Error(`無法從 ${ENV_FILE} 讀取 ALD_NOTION_TOKEN`);
    return token;
}

// ── Telegram：token 只從 .env 讀，不寫死 ──
function loadTelegramToken(): string {
    const content = readFileSync(ENV_FILE, 'utf-8');
    const line = content.split('\n').find(l => l.startsWith('TELEGRAM_BOT_TOKEN='));
    const token = line?.slice('TELEGRAM_BOT_TOKEN='.length).trim();
    if (!token) throw new Error(`無法從 ${ENV_FILE} 讀取 TELEGRAM_BOT_TOKEN`);
    return token;
}

async function tgSendDocument(token: string, brand: Brand, csv: string): Promise<void> {
    const date = new Date().toISOString().slice(0, 10);
    const form = new FormData();
    form.append('chat_id', TG_CHAT_ID);
    form.append('document', new Blob([csv], { type: 'text/csv' }), `${brand} ${date}.csv`);
    form.append('caption', `Bug 指派人員統計 - ${brand}（${date}）`);
    const res = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(TG_TIMEOUT_MS),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.ok) {
        throw new Error(`Telegram 推送失敗: ${JSON.stringify(data)}`);
    }
}

async function tgNotifyFail(token: string, message: string): Promise<void> {
    try {
        await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: TG_CHAT_ID, text: `⚠️ Bug 報表排程失敗：${message}` }),
            signal: AbortSignal.timeout(TG_TIMEOUT_MS),
        });
    } catch {
        // 失敗通知本身失敗就不再重試，留給 stderr 紀錄
    }
}

// ── 依基準路徑推導各品牌的輸出路徑（在副檔名前插入品牌後綴）──
function brandOutPath(base: string, brand: Brand): string {
    const dot = base.lastIndexOf('.');
    if (dot < 0) return `${base}-${brand}`;
    return `${base.slice(0, dot)}-${brand}${base.slice(dot)}`;
}

// ── 載入技術人員名單（以 notion_user_id 為比對主鍵）──
function loadTechIds(): Set<string> {
    const lines = readFileSync(TECH_USERS_CSV, 'utf-8').split('\n').filter(l => l.trim());
    const [header, ...rows] = lines;
    const idIdx = header.split(',').indexOf('notion_user_id');
    const ids = new Set<string>();
    for (const row of rows) {
        const id = row.split(',')[idIdx]?.trim();
        if (id) ids.add(id);
    }
    return ids;
}

async function queryAll(filter: object, notionToken: string) {
    const all: any[] = [];
    let startCursor: string | undefined;
    let hasMore = true;
    while (hasMore) {
        const body: any = { filter, page_size: 100 };
        if (startCursor) body.start_cursor = startCursor;
        const res = await fetch(`${NOTION_API}/data_sources/${DATA_SOURCE_ID}/query`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${notionToken}`,
                'Notion-Version': '2025-09-03',
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error(`Notion API error ${res.status}: ${await res.text()}`);
        const data = await res.json();
        all.push(...data.results);
        hasMore = data.has_more;
        startCursor = data.next_cursor;
    }
    return all;
}

// ── 品牌分類：影響端口含「巨星」→ 巨星；否則問題摘要含「巨星」→ 巨星；其餘 → FF；空/僅未分配 → 未分類 ──
type Brand = 'FF' | '巨星' | '未分類';
const BRANDS: Brand[] = ['FF', '巨星', '未分類'];
function classifyBrand(ports: string[], title: string): Brand {
    const meaningful = ports.filter(p => p !== '未分配');
    if (meaningful.length === 0) return '未分類';
    if (meaningful.some(p => p.includes('巨星'))) return '巨星';
    if (title.includes('巨星')) return '巨星';
    return 'FF';
}

const outBase = parseOut();
let tgToken: string | undefined;
if (shouldPush) {
    try {
        tgToken = loadTelegramToken();
    } catch (e) {
        console.error(e instanceof Error ? e.message : String(e));
        process.exit(1);
    }
}
let notionToken: string;
try {
    notionToken = loadNotionToken();
} catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
}
const techIds = loadTechIds();
const filter = { or: WANTED_STATUSES.map(s => ({ property: '狀態', select: { equals: s } })) };
const pages = await queryAll(filter, notionToken);

type Cat = '技術人員' | '非技術人員' | '未指派';
interface Stat { name: string; cat: Cat; bySev: Map<string, number>; total: number }

const SEV_EMPTY = '（未分級）';

// ── 依品牌分桶 ──
const pagesByBrand: Record<Brand, any[]> = { 'FF': [], '巨星': [], '未分類': [] };
for (const page of pages) {
    const props = page.properties;
    const status = props['狀態']?.select?.name ?? '';
    if (!WANTED_STATUSES.includes(status)) continue;
    const ports = ((props['影響端口']?.multi_select ?? []) as any[]).map(m => m.name as string);
    const title = ((props['問題摘要']?.title ?? []) as any[]).map(t => t.plain_text).join('');
    pagesByBrand[classifyBrand(ports, title)].push(page);
}

// ── 單一品牌分桶內：組出一人一列、跨等級分布的 pivot CSV ──
function buildCsv(brandPages: any[]): { csv: string; summary: string } {
    const byKey = new Map<string, Stat>();
    const sevSet = new Set<string>();
    const ensure = (key: string, name: string, cat: Cat) => {
        if (!byKey.has(key)) byKey.set(key, { name, cat, bySev: new Map(), total: 0 });
        return byKey.get(key)!;
    };
    const bump = (s: Stat, sev: string) => {
        s.bySev.set(sev, (s.bySev.get(sev) ?? 0) + 1);
        s.total++;
        sevSet.add(sev);
    };

    for (const page of brandPages) {
        const props = page.properties;
        const sev = props['嚴重性']?.select?.name?.trim() || SEV_EMPTY;
        const people = (props['當前指派']?.people ?? []) as any[];
        if (people.length === 0) {
            bump(ensure('__UNASSIGNED__', '（未指派）', '未指派'), sev);
        } else {
            for (const p of people) {
                const id = p.id ?? '';
                const name = (p.name ?? '（無名稱）').trim() || '（無名稱）';
                const cat: Cat = techIds.has(id) ? '技術人員' : '非技術人員';
                bump(ensure(id || name, name, cat), sev);
            }
        }
    }

    // 等級欄排序：依 P 後數字由小到大（P0→P4…），未分級殿後
    const sevRank = (s: string) => { const m = s.match(/^P(\d+)/); return m ? Number(m[1]) : 999; };
    const sevOrder = [...sevSet].sort((a, b) => sevRank(a) - sevRank(b) || a.localeCompare(b));

    // 排序：技術人員 → 非技術人員 → 未指派；各組內依小計（跨等級總量）由高到低
    const catOrder: Record<Cat, number> = { '技術人員': 0, '非技術人員': 1, '未指派': 2 };
    const sorted = [...byKey.values()].sort((a, b) =>
        catOrder[a.cat] - catOrder[b.cat] || b.total - a.total
    );

    // 組 CSV：一人一列，欄位為各嚴重性等級 + 小計
    const cell = (s: Stat, sev: string) => s.bySev.get(sev) ?? 0;
    const rows: string[] = [['當前指派人員', '類別', ...sevOrder, '小計'].join(',')];
    const groupSum: Record<Cat, { sev: Map<string, number>; total: number }> = {
        '技術人員': { sev: new Map(), total: 0 },
        '非技術人員': { sev: new Map(), total: 0 },
        '未指派': { sev: new Map(), total: 0 },
    };
    for (const s of sorted) {
        rows.push([s.name, s.cat, ...sevOrder.map(sev => cell(s, sev)), s.total].join(','));
        const g = groupSum[s.cat];
        for (const sev of sevOrder) g.sev.set(sev, (g.sev.get(sev) ?? 0) + cell(s, sev));
        g.total += s.total;
    }
    rows.push('');

    // 跨人員彙總：每類別一列（亦為等級分布）+ 總計
    const sumRow = (label: string, cat: string, g: { sev: Map<string, number>; total: number }) =>
        [label, cat, ...sevOrder.map(sev => g.sev.get(sev) ?? 0), g.total].join(',');
    const grand: { sev: Map<string, number>; total: number } = { sev: new Map(), total: 0 };
    for (const cat of ['技術人員', '非技術人員', '未指派'] as Cat[]) {
        const g = groupSum[cat];
        rows.push(sumRow(`${cat}小計`, cat, g));
        for (const sev of sevOrder) grand.sev.set(sev, (grand.sev.get(sev) ?? 0) + (g.sev.get(sev) ?? 0));
        grand.total += g.total;
    }
    rows.push(sumRow('總計', '全部', grand));

    const csv = rows.join('\n') + '\n';
    const sevSummary = sevOrder.map(sev => `${sev}:${grand.sev.get(sev) ?? 0}`).join(' / ');
    const summary = `等級欄: ${sevOrder.join(', ') || '(無)'} | 各等級張數: ${sevSummary || '(無)'} | 總計: ${grand.total}`;
    return { csv, summary };
}

console.error(`技術名單載入: ${techIds.size} 人`);
let hadFailure = false;
for (const brand of BRANDS) {
    const path = brandOutPath(outBase, brand);
    const { csv, summary } = buildCsv(pagesByBrand[brand]);
    await Bun.write(path, csv);
    console.error(`[${brand}] ${summary}`);
    console.error(`已寫入: ${path}`);
    console.log(csv);

    if (tgToken) {
        try {
            await tgSendDocument(tgToken, brand, csv);
            console.error(`[${brand}] 已推送 Telegram`);
        } catch (e) {
            hadFailure = true;
            const message = e instanceof Error ? e.message : String(e);
            console.error(`[${brand}] Telegram 推送失敗: ${message}`);
            await tgNotifyFail(tgToken, `[${brand}] ${message}`);
        }
    }
}
if (hadFailure) process.exit(1);
