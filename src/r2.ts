import {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { AppConfig } from './config.js';
import { log } from './logger.js';

/**
 * Cloudflare R2 (S3-compatible) storage. Public bucket holds delivered media
 * and previews; private bucket holds locks, idempotency, encrypted token
 * state and recovery metadata. Private state MUST never enter the public bucket.
 */

export interface R2 {
  client: S3Client;
  publicBucket: string;
  privateBucket: string;
  publicBaseUrl: string;
}

export function createR2(cfg: AppConfig): R2 {
  const client = new S3Client({
    region: 'auto',
    endpoint: cfg.r2.endpoint,
    credentials: {
      accessKeyId: cfg.r2.accessKeyId,
      secretAccessKey: cfg.r2.secretAccessKey,
    },
    forcePathStyle: true,
  });
  return {
    client,
    publicBucket: cfg.r2.publicBucket,
    privateBucket: cfg.r2.privateBucket,
    publicBaseUrl: cfg.r2.publicBaseUrl,
  };
}

async function streamToBuffer(body: unknown): Promise<Buffer> {
  const stream = body as AsyncIterable<Uint8Array>;
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks.map((c) => Buffer.from(c)));
}

export interface PutOptions {
  contentType: string;
  cacheControl?: string;
}

/** Put an object (bytes) into the PUBLIC bucket. */
export async function putPublic(
  r2: R2,
  key: string,
  body: Buffer | string,
  opts: PutOptions,
): Promise<string> {
  await r2.client.send(
    new PutObjectCommand({
      Bucket: r2.publicBucket,
      Key: key,
      Body: body,
      ContentType: opts.contentType,
      CacheControl: opts.cacheControl ?? 'public, max-age=31536000, immutable',
    }),
  );
  return publicUrl(r2, key);
}

/**
 * Conditional-write options for private puts. R2 supports the S3 conditional
 * headers: `ifNoneMatch: '*'` creates only when the key is absent; `ifMatch`
 * replaces only when the stored ETag still matches. A failed precondition
 * rejects with a 412 (see isPreconditionFailed) — the basis for atomic
 * lock acquisition/heartbeat.
 */
export interface PutCondition {
  ifMatch?: string;
  ifNoneMatch?: '*';
}

/** Put an object into the PRIVATE bucket. Never public-cached. */
export async function putPrivate(
  r2: R2,
  key: string,
  body: Buffer | string,
  contentType = 'application/json',
  cond?: PutCondition,
): Promise<void> {
  await r2.client.send(
    new PutObjectCommand({
      Bucket: r2.privateBucket,
      Key: key,
      Body: body,
      ContentType: contentType,
      CacheControl: 'no-store, private',
      IfMatch: cond?.ifMatch,
      IfNoneMatch: cond?.ifNoneMatch,
    }),
  );
}

/** Public URL for a public-bucket key. */
export function publicUrl(r2: R2, key: string): string {
  return `${r2.publicBaseUrl}/${key.replace(/^\/+/, '')}`;
}

/** HEAD a public object; returns metadata or null when absent. */
export async function headPublic(
  r2: R2,
  key: string,
): Promise<{ contentType?: string; contentLength?: number } | null> {
  try {
    const res = await r2.client.send(new HeadObjectCommand({ Bucket: r2.publicBucket, Key: key }));
    return { contentType: res.ContentType, contentLength: res.ContentLength };
  } catch {
    return null;
  }
}

/** Read a private JSON object, or null when missing. */
export async function getPrivateJson<T>(r2: R2, key: string): Promise<T | null> {
  try {
    const res = await r2.client.send(new GetObjectCommand({ Bucket: r2.privateBucket, Key: key }));
    const buf = await streamToBuffer(res.Body);
    return JSON.parse(buf.toString('utf8')) as T;
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

/** Write a private JSON object (optionally conditional — see PutCondition). */
export async function putPrivateJson(
  r2: R2,
  key: string,
  value: unknown,
  cond?: PutCondition,
): Promise<void> {
  await putPrivate(r2, key, JSON.stringify(value, null, 2), 'application/json', cond);
}

/** Read a private JSON object together with its ETag (for conditional writes). */
export async function getPrivateJsonWithEtag<T>(
  r2: R2,
  key: string,
): Promise<{ value: T; etag: string | null } | null> {
  try {
    const res = await r2.client.send(new GetObjectCommand({ Bucket: r2.privateBucket, Key: key }));
    const buf = await streamToBuffer(res.Body);
    return { value: JSON.parse(buf.toString('utf8')) as T, etag: res.ETag ?? null };
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

/** True when a conditional put was rejected (ETag mismatch / key exists). */
export function isPreconditionFailed(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return (
    e?.name === 'PreconditionFailed' ||
    e?.$metadata?.httpStatusCode === 412 ||
    // S3 returns 409 ConditionalRequestConflict for concurrent conditional writes.
    e?.$metadata?.httpStatusCode === 409
  );
}

/** Delete a private object (used for lock release). */
export async function deletePrivate(r2: R2, key: string): Promise<void> {
  await r2.client.send(new DeleteObjectCommand({ Bucket: r2.privateBucket, Key: key }));
}

/** List private object keys under a prefix. */
export async function listPrivate(r2: R2, prefix: string): Promise<string[]> {
  const res = await r2.client.send(
    new ListObjectsV2Command({ Bucket: r2.privateBucket, Prefix: prefix }),
  );
  return (res.Contents ?? []).map((o) => o.Key ?? '').filter(Boolean);
}

export function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === 'NoSuchKey' || e?.name === 'NotFound' || e?.$metadata?.httpStatusCode === 404;
}

/**
 * Verify a public URL is reachable without authentication and returns 200.
 * Uses a real HTTP GET/HEAD against the public base URL.
 */
export async function verifyPublicUrl(url: string): Promise<{
  ok: boolean;
  status: number;
  contentType: string | null;
  contentLength: number | null;
}> {
  let status = 0;
  let contentType: string | null = null;
  let contentLength: number | null = null;
  try {
    const res = await fetch(url, { method: 'GET' });
    status = res.status;
    contentType = res.headers.get('content-type');
    const len = res.headers.get('content-length');
    contentLength = len ? Number(len) : null;
    // Drain body to release the connection.
    await res.arrayBuffer();
  } catch (err) {
    log.warn('public URL verification threw', { url });
    void err;
  }
  return { ok: status === 200, status, contentType, contentLength };
}
