/**
 * 把 CSV 整份覆蓋寫入 Google Sheet 的指定工作表（以 service account 認證）。
 * 憑證：aladdin_ai/service-account.json（已 gitignore，600 權限）。
 * 試算表需已把 client_email 加為「編輯者」。
 */
import { readFileSync } from 'fs';
import { createSign } from 'crypto';

const SA_FILE = '/Users/user/aladdin/aladdin_ai/service-account.json';
export const SPREADSHEET_ID = '1QOa-9cXGbCbQ97XqOtHR0NerBgnfiX_KHvQxYJ0ZCOI';
const API = 'https://sheets.googleapis.com/v4/spreadsheets';
const TIMEOUT_MS = 60_000;

const b64 = (o: unknown) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');

async function getAccessToken(): Promise<string> {
    const sa = JSON.parse(readFileSync(SA_FILE, 'utf-8'));
    const now = Math.floor(Date.now() / 1000);
    const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
        iss: sa.client_email,
        scope: 'https://www.googleapis.com/auth/spreadsheets',
        aud: 'https://oauth2.googleapis.com/token',
        iat: now,
        exp: now + 3600,
    })}`;
    const sig = createSign('RSA-SHA256').update(unsigned).sign(sa.private_key, 'base64url');
    const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${sig}` }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.access_token) throw new Error(`取得 Google access token 失敗: ${JSON.stringify(data)}`);
    return data.access_token;
}

// CSV 內無引號/跳脫（buildCsv 以 join(',') 組成），直接依逗號切；純數字轉 number 以便試算表計算
function csvToRows(csv: string): (string | number)[][] {
    return csv.replace(/\n+$/, '').split('\n').map(line =>
        line.split(',').map(c => (/^\d+$/.test(c) ? Number(c) : c)));
}

/** 先清空再寫入 `<sheetTitle>!A1`，確保上次較長的資料不殘留。 */
export async function overwriteSheet(sheetTitle: string, csv: string): Promise<void> {
    const token = await getAccessToken();
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const range = encodeURIComponent(sheetTitle);

    const clear = await fetch(`${API}/${SPREADSHEET_ID}/values/${range}:clear`, {
        method: 'POST', headers, body: '{}', signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!clear.ok) throw new Error(`清空工作表「${sheetTitle}」失敗: ${clear.status} ${await clear.text()}`);

    const put = await fetch(`${API}/${SPREADSHEET_ID}/values/${range}!A1?valueInputOption=RAW`, {
        method: 'PUT', headers, body: JSON.stringify({ values: csvToRows(csv) }), signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!put.ok) throw new Error(`寫入工作表「${sheetTitle}」失敗: ${put.status} ${await put.text()}`);
}
