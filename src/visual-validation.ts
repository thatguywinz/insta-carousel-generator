import crypto from 'node:crypto';
import sharp from 'sharp';
import { Post } from '../schemas/post.js';
import { Settings } from '../schemas/settings.js';
import { RenderedSlide, SLIDE_WIDTH, SLIDE_HEIGHT, MIN_BODY_FONT_PX } from './render.js';
import { validateSlideBounds } from '../schemas/post.js';

/**
 * Automated visual + copy validation. Runs BEFORE upload/publish. Failing
 * checks block the pipeline; the operating model additionally performs a
 * human-grade visual inspection of the rendered PNGs on top of these.
 */

export interface ValidationIssue {
  slide: number | null;
  code: string;
  message: string;
  severity: 'error' | 'warning';
}

export interface ValidationReport {
  ok: boolean;
  issues: ValidationIssue[];
}

const GENERIC_AI_PHRASES = [
  "in today's fast-paced world",
  'unlock the power',
  'take your',
  'to the next level',
  'game-changer',
  'in conclusion',
  'dive deep',
  'when it comes to',
  'the world of',
];

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function countEmojis(text: string): number {
  const matches = text.match(/\p{Extended_Pictographic}/gu);
  return matches ? matches.length : 0;
}

/** Copy-level validation of the structured post (no rendering needed). */
export function validatePostCopy(post: Post, settings: Settings): ValidationReport {
  const issues: ValidationIssue[] = [];

  const bounds = validateSlideBounds(post.slides.length, settings.MIN_SLIDES, settings.MAX_SLIDES);
  if (!bounds.ok) {
    issues.push({
      slide: null,
      code: 'SLIDE_COUNT',
      message: bounds.reason ?? 'bad slide count',
      severity: 'error',
    });
  }

  if (post.slides[0]?.type !== 'cover') {
    issues.push({
      slide: 1,
      code: 'NO_COVER',
      message: 'first slide must be a cover',
      severity: 'error',
    });
  }
  const last = post.slides[post.slides.length - 1];
  if (last && last.type !== 'summary' && last.type !== 'cta') {
    issues.push({
      slide: post.slides.length,
      code: 'NO_CLOSER',
      message: 'last slide should be summary or cta',
      severity: 'warning',
    });
  }

  // Per-slide headline/body checks.
  const seen = new Map<string, number>();
  post.slides.forEach((slide, i) => {
    const n = i + 1;
    const headlineWords = countWords(slide.headline);
    if (headlineWords > 12) {
      issues.push({
        slide: n,
        code: 'HEADLINE_LONG',
        message: `headline ${headlineWords} words (>12)`,
        severity: 'warning',
      });
    }
    const bodyText = [slide.body, slide.myth, slide.reality, slide.mistake, slide.solution]
      .filter(Boolean)
      .join(' ');
    if (bodyText && countWords(bodyText) > 55) {
      issues.push({
        slide: n,
        code: 'BODY_LONG',
        message: `slide body ${countWords(bodyText)} words (>55)`,
        severity: 'warning',
      });
    }
    // Duplicate slide content.
    const key = (slide.headline + '|' + (slide.body ?? '')).toLowerCase().trim();
    if (seen.has(key)) {
      issues.push({
        slide: n,
        code: 'DUP_SLIDE',
        message: `slide duplicates slide ${seen.get(key)}`,
        severity: 'error',
      });
    } else {
      seen.set(key, n);
    }
  });

  // Caption checks.
  if (post.caption.length > 2200) {
    issues.push({
      slide: null,
      code: 'CAPTION_LONG',
      message: 'caption exceeds 2200 chars',
      severity: 'error',
    });
  }
  if (post.hashtags.length > 8) {
    issues.push({
      slide: null,
      code: 'HASHTAGS',
      message: `${post.hashtags.length} hashtags (>8)`,
      severity: 'error',
    });
  }

  // Generic AI phrasing (warning only).
  const allCopy = (
    post.caption +
    ' ' +
    post.slides.map((s) => s.headline + ' ' + (s.body ?? '')).join(' ')
  ).toLowerCase();
  for (const phrase of GENERIC_AI_PHRASES) {
    if (allCopy.includes(phrase)) {
      issues.push({
        slide: null,
        code: 'GENERIC_PHRASE',
        message: `contains generic phrase: "${phrase}"`,
        severity: 'warning',
      });
    }
  }

  // Emoji density in caption.
  if (countEmojis(post.caption) > 8) {
    issues.push({
      slide: null,
      code: 'EMOJI',
      message: 'excessive emojis in caption',
      severity: 'warning',
    });
  }

  return { ok: issues.every((i) => i.severity !== 'error'), issues };
}

