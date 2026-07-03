import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { validatePostCopy, validateMetrics, validateImages } from '../../src/visual-validation.js';
import { RenderedSlide, SlideMetrics, SLIDE_WIDTH, SLIDE_HEIGHT } from '../../src/render.js';
import { PostSchema, Post } from '../../schemas/post.js';
import { parseSettings } from '../../schemas/settings.js';

const post: Post = PostSchema.parse(
  JSON.parse(readFileSync(path.join(__dirname, '..', 'fixtures', 'sample-post.json'), 'utf8')),
);
const settings = parseSettings({ MIN_SLIDES: '6', MAX_SLIDES: '8' });

const goodMetrics: SlideMetrics = {
  scrollWidth: SLIDE_WIDTH,
  scrollHeight: SLIDE_HEIGHT,
  hasOverflow: false,
  minFontPx: 38,
  overflowingSelectors: [],
  hasHeadline: true,
  hasHandle: true,
  hasPageNumber: true,
};

async function pngImage(w: number, h: number, colorful: boolean): Promise<Buffer> {
  const r = colorful ? 40 : 255;
  const g = colorful ? 120 : 255;
  const b = colorful ? 200 : 255;
  let img = sharp({ create: { width: w, height: h, channels: 3, background: { r, g, b } } });
  if (colorful) {
    // add a contrasting rectangle so stdev > 0
    const overlay = await sharp({
      create: {
        width: Math.floor(w / 2),
        height: Math.floor(h / 2),
        channels: 3,
        background: { r: 240, g: 240, b: 10 },
      },
    })
      .png()
      .toBuffer();
    img = img.composite([{ input: overlay, top: 0, left: 0 }]);
  }
  return img.png().toBuffer();
}

describe('copy validation', () => {
  it('passes the sample fixture', () => {
    const report = validatePostCopy(post, settings);
    expect(report.ok).toBe(true);
  });

  it('flags slide count out of bounds', () => {
    const tooFew = { ...post, slides: post.slides.slice(0, 4) };
    const report = validatePostCopy(
      PostSchema.parse(tooFew),
      parseSettings({ MIN_SLIDES: '6', MAX_SLIDES: '8' }),
    );
    expect(report.ok).toBe(false);
    expect(report.issues.some((i) => i.code === 'SLIDE_COUNT')).toBe(true);
  });

  it('flags missing cover', () => {
    const noCover = {
      ...post,
      slides: post.slides.map((s, i) =>
        i === 0 ? { ...s, type: 'standard-content' as const } : s,
      ),
    };
    const report = validatePostCopy(PostSchema.parse(noCover), settings);
    expect(report.issues.some((i) => i.code === 'NO_COVER')).toBe(true);
  });

  it('flags too many hashtags at schema-safe level via copy', () => {
    const report = validatePostCopy(
      { ...post, hashtags: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] },
      settings,
    );
    expect(report.ok).toBe(true); // 8 is allowed
  });

  it('detects duplicate slide content', () => {
    const dup = { ...post };
    const slides = [...dup.slides];
    slides[2] = { ...(slides[1] as (typeof slides)[number]) };
    const report = validatePostCopy(PostSchema.parse({ ...dup, slides }), settings);
    expect(report.issues.some((i) => i.code === 'DUP_SLIDE')).toBe(true);
  });
});

describe('metric validation', () => {
  it('passes clean metrics', () => {
    const slides: RenderedSlide[] = [
      {
        index: 1,
        type: 'cover',
        png: Buffer.alloc(0),
        width: SLIDE_WIDTH,
        height: SLIDE_HEIGHT,
        metrics: goodMetrics,
      },
    ];
    expect(validateMetrics(slides).ok).toBe(true);
  });

  it('flags overflow and tiny fonts', () => {
    const slides: RenderedSlide[] = [
      {
        index: 1,
        type: 'cover',
        png: Buffer.alloc(0),
        width: SLIDE_WIDTH,
        height: SLIDE_HEIGHT,
        metrics: { ...goodMetrics, hasOverflow: true, overflowingSelectors: ['body'] },
      },
      {
        index: 2,
        type: 'standard-content',
        png: Buffer.alloc(0),
        width: SLIDE_WIDTH,
        height: SLIDE_HEIGHT,
        metrics: { ...goodMetrics, minFontPx: 12 },
      },
    ];
    const report = validateMetrics(slides);
    expect(report.ok).toBe(false);
    expect(report.issues.some((i) => i.code === 'OVERFLOW')).toBe(true);
    expect(report.issues.some((i) => i.code === 'TINY_FONT')).toBe(true);
  });

  it('flags missing handle/headline', () => {
    const slides: RenderedSlide[] = [
      {
        index: 1,
        type: 'cover',
        png: Buffer.alloc(0),
        width: SLIDE_WIDTH,
        height: SLIDE_HEIGHT,
        metrics: { ...goodMetrics, hasHandle: false, hasHeadline: false },
      },
    ];
    const report = validateMetrics(slides);
    expect(report.issues.some((i) => i.code === 'NO_HANDLE')).toBe(true);
    expect(report.issues.some((i) => i.code === 'NO_HEADLINE')).toBe(true);
  });
});

describe('image validation', () => {
  it('accepts a correctly-sized non-blank image', async () => {
    const png = await pngImage(SLIDE_WIDTH, SLIDE_HEIGHT, true);
    const slides: RenderedSlide[] = [
      {
        index: 1,
        type: 'cover',
        png,
        width: SLIDE_WIDTH,
        height: SLIDE_HEIGHT,
        metrics: goodMetrics,
      },
    ];
    const report = await validateImages(slides);
    expect(report.ok).toBe(true);
  });

  it('rejects wrong dimensions', async () => {
    const png = await pngImage(1080, 1080, true);
    const slides: RenderedSlide[] = [
      { index: 1, type: 'cover', png, width: 1080, height: 1080, metrics: goodMetrics },
    ];
    const report = await validateImages(slides);
    expect(report.issues.some((i) => i.code === 'DIMENSIONS')).toBe(true);
  });

  it('rejects a blank image', async () => {
    const png = await pngImage(SLIDE_WIDTH, SLIDE_HEIGHT, false);
    const slides: RenderedSlide[] = [
      {
        index: 1,
        type: 'cover',
        png,
        width: SLIDE_WIDTH,
        height: SLIDE_HEIGHT,
        metrics: goodMetrics,
      },
    ];
    const report = await validateImages(slides);
    expect(report.issues.some((i) => i.code === 'BLANK')).toBe(true);
  });

  it('detects duplicate identical renders', async () => {
    const png = await pngImage(SLIDE_WIDTH, SLIDE_HEIGHT, true);
    const slides: RenderedSlide[] = [
      {
        index: 1,
        type: 'cover',
        png,
        width: SLIDE_WIDTH,
        height: SLIDE_HEIGHT,
        metrics: goodMetrics,
      },
      {
        index: 2,
        type: 'numbered-point',
        png,
        width: SLIDE_WIDTH,
        height: SLIDE_HEIGHT,
        metrics: goodMetrics,
      },
    ];
    const report = await validateImages(slides);
    expect(report.issues.some((i) => i.code === 'DUP_IMAGE')).toBe(true);
  });
});
