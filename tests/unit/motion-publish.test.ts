import { describe, it, expect } from 'vitest';
import { createIgClient, createVideoChildContainer, HttpClient } from '../../src/instagram.js';
import { AppConfig } from '../../src/config.js';
import { normalizeMedia, MediaDescriptor } from '../../src/media.js';
import { buildPreviewHtml } from '../../src/preview.js';
import { PostSchema } from '../../schemas/post.js';

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

describe('createVideoChildContainer', () => {
  it('POSTs media_type=VIDEO + video_url + is_carousel_item and returns the id', async () => {
    let captured: Record<string, unknown> | null = null;
    const http: HttpClient = {
      async get() {
        return { status: 200, json: {} };
      },
      async post(_url: string, body?: Record<string, unknown>) {
        captured = body ?? null;
        return { status: 200, json: { id: 'video-container-1' } };
      },
    };
    const ig = createIgClient(cfg(), 'tok', '123', http);
    const id = await createVideoChildContainer(ig, 'https://cdn.test/slide-01.mp4');
    expect(id).toBe('video-container-1');
    expect(captured).toMatchObject({
      video_url: 'https://cdn.test/slide-01.mp4',
      media_type: 'VIDEO',
      is_carousel_item: 'true',
    });
  });
});

describe('normalizeMedia (manifest back-compat)', () => {
  it('maps a legacy flat slideUrls string[] to IMAGE descriptors', () => {
    const out = normalizeMedia(undefined, ['https://cdn.test/a.png', 'https://cdn.test/b.png']);
    expect(out).toEqual([
      { url: 'https://cdn.test/a.png', type: 'IMAGE' },
      { url: 'https://cdn.test/b.png', type: 'IMAGE' },
    ]);
  });

  it('passes through new slideMedia descriptors unchanged', () => {
    const media: MediaDescriptor[] = [
      { url: 'https://cdn.test/1.mp4', type: 'VIDEO', posterUrl: 'https://cdn.test/1.png' },
      { url: 'https://cdn.test/2.png', type: 'IMAGE' },
    ];
    expect(normalizeMedia(media, ['ignored'])).toBe(media);
  });

  it('handles a missing/empty manifest gracefully', () => {
    expect(normalizeMedia(undefined, undefined)).toEqual([]);
    expect(normalizeMedia([], [])).toEqual([]);
  });
});

describe('preview video branch', () => {
  const post = PostSchema.parse({
    idea_id: 'x',
    idea: 'Test idea',
    hook: 'A hook',
    content_pillar: 'AI',
    template: 'numbered-list',
    slides: [
      { type: 'cover', headline: 'H' },
      { type: 'summary', headline: 'S' },
      { type: 'cta', headline: 'C' },
    ],
    caption: 'cap',
    hashtags: ['#ai'],
    generated_at: '2026-07-04',
    idempotency_key: 'k',
  });

  it('renders <video> for VIDEO items and <img> for IMAGE items', () => {
    const html = buildPreviewHtml({
      post,
      mode: 'TEST',
      label: 'DRAFT',
      media: [
        { url: 'https://cdn.test/1.mp4', type: 'VIDEO', posterUrl: 'https://cdn.test/1.png' },
        { url: 'https://cdn.test/2.png', type: 'IMAGE' },
      ],
    });
    expect(html).toContain('<video');
    expect(html).toContain('type="video/mp4"');
    expect(html).toContain('poster="https://cdn.test/1.png"');
    expect(html).toContain('src="https://cdn.test/2.png"');
    expect(html).toContain('Slides: 2');
  });
});
