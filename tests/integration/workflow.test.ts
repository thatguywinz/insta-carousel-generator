import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * End-to-end workflow integration test. Google Sheets and Chromium rendering
 * are mocked; R2 uses an in-memory fake; Instagram uses a scripted HTTP client.
 * Everything else (locks, idempotency, tracker logic, validation) runs for real.
 * All shared state lives in vi.hoisted so the hoisted vi.mock factories can use
 * it without touching module imports.
 */
const H = vi.hoisted(() => {
  // In-memory S3-compatible fake R2.
  const store = new Map<string, { body: Buffer; contentType?: string }>();
  const objKey = (bucket: string, key: string): string => `${bucket}//${key}`;
  const client = {
    async send(command: { constructor: { name: string }; input: Record<string, unknown> }) {
      const name = command.constructor.name;
      const input = command.input;
      const bucket = input.Bucket as string;
      const key = input.Key as string | undefined;
      if (name === 'PutObjectCommand') {
        const raw = input.Body as Buffer | string;
        store.set(objKey(bucket, key!), {
          body: Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw)),
          contentType: input.ContentType as string,
        });
        return {};
      }
      if (name === 'HeadObjectCommand') {
        const obj = store.get(objKey(bucket, key!));
        if (!obj) {
          const e = new Error('NotFound') as Error & {
            name: string;
            $metadata: { httpStatusCode: number };
          };
          e.name = 'NotFound';
          e.$metadata = { httpStatusCode: 404 };
          throw e;
        }
        return { ContentType: obj.contentType, ContentLength: obj.body.length };
      }
      if (name === 'GetObjectCommand') {
        const obj = store.get(objKey(bucket, key!));
        if (!obj) {
          const e = new Error('NoSuchKey') as Error & {
            name: string;
            $metadata: { httpStatusCode: number };
          };
          e.name = 'NoSuchKey';
          e.$metadata = { httpStatusCode: 404 };
          throw e;
        }
        async function* gen() {
          yield new Uint8Array(obj!.body);
        }
        return { Body: gen() };
      }
      if (name === 'DeleteObjectCommand') {
        store.delete(objKey(bucket, key!));
        return {};
      }
      if (name === 'ListObjectsV2Command') {
        const prefix = (input.Prefix as string) ?? '';
        return {
          Contents: [...store.keys()]
            .filter((k) => k.startsWith(`${bucket}//`))
            .map((k) => k.slice(`${bucket}//`.length))
            .filter((k) => k.startsWith(prefix))
            .map((k) => ({ Key: k })),
        };
      }
      throw new Error(`fake R2: unhandled command ${name}`);
    },
  };
  const fakeR2 = {
    client: client as unknown,
    publicBucket: 'public-test',
    privateBucket: 'private-test',
    publicBaseUrl: 'https://cdn.test',
    store,
  };
  const grid = {
    tabs: ['Instructions', 'Settings', 'Content'],
    settings: [] as string[][],
    header: [] as string[],
    data: [] as string[][],
  };
  // When true, the render mock attaches a fake MP4 to slide 1 (motion).
  const flags = { motion: false };
  return { fakeR2, grid, store, flags };
});

const fakeR2 = H.fakeR2;
const grid = H.grid;
const flags = H.flags;

vi.mock('../../src/google-sheets.js', () => {
  return {
    createSheetsClient: async () => ({ api: {}, spreadsheetId: 'test' }),
    decodeServiceAccount: () => ({
      client_email: 'x@y.iam.gserviceaccount.com',
      private_key: 'BEGIN',
      project_id: 'p',
      private_key_id: 'k',
      type: 'service_account',
    }),
    listTabs: async () => H.grid.tabs,
    readRange: async (_c: unknown, range: string) => {
      if (range === 'Settings!A:B') return H.grid.settings;
      if (range.startsWith('Content!A1:') && range.endsWith('1')) return [H.grid.header];
      if (range.startsWith('Content!A2:')) return H.grid.data;
      return [];
    },
    updateRange: async () => {},
    appendRows: async (_c: unknown, _r: string, values: string[][]) => {
      for (const v of values) H.grid.data.push(v);
    },
    batchUpdate: async (_c: unknown, data: Array<{ range: string; values: string[][] }>) => {
      for (const u of data) {
        const m = u.range.match(/Content!([A-Z]+)(\d+)/);
        if (!m) continue;
        let col = 0;
        for (const ch of m[1]!) col = col * 26 + (ch.charCodeAt(0) - 64);
        col -= 1;
        const rowIdx = Number(m[2]) - 2;
        while (H.grid.data.length <= rowIdx) H.grid.data.push([]);
        const row = H.grid.data[rowIdx]!;
        while (row.length <= col) row.push('');
        row[col] = String(u.values[0]![0]);
      }
    },
  };
});

