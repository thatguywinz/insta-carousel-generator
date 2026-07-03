import { DateTime } from 'luxon';
import { SheetsClient, readRange, listTabs, batchUpdate, appendRows } from './google-sheets.js';
import {
  CONTENT_HEADERS,
  ContentHeader,
  ContentRow,
  ContentRowSchema,
  TrackedRow,
} from '../schemas/post.js';
import { parseSettings, Settings } from '../schemas/settings.js';
import { log } from './logger.js';

/**
 * Higher-level Google Sheet operations enforcing the tab/column contract.
 * All row updates are addressed by idea_id, never by cached row position.
 */

export const REQUIRED_TABS = ['Instructions', 'Settings', 'Content'] as const;

export interface SheetContext {
  client: SheetsClient;
  timezone: string;
}

/** Convert a 1-based column index to an A1 column letter (1 => A). */
export function columnLetter(index1: number): string {
  let n = index1;
  let s = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

const LAST_COL = columnLetter(CONTENT_HEADERS.length); // 'Q'

/** ISO-ish timestamp in the configured timezone. */
export function nowTimestamp(timezone: string): string {
  const dt = DateTime.now().setZone(timezone);
  const valid = dt.isValid ? dt : DateTime.now().setZone('America/Toronto');
  return valid.toFormat("yyyy-MM-dd HH:mm:ss 'ZZZZ'").replace('ZZZZ', valid.offsetNameShort ?? '');
}

/** Verify all required tabs exist. Throws listing the missing ones. */
export async function verifyTabs(ctx: SheetContext): Promise<void> {
  const tabs = await listTabs(ctx.client);
  const missing = REQUIRED_TABS.filter((t) => !tabs.includes(t));
  if (missing.length > 0) {
    throw new Error(`Google Sheet is missing required tabs: ${missing.join(', ')}`);
  }
}

/** Read Settings!A:B into a validated Settings object. */
export async function readSettings(ctx: SheetContext): Promise<Settings> {
  const rows = await readRange(ctx.client, 'Settings!A:B');
  const map: Record<string, string> = {};
  for (const row of rows) {
    const key = (row[0] ?? '').trim();
    if (!key || key.startsWith('#')) continue;
    map[key] = (row[1] ?? '').toString();
  }
  return parseSettings(map);
}

/**
 * Verify the Content header row matches the contract EXACTLY (order + names).
 * Fails safely — we never silently create incompatible columns.
 */
export async function verifyContentHeaders(ctx: SheetContext): Promise<void> {
  const rows = await readRange(ctx.client, `Content!A1:${LAST_COL}1`);
  const header = rows[0] ?? [];
  const actual = header.map((h) => h.trim());
  const expected = [...CONTENT_HEADERS];

  const mismatches: string[] = [];
  for (let i = 0; i < expected.length; i++) {
    if (actual[i] !== expected[i]) {
      mismatches.push(
        `col ${columnLetter(i + 1)}: expected "${expected[i]}", got "${actual[i] ?? '(empty)'}"`,
      );
    }
  }
  if (actual.length > expected.length) {
    mismatches.push(
      `sheet has ${actual.length} header columns, contract expects ${expected.length}`,
    );
  }
  if (mismatches.length > 0) {
    throw new Error(`Content headers do not match contract: ${mismatches.join('; ')}`);
  }
}

/** Read all Content data rows (excludes header), each tagged with its row number. */
export async function readContentRows(ctx: SheetContext): Promise<TrackedRow[]> {
  const rows = await readRange(ctx.client, `Content!A2:${LAST_COL}`);
  const out: TrackedRow[] = [];
  rows.forEach((raw, i) => {
    // Skip completely empty rows.
    if (raw.every((c) => (c ?? '').trim() === '')) return;
    const obj: Record<string, string> = {};
    CONTENT_HEADERS.forEach((h, idx) => {
      obj[h] = (raw[idx] ?? '').toString();
    });
    const parsed = ContentRowSchema.parse(obj);
    out.push({ ...parsed, rowNumber: i + 2 });
  });
  return out;
}

/** Find the tracked row for an idea_id, or null. */
export function findByIdeaId(rows: TrackedRow[], ideaId: string): TrackedRow | null {
  return rows.find((r) => r.idea_id === ideaId) ?? null;
}

/**
 * Update specific fields of the row identified by idea_id. Re-reads the sheet
 * to locate the current row position (never assumes cached positions).
 */
export async function updateRowFields(
  ctx: SheetContext,
  ideaId: string,
  fields: Partial<Record<ContentHeader, string>>,
): Promise<void> {
  const rows = await readContentRows(ctx);
  const target = findByIdeaId(rows, ideaId);
  if (!target) {
    throw new Error(`Cannot update Content row: idea_id ${ideaId} not found`);
  }
  const updates: Array<{ range: string; values: (string | number)[][] }> = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    const colIdx = CONTENT_HEADERS.indexOf(key as ContentHeader);
    if (colIdx < 0) continue;
    const col = columnLetter(colIdx + 1);
    updates.push({ range: `Content!${col}${target.rowNumber}`, values: [[value]] });
  }
  await batchUpdate(ctx.client, updates);
  log.debug('updated Content row', { ideaId, fields: Object.keys(fields) });
}

/** Append a brand-new Content row from a partial ContentRow. Never deletes. */
export async function appendContentRow(
  ctx: SheetContext,
  row: Partial<ContentRow> & { idea_id: string; idea: string },
): Promise<void> {
  const full = ContentRowSchema.parse({ ...row });
  const values = CONTENT_HEADERS.map((h) => full[h] ?? '');
  await appendRows(ctx.client, `Content!A1:${LAST_COL}`, [values]);
  log.debug('appended Content row', { ideaId: row.idea_id });
}
