import { AppConfig } from './config.js';
import { log } from './logger.js';
import { sanitizeError } from './security.js';

/**
 * Official Instagram API (graph.instagram.com) client with Instagram Login.
 * All network calls go through an injectable HttpClient so the publish flow
 * is fully unit-testable without touching the network.
 */

export interface HttpResponse {
  status: number;
  json: unknown;
}

export interface HttpClient {
  get(url: string): Promise<HttpResponse>;
  post(url: string, body: Record<string, string>): Promise<HttpResponse>;
}

/** Default fetch-based HTTP client. */
export const defaultHttp: HttpClient = {
  async get(url: string): Promise<HttpResponse> {
    const res = await fetch(url, { method: 'GET' });
    return { status: res.status, json: await safeJson(res) };
  },
  async post(url: string, body: Record<string, string>): Promise<HttpResponse> {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString(),
    });
    return { status: res.status, json: await safeJson(res) };
  },
};

async function safeJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return {};
  }
}

export interface IgClient {
  http: HttpClient;
  base: string;
  userId: string;
  token: string;
}

export function createIgClient(
  cfg: AppConfig,
  token: string,
  userId: string,
  http: HttpClient = defaultHttp,
): IgClient {
  return {
    http,
    base: `https://graph.instagram.com/${cfg.instagram.graphApiVersion}`,
    userId,
    token,
  };
}

interface IgError {
  error?: { message?: string; type?: string; code?: number; error_subcode?: number };
}

/** Classify whether an error is permanent (do not retry) or temporary. */
export function isPermanentError(status: number, json: unknown): boolean {
  const err = (json as IgError).error;
  // Auth/permission/validation are permanent.
  if (status === 400 || status === 401 || status === 403) {
    // Rate-limit (code 4, 17, 32, 613) is temporary despite 400/403.
    const code = err?.code;
    if (code === 4 || code === 17 || code === 32 || code === 613) return false;
    return true;
  }
  return false;
}

function errMessage(json: unknown): string {
  const err = (json as IgError).error;
  return sanitizeError(err?.message ?? JSON.stringify(json));
}

/** Validate the token belongs to a professional account. Non-publishing. */
export async function validateCredentials(
  ig: IgClient,
): Promise<{ ok: boolean; accountId?: string; username?: string; reason?: string }> {
  const url = `${ig.base}/${ig.userId}?fields=id,username,account_type&access_token=${encodeURIComponent(ig.token)}`;
  const res = await ig.http.get(url);
  if (res.status !== 200) {
    return { ok: false, reason: `credential check status ${res.status}: ${errMessage(res.json)}` };
  }
  const body = res.json as { id?: string; username?: string; account_type?: string };
  if (!body.id) return { ok: false, reason: 'no account id returned' };
  return { ok: true, accountId: body.id, username: body.username };
}

/** Check remaining content-publishing quota. Returns usage/limit if available. */
export async function checkPublishingLimit(
  ig: IgClient,
): Promise<{ quotaUsage: number | null; quotaTotal: number | null }> {
  const url = `${ig.base}/${ig.userId}/content_publishing_limit?fields=quota_usage,config&access_token=${encodeURIComponent(ig.token)}`;
  try {
    const res = await ig.http.get(url);
    if (res.status !== 200) return { quotaUsage: null, quotaTotal: null };
    const data = (
      res.json as { data?: Array<{ quota_usage?: number; config?: { quota_total?: number } }> }
    ).data;
    const first = data?.[0];
    return {
      quotaUsage: first?.quota_usage ?? null,
      quotaTotal: first?.config?.quota_total ?? null,
    };
  } catch {
    return { quotaUsage: null, quotaTotal: null };
  }
}

/** Create one carousel-item child container for a slide image URL. */
export async function createChildContainer(ig: IgClient, imageUrl: string): Promise<string> {
  const url = `${ig.base}/${ig.userId}/media`;
  const res = await ig.http.post(url, {
    image_url: imageUrl,
    is_carousel_item: 'true',
    access_token: ig.token,
  });
  if (res.status !== 200) {
    const permanent = isPermanentError(res.status, res.json);
    throw new IgApiError(
      `create child container failed: ${errMessage(res.json)}`,
      permanent,
      res.status,
    );
  }
  const id = (res.json as { id?: string }).id;
  if (!id) throw new IgApiError('child container returned no id', true, res.status);
  return id;
}

/**
 * Create one carousel-item child container for a slide VIDEO URL. Uses
 * `media_type=VIDEO` (the correct type for carousel children; REELS is for
 * standalone video posts). The container processes asynchronously — poll it to
 * FINISHED before assembling the parent CAROUSEL.
 */
export async function createVideoChildContainer(ig: IgClient, videoUrl: string): Promise<string> {
  const url = `${ig.base}/${ig.userId}/media`;
  const res = await ig.http.post(url, {
    video_url: videoUrl,
    media_type: 'VIDEO',
    is_carousel_item: 'true',
    access_token: ig.token,
  });
  if (res.status !== 200) {
    const permanent = isPermanentError(res.status, res.json);
    throw new IgApiError(
      `create video child container failed: ${errMessage(res.json)}`,
      permanent,
      res.status,
    );
  }
  const id = (res.json as { id?: string }).id;
  if (!id) throw new IgApiError('video child container returned no id', true, res.status);
  return id;
}

