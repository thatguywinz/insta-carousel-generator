import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, Browser, LaunchOptions, Page } from 'playwright';
import sanitizeHtml from 'sanitize-html';
import { Post, Slide, Template, ThemeName } from '../schemas/post.js';
import { Settings, MotionSlides } from '../schemas/settings.js';
import { log } from './logger.js';
import { captureFrames, encodeMp4, pauseAndReset, resolveFfmpeg } from './motion.js';
import { fontFaceCss } from './fonts.js';
import {
  resolveArtDirection,
  ResolvedArtDirection,
  MOTION_KEYFRAMES,
  BASELINE_MOTION_CSS,
} from './art-direction.js';

/**
 * Deterministic HTML/CSS → 1080×1350 image renderer. Templates provide a
 * consistent visual system via per-template CSS; brand values from the Sheet
 * drive CSS custom properties. Rendering is done headlessly with Chromium.
 * Slides selected for motion are additionally captured to an animated MP4.
 */

export const SLIDE_WIDTH = 1080;
export const SLIDE_HEIGHT = 1350;
export const MIN_BODY_FONT_PX = 26;
/** Auto-fit floor for the cover headline. Below this the hook stops working, so */
/** we surface a warning to shorten copy rather than shrink further. */
export const HEADLINE_FLOOR_PX = 56;

/** Which slides render as animated MP4s. Mirrors the MOTION_SLIDES setting. */
export type MotionMode = MotionSlides;

/**
 * Decide whether a slide animates. An explicit per-slide `animate` flag always
 * wins; otherwise the MOTION_SLIDES mode decides (the cover is slide index 1).
 */
