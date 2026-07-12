import crypto from 'node:crypto';
import sharp from 'sharp';
import { Post } from '../schemas/post.js';
import { Settings } from '../schemas/settings.js';
import { RenderedSlide, SLIDE_WIDTH, SLIDE_HEIGHT, MIN_BODY_FONT_PX } from './render.js';
import { inspectMp4 } from './motion.js';
import { validateSlideBounds } from '../schemas/post.js';
import { validateClaims } from './research-validation.js';

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
  "let's dive in",
  'when it comes to',
  'the world of',
  'without further ado',
  'buckle up',
  'say goodbye to',
  'look no further',
  'harness the power',
  'supercharge your',
  'revolutionize',
  'in a nutshell',
  'the future is here',
  'game changer',
  'game-changing',
  'let that sink in',
  "here's the kicker",
  'the best part?',
  'mind-blowing',
  "you won't believe",
  'stop scrolling',
  'elevate your',
  'stay tuned',
];

/** Normalize curly quotes so phrase matching catches typographic apostrophes. */
function normalizeQuotes(text: string): string {
  return text.replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
}

/** Signals that a cover headline has a real hook: a number, a named subject, or tension. */
const HOOK_NUMBER = /\d/;
const HOOK_SUBJECT =
  /\b(claude|anthropic|gpt-?\d*|chatgpt|openai|codex|gemini|deepmind|grok|xai|llama|meta|mistral|copilot|cursor|windsurf|sora|deepseek|qwen|ai)\b/i;
const HOOK_TENSION =
  /\b(just|new|stop|wrong|nobody|everyone|secret|mistake|why|how|vs|versus|before|after|changed?|changes|killed?|kills|beats?|beaten|free|broke|breaking|leaked?|drops?|dropped|ships?|shipped|inside|truth|actually|real|not|never|always|now|don'?t|won'?t|this)\b/i;

/** Instagram shows roughly this many caption chars before truncating with "…more". */
const CAPTION_FOLD_CHARS = 125;

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
      message: 'last slide must be a summary or cta that closes the value + earns the follow',
      severity: 'error',
    });
  }
  // A cta closer needs a value reason to follow: either the slide carries it or
  // DEFAULT_CTA supplies it at render. Warn (don't block) when neither exists.
  if (last && last.type === 'cta') {
    const ctaCopy = `${last.body ?? ''} ${last.kicker ?? ''}`.trim();
    if (!ctaCopy && !settings.DEFAULT_CTA.trim()) {
      issues.push({
        slide: post.slides.length,
        code: 'CTA_WEAK',
        message: 'cta has no follow reason — write a cta body or set DEFAULT_CTA in the Sheet',
        severity: 'warning',
      });
    }
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

  // Generic AI phrasing. On the cover and the closer — the two slides that win
  // or lose the scroll — slop is a hard error; elsewhere (and in the caption)
  // it warns so the operator applies judgment.
  post.slides.forEach((slide, i) => {
    const copy = normalizeQuotes(
      [slide.headline, slide.body, slide.kicker, slide.myth, slide.reality, slide.mistake]
        .filter(Boolean)
        .join(' '),
    ).toLowerCase();
    const critical = i === 0 || i === post.slides.length - 1;
    for (const phrase of GENERIC_AI_PHRASES) {
      if (copy.includes(phrase)) {
        issues.push({
          slide: i + 1,
          code: 'GENERIC_PHRASE',
          message: `contains generic phrase: "${phrase}"`,
          severity: critical ? 'error' : 'warning',
        });
      }
    }
  });
  const captionCopy = normalizeQuotes(post.caption).toLowerCase();
  for (const phrase of GENERIC_AI_PHRASES) {
    if (captionCopy.includes(phrase)) {
      issues.push({
        slide: null,
        code: 'GENERIC_PHRASE',
        message: `caption contains generic phrase: "${phrase}"`,
        severity: 'warning',
      });
    }
  }

  // Hook lint: a cover headline with no number, no named tool/model and no
  // tension word rarely stops a scroll. Warning only — judgment stays human.
  const coverHeadline = post.slides[0]?.headline ?? '';
  if (
    post.slides[0]?.type === 'cover' &&
    !HOOK_NUMBER.test(coverHeadline) &&
    !HOOK_SUBJECT.test(coverHeadline) &&
    !HOOK_TENSION.test(normalizeQuotes(coverHeadline))
  ) {
    issues.push({
      slide: 1,
      code: 'HOOK_WEAK',
      message:
        'cover headline has no number, named tool, or tension word — consider a stronger hook',
      severity: 'warning',
    });
  }

  // Caption fold: the first line doubles as a second hook and is cut at ~125
  // chars before "…more".
  const firstLine = post.caption.split('\n', 1)[0] ?? '';
  if (firstLine.length > CAPTION_FOLD_CHARS) {
    issues.push({
      slide: null,
      code: 'CAPTION_FOLD',
      message: `caption first line is ${firstLine.length} chars (> ${CAPTION_FOLD_CHARS}); it will be truncated in the feed`,
      severity: 'warning',
    });
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

/**
 * Anti-fabrication: a post that makes volatile hard claims (statistics, prices,
 * legal/medical assertions) must carry at least one source. Blocks publish so
 * the operator adds a primary source or rewrites — never invents a number.
 */
export function validateResearch(post: Post): ValidationReport {
  const combined = (
    post.caption +
    ' ' +
    post.slides
      .map((s) =>
        [s.headline, s.body, s.myth, s.reality, s.mistake, s.solution, ...(s.items ?? [])]
          .filter(Boolean)
          .join(' '),
      )
      .join(' ')
  ).trim();
  const { issues: claimIssues } = validateClaims(combined, post.sources.length);
  const issues: ValidationIssue[] = claimIssues.map((message) => ({
    slide: null,
    code: 'UNSOURCED_CLAIM',
    message,
    severity: 'error' as const,
  }));
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

    // Exact-duplicate image detection. Motion slides are keyed by their poster,
    // which can legitimately repeat across similar animated frames, so skip the
    // dup check for them (their MP4s are what actually differ downstream).
    if (!s.mp4) {
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

    // Motion slides: structurally sanity-check the encoded MP4 (deep spec
    // validation happens in verify:motion against the live API).
    if (s.mp4) {
      const v = inspectMp4(s.mp4);
      if (!v.ok) {
        issues.push({
          slide: s.index,
          code: 'BAD_VIDEO',
          message: `invalid motion mp4: ${v.reason} (${v.bytes} bytes)`,
          severity: 'error',
        });
      }
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
    validateResearch(post),
    validateMetrics(slides),
    await validateImages(slides),
  ];
  const issues = reports.flatMap((r) => r.issues);
  return { ok: issues.every((i) => i.severity !== 'error'), issues };
}
