import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, Browser, LaunchOptions } from 'playwright';
import sanitizeHtml from 'sanitize-html';
import { Post, Slide, Template } from '../schemas/post.js';
import { Settings } from '../schemas/settings.js';
import { log } from './logger.js';

/**
 * Deterministic HTML/CSS → 1080×1350 image renderer. Templates provide a
 * consistent visual system via per-template CSS; brand values from the Sheet
 * drive CSS custom properties. Rendering is done headlessly with Chromium.
 */

export const SLIDE_WIDTH = 1080;
export const SLIDE_HEIGHT = 1350;
export const MIN_BODY_FONT_PX = 26;

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
  };
}

function esc(text: string | undefined): string {
  if (!text) return '';
  return sanitizeHtml(text, { allowedTags: [], allowedAttributes: {} });
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
  }
  .kicker { font-size: 30px; font-weight: 700; letter-spacing: 3px;
    text-transform: uppercase; color: var(--c-secondary); margin-bottom: 28px; }
  .headline { font-size: 82px; font-weight: 800; line-height: 1.05;
    letter-spacing: -1.5px; color: var(--c-text); }
  .headline.small { font-size: 64px; }
  .body { font-size: 38px; line-height: 1.4; color: var(--c-text);
    font-weight: 450; }
  .muted { color: var(--c-muted); }
  .content { flex: 1; display: flex; flex-direction: column;
    justify-content: center; gap: 32px; }
  .footer { display: flex; align-items: center; justify-content: space-between;
    font-size: 30px; font-weight: 600; color: var(--c-muted); }
  .handle { color: var(--c-secondary); }
  .badge { display: inline-flex; align-items: center; justify-content: center;
    min-width: 86px; height: 86px; padding: 0 22px; border-radius: 22px;
    background: var(--c-primary); color: var(--c-on-primary);
    font-size: 46px; font-weight: 800; }
  .pagenum { font-variant-numeric: tabular-nums; }
