import { describe, it, expect } from 'vitest';
import {
  createIgClient,
  isPermanentError,
  validateCredentials,
  createChildContainer,
  createCarouselContainer,
  publishContainer,
  pollUntilReady,
  getMedia,
  HttpClient,
  HttpResponse,
  IgApiError,
} from '../../src/instagram.js';
import { AppConfig } from '../../src/config.js';

function cfg(): AppConfig {
  return {
    googleSheetId: 's',
    googleServiceAccountB64: 'b',
    r2: {
      accountId: 'a',
      accessKeyId: 'k',
      secretAccessKey: 's',
      publicBucket: 'p',
      privateBucket: 'pr',
      endpoint: 'e',
      publicBaseUrl: 'u',
    },
    instagram: { accessToken: 'tok', userId: '123', graphApiVersion: 'v21.0' },
    tokenEncryptionKey: 'k'.repeat(64),
    timezone: 'America/Toronto',
    nodeEnv: 'test',
    missingCore: [],
    missingInstagram: [],
  };
}

/** Scripted HTTP client returning queued responses per URL substring. */
function scripted(
  routes: Array<{ match: string; res: HttpResponse; method?: 'get' | 'post' }>,
): HttpClient {
  const pick = (url: string, method: 'get' | 'post'): HttpResponse => {
    const r = routes.find((x) => url.includes(x.match) && (x.method ?? method) === method);
    if (!r) return { status: 500, json: { error: { message: 'no route' } } };
    return r.res;
  };
  return {
    async get(url) {
      return pick(url, 'get');
    },
    async post(url) {
      return pick(url, 'post');
    },
  };
}

describe('instagram error classification', () => {
  it('treats 400/401/403 as permanent, except rate limits', () => {
    expect(isPermanentError(400, { error: { code: 100 } })).toBe(true);
    expect(isPermanentError(401, {})).toBe(true);
    expect(isPermanentError(403, { error: { code: 4 } })).toBe(false); // rate limit
    expect(isPermanentError(500, {})).toBe(false);
  });
});

describe('instagram publish primitives', () => {
  it('validates credentials from /{userId}', async () => {
    const ig = createIgClient(
      cfg(),
      'tok',
      '123',
      scripted([
        { match: '/123?fields=id', res: { status: 200, json: { id: '123', username: 'brand' } } },
      ]),
    );
    const res = await validateCredentials(ig);
    expect(res.ok).toBe(true);
    expect(res.username).toBe('brand');
  });

  it('creates a child container', async () => {
    const ig = createIgClient(
      cfg(),
      'tok',
      '123',
      scripted([
        { match: '/123/media', method: 'post', res: { status: 200, json: { id: 'child-1' } } },
      ]),
    );
    expect(await createChildContainer(ig, 'https://cdn/s.png')).toBe('child-1');
  });

  it('throws permanent error on 400 child creation', async () => {
    const ig = createIgClient(
      cfg(),
      'tok',
      '123',
      scripted([
        {
          match: '/123/media',
          method: 'post',
          res: { status: 400, json: { error: { message: 'bad url', code: 100 } } },
        },
      ]),
    );
    await expect(createChildContainer(ig, 'x')).rejects.toBeInstanceOf(IgApiError);
    await expect(createChildContainer(ig, 'x')).rejects.toMatchObject({ permanent: true });
  });

  it('creates a carousel parent and publishes', async () => {
    const ig = createIgClient(
      cfg(),
      'tok',
      '123',
      scripted([
        {
          match: '/123/media_publish',
          method: 'post',
          res: { status: 200, json: { id: 'media-1' } },
        },
        { match: '/123/media', method: 'post', res: { status: 200, json: { id: 'parent-1' } } },
      ]),
    );
    const parent = await createCarouselContainer(ig, ['c1', 'c2'], 'cap');
    expect(parent).toBe('parent-1');
    expect(await publishContainer(ig, parent)).toBe('media-1');
  });

  it('polls until FINISHED', async () => {
    let calls = 0;
    const http: HttpClient = {
      async get() {
        calls++;
        return { status: 200, json: { status_code: calls >= 2 ? 'FINISHED' : 'IN_PROGRESS' } };
      },
      async post() {
        return { status: 200, json: {} };
      },
    };
    const ig = createIgClient(cfg(), 'tok', '123', http);
    await pollUntilReady(ig, 'parent-1', { baseDelayMs: 1, sleep: async () => {} });
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it('throws on ERROR status while polling', async () => {
    const ig = createIgClient(
      cfg(),
      'tok',
      '123',
      scripted([
        { match: '?fields=status_code', res: { status: 200, json: { status_code: 'ERROR' } } },
      ]),
    );
    await expect(pollUntilReady(ig, 'p', { sleep: async () => {} })).rejects.toBeInstanceOf(
      IgApiError,
    );
  });

  it('reads media permalink + owner', async () => {
    const ig = createIgClient(
      cfg(),
      'tok',
      '123',
      scripted([
        {
          match: '/media-1?fields=id',
          res: {
            status: 200,
            json: { permalink: 'https://instagram.com/p/x', owner: { id: '123' } },
          },
        },
      ]),
    );
    const m = await getMedia(ig, 'media-1');
    expect(m.permalink).toContain('instagram.com');
    expect(m.ownerId).toBe('123');
  });
});
