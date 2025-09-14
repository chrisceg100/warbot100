// sheets.js — minimal Google Sheets bootstrap for wars + responses

import { google } from 'googleapis';

const SHEET_WARS = 'wars';
const SHEET_RESP = 'war_responses';

// Ensure a sheet exists (create if missing)
async function ensureSheet(sheets, spreadsheetId, title, headers) {
  // try to read header
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${title}!A1:Z1`,
    });
    const have = (res.data.values && res.data.values[0]) || [];
    const need = headers;
    // if headers mismatch length or any header missing, set them (non-destructive for existing rows)
    if (need.some((h, i) => (have[i] || '').toString().trim() !== h)) {
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${title}!A1:${String.fromCharCode(64 + need.length)}1`,
        valueInputOption: 'RAW',
        requestBody: { values: [need] },
      });
    }
    return;
  } catch (e) {
    // create sheet, then set headers
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title } } }] }
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${title}!A1:${String.fromCharCode(64 + headers.length)}1`,
      valueInputOption: 'RAW',
      requestBody: { values: [headers] },
    });
  }
}

async function getClient() {
  const auth = new google.auth.GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

export async function initSheets() {
  if (!process.env.SHEETS_ID) throw new Error('SHEETS_ID missing in env');
  const sheets = await getClient();
  const id = process.env.SHEETS_ID;

  await ensureSheet(sheets, id, SHEET_WARS, [
    'war_id','opponent','format','team_size','start_et','channel_id','message_id','created_at_iso'
  ]);

  await ensureSheet(sheets, id, SHEET_RESP, [
    'war_id','user_id','name','status','ts_iso'
  ]);

  console.log('✅ Google Sheets ready');
}

export async function getNextWarId() {
  const sheets = await getClient();
  const id = process.env.SHEETS_ID;
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: id,
    range: `${SHEET_WARS}!A2:A`,
  });
  const rows = res.data.values || [];
  let max = 0;
  for (const r of rows) {
    const v = parseInt(r[0], 10);
    if (Number.isFinite(v) && v > max) max = v;
  }
  return max + 1;
}

export async function pushWarCreated({ warId, opponent, format, teamSize, startET, channelId, messageId }) {
  const sheets = await getClient();
  const id = process.env.SHEETS_ID;
  const now = new Date().toISOString();
  await sheets.spreadsheets.values.append({
    spreadsheetId: id,
    range: `${SHEET_WARS}!A2:H`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: {
      values: [[ String(warId), opponent, format, String(teamSize), startET, String(channelId), String(messageId), now ]]
    }
  });
}

export async function pushResponse({ warId, userId, name, status, tsIso }) {
  const sheets = await getClient();
  const id = process.env.SHEETS_ID;
  await sheets.spreadsheets.values.append({
    spreadsheetId: id,
    range: `${SHEET_RESP}!A2:E`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [[ String(warId), String(userId), name, status, tsIso ]] }
  });
}
