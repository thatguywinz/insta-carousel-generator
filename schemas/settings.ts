import { z } from 'zod';

/**
 * Settings tab contract. The Settings tab is read as key/value rows (A:B).
 * All values arrive as strings from Google Sheets and are coerced here.
 */

export const ModeSchema = z.enum(['TEST', 'LIVE']);
export type Mode = z.infer<typeof ModeSchema>;

export const PrioritySchema = z.enum(['High', 'Medium', 'Low']);
export type Priority = z.infer<typeof PrioritySchema>;

export const SourceSchema = z.enum(['Manual', 'Claude']);
export type Source = z.infer<typeof SourceSchema>;

/**
 * Which slides render as animated MP4 ("moving") carousel items.
 * - off       : image-only carousels.
 * - cover     : only slide 1 (the hook) moves.
 * - cover+key : slide 1 plus any slide the author flags `animate: true` (default).
 * - all       : every slide moves (heaviest render).
 */
export const MotionSlidesSchema = z.enum(['off', 'cover', 'cover+key', 'all']);
export type MotionSlides = z.infer<typeof MotionSlidesSchema>;

/**
 * The content policy. Two lanes exist — `news` and `value` (AI education) — and
 * the mode decides how they may be used.
 *
 * - news-preferred : (default) NEWS WINS whenever a real, fresh story exists. When
 *                    genuinely nothing shipped, a `value` post is allowed — but it
 *                    must clear the value bar (a concrete promise + an actionable
 *                    deck), never filler.
 * - news-only      : only `news` posts ship. No fresh story → no post.
 * - mixed          : the same checks, but they only warn.
 * - evergreen-ok   : no bar at all.
 */
export const ContentModeSchema = z.enum(['news-preferred', 'news-only', 'mixed', 'evergreen-ok']);
export type ContentMode = z.infer<typeof ContentModeSchema>;

/** Modes where the news/value bar actually blocks the run. */
export function isEnforcingMode(mode: ContentMode): boolean {
  return mode === 'news-preferred' || mode === 'news-only';
}

/** Parse a sheet boolean cell tolerantly. Unknown/blank => false. */
export function parseSheetBoolean(raw: string | undefined): boolean {
  if (!raw) return false;
  const v = raw.trim().toLowerCase();
  return v === 'true' || v === 'yes' || v === 'y' || v === '1' || v === 'on';
}

const TRUE_WORDS = new Set(['true', 'yes', 'y', '1', 'on']);
const FALSE_WORDS = new Set(['false', 'no', 'n', '0', 'off']);

/**
 * Tri-state boolean: an explicit true/false word, or null when the cell is
 * missing, blank, or garbage (e.g. accidentally pasted text). Callers apply
 * their documented default on null instead of silently flipping to false.
 */
export function parseSheetBooleanStrict(raw: string | undefined): boolean | null {
  if (raw === undefined) return null;
  const v = raw.trim().toLowerCase();
  if (TRUE_WORDS.has(v)) return true;
  if (FALSE_WORDS.has(v)) return false;
  return null;
}

/**
 * DEFAULT_CTA is rendered verbatim as the CTA slide's body when the author
 * leaves it empty, so an accidentally pasted paragraph would ship on a real
 * slide. Anything longer than a short follow reason is rejected with a warning.
 */
export const MAX_DEFAULT_CTA_CHARS = 220;

export const SettingsSchema = z.object({
  MODE: ModeSchema.catch('TEST'),
  NICHE: z.string().default(''),
  TARGET_AUDIENCE: z.string().default(''),
  ACCOUNT_GOAL: z.string().default(''),
  BRAND_NAME: z.string().default(''),
  INSTAGRAM_HANDLE: z.string().default(''),
  BRAND_COLORS: z.string().default(''),
  BRAND_STYLE: z.string().default(''),
  CONTENT_PILLARS: z.string().default(''),
  DEFAULT_CTA: z.string().default(''),
  POST_LANGUAGE: z.string().default('en'),
  LOOKBACK_DAYS: z.number().int().positive().default(30),
  MIN_SLIDES: z.number().int().min(3).max(20).default(6),
  MAX_SLIDES: z.number().int().min(3).max(20).default(8),
  PUBLISH_EXISTING_DRAFT_FIRST: z.boolean().default(true),
  AUTO_GENERATE_WHEN_EMPTY: z.boolean().default(true),
  MOTION_SLIDES: MotionSlidesSchema.catch('cover+key'),
  /**
   * Visual art-direction rotation. `auto` (default) rotates the style per idea;
   * a specific style name (editorial/brutalist/spotlight/kinetic/blueprint/
   * poster) pins every post to that look. Validated against known styles at
   * render time; unknown values fall back to `auto`.
   */
  ART_DIRECTION: z.string().default('auto'),
  /** Content policy. Default `news-preferred`: news wins, value is the fallback. */
  CONTENT_MODE: ContentModeSchema.catch('news-preferred'),
  /** A story is "fresh" if a source was published within this many days. */
  MAX_STORY_AGE_DAYS: z.number().int().positive().default(14),
  /**
   * The first-mover window. Stories sourced within this many hours are "breaking"
   * — the ones worth racing on. Older-but-still-fresh stories only warn
   * (`SLOW_TO_POST`), because being early is most of the reach.
   */
  BREAKING_WINDOW_HOURS: z.number().int().positive().default(48),
});

