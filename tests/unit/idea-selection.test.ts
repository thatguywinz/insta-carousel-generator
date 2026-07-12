import { describe, it, expect } from 'vitest';
import {
  selectUnusedIdea,
  selectPublishableDraft,
  selectResumable,
  selectVerifyRequired,
  generateIdeaId,
} from '../../src/idea-selection.js';
import { ContentRowSchema, TrackedRow } from '../../schemas/post.js';
import { DateTime } from 'luxon';

function row(partial: Partial<TrackedRow> & { rowNumber: number }): TrackedRow {
  const base = ContentRowSchema.parse({ ...partial });
  return { ...base, rowNumber: partial.rowNumber };
}

describe('idea selection ordering', () => {
  it('prefers High > Medium > Low, then oldest row', () => {
    const rows: TrackedRow[] = [
      row({ rowNumber: 2, idea_id: 'a', idea: 'low', priority: 'Low', status: 'UNUSED' }),
      row({ rowNumber: 3, idea_id: 'b', idea: 'high-newer', priority: 'High', status: 'UNUSED' }),
      row({ rowNumber: 4, idea_id: 'c', idea: 'med', priority: 'Medium', status: 'UNUSED' }),
      row({ rowNumber: 5, idea_id: 'd', idea: 'high-older', priority: 'High', status: 'UNUSED' }),
    ];
    const chosen = selectUnusedIdea(rows);
    expect(chosen?.idea_id).toBe('b'); // both High; row 3 older than row 5
  });

  it('ignores non-UNUSED and blank-idea rows', () => {
    const rows: TrackedRow[] = [
      row({ rowNumber: 2, idea_id: 'a', idea: '', priority: 'High', status: 'UNUSED' }),
      row({ rowNumber: 3, idea_id: 'b', idea: 'posted', priority: 'High', status: 'POSTED' }),
    ];
    expect(selectUnusedIdea(rows)).toBeNull();
  });
});

describe('news-first queue expiry (so a breaking story can preempt)', () => {
  const NOW = DateTime.fromISO('2026-07-12T00:00:00', { zone: 'utc' });
  const opts = { maxAgeDays: 14, timezone: 'utc', now: NOW };

  it('skips stale Claude-generated ideas so the queue does not block fresh news', () => {
    const rows: TrackedRow[] = [
      row({
        rowNumber: 2,
        idea_id: 'stale',
        idea: 'old news',
        priority: 'High',
        status: 'UNUSED',
        source: 'Claude',
        added_at: '2026-06-01 09:00:00 UTC', // ~41 days old
      }),
      row({
        rowNumber: 3,
        idea_id: 'fresh',
        idea: 'new news',
        priority: 'Medium',
        status: 'UNUSED',
        source: 'Claude',
        added_at: '2026-07-11 09:00:00 UTC',
      }),
    ];
    // Stale High is skipped even though it outranks the fresh Medium.
    expect(selectUnusedIdea(rows, opts)?.idea_id).toBe('fresh');
    // Returns null when everything is stale → caller generates a fresh idea.
    expect(selectUnusedIdea([rows[0]!], opts)).toBeNull();
  });

  it('never expires manual rows — the owner asked for those', () => {
    const rows: TrackedRow[] = [
      row({
        rowNumber: 2,
        idea_id: 'manual',
        idea: 'owner idea',
        priority: 'High',
        status: 'UNUSED',
        source: 'Manual',
        added_at: '2026-01-01 09:00:00 UTC', // ancient
      }),
    ];
    expect(selectUnusedIdea(rows, opts)?.idea_id).toBe('manual');
  });

  it('without maxAgeDays the queue behaves exactly as before', () => {
    const rows: TrackedRow[] = [
      row({
        rowNumber: 2,
        idea_id: 'stale',
        idea: 'old',
        priority: 'High',
        status: 'UNUSED',
        source: 'Claude',
        added_at: '2026-01-01 09:00:00 UTC',
      }),
    ];
    expect(selectUnusedIdea(rows)?.idea_id).toBe('stale');
  });

  it('selectPublishableDraft needs assets and no media id', () => {
    const rows: TrackedRow[] = [
      row({
        rowNumber: 2,
        idea_id: 'a',
        idea: 'x',
        status: 'DRAFT_READY',
        preview_url: 'https://p',
        caption: 'c',
        instagram_media_id: '',
      }),
      row({
        rowNumber: 3,
        idea_id: 'b',
        idea: 'y',
        status: 'DRAFT_READY',
        preview_url: 'https://p',
        caption: 'c',
        instagram_media_id: '999',
      }),
    ];
    expect(selectPublishableDraft(rows)?.idea_id).toBe('a');
  });

  it('selectResumable finds in-progress rows', () => {
    const rows: TrackedRow[] = [
      row({ rowNumber: 2, idea_id: 'a', idea: 'x', status: 'GENERATING' }),
      row({ rowNumber: 3, idea_id: 'b', idea: 'y', status: 'UNUSED' }),
    ];
    expect(selectResumable(rows)?.idea_id).toBe('a');
  });

  it('selectVerifyRequired finds VERIFY_REQUIRED rows', () => {
    const rows: TrackedRow[] = [
      row({ rowNumber: 2, idea_id: 'a', idea: 'x', status: 'VERIFY_REQUIRED' }),
    ];
    expect(selectVerifyRequired(rows)?.idea_id).toBe('a');
  });

  it('generateIdeaId is unique and prefixed', () => {
    const a = generateIdeaId();
    const b = generateIdeaId();
    expect(a).not.toBe(b);
    expect(a.startsWith('idea_')).toBe(true);
  });
});
