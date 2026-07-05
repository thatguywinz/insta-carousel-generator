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

/** Parse a sheet boolean cell tolerantly. Unknown/blank => false. */
export function parseSheetBoolean(raw: string | undefined): boolean {
  if (!raw) return false;
  const v = raw.trim().toLowerCase();
  return v === 'true' || v === 'yes' || v === 'y' || v === '1' || v === 'on';
}

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
});

export type Settings = z.infer<typeof SettingsSchema>;

/**
 * Build a validated Settings object from a raw key/value map.
 * MODE defaults safely to TEST when missing, malformed or unknown.
 */
export function parseSettings(raw: Record<string, string>): Settings {
  const num = (key: string, fallback: number): number => {
    const v = raw[key];
    if (v === undefined || v.trim() === '') return fallback;
    const n = Number(v.trim());
    return Number.isFinite(n) ? n : fallback;
  };

  const parsed = SettingsSchema.parse({
    MODE: (raw.MODE ?? '').trim().toUpperCase(),
    NICHE: raw.NICHE ?? '',
    TARGET_AUDIENCE: raw.TARGET_AUDIENCE ?? '',
    ACCOUNT_GOAL: raw.ACCOUNT_GOAL ?? '',
    BRAND_NAME: raw.BRAND_NAME ?? '',
    INSTAGRAM_HANDLE: raw.INSTAGRAM_HANDLE ?? '',
    BRAND_COLORS: raw.BRAND_COLORS ?? '',
    BRAND_STYLE: raw.BRAND_STYLE ?? '',
    CONTENT_PILLARS: raw.CONTENT_PILLARS ?? '',
    DEFAULT_CTA: raw.DEFAULT_CTA ?? '',
    POST_LANGUAGE: (raw.POST_LANGUAGE ?? 'en').trim() || 'en',
    LOOKBACK_DAYS: num('LOOKBACK_DAYS', 30),
    MIN_SLIDES: num('MIN_SLIDES', 6),
    MAX_SLIDES: num('MAX_SLIDES', 8),
    PUBLISH_EXISTING_DRAFT_FIRST:
      parseSheetBoolean(raw.PUBLISH_EXISTING_DRAFT_FIRST) ||
      raw.PUBLISH_EXISTING_DRAFT_FIRST === undefined,
    AUTO_GENERATE_WHEN_EMPTY:
      parseSheetBoolean(raw.AUTO_GENERATE_WHEN_EMPTY) || raw.AUTO_GENERATE_WHEN_EMPTY === undefined,
    MOTION_SLIDES: (raw.MOTION_SLIDES ?? '').trim().toLowerCase(),
    ART_DIRECTION: (raw.ART_DIRECTION ?? 'auto').trim().toLowerCase() || 'auto',
  });

  // Guard against inverted slide bounds.
  if (parsed.MIN_SLIDES > parsed.MAX_SLIDES) {
    return { ...parsed, MIN_SLIDES: parsed.MAX_SLIDES };
  }
  return parsed;
}