vi.mock('../../src/r2.js', async (importActual) => {
  const actual = await importActual<typeof import('../../src/r2.js')>();
  return {
    ...actual,
    createR2: () => H.fakeR2,
    verifyPublicUrl: async (url: string) => ({
      ok: true,
      status: 200,
      contentType: url.endsWith('.mp4') ? 'video/mp4' : 'image/png',
      contentLength: 12345,
    }),
    headPublic: async (_r: unknown, key: string) => ({
      contentType: key.endsWith('.mp4') ? 'video/mp4' : 'image/png',
      contentLength: 12345,
    }),
  };
});

vi.mock('../../src/render.js', async (importActual) => {
  const actual = await importActual<typeof import('../../src/render.js')>();
  const sharpMod = (await import('sharp')).default;
  const W = 1080;
  const Hh = 1350;
  const goodMetrics = {
    scrollWidth: W,
    scrollHeight: Hh,
    hasOverflow: false,
    minFontPx: 38,
    overflowingSelectors: [],
    hasHeadline: true,
    hasHandle: true,
    hasPageNumber: true,
  };
  return {
    ...actual,
    renderPost: async (post: { slides: unknown[] }) => {
      const out = [];
      for (let i = 0; i < post.slides.length; i++) {
        const png = await sharpMod({
          create: {
            width: W,
            height: Hh,
            channels: 3,
            background: { r: 20 + i * 10, g: 120, b: 200 },
          },
        })
          .composite([
            {
              input: await sharpMod({
                create: {
                  width: 400,
                  height: 400,
                  channels: 3,
                  background: { r: 240, g: 230, b: 10 },
                },
              })
                .png()
                .toBuffer(),
              top: 10,
              left: 10 + i,
            },
          ])
          .png()
          .toBuffer();
        const slide: Record<string, unknown> = {
          index: i + 1,
          type: 'cover',
          png,
          width: W,
          height: Hh,
          metrics: goodMetrics,
        };
        // Motion: attach a structurally-valid fake MP4 to slide 1.
        if (H.flags.motion && i === 0) {
          slide.mp4 = Buffer.concat([
            Buffer.from([0, 0, 0, 0x18]),
            Buffer.from('ftyp'),
            Buffer.alloc(4000),
          ]);
        }
        out.push(slide);
      }
      return out;
    },
  };
});

const { runWorkflow } = await import('../../src/workflow.js');

const fixturePost = JSON.parse(
  readFileSync(path.join(__dirname, '..', 'fixtures', 'sample-post.json'), 'utf8'),
);

function cfg(mode: 'TEST' | 'LIVE'): import('../../src/config.js').AppConfig {
  return {
    googleSheetId: 's',
    googleServiceAccountB64: Buffer.from(
      JSON.stringify({
        type: 'service_account',
        project_id: 'p',
        private_key_id: 'k',
        private_key: '-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----',
        client_email: 'x@y.iam.gserviceaccount.com',
      }),
    ).toString('base64'),
    r2: {
      accountId: 'a',
      accessKeyId: 'k',
      secretAccessKey: 's',
      publicBucket: 'public-test',
      privateBucket: 'private-test',
      endpoint: 'https://e',
      publicBaseUrl: 'https://cdn.test',
    },
    instagram: {
      accessToken: mode === 'LIVE' ? 'tok' : undefined,
      userId: mode === 'LIVE' ? '123' : undefined,
      graphApiVersion: 'v21.0',
    },
    tokenEncryptionKey: 'k'.repeat(64),
    timezone: 'America/Toronto',
    nodeEnv: 'test',
    missingCore: [],
    missingInstagram: mode === 'LIVE' ? [] : ['INSTAGRAM_USER_ID'],
  };
}

const HEADERS = [
  'idea_id',
  'idea',
  'priority',
  'source',
  'status',
  'added_at',
  'selected_at',
  'hook',
  'content_pillar',
  'template',
  'slide_count',
  'caption',
  'preview_url',
  'published_at',
  'instagram_media_id',
  'permalink',
  'error',
];

beforeEach(() => {
  grid.settings = [];
  grid.header = [...HEADERS];
  grid.data = [];
  fakeR2.store.clear();
  flags.motion = false;
});

function setSettings(mode: string, extra: Record<string, string> = {}): void {
  grid.settings = Object.entries({
    MODE: mode,
    NICHE: 'freelancing',
    MIN_SLIDES: '6',
    MAX_SLIDES: '8',
    BRAND_NAME: 'Test',
    INSTAGRAM_HANDLE: '@test',
    ...extra,
  }).map(([k, v]) => [k, v]);
}

