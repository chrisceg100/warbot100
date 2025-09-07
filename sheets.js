// sheets.js — keep existing tabs/headers; add `side` to maps rows
import { google } from 'googleapis';

let sheets = null;
let SPREADSHEET_ID = null;

/** Create a sheet if it doesn't exist. If it already exists, silently skip. */
async function ensureSheet(title) {
  // Check existing tabs first
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const exists = (meta.data.sheets || []).some(s => s.properties?.title === title);
  if (exists) return;

  // Try to create; if Google says it already exists, ignore
  try {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title } } }] }
    });
  } catch (err) {
    const msg = err?.response?.data?.error?.message || err?.message || '';
    if (!/already exists/i.test(msg)) throw err;
  }
}

/** Append one row to a tab. */
async function appendRow(title, row) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${title}!A:A`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [row] }
  });
}

/* ========================= Public API ========================= */

export async function initSheets() {
  const idFromEnv = process.env.SHEETS_ID || process.env.GOOGLE_SHEET_ID;
  if (!idFromEnv) throw new Error('SHEETS_ID or GOOGLE_SHEET_ID missing in env');
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    throw new Error('GOOGLE_APPLICATION_CREDENTIALS missing in env');
  }

  const auth = new google.auth.GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
  });

  const client = await auth.getClient();
  sheets = google.sheets({ version: 'v4', auth: client });
  SPREADSHEET_ID = idFromEnv;

  // Only create tabs if missing; do NOT write headers if they already exist.
  await ensureSheet('wars');
  await ensureSheet('maps');
  await ensureSheet('vod');
  await ensureSheet('subs');
  await ensureSheet('noshow');

  console.log('✅ Google Sheets ready');
}

/**
 * Roster chosen/updated.
 * Classic order expected in `wars`:
 * war_id, opponent, format, start_et, locked_at, team_size, starters, backups, planned_maps
 */
export async function pushWarLock({
  warId, opponent = '', format, startET, lockedAt,
  starters = [], backups = [], plannedMaps = [], teamSize
}) {
  const startersStr = starters.map(s => `${s.name} (${s.userId})`).join(', ');
  const backupsStr  = backups.map(s => `${s.name} (${s.userId})`).join(', ');
  const mapsStr     = plannedMaps.join(' | ');

  await appendRow('wars', [
    warId, opponent, format, startET, lockedAt, (teamSize ?? ''), startersStr, backupsStr, mapsStr
  ]);
}

/**
 * Add or update a map score.
 * EXACT COLUMN ORDER (to match your sheet):
 * war_id, map_order, map_name, our_score, opp_score, side
 */
export async function pushMapScore({ warId, mapOrder, mapName, our, opp, side }) {
  await appendRow('maps', [
    warId, mapOrder, (mapName || ''), (our ?? ''), (opp ?? ''), (side || '')
  ]);
}

/** Added a map without scores yet (still includes 'side' column, left blank unless provided). */
export async function pushAddedMap({ warId, mapOrder, mapName, our = '', opp = '', side = '' }) {
  await appendRow('maps', [
    warId, mapOrder, (mapName || ''), (our ?? ''), (opp ?? ''), (side || '')
  ]);
}

/** Minimal VOD row: war_id, vod_url  */
export async function pushVOD({ warId, vodUrl }) {
  await appendRow('vod', [warId, (vodUrl || '')]);
}

/** Minimal Subs row: war_id, user_in, user_out, note */
export async function pushSub({ warId, userIn, userOut, note = '' }) {
  await appendRow('subs', [warId, (userIn || ''), (userOut || ''), (note || '')]);
}

/** Minimal NoShows row: war_id, user_id, name */
export async function pushNoShow({ warId, userId, name }) {
  await appendRow('noshow', [warId, (userId || ''), (name || '')]);
}