export function shouldAnimate(slide: Slide, index: number, mode: MotionMode): boolean {
  if (slide.animate === true) return true;
  if (slide.animate === false) return false;
  switch (mode) {
    case 'all':
      return true;
    case 'cover':
    case 'cover+key':
      return index === 1;
    case 'off':
    default:
      return false;
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

export interface Brand {
  brandName: string;
  instagramHandle: string;
  colors: {
    primary: string;
    secondary: string;
    accent: string;
    background: string;
    surface: string;
    text: string;
    textMuted: string;
    onPrimary: string;
  };
  style: string;
  language: string;
  /** Send/save ask from DEFAULT_CTA; used to fill the CTA slide body. */
  defaultCta?: string;
}

interface DefaultBrandFile {
  brandName: string;
  instagramHandle: string;
  colors: Brand['colors'];
  style: string;
  fonts: { heading: string; body: string };
  language: string;
}

function normHex(v: string): string {
  return v.startsWith('#') ? v : `#${v}`;
}

/** Relative luminance (0=black, 1=white) of a hex color. */
function luminance(hex: string): number {
  const h = hex.replace('#', '');
  const full =
    h.length === 3
      ? h
          .split('')
          .map((c) => c + c)
          .join('')
      : h;
  const r = parseInt(full.slice(0, 2), 16) / 255;
  const g = parseInt(full.slice(2, 4), 16) / 255;
  const b = parseInt(full.slice(4, 6), 16) / 255;
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** Saturation-ish spread used to pick the "accent" among candidates. */
function chroma(hex: string): number {
  const h = hex.replace('#', '');
  const full =
    h.length === 3
      ? h
          .split('')
          .map((c) => c + c)
          .join('')
      : h;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  return (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
}

/** Slightly lighten a hex toward white by t (0..1). */
function lighten(hex: string, t: number): string {
  const h = hex.replace('#', '');
  const full =
    h.length === 3
      ? h
          .split('')
          .map((c) => c + c)
          .join('')
      : h;
  const mix = (c: number) => Math.round(c + (255 - c) * t);
  const r = mix(parseInt(full.slice(0, 2), 16));
  const g = mix(parseInt(full.slice(2, 4), 16));
  const b = mix(parseInt(full.slice(4, 6), 16));
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Derive a coherent, readable colour scheme from the brand colours. Roles are
 * assigned by luminance/chroma (not sheet position) so a palette like
 * "navy, white, gold" always yields high-contrast text with the vivid colour as
 * a decorative accent — never white text used as a body colour.
 *
 * Explicit "primary=#..,accent=#.." key/value pairs override role inference.
 */
function parseBrandColors(raw: string, base: Brand['colors']): Brand['colors'] {
  const out = { ...base };
  if (!raw.trim()) return out;

  const parts = raw
    .split(/[,\n;]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const positional: string[] = [];
  const explicit: Record<string, string> = {};
  for (const part of parts) {
    const kv = part.split('=');
    if (kv.length === 2) {
      const key = kv[0]!.trim().toLowerCase();
      const val = kv[1]!.trim();
      if (key in out && /^#?[0-9a-fA-F]{3,8}$/.test(val)) explicit[key] = normHex(val);
    } else if (/^#?[0-9a-fA-F]{3,8}$/.test(part)) {
      positional.push(normHex(part));
    }
  }

  if (positional.length >= 2) {
    const sorted = [...positional].sort((a, b) => luminance(a) - luminance(b));
    const dark = sorted[0]!;
    const light = sorted[sorted.length - 1]!;
    // Accent = the middle/most-chromatic colour that is neither near-black nor near-white.
    const mids = positional.filter((c) => c !== dark && c !== light);
    const accentCandidates = (mids.length ? mids : positional)
      .slice()
      .sort((a, b) => chroma(b) - chroma(a));
    const accent = accentCandidates[0] ?? base.accent;

    const lightIsPaper = luminance(light) > 0.75;
    out.background = lightIsPaper ? light : base.background;
    out.surface = lightIsPaper ? '#FFFFFF' : base.surface;
    out.text = dark;
    out.textMuted = lighten(dark, 0.45);
    out.primary = dark;
    out.secondary = dark; // strong, high-contrast text/decoration
    out.accent = accent; // vivid decorative pops
    out.onPrimary = lightIsPaper ? light : '#FFFFFF';
  } else if (positional.length === 1) {
    out.primary = positional[0]!;
    out.secondary = positional[0]!;
  }

  // Explicit key/value overrides win.
  for (const [k, v] of Object.entries(explicit)) (out as Record<string, string>)[k] = v;
  return out;
}

/** Build the effective brand by layering Sheet settings over defaults. */
export async function loadBrand(settings: Settings): Promise<Brand> {
  const raw = await readFile(path.join(REPO_ROOT, 'brand', 'default-brand.json'), 'utf8');
  const def = JSON.parse(raw) as DefaultBrandFile;
  return {
    brandName: settings.BRAND_NAME.trim() || def.brandName,
    instagramHandle: settings.INSTAGRAM_HANDLE.trim() || def.instagramHandle,
    colors: parseBrandColors(settings.BRAND_COLORS, def.colors),
    style: settings.BRAND_STYLE.trim() || def.style,
    language: settings.POST_LANGUAGE.trim() || def.language,
    defaultCta: settings.DEFAULT_CTA.trim() || undefined,
  };
}

function esc(text: string | undefined): string {
  if (!text) return '';
  return sanitizeHtml(text, { allowedTags: [], allowedAttributes: {} });
}

/**
 * Headline formatter: escape first, then convert `*word*` accent markers into
 * `<em class="hl">` spans each art direction styles as its own graphic move
 * (italic serif, accent slab, ruler underline…). One marked word per headline
 * is the authoring guidance; unmatched asterisks pass through untouched.
 */
function fmtHeadline(text: string | undefined): string {
  return esc(text).replace(/\*([^*\n]+)\*/g, '<em class="hl">$1</em>');
}

/**
 * Topic theming. Each carousel is visually branded to its subject: posts about
 * Claude/Anthropic get a warm cream+clay world, posts about OpenAI/ChatGPT get
 * a near-black+teal world, everything else keeps the premium brand default.
 * A post may pin `theme` explicitly; otherwise it is detected from the
 * content pillar + idea text.
 */

const THEME_KEYWORDS: Array<{ name: ThemeName; pattern: RegExp }> = [
  { name: 'claude', pattern: /\b(claude|anthropic)\b/i },
  { name: 'openai', pattern: /\b(codex|openai|chatgpt|gpt\d*|sora|dall-?e)\b/i },
  { name: 'gemini', pattern: /\b(gemini|deepmind|bard)\b/i },
  { name: 'grok', pattern: /\b(grok|xai|x\.ai)\b/i },
  { name: 'meta', pattern: /\b(meta\s?ai|llama\d*|meta['’]s|facebook\s?ai)\b/i },
  { name: 'mistral', pattern: /\b(mistral|mixtral|le\s?chat)\b/i },
  // Generic attention theme — matched last so a named vendor always wins.
  {
    name: 'breaking',
    pattern: /\b(breaking|just\s?(shipped|launched|dropped|released)|leaked|rumou?r)\b/i,
  },
];

/** Pick the visual theme for a post (explicit `theme` field wins). */
export function detectTheme(
  post: Pick<Post, 'content_pillar' | 'idea'> & { theme?: ThemeName },
): ThemeName {
  if (post.theme) return post.theme;
  const text = `${post.content_pillar} ${post.idea}`;
  for (const { name, pattern } of THEME_KEYWORDS) {
    if (pattern.test(text)) return name;
  }
  return 'default';
}

export interface ResolvedTheme {
  name: ThemeName;
  /** Theme CSS layered between brand vars and template CSS. */
  css: string;
  /** data-URI of the subject's mark (cover + footer), when the theme has one. */
  logo?: string;
  /** Wordmark label rendered beside the mark on the cover. */
  label?: string;
}

const logoCache = new Map<string, string | undefined>();

/** Load an assets/brand/<name>.svg mark as a data URI (cached; missing → undefined). */
function logoDataUri(name: string): string | undefined {
  if (!logoCache.has(name)) {
    try {
      const svg = readFileSync(path.join(REPO_ROOT, 'assets', 'brand', `${name}.svg`));
      logoCache.set(name, `data:image/svg+xml;base64,${svg.toString('base64')}`);
    } catch {
      log.warn('brand mark svg missing', { name });
      logoCache.set(name, undefined);
    }
  }
  return logoCache.get(name);
}

/**
 * Themes are PALETTE-ONLY. They define the `--c-*` color roles for a subject and
 * nothing else — the background TREATMENT and DECOR belong to the art direction
 * (src/art-direction.ts), which is injected after the theme. This keeps the
 * three axes (theme=color, template=layout, art-direction=style) independent and
 * removes the old per-theme "rainbow" gradient washes.
 */

/** Claude / Anthropic: warm cream palette, clay accents. */
function claudeThemeCss(): string {
  return `
  :root {
    --c-primary: #1F1E1D; --c-secondary: #CC785C; --c-accent: #D97757;
    --c-bg: #F0EEE6; --c-surface: #FFFDF8; --c-text: #1F1E1D;
    --c-muted: #6E6558; --c-on-primary: #F5EDE3;
    --c-ink-accent: #A84E30;
    --c-on-primary-accent: #E7A98C;
    --c-card: #FFFDF8; --c-card-border: #E6D8C4;
    --c-bad-bg: #F6E2D8; --c-bad-border: #C25E3C; --c-bad-tag: #A84E30;
    --c-good-bg: #EAEDDF; --c-good-border: #77875D; --c-good-tag: #55673F;
  }
  `;
}

/** OpenAI / ChatGPT: near-black with a teal accent. */
function openaiThemeCss(): string {
  return `
  :root {
    --c-primary: #10A37F; --c-secondary: #10A37F; --c-accent: #10A37F;
    --c-bg: #0D0D0D; --c-surface: #151517; --c-text: #FFFFFF;
    --c-muted: #A6ADBB; --c-on-primary: #05231A;
    --c-ink-accent: #2FC79E;
    --c-on-primary-accent: #05231A;
    --c-card: rgba(255,255,255,0.05); --c-card-border: rgba(255,255,255,0.16);
    --c-bad-bg: rgba(240,84,84,0.12); --c-bad-border: #F26D6D; --c-bad-tag: #FF9B8E;
    --c-good-bg: rgba(16,163,127,0.14); --c-good-border: #10A37F; --c-good-tag: #2FC79E;
  }
  `;
}

/** Google Gemini: cool white with a blue accent (purple as ink-accent). */
function geminiThemeCss(): string {
  return `
  :root {
    --c-primary: #1B1B28; --c-secondary: #4285F4; --c-accent: #9B72CB;
    --c-bg: #F6F8FE; --c-surface: #FFFFFF; --c-text: #1B1B28;
    --c-muted: #5B6072; --c-on-primary: #FFFFFF;
    --c-ink-accent: #6C4BB6; --c-on-primary-accent: #C9B6E8;
    --c-card: #FFFFFF; --c-card-border: #E1E6F5;
    --c-bad-bg: #FCEBEC; --c-bad-border: #D64545; --c-bad-tag: #C23838;
    --c-good-bg: #EAF1FC; --c-good-border: #4285F4; --c-good-tag: #2C64C8;
  }
  `;
}

/** xAI Grok: stark near-black with a cool electric accent. */
function grokThemeCss(): string {
  return `
  :root {
    --c-primary: #F3F4F6; --c-secondary: #E7E9EA; --c-accent: #7FB2FF;
    --c-bg: #0A0A0C; --c-surface: #16171A; --c-text: #F3F4F6;
    --c-muted: #A6ADBB; --c-on-primary: #0A0A0C;
    --c-ink-accent: #9CC4FF; --c-on-primary-accent: #0A0A0C;
    --c-card: rgba(255,255,255,0.05); --c-card-border: rgba(255,255,255,0.16);
    --c-bad-bg: rgba(240,84,84,0.12); --c-bad-border: #F26D6D; --c-bad-tag: #FF9B8E;
    --c-good-bg: rgba(127,178,255,0.14); --c-good-border: #7FB2FF; --c-good-tag: #9CC4FF;
  }
  `;
}

/** Meta AI: light with a bold Meta-blue accent. */
function metaThemeCss(): string {
  return `
  :root {
    --c-primary: #101828; --c-secondary: #0866FF; --c-accent: #0866FF;
    --c-bg: #F4F7FF; --c-surface: #FFFFFF; --c-text: #101828;
    --c-muted: #566074; --c-on-primary: #FFFFFF;
    --c-ink-accent: #0A5AE0; --c-on-primary-accent: #CFE0FF;
    --c-card: #FFFFFF; --c-card-border: #DCE6FB;
    --c-bad-bg: #FCEBEC; --c-bad-border: #D64545; --c-bad-tag: #C23838;
    --c-good-bg: #E7F0FF; --c-good-border: #0866FF; --c-good-tag: #0A5AE0;
  }
  `;
}

/** Mistral: dark with a warm flame accent. */
function mistralThemeCss(): string {
  return `
  :root {
    --c-primary: #FBF3EC; --c-secondary: #FA520F; --c-accent: #FF8205;
    --c-bg: #0E0B09; --c-surface: #1A1512; --c-text: #FBF3EC;
    --c-muted: #C6A992; --c-on-primary: #1A0E06;
    --c-ink-accent: #FF8A3D; --c-on-primary-accent: #2A1305;
    --c-card: rgba(255,255,255,0.05); --c-card-border: rgba(255,180,120,0.20);
    --c-bad-bg: rgba(240,84,84,0.12); --c-bad-border: #F26D6D; --c-bad-tag: #FF9B8E;
    --c-good-bg: rgba(255,130,5,0.14); --c-good-border: #FF8205; --c-good-tag: #FF8A3D;
  }
  `;
}

/** Generic high-attention "AI news / breaking" look: red on near-black. */
function breakingThemeCss(): string {
  return `
  :root {
    --c-primary: #FFFFFF; --c-secondary: #FF3B30; --c-accent: #FF3B30;
    --c-bg: #0C0C0E; --c-surface: #17171B; --c-text: #FFFFFF;
    --c-muted: #B4B9C6; --c-on-primary: #14060A;
    --c-ink-accent: #FF6A61; --c-on-primary-accent: #14060A;
    --c-card: rgba(255,255,255,0.05); --c-card-border: rgba(255,255,255,0.16);
    --c-bad-bg: rgba(255,59,48,0.14); --c-bad-border: #FF3B30; --c-bad-tag: #FF6A61;
    --c-good-bg: rgba(255,212,0,0.14); --c-good-border: #FFD400; --c-good-tag: #F2C200;
  }
  `;
}

/** Default: no third-party subject — the brand palette (from brandVars) stands
 *  alone; the art direction supplies background treatment + decor. */
const DEFAULT_THEME_CSS = '';

/** Resolve the full theme (palette CSS + embedded mark) for a post. */
export function resolveTheme(
  post: Pick<Post, 'content_pillar' | 'idea'> & { theme?: ThemeName },
): ResolvedTheme {
  const name = detectTheme(post);
  switch (name) {
    case 'claude':
      return { name, css: claudeThemeCss(), logo: logoDataUri('claude'), label: 'Claude' };
    case 'openai':
      return { name, css: openaiThemeCss(), logo: logoDataUri('openai'), label: 'OpenAI' };
    case 'gemini':
      return { name, css: geminiThemeCss(), logo: logoDataUri('gemini'), label: 'Gemini' };
    case 'grok':
      return { name, css: grokThemeCss(), logo: logoDataUri('grok'), label: 'Grok' };
    case 'meta':
      return { name, css: metaThemeCss(), logo: logoDataUri('meta'), label: 'Meta AI' };
    case 'mistral':
      return { name, css: mistralThemeCss(), logo: logoDataUri('mistral'), label: 'Mistral' };
    case 'breaking':
      return { name, css: breakingThemeCss(), logo: logoDataUri('breaking'), label: 'AI News' };
    default:
      return { name: 'default', css: DEFAULT_THEME_CSS };
  }
}

async function loadTemplateCss(template: Template): Promise<string> {
  const p = path.join(REPO_ROOT, 'templates', template, 'template.css');
  try {
    return await readFile(p, 'utf8');
  } catch {
    log.warn('template css missing, using base only', { template });
    return '';
  }
}

const BASE_CSS = `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: ${SLIDE_WIDTH}px; height: ${SLIDE_HEIGHT}px; overflow: hidden; }
  :root {
    --c-primary: #1A2B4A; --c-secondary: #3B6FE0; --c-accent: #F2B705;
    --c-bg: #FBFAF7; --c-surface: #FFFFFF; --c-text: #141B2E;
    --c-muted: #5A6478; --c-on-primary: #FFFFFF;
    /* Accent when used AS text/glyphs (themes tune it for contrast). */
    --c-ink-accent: var(--c-secondary);
    /* Accent readable on top of --c-primary fills. */
    --c-on-primary-accent: var(--c-accent);
    /* Slide background gradient; themes always override. */
    --g-bg: linear-gradient(180deg, var(--c-bg), var(--c-bg));
    /* Card + paired-box semantic colors (myth/reality, mistake/solution…). */
    --c-card: var(--c-surface); --c-card-border: #E4E7EE;
    --c-bad-bg: #FBEDEC; --c-bad-border: #D64545; --c-bad-tag: #C23838;
    --c-good-bg: #E9F3EC; --c-good-border: #2E9E5B; --c-good-tag: #24824A;
    --font: 'Inter', -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    --pad: 96px; --safe: 72px;
  }
  body {
    font-family: var(--font);
    background: var(--c-bg); color: var(--c-text);
    -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility;
  }
  .slide {
    position: relative; width: ${SLIDE_WIDTH}px; height: ${SLIDE_HEIGHT}px;
    padding: var(--pad); display: flex; flex-direction: column;
    background: var(--g-bg); overflow: hidden;
  }
  /* Decorative art layer: clipped to the slide, always behind content. */
  .decor-layer { position: absolute; inset: 0; overflow: hidden;
    pointer-events: none; z-index: 0; }
  .decor { position: absolute; }
  .content, .footer { position: relative; z-index: 1; }
  /* Chip-styled kickers must hug their content, never stretch as flex items. */
  .kicker { font-size: 30px; font-weight: 700; letter-spacing: 3px;
    text-transform: uppercase; color: var(--c-ink-accent); margin-bottom: 28px;
    align-self: flex-start; }
  /* Cover masthead: brandmark + kicker share one row instead of stacking. */
  .masthead { display: flex; align-items: center; gap: 28px; }
  .masthead .kicker { margin-bottom: 0; }
  /* Cover deck: body + swipe travel together as the bottom group. */
  .deck { display: flex; flex-direction: column; gap: 26px; }
  .headline { font-size: 82px; font-weight: 800; line-height: 1.05;
    letter-spacing: -1.5px; color: var(--c-text); }
  .headline.small { font-size: 64px; }
  /* Accent-word markup: *word* in a headline renders as an <em class="hl">. */
  .headline .hl { font-style: normal; color: var(--c-ink-accent); }
  /* Ghost slide numeral (numbered/step): lives in the clipped decor layer. */
  .decor-num::after { content: attr(data-num); }
  .decor-num { font-weight: 800; font-size: 520px; line-height: 1;
    right: -30px; top: -70px;
    color: color-mix(in srgb, var(--c-text) 7%, transparent); }
  .body { font-size: 38px; line-height: 1.4; color: var(--c-text);
    font-weight: 450; }
  /* Myth/Reality and Mistake/Do-this labels. Base sizing so these slide types
     stay legible under ANY template — template CSS layers color on top. Without
     this, a myth-reality/mistake-solution slide rendered under a non-matching
     template falls back to the 16px default and fails the min-font gate. */
  .tag { display: inline-block; font-size: 28px; font-weight: 800;
    letter-spacing: 2px; text-transform: uppercase; }
  .muted { color: var(--c-muted); }
  .content { flex: 1; display: flex; flex-direction: column;
    justify-content: center; gap: 32px; }
  .footer { display: flex; align-items: center; justify-content: space-between;
    font-size: 30px; font-weight: 600; color: var(--c-muted); flex-shrink: 0; }
  .handle { color: var(--c-ink-accent); }
  .footer-logo { width: 42px; height: 42px; display: block; opacity: 0.9; }
  .brandmark { display: flex; align-items: center; gap: 18px; }
  .brandmark img { width: 60px; height: 60px; display: block; }
  .brandmark span { font-size: 30px; font-weight: 700; letter-spacing: 1px;
    color: var(--c-muted); }
  .badge { display: inline-flex; align-items: center; justify-content: center;
    min-width: 86px; height: 86px; padding: 0 22px; border-radius: 22px;
    background: var(--c-primary); color: var(--c-on-primary);
    font-size: 46px; font-weight: 800; }
  .pagenum { font-variant-numeric: tabular-nums; }
`;

/**
 * Motion. The shared keyframes (MOTION_KEYFRAMES) plus each art direction's own
 * `.slide.motion …` selectors live in src/art-direction.ts. They are injected
 * only on animated slides, so static renders stay byte-identical, and every
 * animation is "settled at t=0" (frame 0 == the still poster the overflow
 * validator sees) and seamless over a 2s loop. When no art direction is present
 * (older callers/tests), BASELINE_MOTION_CSS provides the prior behavior.
 */

function brandVars(brand: Brand): string {
  const c = brand.colors;
  return `:root{--c-primary:${c.primary};--c-secondary:${c.secondary};--c-accent:${c.accent};--c-bg:${c.background};--c-surface:${c.surface};--c-text:${c.text};--c-muted:${c.textMuted};--c-on-primary:${c.onPrimary};}`;
}

/** Render the inner HTML of a single slide by type. */
function slideBody(slide: Slide, index: number, brand: Brand, theme?: ResolvedTheme): string {
  const brandmark =
    theme?.logo && theme.label
      ? `<div class="brandmark"><img src="${theme.logo}" alt=""><span>${esc(theme.label)}</span></div>`
      : '';
  switch (slide.type) {
    case 'cover': {
      // Masthead: brandmark + kicker share one row; a kicker that merely
      // repeats the theme label ("AI News" twice) is dropped.
      const kickerText = (slide.kicker ?? '').trim();
      const dupLabel =
        !!theme?.label && kickerText.toLowerCase() === theme.label.trim().toLowerCase();
      const kickerChip =
        kickerText && !dupLabel ? `<div class="kicker">${esc(kickerText)}</div>` : '';
      const masthead =
        brandmark || kickerChip ? `<div class="masthead">${brandmark}${kickerChip}</div>` : '';
      return `
        <div class="content cover">
          ${masthead}
          <h1 class="headline">${fmtHeadline(slide.headline)}</h1>
          <div class="deck">
            ${slide.body ? `<p class="body muted">${esc(slide.body)}</p>` : ''}
            <div class="swipe">Swipe →</div>
          </div>
        </div>`;
    }
    case 'numbered-point':
    case 'step':
      return `
        <div class="content numbered">
          <div class="row">
            <span class="badge">${slide.index ?? index}</span>
            <h2 class="headline small">${fmtHeadline(slide.headline)}</h2>
          </div>
          ${slide.body ? `<p class="body">${esc(slide.body)}</p>` : ''}
        </div>`;
    case 'myth-reality':
      return `
        <div class="content myth">
          <h2 class="headline small">${fmtHeadline(slide.headline)}</h2>
          <div class="pair myth-box"><span class="tag">Myth</span><p class="body">${esc(slide.myth)}</p></div>
          <div class="pair reality-box"><span class="tag">Reality</span><p class="body">${esc(slide.reality)}</p></div>
        </div>`;
    case 'mistake-solution':
      return `
        <div class="content mistake">
          <h2 class="headline small">${fmtHeadline(slide.headline)}</h2>
          <div class="pair mistake-box"><span class="tag">Mistake</span><p class="body">${esc(slide.mistake)}</p></div>
          <div class="pair solution-box"><span class="tag">Do this</span><p class="body">${esc(slide.solution)}</p></div>
        </div>`;
    case 'comparison':
      return `
        <div class="content comparison">
          <h2 class="headline small">${fmtHeadline(slide.headline)}</h2>
          <div class="cols">
            <div class="col"><div class="col-title">${esc(slide.optionA)}</div><ul>${(slide.pointsA ?? []).map((p) => `<li>${esc(p)}</li>`).join('')}</ul></div>
            <div class="col alt"><div class="col-title">${esc(slide.optionB)}</div><ul>${(slide.pointsB ?? []).map((p) => `<li>${esc(p)}</li>`).join('')}</ul></div>
          </div>
        </div>`;
    case 'checklist':
      return `
        <div class="content checklist">
          <h2 class="headline small">${fmtHeadline(slide.headline)}</h2>
          <ul class="checks">${(slide.items ?? []).map((p) => `<li><span class="check">✓</span>${esc(p)}</li>`).join('')}</ul>
        </div>`;
    case 'summary':
      return `
        <div class="content summary">
          <div class="kicker">In summary</div>
          <h2 class="headline small">${fmtHeadline(slide.headline)}</h2>
          ${slide.body ? `<p class="body">${esc(slide.body)}</p>` : ''}
          ${(slide.items ?? []).length ? `<ul class="checks">${(slide.items ?? []).map((p) => `<li><span class="check">✓</span>${esc(p)}</li>`).join('')}</ul>` : ''}
        </div>`;
    case 'cta': {
      // Wire the Sheet's DEFAULT_CTA (a send/save ask) as the body fallback;
      // the pill is a short action label (the long sentence would overflow a
      // button). The ask is a send or save, never a follow — sends-per-reach
      // is the ranking signal this account optimizes for.
      const ctaBody = slide.body || brand.defaultCta || '';
      const ctaPill = slide.kicker || 'Send this';
      return `
        <div class="content cta">
          <h2 class="headline">${fmtHeadline(slide.headline)}</h2>
          ${ctaBody ? `<p class="body">${esc(ctaBody)}</p>` : ''}
          <div class="cta-pill">${esc(ctaPill)}</div>
        </div>`;
    }
    case 'standard-content':
    default:
      return `
        <div class="content standard">
          <h2 class="headline small">${fmtHeadline(slide.headline)}</h2>
          ${slide.body ? `<p class="body">${esc(slide.body)}</p>` : ''}
        </div>`;
  }
}

/** Build a full standalone HTML document for one slide. */
export function buildSlideHtml(
  slide: Slide,
  index: number,
  total: number,
  brand: Brand,
  templateCss: string,
  theme?: ResolvedTheme,
  animate = false,
  art?: ResolvedArtDirection,
): string {
  const footer = `
    <div class="footer">
      <span class="handle">${esc(brand.instagramHandle)}</span>
      ${theme?.logo ? `<img class="footer-logo" src="${theme.logo}" alt="">` : ''}
      <span class="pagenum">${index} / ${total}</span>
    </div>`;
  // Ghost sequence numeral for sparse interior slides; rendered inside the
  // clipped decor layer so it can bleed without tripping overflow measurement.
  const ghostNum =
    slide.type === 'numbered-point' || slide.type === 'step'
      ? `<div class="decor decor-num" data-num="${String(slide.index ?? index).padStart(2, '0')}"></div>`
      : '';
  const decor = `
    <div class="decor-layer" aria-hidden="true">
      <div class="decor decor-1"></div>
      <div class="decor decor-2"></div>
      <div class="decor decor-3"></div>
      ${ghostNum}
    </div>`;
  // Cascade: fonts → base → brand palette → theme palette → template layout →
  // art-direction style → motion (art-direction owns background + decor + type).
  const artCss = art ? `\n${art.css}` : '';
  const motionCss = animate
    ? `\n${MOTION_KEYFRAMES}\n${art ? art.motionCss : BASELINE_MOTION_CSS}`
    : '';
  const artClass = art ? ` ad-${art.name}` : '';
  const motionClass = animate ? ' motion' : '';
  return `<!doctype html><html lang="${esc(brand.language)}"><head><meta charset="utf-8">
    <style>${fontFaceCss()}\n${BASE_CSS}\n${brandVars(brand)}\n${theme?.css ?? DEFAULT_THEME_CSS}\n${templateCss}${artCss}${motionCss}</style></head>
    <body><div class="slide slide-${slide.type}${artClass}${motionClass}">${decor}${slideBody(slide, index, brand, theme)}${footer}</div></body></html>`;
}

export interface SlideMetrics {
  scrollWidth: number;
  scrollHeight: number;
  hasOverflow: boolean;
  minFontPx: number;
  overflowingSelectors: string[];
  hasHeadline: boolean;
  hasHandle: boolean;
  hasPageNumber: boolean;
}

export interface RenderedSlide {
  index: number;
  type: string;
  /** Always a real PNG: the slide for static items, the poster (t=0 frame) for */
  /** motion items. Keeps sharp validation, the preview <img>, and PNG inspection */
  /** working uniformly. */
  png: Buffer;
  /** Present only for animated slides: the encoded H.264 MP4 to publish. */
  mp4?: Buffer;
  width: number;
  height: number;
  metrics: SlideMetrics;
}

/**
 * In-page cover-headline auto-fit. Templates set the cover headline size with
 * higher-specificity CSS loaded last, so we shrink via an inline style (which
 * wins) — never the base rule. Only shrinks when the natural size overflows, so
 * covers that already fit stay byte-identical. Floors at HEADLINE_FLOOR_PX; if
 * copy still overflows there, MEASURE_FN reports OVERFLOW and validation blocks,
 * signalling the author to shorten rather than rendering an illegibly small hook.
 */
const AUTOFIT_FN = `(async () => {
  const W = ${SLIDE_WIDTH}, H = ${SLIDE_HEIGHT}, FLOOR = ${HEADLINE_FLOOR_PX};
  try { await document.fonts.ready; } catch (e) {}
  const el = document.querySelector('.slide-cover .headline');
  if (!el) return { fitted: false };
  // A giant headline can also squeeze or push the rest of the column (deck,
  // footer) out of frame, so fitting means EVERY content element stays inside
  // the canvas — not just the headline box.
  const fits = () => {
    const all = [el, ...document.querySelectorAll('.content *, .footer, .footer *')];
    for (const n of all) {
      const r = n.getBoundingClientRect();
      if (r.width > 0 && (r.right > W + 1.5 || r.bottom > H + 1.5 || r.left < -1.5 || r.top < -1.5)) {
        return false;
      }
    }
    return document.body.scrollWidth <= W + 1 && document.body.scrollHeight <= H + 1;
  };
  if (fits()) return { fitted: false };
  const start = parseFloat(getComputedStyle(el).fontSize) || 96;
  let lo = FLOOR, hi = start, best = FLOOR;
  for (let i = 0; i < 14; i++) {
    const mid = (lo + hi) / 2;
    el.style.fontSize = mid + 'px';
    if (fits()) { best = mid; lo = mid; } else { hi = mid; }
  }
  el.style.fontSize = best + 'px';
  return { fitted: true, px: Math.round(best), floored: best <= FLOOR + 0.5 };
})()`;

/** In-page measurement script (self-invoking): detects overflow, tiny fonts, missing elements. */
const MEASURE_FN = `(() => {
  const W = ${SLIDE_WIDTH}, H = ${SLIDE_HEIGHT};
  const SKIP = { STYLE: 1, SCRIPT: 1, HEAD: 1, TITLE: 1, META: 1, LINK: 1 };
  const all = Array.from(document.querySelectorAll('.slide *'));
  let minFont = 999;
  const overflowing = [];
  for (const el of all) {
    if (SKIP[el.tagName]) continue;
    // Decorative shapes intentionally bleed past the canvas and are clipped
    // by the .decor-layer; they carry no text and are not layout overflow.
    if (el.closest('.decor-layer')) continue;
    const cs = getComputedStyle(el);
    const fs = parseFloat(cs.fontSize);
    const hasText = el.textContent && el.textContent.trim().length > 0;
    if (hasText && el.children.length === 0 && fs > 0) minFont = Math.min(minFont, fs);
    const r = el.getBoundingClientRect();
    if (r.width > 0 && (r.right > W + 1.5 || r.bottom > H + 1.5 || r.left < -1.5 || r.top < -1.5)) {
      overflowing.push(el.className || el.tagName);
    }
  }
  const body = document.body;
  return {
    scrollWidth: body.scrollWidth,
    scrollHeight: body.scrollHeight,
    hasOverflow: body.scrollWidth > W + 1 || body.scrollHeight > H + 1 || overflowing.length > 0,
    minFontPx: minFont === 999 ? 0 : Math.round(minFont),
    overflowingSelectors: overflowing.slice(0, 6),
    hasHeadline: !!document.querySelector('.headline'),
    hasHandle: !!document.querySelector('.handle'),
    hasPageNumber: !!document.querySelector('.pagenum'),
  };
})()`;

/**
 * Resolve a usable Chromium executable. In managed environments the browser is
 * pre-installed and Playwright's pinned build may differ, so we point at the
 * provided binary via env override or the standard pre-install path, falling
 * back to Playwright's own managed browser when neither exists.
 */
function resolveExecutablePath(): string | undefined {
  const candidates = [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
    process.env.CHROMIUM_PATH,
    '/opt/pw-browsers/chromium',
  ].filter((c): c is string => !!c);
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return undefined;
}

export interface RenderOptions {
  /** Which slides to capture as animated MP4s. Defaults to 'off' (image-only). */
  motion?: MotionMode;
  /** ART_DIRECTION setting: `auto` (rotate per idea) or a pinned style name. */
  artDirection?: string;
}

/**
 * Render every slide to a 1080×1350 PNG. Slides selected by `opts.motion` are
 * additionally captured to a seamless H.264 MP4; their PNG is the poster frame.
 */
export async function renderPost(
  post: Post,
  brand: Brand,
  opts: RenderOptions = {},
): Promise<RenderedSlide[]> {
  const templateCss = await loadTemplateCss(post.template);
  const theme = resolveTheme(post);
  const art = resolveArtDirection(post, opts.artDirection);
  const motionMode: MotionMode = opts.motion ?? 'off';
  const animateFlags = post.slides.map((s, i) => shouldAnimate(s, i + 1, motionMode));
  const anyMotion = animateFlags.some(Boolean);
  const ffmpegPath = anyMotion ? resolveFfmpeg() : '';
  log.info('theme resolved', {
    theme: theme.name,
    template: post.template,
    artDirection: art.name,
    motion: motionMode,
    motionSlides: animateFlags.filter(Boolean).length,
  });
  let browser: Browser | null = null;
  const out: RenderedSlide[] = [];
  const clip = { width: SLIDE_WIDTH, height: SLIDE_HEIGHT };
  try {
    const launchOpts: LaunchOptions = {
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--force-color-profile=srgb'],
    };
    const exe = resolveExecutablePath();
    if (exe) launchOpts.executablePath = exe;
    browser = await chromium.launch(launchOpts);
    const context = await browser.newContext({
      viewport: { width: SLIDE_WIDTH, height: SLIDE_HEIGHT },
      deviceScaleFactor: 1,
    });
    const total = post.slides.length;
    for (let i = 0; i < post.slides.length; i++) {
      const slide = post.slides[i]!;
      const animate = animateFlags[i]!;
      const html = buildSlideHtml(slide, i + 1, total, brand, templateCss, theme, animate, art);
      const page: Page = await context.newPage();
      await page.setViewportSize(clip);
      await page.setContent(html, { waitUntil: 'networkidle' });
      await page.evaluate(AUTOFIT_FN);

      if (animate) {
        // Measure and capture from the settled t=0 frame.
        await pauseAndReset(page);
        const metrics = (await page.evaluate(MEASURE_FN)) as SlideMetrics;
        const frames = await captureFrames(page, clip);
        const mp4 = await encodeMp4(frames, ffmpegPath);
        out.push({
          index: i + 1,
          type: slide.type,
          png: frames[0]!,
          mp4,
          width: SLIDE_WIDTH,
          height: SLIDE_HEIGHT,
          metrics,
        });
      } else {
        const metrics = (await page.evaluate(MEASURE_FN)) as SlideMetrics;
        const png = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, ...clip } });
        out.push({
          index: i + 1,
          type: slide.type,
          png: Buffer.from(png),
          width: SLIDE_WIDTH,
          height: SLIDE_HEIGHT,
          metrics,
        });
      }
      await page.close();
    }
    await context.close();
  } finally {
    if (browser) await browser.close();
  }
  log.info('rendered slides', { count: out.length, motion: out.filter((s) => s.mp4).length });
  return out;
}
