import { describe, it, expect } from 'vitest';
import {
  computeIdempotencyKey,
  saveIdempotencyRecord,
  getIdempotencyRecord,
  verifyPublication,
} from '../../src/recovery.js';
import { createFakeR2 } from '../fixtures/fake-r2.js';
import { createIgClient, HttpClient } from '../../src/instagram.js';
import { AppConfig } from '../../src/config.js';
import { PostSchema } from '../../schemas/post.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const post = PostSchema.parse(
  JSON.parse(readFileSync(path.join(__dirname, '..', 'fixtures', 'sample-post.json'), 'utf8')),
);

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

describe('idempotency', () => {
  it('key is stable for the same idea + manifest', () => {
    const a = computeIdempotencyKey('idea1', ['u1', 'u2']);
    const b = computeIdempotencyKey('idea1', ['u1', 'u2']);
    const c = computeIdempotencyKey('idea1', ['u1', 'u3']);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('round-trips an idempotency record', async () => {
    const r2 = createFakeR2();
    await saveIdempotencyRecord(r2, {
      idempotencyKey: 'k1',
      ideaId: 'i',
      mediaId: 'm',
      permalink: 'p',
      publishedAt: 1,
    });
    const rec = await getIdempotencyRecord(r2, 'k1');
    expect(rec?.mediaId).toBe('m');
  });
});

describe('ambiguous publish recovery', () => {
  it('returns published=true when idempotency record exists', async () => {
    const r2 = createFakeR2();
    await saveIdempotencyRecord(r2, {
      idempotencyKey: post.idempotency_key,
      ideaId: post.idea_id,
      mediaId: 'm9',
      permalink: 'p9',
      publishedAt: 1,
    });
    const ig = createIgClient(cfg(), 'tok', '123', {
      get: async () => ({ status: 200, json: {} }),
      post: async () => ({ status: 200, json: {} }),
    });
    const res = await verifyPublication(r2, ig, post, null);
    expect(res.published).toBe(true);
    expect(res.mediaId).toBe('m9');
  });

  it('matches recent media by caption fingerprint', async () => {
    const r2 = createFakeR2();
    const firstLine = post.caption.split('\n')[0];
    const http: HttpClient = {
      async get(url) {
        if (url.includes('/media?fields=')) {
          return {
            status: 200,
            json: {
              data: [{ id: 'mX', caption: firstLine + '\nmore', permalink: 'https://ig/pX' }],
            },
          };
        }
        if (url.includes('/mX?fields=')) {
          return { status: 200, json: { owner: { id: '123' }, permalink: 'https://ig/pX' } };
        }
        return { status: 200, json: {} };
      },
      async post() {
        return { status: 200, json: {} };
      },
    };
    const ig = createIgClient(cfg(), 'tok', '123', http);
    const res = await verifyPublication(r2, ig, post, null);
    expect(res.published).toBe(true);
    expect(res.mediaId).toBe('mX');
  });

  it('returns published=false when nothing matches', async () => {
    const r2 = createFakeR2();
    const ig = createIgClient(cfg(), 'tok', '123', {
      get: async () => ({ status: 200, json: { data: [] } }),
      post: async () => ({ status: 200, json: {} }),
    });
    const res = await verifyPublication(r2, ig, post, null);
    expect(res.published).toBe(false);
  });
});
