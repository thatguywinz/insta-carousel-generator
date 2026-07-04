import { describe, it, expect } from 'vitest';
import {
  inspectMp4,
  resolveFfmpeg,
  ffmpegHasH264,
  MOTION_OUTPUT_SECONDS,
} from '../../src/motion.js';
import { shouldAnimate, buildSlideHtml, Brand } from '../../src/render.js';
import { Slide } from '../../schemas/post.js';

const brand: Brand = {
  brandName: 'Test',
  instagramHandle: '@test',
  colors: {
    primary: '#1A2B4A',
    secondary: '#3B6FE0',
    accent: '#F2B705',
    background: '#FBFAF7',
    surface: '#FFFFFF',
    text: '#141B2E',
    textMuted: '#5A6478',
    onPrimary: '#FFFFFF',
  },
  style: 'clean',
  language: 'en',
};

const slide = (extra: Partial<Slide> = {}): Slide =>
  ({ type: 'cover', headline: 'h', body: '', ...extra }) as Slide;

/** Build a minimal buffer whose bytes 4..8 spell an MP4 `ftyp` box. */
function fakeMp4(size: number): Buffer {
  const head = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftyp')]);
  return Buffer.concat([head, Buffer.alloc(Math.max(0, size - head.length))]);
}

describe('shouldAnimate', () => {
  it('honors an explicit per-slide flag over the mode', () => {
    expect(shouldAnimate(slide({ animate: true }), 3, 'off')).toBe(true);
    expect(shouldAnimate(slide({ animate: false }), 1, 'all')).toBe(false);
  });

  it('off animates nothing (unless explicitly flagged)', () => {
    expect(shouldAnimate(slide(), 1, 'off')).toBe(false);
    expect(shouldAnimate(slide(), 4, 'off')).toBe(false);
  });

  it('cover / cover+key animate only the first slide by default', () => {
    for (const mode of ['cover', 'cover+key'] as const) {
      expect(shouldAnimate(slide(), 1, mode)).toBe(true);
      expect(shouldAnimate(slide(), 2, mode)).toBe(false);
    }
    // cover+key lets extra slides opt in explicitly.
    expect(shouldAnimate(slide({ animate: true }), 5, 'cover+key')).toBe(true);
  });

  it('all animates every slide', () => {
    expect(shouldAnimate(slide(), 1, 'all')).toBe(true);
    expect(shouldAnimate(slide(), 7, 'all')).toBe(true);
  });
});

describe('buildSlideHtml motion layer', () => {
  it('adds the motion class and keyframes only when animate=true', () => {
    const animated = buildSlideHtml(slide({ kicker: 'k' }), 1, 6, brand, '', undefined, true);
    expect(animated).toContain('slide-cover motion');
    expect(animated).toContain('@keyframes bg-shimmer');

    const staticHtml = buildSlideHtml(slide({ kicker: 'k' }), 1, 6, brand, '', undefined, false);
    expect(staticHtml).toContain('class="slide slide-cover"');
    expect(staticHtml).not.toContain('motion');
    expect(staticHtml).not.toContain('@keyframes');
  });
});

describe('inspectMp4', () => {
  it('accepts a well-formed, in-envelope mp4', () => {
    expect(inspectMp4(fakeMp4(50_000)).ok).toBe(true);
  });

  it('rejects a too-small buffer', () => {
    const r = inspectMp4(fakeMp4(500));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/small/);
  });

  it('rejects a buffer without an ftyp box', () => {
    const r = inspectMp4(Buffer.alloc(10_000));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/ftyp/);
  });
});

describe('ffmpeg resolution', () => {
  it('resolves a binary path', () => {
    expect(typeof resolveFfmpeg()).toBe('string');
    expect(resolveFfmpeg().length).toBeGreaterThan(0);
  });

  it('the resolved ffmpeg can encode H.264 (libx264)', async () => {
    expect(await ffmpegHasH264()).toBe(true);
  });

  it('targets an Instagram-safe output length (>= 3s minimum)', () => {
    expect(MOTION_OUTPUT_SECONDS).toBeGreaterThanOrEqual(3);
  });
});