describe('workflow TEST mode', () => {
  it('selects an UNUSED idea and produces a DRAFT_READY draft', async () => {
    setSettings('TEST');
    grid.data = [
      [
        '',
        'How to price freelance work',
        'High',
        'Manual',
        'UNUSED',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
      ],
    ];

    const result = await runWorkflow({
      cfg: cfg('TEST'),
      providers: {
        authorPost: async (ctx) => ({ ...fixturePost, idea_id: ctx.ideaId }),
        inspectVisuals: async () => ({ approved: true, notes: 'looks good' }),
      },
    });

    expect(result.status).toBe('DRAFT_READY');
    expect(result.mode).toBe('TEST');
    expect(result.previewUrl).toContain('previews/');
    expect(result.slideCount).toBe(fixturePost.slides.length);
    expect(result.lockReleased).toBe(true);
    // No Instagram media in TEST mode.
    expect(result.mediaId).toBeNull();
    // Row marked DRAFT_READY.
    const statusCol = HEADERS.indexOf('status');
    expect(grid.data[0]![statusCol]).toBe('DRAFT_READY');
  });

  it('fails safely (no crash) when visual inspection rejects', async () => {
    setSettings('TEST');
    grid.data = [
      ['', 'Idea B', 'Medium', 'Manual', 'UNUSED', '', '', '', '', '', '', '', '', '', '', '', ''],
    ];
    const result = await runWorkflow({
      cfg: cfg('TEST'),
      providers: {
        authorPost: async (ctx) => ({ ...fixturePost, idea_id: ctx.ideaId }),
        inspectVisuals: async () => ({ approved: false, notes: 'text clipped on slide 3' }),
      },
    });
    expect(result.status).toBe('FAILED');
    expect(result.lockReleased).toBe(true);
    const statusCol = HEADERS.indexOf('status');
    expect(grid.data[0]![statusCol]).toBe('FAILED');
  });

  it('does nothing when queue empty and AUTO_GENERATE_WHEN_EMPTY is false', async () => {
    setSettings('TEST', { AUTO_GENERATE_WHEN_EMPTY: 'FALSE' });
    grid.data = [];
    const result = await runWorkflow({
      cfg: cfg('TEST'),
      providers: { authorPost: async (ctx) => ({ ...fixturePost, idea_id: ctx.ideaId }) },
    });
    expect(result.status).toBe('NO_WORK');
  });
});