/** Validate render metrics from the in-page measurement. */
export function validateMetrics(slides: RenderedSlide[]): ValidationReport {
  const issues: ValidationIssue[] = [];
  for (const s of slides) {
    const m = s.metrics;
    if (m.hasOverflow) {
      issues.push({
        slide: s.index,
        code: 'OVERFLOW',
        message: `content overflows slide box (${m.overflowingSelectors.join(', ') || 'scroll'})`,
        severity: 'error',
      });
    }
    if (m.minFontPx > 0 && m.minFontPx < MIN_BODY_FONT_PX) {
      issues.push({
        slide: s.index,
        code: 'TINY_FONT',
        message: `min font ${m.minFontPx}px < ${MIN_BODY_FONT_PX}px`,
        severity: 'error',
      });
    }
    if (!m.hasHeadline) {
      issues.push({
        slide: s.index,
        code: 'NO_HEADLINE',
        message: 'missing headline element',
        severity: 'error',
      });
    }
    if (!m.hasHandle) {
      issues.push({
        slide: s.index,
        code: 'NO_HANDLE',
        message: 'missing brand handle',
        severity: 'error',
      });
    }
    if (!m.hasPageNumber) {
      issues.push({
        slide: s.index,
        code: 'NO_PAGENUM',
        message: 'missing slide number',
        severity: 'warning',
      });
    }
  }
  return { ok: issues.every((i) => i.severity !== 'error'), issues };
}

/** Validate the actual rendered PNGs with sharp: dimensions, blankness, size. */
export async function validateImages(slides: RenderedSlide[]): Promise<ValidationReport> {
  const issues: ValidationIssue[] = [];
  const hashes = new Map<string, number>();

  for (const s of slides) {
    let meta: sharp.Metadata;
    let stats: sharp.Stats;
    try {
      const img = sharp(s.png);
      meta = await img.metadata();
      stats = await img.stats();
    } catch {
      issues.push({
        slide: s.index,
        code: 'BAD_IMAGE',
        message: 'unreadable image file',
        severity: 'error',
      });
      continue;
    }

    if (meta.width !== SLIDE_WIDTH || meta.height !== SLIDE_HEIGHT) {
      issues.push({
        slide: s.index,
        code: 'DIMENSIONS',
        message: `image is ${meta.width}×${meta.height}, expected ${SLIDE_WIDTH}×${SLIDE_HEIGHT}`,
        severity: 'error',
      });
    }

    if (s.png.length < 3000) {
      issues.push({
        slide: s.index,
        code: 'TOO_SMALL',
        message: `image only ${s.png.length} bytes (likely blank)`,
        severity: 'error',
      });
    }
    if (s.png.length > 4_000_000) {
      issues.push({
        slide: s.index,
        code: 'TOO_LARGE',
        message: `image ${s.png.length} bytes (>4MB)`,
        severity: 'warning',
      });
    }

    // Blank detection: near-zero variance across all channels.
    const totalStdev = stats.channels.reduce((sum, c) => sum + c.stdev, 0);
    if (totalStdev < 2) {
      issues.push({
        slide: s.index,
        code: 'BLANK',
        message: 'image appears blank/uniform',
        severity: 'error',
      });
    }

    // Exact-duplicate image detection.
    const hash = crypto.createHash('sha256').update(s.png).digest('hex');
    if (hashes.has(hash)) {
      issues.push({
        slide: s.index,
        code: 'DUP_IMAGE',
        message: `identical render to slide ${hashes.get(hash)}`,
        severity: 'error',
      });
    } else {
      hashes.set(hash, s.index);
    }
  }

  return { ok: issues.every((i) => i.severity !== 'error'), issues };
}

/** Run all automated validation passes and merge reports. */
export async function validateAll(
  post: Post,
  slides: RenderedSlide[],
  settings: Settings,
): Promise<ValidationReport> {
  const reports = [
    validatePostCopy(post, settings),
    validateMetrics(slides),
    await validateImages(slides),
  ];
  const issues = reports.flatMap((r) => r.issues);
  return { ok: issues.every((i) => i.severity !== 'error'), issues };
}
