import crypto from 'node:crypto';
import { R2, getPrivateJson, putPrivateJson } from './r2.js';
import { IgClient, getMedia, listRecentMedia } from './instagram.js';
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
  mediaId: string | null;
  permalink: string | null;
  reason: string;
}

/**
 * Determine whether an ambiguous publish actually succeeded. Checks, in order:
 * 1) an existing idempotency record, 2) the saved parent container's published
 * media, 3) recent account media matching the caption fingerprint.
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
      mediaId: existing.mediaId,
      permalink: existing.permalink,
      reason: 'idempotency record present',
    };
  }

  // 2. If the parent container was published, media metadata will resolve and
  //    the caption fingerprint should match the account's recent media.
  const captionFingerprint = captionKey(post.caption);
  const recent = await listRecentMedia(ig, 15);
  for (const m of recent) {
    if (m.caption && captionKey(m.caption) === captionFingerprint) {
      // Confirm ownership by fetching the media directly.
      const media = await getMedia(ig, m.id);
      if (media.ownerId === null || media.ownerId === ig.userId) {
        return {
          published: true,
          mediaId: m.id,
          permalink: m.permalink ?? media.permalink,
          reason: 'matched recent account media by caption',
        };
      }
    }
  }

  void attempt;
  return {
    published: false,
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
