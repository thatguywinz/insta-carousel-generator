import crypto from 'node:crypto';
import { DateTime } from 'luxon';
import { TrackedRow } from '../schemas/post.js';
import { Priority, Settings } from '../schemas/settings.js';
import { SheetContext, appendContentRow, nowTimestamp, columnLetter } from './content-tracker.js';
import { batchUpdate } from './google-sheets.js';
import { CONTENT_HEADERS, ContentHeader } from '../schemas/post.js';
import { checkSimilarity } from './similarity.js';
import { log } from './logger.js';

/** Generate a secure, unique, sheet-friendly idea id. */
export function generateIdeaId(): string {
  return `idea_${crypto.randomUUID()}`;
}

const PRIORITY_RANK: Record<string, number> = { High: 0, Medium: 1, Low: 2 };

function normalizePriority(raw: string): Priority {
  const v = raw.trim().toLowerCase();
  if (v === 'high') return 'High';
  if (v === 'low') return 'Low';
  return 'Medium';
}

/**
 * Choose the highest-priority UNUSED idea. Ties broken by oldest row
 * (lowest rowNumber, which reflects insertion order).
 */
export function selectUnusedIdea(rows: TrackedRow[]): TrackedRow | null {
  const unused = rows.filter(
    (r) => r.status.trim().toUpperCase() === 'UNUSED' && r.idea.trim() !== '',
  );
  if (unused.length === 0) return null;
  unused.sort((a, b) => {
    const pa = PRIORITY_RANK[normalizePriority(a.priority)] ?? 1;
    const pb = PRIORITY_RANK[normalizePriority(b.priority)] ?? 1;
    if (pa !== pb) return pa - pb;
    return a.rowNumber - b.rowNumber;
  });
  return unused[0] ?? null;
}

/**
 * Find the oldest DRAFT_READY row that has complete assets (preview + caption)
 * but no Instagram media id yet — eligible to publish first.
 */
export function selectPublishableDraft(rows: TrackedRow[]): TrackedRow | null {
  const drafts = rows.filter(
    (r) =>
      r.status.trim().toUpperCase() === 'DRAFT_READY' &&
      r.preview_url.trim() !== '' &&
      r.caption.trim() !== '' &&
      r.instagram_media_id.trim() === '',
  );
  if (drafts.length === 0) return null;
  drafts.sort((a, b) => a.rowNumber - b.rowNumber);
  return drafts[0] ?? null;
}

/**
 * Find an in-progress row to resume (SELECTED / GENERATING / RENDERING). This
 * lets a two-phase run (select, then author + render) and crash recovery reuse
 * a row instead of selecting a fresh idea. Oldest first.
 */
export function selectResumable(rows: TrackedRow[]): TrackedRow | null {
  const inProgress = rows.filter((r) => {
    const s = r.status.trim().toUpperCase();
    return s === 'SELECTED' || s === 'GENERATING' || s === 'RENDERING';
  });
  if (inProgress.length === 0) return null;
  inProgress.sort((a, b) => a.rowNumber - b.rowNumber);
  return inProgress[0] ?? null;
}

/** Find rows needing publication recovery. */
export function selectVerifyRequired(rows: TrackedRow[]): TrackedRow | null {
  const rowsVR = rows.filter((r) => r.status.trim().toUpperCase() === 'VERIFY_REQUIRED');
  if (rowsVR.length === 0) return null;
  rowsVR.sort((a, b) => a.rowNumber - b.rowNumber);
  return rowsVR[0] ?? null;
}

/**
 * Mark a selected row as SELECTED. Because a manual row may lack an idea_id
 * (which we can only assign here), the update is addressed by the KNOWN row
 * number, not by id. Assigns a new id if missing, stamps selected_at, and
 * preserves the existing source (e.g. Manual).
 */
export async function markSelected(ctx: SheetContext, row: TrackedRow): Promise<string> {
  const ideaId = row.idea_id.trim() || generateIdeaId();
  const fields: Array<{ header: ContentHeader; value: string }> = [
    { header: 'idea_id', value: ideaId },
    { header: 'status', value: 'SELECTED' },
    { header: 'selected_at', value: nowTimestamp(ctx.timezone) },
    { header: 'source', value: row.source.trim() || 'Manual' },
    { header: 'error', value: '' },
  ];
  const updates = fields.map((u) => {
    const colIdx = CONTENT_HEADERS.indexOf(u.header);
    return { range: `Content!${columnLetter(colIdx + 1)}${row.rowNumber}`, values: [[u.value]] };
  });
  await batchUpdate(ctx.client, updates);
  log.info('marked idea SELECTED', { ideaId, rowNumber: row.rowNumber });
  return ideaId;
}

/** Build the corpus of recent topics/hooks within LOOKBACK_DAYS for dedup. */
export function buildRecentCorpus(
  rows: TrackedRow[],
  settings: Settings,
  timezone: string,
): string[] {
  const cutoff = DateTime.now().setZone(timezone).minus({ days: settings.LOOKBACK_DAYS });
  const corpus: string[] = [];
  for (const r of rows) {
    const status = r.status.trim().toUpperCase();
    if (status !== 'POSTED' && status !== 'DRAFT_READY' && status !== 'SELECTED') continue;
    // Prefer selected/added time; if unpariseable, include anyway (conservative).
    const stamp = r.published_at || r.selected_at || r.added_at;
    let recent = true;
    if (stamp) {
      const dt = DateTime.fromFormat(stamp.replace(/\s+[A-Z]{2,5}$/, ''), 'yyyy-MM-dd HH:mm:ss', {
        zone: timezone,
      });
      if (dt.isValid) recent = dt >= cutoff;
    }
    if (recent) {
      if (r.idea.trim()) corpus.push(r.idea.trim());
      if (r.hook.trim()) corpus.push(r.hook.trim());
    }
  }
  return corpus;
}

export interface GeneratedIdeaInput {
  idea: string;
  priority?: Priority;
  content_pillar?: string;
}

/**
 * Insert a Claude-generated idea into the Content tab, already marked SELECTED.
 * Rejects the idea if it is too similar to a recent one.
 */
export async function insertGeneratedIdea(
  ctx: SheetContext,
  input: GeneratedIdeaInput,
  corpus: string[],
): Promise<{ ideaId: string; similarity: number }> {
  const sim = checkSimilarity(input.idea, corpus);
  if (sim.isDuplicate) {
    throw new Error(
      `Generated idea too similar to recent content (score ${sim.maxScore.toFixed(2)}): "${sim.mostSimilar ?? ''}"`,
    );
  }
  const ideaId = generateIdeaId();
  const ts = nowTimestamp(ctx.timezone);
  await appendContentRow(ctx, {
    idea_id: ideaId,
    idea: input.idea,
    priority: input.priority ?? 'Medium',
    source: 'Claude',
    status: 'SELECTED',
    added_at: ts,
    selected_at: ts,
    content_pillar: input.content_pillar ?? '',
  });
  log.info('inserted Claude-generated idea', {
    ideaId,
    similarity: Number(sim.maxScore.toFixed(2)),
  });
  return { ideaId, similarity: sim.maxScore };
}
