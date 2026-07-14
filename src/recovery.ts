import crypto from 'node:crypto';
import { R2, getPrivateJson, putPrivateJson } from './r2.js';
import { IgClient, getMedia, getContainerStatus, listRecentMedia } from './instagram.js';
import { Post } from '../schemas/post.js';
import { log } from './logger.js';

/**
 * Idempotency, publication-attempt records, and ambiguous-publish recovery.
 * The private R2 bucket is the durable source of truth for "did we publish?".
 */

/** Stable idempotency key from idea id + ordered asset manifest. */
export function computeIdempotencyKey(ideaId: string, slideUrls: string[]): string {
  const manifest = slideUrls.join('|');
  const hash = crypto
    .createHash('sha256')
    .update(`${ideaId}::${manifest}`)
    .digest('hex')
    .slice(0, 24);
  return `${ideaId}:${hash}`;
}

export interface IdempotencyRecord {
  idempotencyKey: string;
  ideaId: string;
  mediaId: string;
  permalink: string | null;
  publishedAt: number;
}

export interface AttemptRecord {
  idempotencyKey: string;
  ideaId: string;
  parentContainerId: string | null;
  childContainerIds: string[];
  stage: 'containers-created' | 'parent-created' | 'publish-submitted' | 'published' | 'failed';
  updatedAt: number;
  note?: string;
}

const idemKey = (key: string): string => `idempotency/${encodeURIComponent(key)}.json`;
const attemptKey = (key: string): string => `attempts/${encodeURIComponent(key)}.json`;

export async function getIdempotencyRecord(r2: R2, key: string): Promise<IdempotencyRecord | null> {
  return getPrivateJson<IdempotencyRecord>(r2, idemKey(key));
}

export async function saveIdempotencyRecord(r2: R2, record: IdempotencyRecord): Promise<void> {
  await putPrivateJson(r2, idemKey(record.idempotencyKey), record);
  log.info('saved idempotency record', { key: record.idempotencyKey, mediaId: record.mediaId });
}

export async function getAttemptRecord(r2: R2, key: string): Promise<AttemptRecord | null> {
  return getPrivateJson<AttemptRecord>(r2, attemptKey(key));
}

export async function saveAttemptRecord(r2: R2, record: AttemptRecord): Promise<void> {
  await putPrivateJson(r2, attemptKey(record.idempotencyKey), { ...record, updatedAt: Date.now() });
}

export interface VerificationOutcome {
  published: boolean;
  /**
   * True when verification could not run to completion (API failure, unknown
   * container status). An inconclusive outcome must keep the row
   * VERIFY_REQUIRED — treating it as "not published" invites a double publish.
   */
  inconclusive: boolean;
  mediaId: string | null;
  permalink: string | null;
  reason: string;
}

/**
 * Determine whether an ambiguous publish actually succeeded. Checks, in order:
 * 1) an existing idempotency record, 2) the saved parent container's status
 * (PUBLISHED is definitive proof), 3) recent account media matching the
 * caption fingerprint — bounded in time so an older post with a reused first
 * line can never masquerade as this publication. Any check that cannot run
 * makes the outcome inconclusive rather than "not published".
 */
export async function verifyPublication(
  r2: R2,
  ig: IgClient,
  post: Post,
  attempt: AttemptRecord | null,
): Promise<VerificationOutcome> {
  // 1. Idempotency record already proves success.
  const existing = await getIdempotencyRecord(r2, post.idempotency_key);
  if (existing) {
    return {
      published: true,
      inconclusive: false,
      mediaId: existing.mediaId,
      permalink: existing.permalink,
      reason: 'idempotency record present',
    };
  }

  // 2. The saved parent container is the strongest evidence we hold: a
  //    PUBLISHED status means the post IS live even when we don't yet know the
  //    media id; the caption scan below then tries to resolve it.
  let containerPublished = false;
  let containerUnknown = false;
  if (attempt?.parentContainerId) {
    const status = await getContainerStatus(ig, attempt.parentContainerId);
    if (status === 'PUBLISHED') containerPublished = true;
    else if (status === 'UNKNOWN') containerUnknown = true;
  }

  // 3. Caption-fingerprint scan of recent media, accepting only media created
  //    around/after the publish attempt (6h clock-skew allowance) so a
  //    months-old post with the same first line is never matched.
  const captionFingerprint = captionKey(post.caption);
  const attemptTime = attempt?.updatedAt ?? Date.parse(post.generated_at) ?? null;
  const earliest =
    attemptTime && Number.isFinite(attemptTime) ? attemptTime - 6 * 60 * 60 * 1000 : null;
  const recent = await listRecentMedia(ig, 15);
  if (recent === null) {
    return {
      published: containerPublished,
      inconclusive: true,
      mediaId: null,
      permalink: null,
      reason: containerPublished
        ? 'parent container PUBLISHED but recent-media lookup failed; media id unresolved'
        : 'recent-media lookup failed; cannot verify — keeping VERIFY_REQUIRED',
    };
  }
  for (const m of recent) {
    if (!m.caption || captionKey(m.caption) !== captionFingerprint) continue;
    if (earliest !== null && m.timestamp) {
      const ts = Date.parse(m.timestamp);
      if (Number.isFinite(ts) && ts < earliest) continue; // predates the attempt
    }
    // Confirm ownership by fetching the media directly.
    const media = await getMedia(ig, m.id);
    if (media.ownerId === null || media.ownerId === ig.userId) {
      return {
        published: true,
        inconclusive: false,
        mediaId: m.id,
        permalink: m.permalink ?? media.permalink,
        reason: 'matched recent account media by caption',
      };
    }
  }

  if (containerPublished) {
    // Definitively live, but the media id could not be resolved this run.
    return {
      published: true,
      inconclusive: true,
      mediaId: null,
      permalink: null,
      reason: 'parent container PUBLISHED; media id not yet resolved',
    };
  }
  if (containerUnknown) {
    return {
      published: false,
      inconclusive: true,
      mediaId: null,
      permalink: null,
      reason: 'parent container status unavailable; cannot verify — keeping VERIFY_REQUIRED',
    };
  }
  return {
    published: false,
    inconclusive: false,
    mediaId: null,
    permalink: null,
    reason: 'no matching published media found',
  };
}

/** Normalize a caption to a comparable fingerprint (first line + length). */
function captionKey(caption: string): string {
  const firstLine = caption.split('\n')[0]?.trim().toLowerCase().replace(/\s+/g, ' ') ?? '';
  return crypto.createHash('sha256').update(firstLine).digest('hex').slice(0, 16);
}
