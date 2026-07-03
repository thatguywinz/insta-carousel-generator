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
]);
export type Template = z.infer<typeof TemplateSchema>;

/** Visual theme keyed to the post's subject. Detected from content when absent. */
export const ThemeNameSchema = z.enum(['claude', 'openai', 'default']);
export type ThemeName = z.infer<typeof ThemeNameSchema>;

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
  })
  .strict();
export type Slide = z.infer<typeof SlideSchema>;

export const SourceRefSchema = z.object({
  url: z.string().url(),
  description: z.string().max(200),
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
    slides: z.array(SlideSchema).min(3).max(20),
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