export type Settings = z.infer<typeof SettingsSchema>;

/**
 * Build a validated Settings object from a raw key/value map.
 * MODE defaults safely to TEST when missing, malformed or unknown.
 *
 * Malformed cells (pasted text in a numeric/boolean cell, an overlong
 * DEFAULT_CTA) fall back to their documented defaults and are reported through
 * `onWarning` so a corrupted Sheet is loud in the logs instead of silent.
 */
export function parseSettings(
  raw: Record<string, string>,
  onWarning?: (message: string) => void,
): Settings {
  const warn = (message: string): void => onWarning?.(message);

  const num = (key: string, fallback: number): number => {
    const v = raw[key];
    if (v === undefined || v.trim() === '') return fallback;
    const n = Number(v.trim());
    if (!Number.isFinite(n)) {
      warn(`${key} is not a number ("${v.trim().slice(0, 40)}…" ignored); using ${fallback}`);
      return fallback;
    }
    return n;
  };

  const bool = (key: string, fallback: boolean): boolean => {
    const v = raw[key];
    const parsed = parseSheetBooleanStrict(v);
    if (parsed !== null) return parsed;
    if (v !== undefined && v.trim() !== '') {
      warn(`${key} is not TRUE/FALSE ("${v.trim().slice(0, 40)}…" ignored); using ${fallback}`);
    }
    return fallback;
  };

  const modeRaw = (raw.MODE ?? '').trim().toUpperCase();
  if (modeRaw && modeRaw !== 'TEST' && modeRaw !== 'LIVE') {
    warn(`MODE "${modeRaw.slice(0, 20)}" is not TEST/LIVE; defaulting to TEST`);
  }

  let defaultCta = raw.DEFAULT_CTA ?? '';
  if (defaultCta.trim().length > MAX_DEFAULT_CTA_CHARS) {
    warn(
      `DEFAULT_CTA is ${defaultCta.trim().length} chars (> ${MAX_DEFAULT_CTA_CHARS}) — it looks like pasted text, not a follow reason; ignoring it`,
    );
    defaultCta = '';
  }

  const parsed = SettingsSchema.parse({
    MODE: modeRaw,
    NICHE: raw.NICHE ?? '',
    TARGET_AUDIENCE: raw.TARGET_AUDIENCE ?? '',
    ACCOUNT_GOAL: raw.ACCOUNT_GOAL ?? '',
    BRAND_NAME: raw.BRAND_NAME ?? '',
    INSTAGRAM_HANDLE: raw.INSTAGRAM_HANDLE ?? '',
    BRAND_COLORS: raw.BRAND_COLORS ?? '',
    BRAND_STYLE: raw.BRAND_STYLE ?? '',
    CONTENT_PILLARS: raw.CONTENT_PILLARS ?? '',
    DEFAULT_CTA: defaultCta,
    POST_LANGUAGE: (raw.POST_LANGUAGE ?? 'en').trim() || 'en',
    LOOKBACK_DAYS: num('LOOKBACK_DAYS', 30),
    MIN_SLIDES: num('MIN_SLIDES', 6),
    MAX_SLIDES: num('MAX_SLIDES', 8),
    PUBLISH_EXISTING_DRAFT_FIRST: bool('PUBLISH_EXISTING_DRAFT_FIRST', true),
    AUTO_GENERATE_WHEN_EMPTY: bool('AUTO_GENERATE_WHEN_EMPTY', true),
    MOTION_SLIDES: (raw.MOTION_SLIDES ?? '').trim().toLowerCase(),
    ART_DIRECTION: (raw.ART_DIRECTION ?? 'auto').trim().toLowerCase() || 'auto',
    // `news-first` is the old name for the strict lane; keep it working.
    CONTENT_MODE: (() => {
      const v = (raw.CONTENT_MODE ?? '').trim().toLowerCase();
      return v === 'news-first' ? 'news-only' : v;
    })(),
    MAX_STORY_AGE_DAYS: num('MAX_STORY_AGE_DAYS', 14),
    BREAKING_WINDOW_HOURS: num('BREAKING_WINDOW_HOURS', 48),
  });

  // Guard against inverted slide bounds.
  if (parsed.MIN_SLIDES > parsed.MAX_SLIDES) {
    return { ...parsed, MIN_SLIDES: parsed.MAX_SLIDES };
  }
  return parsed;
}
