import { z } from 'zod';

/**
 * Runtime schema for a structured carousel post object and its Content-row
 * representation. These are the durable contracts the whole pipeline relies on.
 */

export const ContentStatusSchema = z.enum([
  'UNUSED',
  'SELECTED',
  'GENERATING',
  'RENDERING',
  'DRAFT_READY',
  'POSTING',
  'POSTED',
  'FAILED',
  'VERIFY_REQUIRED',
]);
export type ContentStatus = z.infer<typeof ContentStatusSchema>;

export const SlideTypeSchema = z.enum([
  'cover',
  'numbered-point',
  'standard-content',
  'step',
  'myth-reality',
  'mistake-solution',
  'comparison',
  'checklist',
  'summary',
  'cta',
]);
export type SlideType = z.infer<typeof SlideTypeSchema>;

export const TemplateSchema = z.enum([
  'numbered-list',
  'step-by-step',
  'myth-reality',
  'mistake-solution',
  'comparison',
  'checklist',
  'breaking-news',
]);
export type Template = z.infer<typeof TemplateSchema>;

/**
 * Visual theme keyed to the post's subject. Detected from content when absent.
 * `breaking` is a generic high-attention "AI news" look for topics that don't
 * map to a specific vendor.
 */
export const ThemeNameSchema = z.enum([
  'claude',
  'openai',
  'gemini',
  'grok',
  'meta',
  'mistral',
  'breaking',
  'default',
]);
export type ThemeName = z.infer<typeof ThemeNameSchema>;

/**
 * Art direction — the visual "style" axis, independent of theme (palette) and
 * template (content layout). Controls typography, background treatment, decor
 * and motion personality so every post can look like a different designed piece.
 * When absent the renderer rotates it deterministically per idea.
 */
export const ArtDirectionSchema = z.enum([
  'editorial',
  'brutalist',
  'spotlight',
  'kinetic',
  'blueprint',
  'poster',
]);
export type ArtDirection = z.infer<typeof ArtDirectionSchema>;

/** A single slide. Fields are optional per slide type; renderer reads what it needs. */
export const SlideSchema = z
  .object({
    type: SlideTypeSchema,
    /** Headline / title. Guidance: <= ~10 words. */
    headline: z.string().min(1).max(140),
    /** Body / supporting copy. Guidance: ~15-40 words. */
    body: z.string().max(400).optional().default(''),
    /** Optional index for numbered/step slides. */
    index: z.number().int().positive().optional(),
    /** myth-reality slide. */
    myth: z.string().max(280).optional(),
    reality: z.string().max(280).optional(),
    /** mistake-solution slide. */
    mistake: z.string().max(280).optional(),
    solution: z.string().max(280).optional(),
    /** comparison slide. */
    optionA: z.string().max(120).optional(),
    optionB: z.string().max(120).optional(),
    pointsA: z.array(z.string().max(160)).max(6).optional(),
    pointsB: z.array(z.string().max(160)).max(6).optional(),
    /** checklist slide. */
    items: z.array(z.string().max(160)).max(8).optional(),
    /** small eyebrow/kicker text. */
    kicker: z.string().max(60).optional(),
    /**
     * Motion override. When true this slide renders as an animated MP4 (a "moving"
     * carousel item); when false it stays a static image. When omitted, the
     * MOTION_SLIDES setting decides (cover animates by default). Optional so older
     * manifests without the field still re-parse under `.strict()`.
     */
    animate: z.boolean().optional(),
  })
  .strict();
export type Slide = z.infer<typeof SlideSchema>;

/**
 * The two content lanes. `news` is always preferred; `value` (AI education) is
 * the fallback for when genuinely nothing shipped.
 */
export const ContentTypeSchema = z.enum(['news', 'value']);
export type ContentType = z.infer<typeof ContentTypeSchema>;

export const SourceRefSchema = z.object({
  url: z.string().url(),
  description: z.string().max(200),
  /**
   * ISO date (YYYY-MM-DD) the source/story was published. Drives the freshness
   * gate — a post whose newest source is older than MAX_STORY_AGE_DAYS is stale.
   */
  published_at: z.string().max(40).optional(),
});
export type SourceRef = z.infer<typeof SourceRefSchema>;

export const PostSchema = z
  .object({
    idea_id: z.string().min(1),
    idea: z.string().min(1),
    hook: z.string().min(1).max(200),
    content_pillar: z.string().min(1).max(120),
    template: TemplateSchema,
    /** Optional explicit visual theme; overrides keyword detection. */
    theme: ThemeNameSchema.optional(),
    /** Optional explicit art direction; overrides the ART_DIRECTION rotation. */
    art_direction: ArtDirectionSchema.optional(),
    slides: z.array(SlideSchema).min(3).max(20),
    /**
     * Which lane this post is in. `news` = a real, fresh, sourced development
     * (always preferred). `value` = AI education, allowed only when genuinely
     * nothing shipped — and only if it clears the value bar.
     */
    content_type: ContentTypeSchema.optional(),
    /**
     * NEWS lane. The anchor: what actually happened, when, and why a reader should
     * care THIS WEEK. If you cannot write this honestly, it is not news.
     */
    why_now: z.string().max(280).optional(),
    /**
     * VALUE lane. The concrete thing the reader can DO after reading — a workflow,
     * a setting, a technique. Not "learn about AI"; something testable today.
     */
    value_promise: z.string().max(280).optional(),
    /**
     * VALUE lane. Why you fell back: what you searched and why nothing was worth
     * covering. Keeps the value lane an honest fallback, not the easy default.
     */
    no_news_reason: z.string().max(280).optional(),
    caption: z.string().min(1).max(2200),
    hashtags: z.array(z.string().min(1)).max(8),
    sources: z.array(SourceRefSchema).default([]),
    generated_at: z.string().min(1),
    idempotency_key: z.string().min(1),
  })
  .strict();
export type Post = z.infer<typeof PostSchema>;

/** The exact Content-tab column contract, in order. */
export const CONTENT_HEADERS = [
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
] as const;

export type ContentHeader = (typeof CONTENT_HEADERS)[number];

export const ContentRowSchema = z.object({
  idea_id: z.string().default(''),
  idea: z.string().default(''),
  priority: z.string().default(''),
  source: z.string().default(''),
  status: z.string().default(''),
  added_at: z.string().default(''),
  selected_at: z.string().default(''),
  hook: z.string().default(''),
  content_pillar: z.string().default(''),
  template: z.string().default(''),
  slide_count: z.string().default(''),
  caption: z.string().default(''),
  preview_url: z.string().default(''),
  published_at: z.string().default(''),
  instagram_media_id: z.string().default(''),
  permalink: z.string().default(''),
  error: z.string().default(''),
});
export type ContentRow = z.infer<typeof ContentRowSchema>;

/** A ContentRow augmented with its live 1-based sheet row number. */
export interface TrackedRow extends ContentRow {
  rowNumber: number;
}

/** Validate slide count against configured bounds. */
export function validateSlideBounds(
  slideCount: number,
  min: number,
  max: number,
): { ok: boolean; reason?: string } {
  if (slideCount < min)
    return { ok: false, reason: `slide count ${slideCount} < MIN_SLIDES ${min}` };
  if (slideCount > max)
    return { ok: false, reason: `slide count ${slideCount} > MAX_SLIDES ${max}` };
  return { ok: true };
}