/** Create the parent CAROUSEL container with ordered child ids and caption. */
export async function createCarouselContainer(
  ig: IgClient,
  childIds: string[],
  caption: string,
): Promise<string> {
  const url = `${ig.base}/${ig.userId}/media`;
  const res = await ig.http.post(url, {
    media_type: 'CAROUSEL',
    children: childIds.join(','),
    caption,
    access_token: ig.token,
  });
  if (res.status !== 200) {
    const permanent = isPermanentError(res.status, res.json);
    throw new IgApiError(
      `create carousel container failed: ${errMessage(res.json)}`,
      permanent,
      res.status,
    );
  }
  const id = (res.json as { id?: string }).id;
  if (!id) throw new IgApiError('carousel container returned no id', true, res.status);
  return id;
}

export type ContainerStatus =
  'IN_PROGRESS' | 'FINISHED' | 'ERROR' | 'EXPIRED' | 'PUBLISHED' | 'UNKNOWN';

/** Poll a container's status_code. */
export async function getContainerStatus(
  ig: IgClient,
  containerId: string,
): Promise<ContainerStatus> {
  const url = `${ig.base}/${containerId}?fields=status_code,status&access_token=${encodeURIComponent(ig.token)}`;
  const res = await ig.http.get(url);
  if (res.status !== 200) return 'UNKNOWN';
  const code = (res.json as { status_code?: string }).status_code;
  if (
    code === 'FINISHED' ||
    code === 'IN_PROGRESS' ||
    code === 'ERROR' ||
    code === 'EXPIRED' ||
    code === 'PUBLISHED'
  ) {
    return code;
  }
  return 'UNKNOWN';
}

/** Publish a finished parent container. Returns the published media id. */
export async function publishContainer(ig: IgClient, creationId: string): Promise<string> {
  const url = `${ig.base}/${ig.userId}/media_publish`;
  const res = await ig.http.post(url, { creation_id: creationId, access_token: ig.token });
  if (res.status !== 200) {
    const permanent = isPermanentError(res.status, res.json);
    throw new IgApiError(`media_publish failed: ${errMessage(res.json)}`, permanent, res.status);
  }
  const id = (res.json as { id?: string }).id;
  if (!id) throw new IgApiError('media_publish returned no id', false, res.status);
  return id;
}

/** Fetch a published media's permalink + owner for verification. */
export async function getMedia(
  ig: IgClient,
  mediaId: string,
): Promise<{ permalink: string | null; ownerId: string | null; timestamp: string | null }> {
  const url = `${ig.base}/${mediaId}?fields=id,permalink,owner,timestamp&access_token=${encodeURIComponent(ig.token)}`;
  const res = await ig.http.get(url);
  if (res.status !== 200) return { permalink: null, ownerId: null, timestamp: null };
  const body = res.json as { permalink?: string; owner?: { id?: string }; timestamp?: string };
  return {
    permalink: body.permalink ?? null,
    ownerId: body.owner?.id ?? null,
    timestamp: body.timestamp ?? null,
  };
}

/** List recent media ids for the account (used for ambiguous-publish verification). */
export async function listRecentMedia(
  ig: IgClient,
  limit = 10,
): Promise<
  Array<{ id: string; caption: string | null; permalink: string | null; timestamp: string | null }>
> {
  const url = `${ig.base}/${ig.userId}/media?fields=id,caption,permalink,timestamp&limit=${limit}&access_token=${encodeURIComponent(ig.token)}`;
  const res = await ig.http.get(url);
  if (res.status !== 200) return [];
  const data =
    (
      res.json as {
        data?: Array<{ id: string; caption?: string; permalink?: string; timestamp?: string }>;
      }
    ).data ?? [];
  return data.map((m) => ({
    id: m.id,
    caption: m.caption ?? null,
    permalink: m.permalink ?? null,
    timestamp: m.timestamp ?? null,
  }));
}

export class IgApiError extends Error {
  permanent: boolean;
  status: number;
  constructor(message: string, permanent: boolean, status: number) {
    super(message);
    this.name = 'IgApiError';
    this.permanent = permanent;
    this.status = status;
  }
}

export interface PollOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Poll a container until FINISHED (bounded exponential backoff). Throws on
 * ERROR/EXPIRED or when attempts are exhausted (ambiguous → caller decides).
 */
export async function pollUntilReady(
  ig: IgClient,
  containerId: string,
  opts: PollOptions = {},
): Promise<void> {
  const maxAttempts = opts.maxAttempts ?? 12;
  const baseDelay = opts.baseDelayMs ?? 2000;
  const sleep = opts.sleep ?? defaultSleep;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const status = await getContainerStatus(ig, containerId);
    if (status === 'FINISHED' || status === 'PUBLISHED') {
      log.debug('container ready', { containerId, attempt });
      return;
    }
    if (status === 'ERROR' || status === 'EXPIRED') {
      throw new IgApiError(`container ${containerId} entered ${status}`, true, 0);
    }
    const delay = Math.min(baseDelay * 2 ** attempt, 30000);
    await sleep(delay);
  }
  throw new IgApiError(
    `container ${containerId} not ready after ${maxAttempts} attempts`,
    false,
    0,
  );
}
