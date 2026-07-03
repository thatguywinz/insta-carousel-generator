import { google, sheets_v4 } from 'googleapis';
import { z } from 'zod';
import { log } from './logger.js';

/**
 * Google Sheets access layer. Decodes the service account in memory, never
 * writes it to disk, and uses the narrow Sheets scope.
 */

const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];

const ServiceAccountSchema = z.object({
  type: z.literal('service_account'),
  project_id: z.string().min(1),
  private_key_id: z.string().min(1),
  private_key: z.string().min(1).includes('BEGIN'),
  client_email: z.string().email(),
  client_id: z.string().optional(),
  token_uri: z.string().url().optional(),
});
export type ServiceAccount = z.infer<typeof ServiceAccountSchema>;

/**
 * Decode and validate the base64 service-account credential in memory.
 * Throws with a generic message (never the contents) on malformed input.
 */
export function decodeServiceAccount(b64: string): ServiceAccount {
  let jsonText: string;
  try {
    jsonText = Buffer.from(b64.trim(), 'base64').toString('utf8');
  } catch {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_B64 is not valid base64');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_B64 does not decode to valid JSON');
  }
  const result = ServiceAccountSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error('Decoded service account is missing required credential fields');
  }
  return result.data;
}

export interface SheetsClient {
  api: sheets_v4.Sheets;
  spreadsheetId: string;
}

/** Build an authenticated Sheets client. Credentials are held only in memory. */
export async function createSheetsClient(
  serviceAccountB64: string,
  spreadsheetId: string,
): Promise<SheetsClient> {
  const sa = decodeServiceAccount(serviceAccountB64);
  const auth = new google.auth.JWT({
    email: sa.client_email,
    key: sa.private_key,
    scopes: SCOPES,
  });
  await auth.authorize();
  const api = google.sheets({ version: 'v4', auth });
  return { api, spreadsheetId };
}

/** Read a range as a raw 2D string array. */
export async function readRange(client: SheetsClient, range: string): Promise<string[][]> {
  const res = await client.api.spreadsheets.values.get({
    spreadsheetId: client.spreadsheetId,
    range,
    valueRenderOption: 'UNFORMATTED_VALUE',
  });
  const values = res.data.values ?? [];
  return values.map((row) =>
    row.map((cell) => (cell === null || cell === undefined ? '' : String(cell))),
  );
}

/** Update a single A1 range with a row/matrix of values (RAW). */
export async function updateRange(
  client: SheetsClient,
  range: string,
  values: (string | number)[][],
): Promise<void> {
  await client.api.spreadsheets.values.update({
    spreadsheetId: client.spreadsheetId,
    range,
    valueInputOption: 'RAW',
    requestBody: { values },
  });
}

/** Append rows to the end of a sheet's data region. */
export async function appendRows(
  client: SheetsClient,
  range: string,
  values: (string | number)[][],
): Promise<void> {
  await client.api.spreadsheets.values.append({
    spreadsheetId: client.spreadsheetId,
    range,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values },
  });
}

/** Batch-update several disjoint ranges in one API call. */
export async function batchUpdate(
  client: SheetsClient,
  data: Array<{ range: string; values: (string | number)[][] }>,
): Promise<void> {
  if (data.length === 0) return;
  await client.api.spreadsheets.values.batchUpdate({
    spreadsheetId: client.spreadsheetId,
    requestBody: { valueInputOption: 'RAW', data },
  });
}

/** List the sheet/tab titles present in the spreadsheet. */
export async function listTabs(client: SheetsClient): Promise<string[]> {
  const res = await client.api.spreadsheets.get({
    spreadsheetId: client.spreadsheetId,
    fields: 'sheets.properties.title',
  });
  const sheets = res.data.sheets ?? [];
  const titles: string[] = [];
  for (const s of sheets) {
    const t = s.properties?.title;
    if (t) titles.push(t);
  }
  log.debug('sheet tabs discovered', { titles });
  return titles;
}