`;

function brandVars(brand: Brand): string {
  const c = brand.colors;
  return `:root{--c-primary:${c.primary};--c-secondary:${c.secondary};--c-accent:${c.accent};--c-bg:${c.background};--c-surface:${c.surface};--c-text:${c.text};--c-muted:${c.textMuted};--c-on-primary:${c.onPrimary};}`;
}

/** Render the inner HTML of a single slide by type. */
function slideBody(slide: Slide, index: number): string {
  const kicker = slide.kicker ? `<div class="kicker">${esc(slide.kicker)}</div>` : '';
  switch (slide.type) {
    case 'cover':
      return `
        <div class="content cover">
          ${kicker || '<div class="kicker">Carousel</div>'}
          <h1 class="headline">${esc(slide.headline)}</h1>
          ${slide.body ? `<p class="body muted">${esc(slide.body)}</p>` : ''}
          <div class="swipe">Swipe →</div>
        </div>`;
    case 'numbered-point':
    case 'step':
      return `
        <div class="content numbered">
          <div class="row">
            <span class="badge">${slide.index ?? index}</span>
            <h2 class="headline small">${esc(slide.headline)}</h2>
          </div>
          ${slide.body ? `<p class="body">${esc(slide.body)}</p>` : ''}
        </div>`;
    case 'myth-reality':
      return `
        <div class="content myth">
          <h2 class="headline small">${esc(slide.headline)}</h2>
          <div class="pair myth-box"><span class="tag">Myth</span><p class="body">${esc(slide.myth)}</p></div>
          <div class="pair reality-box"><span class="tag">Reality</span><p class="body">${esc(slide.reality)}</p></div>
        </div>`;
    case 'mistake-solution':
      return `
        <div class="content mistake">
          <h2 class="headline small">${esc(slide.headline)}</h2>
          <div class="pair mistake-box"><span class="tag">Mistake</span><p class="body">${esc(slide.mistake)}</p></div>
          <div class="pair solution-box"><span class="tag">Do this</span><p class="body">${esc(slide.solution)}</p></div>
        </div>`;
    case 'comparison':
      return `
        <div class="content comparison">
          <h2 class="headline small">${esc(slide.headline)}</h2>
          <div class="cols">
            <div class="col"><div class="col-title">${esc(slide.optionA)}</div><ul>${(slide.pointsA ?? []).map((p) => `<li>${esc(p)}</li>`).join('')}</ul></div>
            <div class="col alt"><div class="col-title">${esc(slide.optionB)}</div><ul>${(slide.pointsB ?? []).map((p) => `<li>${esc(p)}</li>`).join('')}</ul></div>
          </div>
        </div>`;
    case 'checklist':
      return `
        <div class="content checklist">
          <h2 class="headline small">${esc(slide.headline)}</h2>
          <ul class="checks">${(slide.items ?? []).map((p) => `<li><span class="check">✓</span>${esc(p)}</li>`).join('')}</ul>
        </div>`;
    case 'summary':
      return `
        <div class="content summary">
          <div class="kicker">In summary</div>
          <h2 class="headline small">${esc(slide.headline)}</h2>
          ${slide.body ? `<p class="body">${esc(slide.body)}</p>` : ''}
          ${(slide.items ?? []).length ? `<ul class="checks">${(slide.items ?? []).map((p) => `<li><span class="check">✓</span>${esc(p)}</li>`).join('')}</ul>` : ''}
        </div>`;
    case 'cta':
      return `
        <div class="content cta">
          <h2 class="headline">${esc(slide.headline)}</h2>
          ${slide.body ? `<p class="body">${esc(slide.body)}</p>` : ''}
          <div class="cta-pill">${esc(slide.kicker || 'Save & share')}</div>
        </div>`;
    case 'standard-content':
    default:
      return `
        <div class="content standard">
          <h2 class="headline small">${esc(slide.headline)}</h2>
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
): string {
  const footer = `
    <div class="footer">
      <span class="handle">${esc(brand.instagramHandle)}</span>
      <span class="pagenum">${index} / ${total}</span>
    </div>`;
  return `<!doctype html><html lang="${esc(brand.language)}"><head><meta charset="utf-8">
    <style>${BASE_CSS}\n${brandVars(brand)}\n${templateCss}</style></head>
    <body><div class="slide slide-${slide.type}">${slideBody(slide, index)}${footer}</div></body></html>`;
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
  png: Buffer;
  width: number;
  height: number;
  metrics: SlideMetrics;
}

/** In-page measurement script (self-invoking): detects overflow, tiny fonts, missing elements. */
const MEASURE_FN = `(() => {
  const W = ${SLIDE_WIDTH}, H = ${SLIDE_HEIGHT};
  const SKIP = { STYLE: 1, SCRIPT: 1, HEAD: 1, TITLE: 1, META: 1, LINK: 1 };
  const all = Array.from(document.querySelectorAll('.slide *'));
  let minFont = 999;
  const overflowing = [];
  for (const el of all) {
    if (SKIP[el.tagName]) continue;
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

/** Render every slide of a post to PNG buffers at exactly 1080×1350. */
export async function renderPost(post: Post, brand: Brand): Promise<RenderedSlide[]> {
  const templateCss = await loadTemplateCss(post.template);
  let browser: Browser | null = null;
  const out: RenderedSlide[] = [];
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
      const html = buildSlideHtml(slide, i + 1, total, brand, templateCss);
      const page = await context.newPage();
      await page.setViewportSize({ width: SLIDE_WIDTH, height: SLIDE_HEIGHT });
      await page.setContent(html, { waitUntil: 'networkidle' });
      const metrics = (await page.evaluate(MEASURE_FN)) as SlideMetrics;
      const png = await page.screenshot({
        type: 'png',
        clip: { x: 0, y: 0, width: SLIDE_WIDTH, height: SLIDE_HEIGHT },
      });
      out.push({
        index: i + 1,
        type: slide.type,
        png: Buffer.from(png),
        width: SLIDE_WIDTH,
        height: SLIDE_HEIGHT,
        metrics,
      });
      await page.close();
    }
    await context.close();
  } finally {
    if (browser) await browser.close();
  }
  log.info('rendered slides', { count: out.length });
  return out;
}
