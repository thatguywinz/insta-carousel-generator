import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { DateTime } from 'luxon';
import { nowTimestamp } from '../../src/content-tracker.js';
import { parseSheetStamp } from '../../src/idea-selection.js';
import { verifyPublication, saveAttemptRecord, AttemptRecord } from '../../src/recovery.js';
import { acquireLock, heartbeatLock } from '../../src/locks.js';
import {
  resolveContentType,
  validateNewsworthiness,
  freshestSourceAgeDays,
} from '../../src/newsworthiness.js';
import { validateResearch } from '../../src/visual-validation.js';
import { buildPreviewHtml } from '../../src/preview.js';
import { createFakeR2 } from '../fixtures/fake-r2.js';
import { PostSchema, Post } from '../../schemas/post.js';
import { parseSettings } from '../../schemas/settings.js';
import { IgClient } from '../../src/instagram.js';

/**
 * Regression tests for the defects confirmed in the 2026-07-14 pipeline audit.
 * Each case encodes a scenario that previously produced wrong behavior.
 */

const fixture = JSON.parse(
  readFileSync(path.join(__dirname, '..', 'fixtures', 'sample-post.json'), 'utf8'),
) as Record<string, unknown>;

const settings = parseSettings({}, () => {});

function fakeIg(handlers: Record<string, { status: number; json: unknown }>): IgClient {
  return {
    userId: 'user-1',
    token: 't',
    base: 'https://graph.test/v1',
    http: {
      async get(url: string) {
        for (const [needle, res] of Object.entries(handlers)) {
          if (url.includes(needle)) return res;
        }
        return { status: 200, json: {} };
      },
      async post() {
        return { status: 200, json: {} };
      },
    },
  };
}

describe('timestamp round-trip (queue expiry / dedup window)', () => {
  it('parses its own output for zones with GMT+N offset names', () => {
    for (const zone of ['Europe/Paris', 'Asia/Kolkata', 'America/Toronto', 'utc']) {
      const stamp = nowTimestamp(zone);
      const parsed = parseSheetStamp(stamp, zone);
      expect(parsed, `zone ${zone} stamp "${stamp}"`).not.toBeNull();
      expect(Math.abs(parsed!.diffNow('minutes').minutes)).toBeLessThan(5);
    }
  });

  it('still parses legacy alpha-suffix and GMT+N-suffix stamps', () => {
    expect(parseSheetStamp('2026-07-10 11:00:00 EDT', 'America/Toronto')).not.toBeNull();
    expect(parseSheetStamp('2026-07-10 11:00:00 UTC', 'utc')).not.toBeNull();
    expect(parseSheetStamp('2026-07-10 11:00:00 GMT+5:30', 'Asia/Kolkata')).not.toBeNull();
    expect(parseSheetStamp('garbage', 'utc')).toBeNull();
  });
});

describe('ambiguous-publish verification (double-publish protection)', () => {
  const post = PostSchema.parse(fixture) as Post;

  it('a failed recent-media lookup is inconclusive, not "not published"', async () => {
    const r2 = createFakeR2();
    const ig = fakeIg({ '/media?fields=': { status: 400, json: { error: { code: 4 } } } });
    const outcome = await verifyPublication(r2, ig, post, null);
    expect(outcome.published).toBe(false);
    expect(outcome.inconclusive).toBe(true);
  });

  it('a PUBLISHED parent container proves the post is live', async () => {
    const r2 = createFakeR2();
    const attempt: AttemptRecord = {
      idempotencyKey: post.idempotency_key,
      ideaId: post.idea_id,
      parentContainerId: 'container-9',
      childContainerIds: [],
      stage: 'publish-submitted',
      updatedAt: Date.now(),
    };
    await saveAttemptRecord(r2, attempt);
    const ig = fakeIg({
      'container-9?fields=status_code': { status: 200, json: { status_code: 'PUBLISHED' } },
      '/media?fields=': { status: 200, json: { data: [] } },
    });
    const outcome = await verifyPublication(r2, ig, post, attempt);
    expect(outcome.published).toBe(true);
  });

  it('a caption match that PREDATES the attempt is rejected (wrong-media protection)', async () => {
    const r2 = createFakeR2();
    const attempt: AttemptRecord = {
      idempotencyKey: post.idempotency_key,
      ideaId: post.idea_id,
      parentContainerId: null,
      childContainerIds: [],
      stage: 'publish-submitted',
      updatedAt: Date.now(),
    };
    const oldTimestamp = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    const ig = fakeIg({
      '/media?fields=': {
        status: 200,
        json: {
          data: [{ id: 'old-media', caption: post.caption, timestamp: oldTimestamp }],
        },
      },
    });
    const outcome = await verifyPublication(r2, ig, post, attempt);
    expect(outcome.published).toBe(false);
    expect(outcome.mediaId).toBeNull();
  });
});