describe('workflow LIVE mode', () => {
  it('publishes a carousel end-to-end and marks POSTED', async () => {
    setSettings('LIVE', { PUBLISH_EXISTING_DRAFT_FIRST: 'FALSE' });
    grid.data = [
      [
        '',
        'Freelance pricing tips',
        'High',
        'Manual',
        'UNUSED',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
      ],
    ];

    let childCount = 0;
    const http = {
      async get(url: string) {
        if (url.includes('?fields=id,username'))
          return { status: 200, json: { id: '123', username: 'test' } };
        if (url.includes('content_publishing_limit'))
          return { status: 200, json: { data: [{ quota_usage: 1, config: { quota_total: 50 } }] } };
        if (url.includes('?fields=status_code'))
          return { status: 200, json: { status_code: 'FINISHED' } };
        if (url.match(/\/\d+_?\d*\?fields=id,permalink/) || url.includes('permalink'))
          return {
            status: 200,
            json: { permalink: 'https://instagram.com/p/abc', owner: { id: '123' } },
          };
        return { status: 200, json: {} };
      },
      async post(url: string) {
        if (url.includes('/media_publish')) return { status: 200, json: { id: 'media-final-1' } };
        if (url.includes('/media')) {
          childCount++;
          return { status: 200, json: { id: `container-${childCount}` } };
        }
        return { status: 200, json: {} };
      },
    };

    const result = await runWorkflow({
      cfg: cfg('LIVE'),
      http,
      providers: {
        authorPost: async (ctx) => ({ ...fixturePost, idea_id: ctx.ideaId }),
        inspectVisuals: async () => ({ approved: true, notes: 'ok' }),
      },
    });

    expect(result.status).toBe('POSTED');
    expect(result.mediaId).toBe('media-final-1');
    expect(result.permalink).toContain('instagram.com');
    expect(result.lockReleased).toBe(true);
    const statusCol = HEADERS.indexOf('status');
    expect(grid.data[0]![statusCol]).toBe('POSTED');
  });

  it('publishes a MOTION carousel: video child + slideMedia manifest', async () => {
    setSettings('LIVE', { PUBLISH_EXISTING_DRAFT_FIRST: 'FALSE', MOTION_SLIDES: 'cover' });
    flags.motion = true;
    grid.data = [
      [
        '',
        'Claude just shipped subagents',
        'High',
        'Manual',
        'UNUSED',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
      ],
    ];

    let childCount = 0;
    let videoChildren = 0;
    const http = {
      async get(url: string) {
        if (url.includes('?fields=id,username'))
          return { status: 200, json: { id: '123', username: 'test' } };
        if (url.includes('content_publishing_limit'))
          return { status: 200, json: { data: [{ quota_usage: 1, config: { quota_total: 50 } }] } };
        if (url.includes('?fields=status_code'))
          return { status: 200, json: { status_code: 'FINISHED' } };
        if (url.match(/\/\d+_?\d*\?fields=id,permalink/) || url.includes('permalink'))
          return {
            status: 200,
            json: { permalink: 'https://instagram.com/p/xyz', owner: { id: '123' } },
          };
        return { status: 200, json: {} };
      },
      async post(url: string, body?: Record<string, unknown>) {
        if (url.includes('/media_publish')) return { status: 200, json: { id: 'media-motion-1' } };
        if (url.includes('/media')) {
          childCount++;
          if (body?.media_type === 'VIDEO' && body?.video_url) videoChildren++;
          return { status: 200, json: { id: `container-${childCount}` } };
        }
        return { status: 200, json: {} };
      },
    };

    const result = await runWorkflow({
      cfg: cfg('LIVE'),
      http,
      providers: {
        authorPost: async (ctx) => ({ ...fixturePost, idea_id: ctx.ideaId }),
        inspectVisuals: async () => ({ approved: true, notes: 'ok' }),
      },
    });

    expect(result.status).toBe('POSTED');
    expect(result.mediaId).toBe('media-motion-1');
    // Slide 1 was published as a VIDEO carousel child.
    expect(videoChildren).toBe(1);
    // The persisted manifest carries per-item media descriptors, slide 1 = VIDEO.
    const manifestRaw = fakeR2.store.get(`private-test//manifests/${result.ideaId}.json`);
    expect(manifestRaw).toBeTruthy();
    const manifest = JSON.parse(manifestRaw!.body.toString('utf8'));
    expect(manifest.slideMedia[0].type).toBe('VIDEO');
    expect(manifest.slideMedia[0].posterUrl).toContain('.png');
    expect(manifest.slideMedia[1].type).toBe('IMAGE');
    // A poster .png and the .mp4 were both uploaded to the public bucket.
    const publicKeys = [...fakeR2.store.keys()].filter((k) => k.startsWith('public-test//'));
    expect(publicKeys.some((k) => k.endsWith('slide-01.mp4'))).toBe(true);
    expect(publicKeys.some((k) => k.endsWith('slide-01.png'))).toBe(true);
  });

  it('marks VERIFY_REQUIRED on ambiguous publish failure', async () => {
    setSettings('LIVE', { PUBLISH_EXISTING_DRAFT_FIRST: 'FALSE' });
    grid.data = [
      [
        '',
        'Another idea',
        'High',
        'Manual',
        'UNUSED',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
      ],
    ];

    let childCount = 0;
    const http = {
      async get(url: string) {
        if (url.includes('?fields=id,username'))
          return { status: 200, json: { id: '123', username: 'test' } };
        if (url.includes('content_publishing_limit'))
          return { status: 200, json: { data: [{ quota_usage: 1, config: { quota_total: 50 } }] } };
        if (url.includes('?fields=status_code'))
          return { status: 200, json: { status_code: 'FINISHED' } };
        if (url.includes('/media?fields=')) return { status: 200, json: { data: [] } };
        return { status: 200, json: {} };
      },
      async post(url: string) {
        if (url.includes('/media_publish'))
          return { status: 500, json: { error: { message: 'timeout' } } };
        if (url.includes('/media')) {
          childCount++;
          return { status: 200, json: { id: `container-${childCount}` } };
        }
        return { status: 200, json: {} };
      },
    };

    const result = await runWorkflow({
      cfg: cfg('LIVE'),
      http,
      providers: {
        authorPost: async (ctx) => ({ ...fixturePost, idea_id: ctx.ideaId }),
        inspectVisuals: async () => ({ approved: true, notes: 'ok' }),
      },
    });

    expect(result.status).toBe('VERIFY_REQUIRED');
    const statusCol = HEADERS.indexOf('status');
    expect(grid.data[0]![statusCol]).toBe('VERIFY_REQUIRED');
  });
});