describe('lock atomicity (concurrent runs)', () => {
  it('two racing acquires cannot both win', async () => {
    const r2 = createFakeR2();
    // Interleave: both read "no lock", then both write — the second conditional
    // create must fail its precondition and report contention.
    const [a, b] = await Promise.all([
      acquireLock(r2, { runId: 'run-A' }),
      acquireLock(r2, { runId: 'run-B' }),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
  });

  it('heartbeat reports ownership loss after a takeover', async () => {
    const r2 = createFakeR2();
    const a = await acquireLock(r2, { runId: 'run-A', ttlMs: -1 }); // instantly stale
    expect(a).not.toBeNull();
    const b = await acquireLock(r2, { runId: 'run-B' }); // stale recovery
    expect(b).not.toBeNull();
    const stillOwned = await heartbeatLock(r2, a!, { stage: 'render' });
    expect(stillOwned).toBe(false);
    const bOwned = await heartbeatLock(r2, b!, { stage: 'render' });
    expect(bOwned).toBe(true);
  });
});

describe('content-lane inference and source dates', () => {
  const base = PostSchema.parse(fixture) as Post;

  it('a sourced value post (stats need sources) stays in the value lane', () => {
    const post: Post = {
      ...base,
      content_type: undefined,
      why_now: undefined,
      value_promise: 'Scope your agent context so it stops re-reading files it does not need.',
      no_news_reason: 'Searched the last 48h of vendor changelogs; nothing shipped worth covering.',
      sources: [{ url: 'https://docs.example.com', description: 'docs' }],
    };
    expect(resolveContentType(post)).toBe('value');
  });

  it('future-dated sources are an error and never count as fresh', () => {
    const now = DateTime.fromISO('2026-07-14T12:00:00Z', { zone: 'utc' }) as DateTime<true>;
    const post: Post = {
      ...base,
      content_type: 'news',
      why_now: 'A real model release happened this week and changes local inference.',
      sources: [
        { url: 'https://x.test/a', description: 'typo year', published_at: '2027-07-11' },
        { url: 'https://x.test/b', description: 'stale', published_at: '2026-04-01' },
      ],
    };
    expect(freshestSourceAgeDays(post, now)).toBeGreaterThan(30); // future one excluded
    const issues = validateNewsworthiness(post, settings, now);
    expect(issues.some((i) => i.code === 'FUTURE_SOURCE_DATE')).toBe(true);
    expect(issues.some((i) => i.code === 'STALE_STORY')).toBe(true); // no longer masked
  });
});

describe('unsourced-claim scan covers all rendered fields', () => {
  const base = PostSchema.parse(fixture) as Post;

  it('a price hidden in comparison points still requires a source', () => {
    const post: Post = {
      ...base,
      sources: [],
      slides: [
        base.slides[0]!,
        {
          type: 'comparison',
          headline: 'Cursor vs Claude Code',
          optionA: 'Cursor',
          optionB: 'Claude Code',
          pointsA: ['Pro plan $20/mo'],
          pointsB: ['Max plan $200/mo'],
          body: '',
        },
        ...base.slides.slice(1),
      ],
    };
    const report = validateResearch(post);
    expect(report.ok).toBe(false);
    expect(report.issues.some((i) => i.code === 'UNSOURCED_CLAIM')).toBe(true);
  });
});

describe('preview escaping', () => {
  it('tag-like caption text is displayed, not silently deleted', () => {
    const post = PostSchema.parse({
      ...fixture,
      caption: 'Wrap your reasoning in <thinking> tags',
    }) as Post;
    const html = buildPreviewHtml({
      post,
      media: [{ type: 'IMAGE', url: 'https://cdn.test/a.png' }],
      mode: 'TEST',
      label: 'DRAFT',
    });
    expect(html).toContain('Wrap your reasoning in &lt;thinking&gt; tags');
    expect(html).not.toContain('<thinking>');
  });
});
