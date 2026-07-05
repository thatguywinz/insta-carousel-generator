/**
 * Art direction — the third visual axis, independent of theme (palette) and
 * template (content layout). An art direction owns TYPOGRAPHY, the background
 * TREATMENT, DECOR geometry and a MOTION personality, all expressed through the
 * theme's palette variables (`--c-*`) and the embedded font variables
 * (`--font*`). It is injected LAST in the cascade (after theme + template), so
 * it wins on equal specificity; every rule is scoped under `.ad-<name>`.
 *
 * The goal: every post looks like a different, deliberately-designed piece —
 * bold, minimal, artistic — never the same gradient-washed template twice, and
 * never a rainbow. Rotate the direction per post (see `resolveArtDirection`).
 */

export const ART_DIRECTIONS = [
  'editorial',
  'brutalist',
  'spotlight',
  'kinetic',
  'blueprint',
  'poster',
] as const;
export type ArtDirectionName = (typeof ART_DIRECTIONS)[number];

export interface ResolvedArtDirection {
  name: ArtDirectionName;
  /** Palette-driven CSS: fonts, --g-bg treatment, decor, cover styling. */
  css: string;
  /** `.slide.motion …` rules for this direction. Uses MOTION_KEYFRAMES. */
  motionCss: string;
}

/** Monochrome film grain as an inline SVG data-URI (no external asset). */
const GRAIN =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")";

/**
 * Shared motion keyframes, injected once whenever any slide animates. Every
 * keyframe is "settled at t=0" (frame 0 == the resting still that becomes the
 * poster and passes the overflow check) and seamless over a 2s loop: either
 * `0% == 100%`, or the moving element is fully off-canvas at both ends so the
 * loop restart is invisible. Content transforms stay ≤ 1.0 (breathe down, not
 * up) so nothing clips mid-loop; the big moves live on clipped `.decor`.
 */
export const MOTION_KEYFRAMES = `
  @keyframes bg-shimmer { 0%{background-position:0% 50%} 50%{background-position:100% 50%} 100%{background-position:0% 50%} }
  @keyframes blob-a { 0%,100%{transform:translate(0,0) scale(1)} 50%{transform:translate(46px,-34px) scale(1.08)} }
  @keyframes blob-b { 0%,100%{transform:translate(0,0) scale(1)} 50%{transform:translate(-40px,30px) scale(1.07)} }
  @keyframes spin-slow { from{transform:rotate(0deg)} to{transform:rotate(360deg)} }
  @keyframes hl-glow { 0%,100%{text-shadow:0 0 0 color-mix(in srgb, var(--c-accent) 0%, transparent)} 50%{text-shadow:0 0 40px color-mix(in srgb, var(--c-accent) 55%, transparent)} }
  @keyframes kicker-pulse { 0%,100%{opacity:.78} 50%{opacity:1} }
  @keyframes swipe-bob { 0%,100%{transform:translateX(0);opacity:.72} 50%{transform:translateX(16px);opacity:1} }
  /* One-directional light sweep; the bar (≤50% wide, ~-14% start) is fully
     off-canvas at BOTH ends (-100% → 280% of its own width) so the loop
     restart is an invisible teleport, not a pop. */
  @keyframes ad-sweep { from{transform:translateX(-100%)} to{transform:translateX(280%)} }
  /* Vertical scan line in px (translateY% is relative to the element's own
     height, useless for a 3px line). The element sits at top:0; -60px→1380px
     clears above the top and below the 1350px bottom at both ends. */
  @keyframes ad-scan { from{transform:translateY(-60px)} to{transform:translateY(1380px)} }
  @keyframes ad-breathe { 0%,100%{transform:scale(1);opacity:.72} 50%{transform:scale(1.14);opacity:1} }
  @keyframes ad-drift { 0%,100%{transform:translate(0,0)} 50%{transform:translate(0,-26px)} }
  /* Tiled-pattern crawl: shift by exactly one tile (per-element --crawl) so the
     pattern returns to itself at the seam. Default matches a 60px grid. */
  @keyframes ad-crawl { from{background-position:0 0} to{background-position:0 var(--crawl,-60px)} }
  @keyframes ad-blink { 0%,45%{opacity:1} 50%,95%{opacity:.15} 100%{opacity:1} }
`;

/**
 * Baseline motion for the no-art-direction path (kept so pre-existing callers /
 * tests that render without an art direction still animate). Real renders always
 * resolve an art direction and use its richer `motionCss`.
 */
export const BASELINE_MOTION_CSS = `
  .slide.motion { background-size: 200% 200%; animation: bg-shimmer 2s ease-in-out infinite; }
  .slide.motion .decor-1 { animation: blob-a 2s ease-in-out infinite; }
  .slide.motion .decor-2 { animation: blob-b 2s ease-in-out infinite; }
  .slide.motion.slide-cover .headline { animation: hl-glow 2s ease-in-out infinite; }
  .slide.motion .kicker { animation: kicker-pulse 2s ease-in-out infinite; }
  .slide.motion .swipe { animation: swipe-bob 1s ease-in-out infinite; }
`;

/** A soft diagonal light bar sized to sweep across the whole slide (decor). */
function sweepBar(): string {
  return `background: linear-gradient(100deg, transparent 0%, color-mix(in srgb, var(--c-accent) 26%, transparent) 45%, color-mix(in srgb, #fff 30%, transparent) 50%, color-mix(in srgb, var(--c-accent) 26%, transparent) 55%, transparent 100%);`;
}

/* ─────────────────────────────── EDITORIAL ─────────────────────────────── */
/* Magazine: high-contrast serif display, generous whitespace, one hairline
   accent, a thin printed frame, flat tonal paper + faint grain. */
function editorial(): ResolvedArtDirection {
  const S = '.ad-editorial';
  return {
    name: 'editorial',
    css: `
    ${S} { --g-bg: linear-gradient(180deg, var(--c-bg) 0%, color-mix(in srgb, var(--c-bg) 90%, var(--c-text)) 100%); }
    ${S} .headline { font-family: var(--font-serif); font-weight: 600; letter-spacing: -1px; }
    ${S} .body { font-family: var(--font); }
    ${S} .kicker { font-family: var(--font-mono); font-weight: 500; font-size: 26px; letter-spacing: 6px; color: var(--c-muted); background: none; padding: 0; }
    ${S} .decor-1 { inset: 40px; border: 2px solid color-mix(in srgb, var(--c-text) 22%, transparent); }
    ${S} .decor-2 { top: 0; bottom: 0; width: 46%; left: -10%; ${sweepBar()} opacity: .5; }
    ${S} .decor-3 { inset: 0; --crawl: -140px; background: ${GRAIN}; background-size: 140px 140px; opacity: .05; mix-blend-mode: multiply; }
    ${S}.slide-cover .content.cover { justify-content: center; gap: 34px; }
    ${S}.slide-cover .headline { font-size: 112px; line-height: 1.0; }
    ${S}.slide-cover .headline::after { content: ''; display: block; width: 132px; height: 4px; margin-top: 40px; background: var(--c-accent); }
    ${S}.slide-cover .swipe { align-self: flex-start; margin-top: 6px; padding: 0; border: none; background: none; color: var(--c-muted); font-family: var(--font-mono); font-size: 26px; letter-spacing: 3px; }
    ${S} .headline.small { font-size: 60px; }
    `,
    motionCss: `
      ${S}.slide.motion .decor-2 { animation: ad-sweep 2s linear infinite; }
      ${S}.slide.motion .decor-3 { animation: ad-crawl 2s steps(6) infinite; }
      ${S}.slide.motion.slide-cover .headline { animation: hl-glow 2s ease-in-out infinite; }
      ${S}.slide.motion .swipe { animation: swipe-bob 1s ease-in-out infinite; }
    `,
  };
}

/* ─────────────────────────────── BRUTALIST ─────────────────────────────── */
/* Raw mono, hard grid, square everything, high-contrast blocks, bracket labels. */
function brutalist(): ResolvedArtDirection {
  const S = '.ad-brutalist';
  return {
    name: 'brutalist',
    css: `
    ${S} { --g-bg: var(--c-bg); }
    ${S} .decor-1 { inset: 0; opacity: .5; --crawl: -120px;
      background:
        linear-gradient(color-mix(in srgb, var(--c-text) 8%, transparent) 2px, transparent 2px) 0 0 / 100% 120px,
        linear-gradient(90deg, color-mix(in srgb, var(--c-text) 8%, transparent) 2px, transparent 2px) 0 0 / 120px 100%; }
    ${S} .decor-2 { top: 0; bottom: 0; width: 40%; left: -8%; ${sweepBar()} opacity: .35; }
    ${S} .decor-3 { width: 220px; height: 220px; right: -40px; top: -40px; border: 10px solid var(--c-accent); }
    ${S} .headline { font-family: var(--font-display); font-weight: 700; letter-spacing: -1.5px; }
    ${S} .body { font-family: var(--font); }
    ${S} .kicker { font-family: var(--font-mono); font-weight: 700; font-size: 26px; letter-spacing: 3px; text-transform: uppercase; color: var(--c-text); background: none; border: 3px solid var(--c-text); border-radius: 0; padding: 10px 20px; display: inline-block; }
    ${S}.slide-cover .content.cover { justify-content: flex-end; gap: 30px; padding-bottom: 40px; }
    ${S}.slide-cover .headline { font-family: var(--font-mono); font-weight: 700; font-size: 92px; line-height: 0.98; text-transform: uppercase; letter-spacing: -3px; }
    ${S}.slide-cover .headline::after { content: ''; display: block; width: 180px; height: 12px; margin-top: 30px; background: var(--c-accent); }
    ${S} .badge { border-radius: 0 !important; font-family: var(--font-mono); box-shadow: none !important; }
    ${S} .cta-pill, ${S} .swipe { border-radius: 0 !important; font-family: var(--font-mono); }
    ${S} .headline.small { font-size: 56px; }
    `,
    motionCss: `
      ${S}.slide.motion .decor-1 { animation: ad-crawl 2s linear infinite; }
      ${S}.slide.motion .decor-2 { animation: ad-sweep 2s linear infinite; }
      ${S}.slide.motion .decor-3 { animation: ad-blink 2s infinite; }
      ${S}.slide.motion .kicker { animation: ad-blink 1s infinite; }
    `,
  };
}

/* ─────────────────────────────── SPOTLIGHT ─────────────────────────────── */
/* Dark cinematic stage: one accent glow from above, deep in-palette vignette,
   centered oversized grotesk, a breathing focal halo. */
function spotlight(): ResolvedArtDirection {
  const S = '.ad-spotlight';
  return {
    name: 'spotlight',
    css: `
    ${S} { --g-bg:
      radial-gradient(1300px 900px at 50% -6%, color-mix(in srgb, var(--c-accent) 34%, transparent), transparent 56%),
      radial-gradient(1500px 1300px at 50% 46%, transparent 30%, rgba(0,0,0,0.24) 100%),
      var(--c-bg); }
    ${S} .headline { font-family: var(--font-display); font-weight: 700; letter-spacing: -2px; }
    ${S} .body { font-family: var(--font); }
    ${S} .decor-1 { width: 760px; height: 760px; border-radius: 50%; top: -220px; left: 50%; margin-left: -380px;
      background: radial-gradient(circle, color-mix(in srgb, var(--c-accent) 40%, transparent), transparent 62%); }
    ${S} .decor-2 { top: 0; bottom: 0; width: 44%; left: -12%; ${sweepBar()} opacity: .55; }
    ${S} .decor-3 { width: 640px; height: 640px; border-radius: 50%; top: 40px; left: 50%; margin-left: -320px;
      border: 2px solid color-mix(in srgb, var(--c-accent) 30%, transparent); }
    ${S}.slide-cover .content.cover { justify-content: center; align-items: center; text-align: center; gap: 34px; }
    ${S}.slide-cover .brandmark { justify-content: center; }
    ${S}.slide-cover .kicker { align-self: center; }
    ${S}.slide-cover .headline { font-size: 108px; line-height: 1.02; }
    ${S}.slide-cover .headline::after { content: ''; display: block; width: 120px; height: 5px; margin: 40px auto 0; border-radius: 4px; background: var(--c-accent); }
    ${S}.slide-cover .body { color: var(--c-muted); max-width: 800px; }
    ${S}.slide-cover .swipe { align-self: center; }
    ${S} .headline.small { font-size: 60px; }
    `,
    motionCss: `
      ${S}.slide.motion .decor-1 { animation: ad-breathe 2s ease-in-out infinite; transform-origin: 50% 40%; }
      ${S}.slide.motion .decor-2 { animation: ad-sweep 2s linear infinite; }
      ${S}.slide.motion .decor-3 { animation: ad-drift 2s ease-in-out infinite; }
      ${S}.slide.motion.slide-cover .headline { animation: hl-glow 2s ease-in-out infinite; }
      ${S}.slide.motion .swipe { animation: swipe-bob 1s ease-in-out infinite; }
    `,
  };
}

/* ─────────────────────────────── KINETIC ─────────────────────────────── */
/* Type IS the art: oversized expanded grotesk, edge-to-edge, tight tracking,
   a bold accent slab, a light sweep that rakes the letters. */
function kinetic(): ResolvedArtDirection {
  const S = '.ad-kinetic';
  return {
    name: 'kinetic',
    css: `
    ${S} { --g-bg: linear-gradient(165deg, var(--c-bg) 0%, color-mix(in srgb, var(--c-bg) 88%, var(--c-primary)) 100%); }
    ${S} .headline { font-family: var(--font-display); font-weight: 700; letter-spacing: -3px; }
    ${S} .body { font-family: var(--font); }
    ${S} .kicker { font-family: var(--font-display); font-weight: 700; font-size: 30px; letter-spacing: 4px; text-transform: uppercase; color: var(--c-on-primary); background: var(--c-primary); padding: 10px 22px; border-radius: 6px; display: inline-block; }
    ${S} .decor-1 { width: 680px; height: 680px; border-radius: 50%; right: -240px; bottom: -240px;
      background: radial-gradient(circle, color-mix(in srgb, var(--c-accent) 26%, transparent), transparent 66%); }
    ${S} .decor-2 { top: 0; bottom: 0; width: 50%; left: -14%; ${sweepBar()} opacity: .6; }
    ${S} .decor-3 { width: 420px; height: 420px; right: -150px; top: -150px; background: var(--c-accent); opacity: .16; }
    ${S}.slide-cover .content.cover { justify-content: center; gap: 26px; }
    ${S}.slide-cover .headline { font-size: 150px; line-height: 0.92; text-transform: uppercase; letter-spacing: -5px; }
    ${S}.slide-cover .headline::after { content: ''; display: block; width: 200px; height: 18px; margin-top: 26px; background: var(--c-accent); }
    ${S}.slide-cover .swipe { align-self: flex-start; }
    ${S} .headline.small { font-size: 64px; text-transform: uppercase; letter-spacing: -1.5px; }
    `,
    motionCss: `
      ${S}.slide.motion .decor-1 { animation: blob-a 2s ease-in-out infinite; }
      ${S}.slide.motion .decor-2 { animation: ad-sweep 2s linear infinite; }
      ${S}.slide.motion.slide-cover .headline { animation: hl-glow 2s ease-in-out infinite; }
      ${S}.slide.motion .kicker { animation: kicker-pulse 2s ease-in-out infinite; }
    `,
  };
}

/* ─────────────────────────────── BLUEPRINT ─────────────────────────────── */
/* Technical schematic: fine graph grid, corner ticks, mono annotations, a
   scanning line. Reads like an engineering spec sheet. */
function blueprint(): ResolvedArtDirection {
  const S = '.ad-blueprint';
  return {
    name: 'blueprint',
    css: `
    ${S} { --g-bg: var(--c-bg); }
    ${S} .decor-1 { inset: 0; opacity: .6;
      background:
        linear-gradient(color-mix(in srgb, var(--c-accent) 12%, transparent) 1px, transparent 1px) 0 0 / 100% 60px,
        linear-gradient(90deg, color-mix(in srgb, var(--c-accent) 12%, transparent) 1px, transparent 1px) 0 0 / 60px 100%; }
    ${S} .decor-2 { left: 40px; right: 40px; height: 3px; top: 0; ${sweepBar()} opacity: .7; }
    ${S} .decor-3 { inset: 40px; border: 2px solid color-mix(in srgb, var(--c-accent) 40%, transparent);
      background:
        linear-gradient(var(--c-accent), var(--c-accent)) 0 0 / 40px 2px no-repeat,
        linear-gradient(var(--c-accent), var(--c-accent)) 0 0 / 2px 40px no-repeat,
        linear-gradient(var(--c-accent), var(--c-accent)) 100% 100% / 40px 2px no-repeat,
        linear-gradient(var(--c-accent), var(--c-accent)) 100% 100% / 2px 40px no-repeat; }
    ${S} .headline { font-family: var(--font-display); font-weight: 700; letter-spacing: -1.5px; }
    ${S} .body { font-family: var(--font); }
    ${S} .kicker { font-family: var(--font-mono); font-weight: 400; font-size: 26px; letter-spacing: 4px; text-transform: uppercase; color: var(--c-ink-accent); background: none; padding: 0; }
    ${S} .kicker::before { content: '+ '; }
    ${S}.slide-cover .content.cover { justify-content: center; gap: 30px; padding: 24px; }
    ${S}.slide-cover .headline { font-size: 104px; line-height: 1.0; }
    ${S}.slide-cover .headline::after { content: ''; display: block; width: 100%; height: 2px; margin-top: 34px; background: color-mix(in srgb, var(--c-accent) 45%, transparent); }
    ${S}.slide-cover .swipe { align-self: flex-start; font-family: var(--font-mono); background: none; border: 2px solid color-mix(in srgb, var(--c-accent) 45%, transparent); color: var(--c-ink-accent); }
    ${S} .headline.small { font-size: 58px; }
    `,
    motionCss: `
      ${S}.slide.motion .decor-1 { animation: ad-crawl 2s linear infinite; }
      ${S}.slide.motion .decor-2 { animation: ad-scan 2s linear infinite; }
      ${S}.slide.motion .decor-3 { animation: kicker-pulse 2s ease-in-out infinite; }
      ${S}.slide.motion.slide-cover .headline { animation: hl-glow 2s ease-in-out infinite; }
    `,
  };
}

/* ─────────────────────────────── POSTER ─────────────────────────────── */
/* Swiss poster: bold flat color blocks (primary + accent geometry), oversized
   grotesk, high contrast, big shapes that parallax. */
function poster(): ResolvedArtDirection {
  const S = '.ad-poster';
  return {
    name: 'poster',
    css: `
    ${S} { --g-bg: var(--c-bg); }
    ${S} .decor-1 { width: 900px; height: 900px; border-radius: 50%; right: -320px; top: -320px; background: var(--c-primary); opacity: .12; }
    ${S} .decor-2 { width: 560px; height: 560px; left: -200px; bottom: -220px; background: var(--c-accent); opacity: .16; }
    ${S} .decor-3 { left: 0; top: 0; bottom: 0; width: 22px; background: var(--c-accent); }
    ${S} .headline { font-family: var(--font-display); font-weight: 700; letter-spacing: -2.5px; }
    ${S} .body { font-family: var(--font); }
    ${S} .kicker { font-family: var(--font-display); font-weight: 700; font-size: 28px; letter-spacing: 3px; text-transform: uppercase; color: var(--c-on-primary); background: var(--c-primary); padding: 10px 22px; border-radius: 999px; display: inline-block; }
    ${S}.slide-cover .content.cover { justify-content: flex-end; gap: 28px; padding-bottom: 48px; }
    ${S}.slide-cover .headline { font-size: 128px; line-height: 0.95; text-transform: uppercase; letter-spacing: -4px; }
    ${S}.slide-cover .headline::after { content: ''; display: block; width: 220px; height: 20px; margin-top: 32px; background: var(--c-accent); }
    ${S}.slide-cover .swipe { align-self: flex-start; background: var(--c-primary); color: var(--c-on-primary); border: none; }
    ${S} .headline.small { font-size: 62px; text-transform: uppercase; letter-spacing: -1.5px; }
    `,
    motionCss: `
      ${S}.slide.motion .decor-1 { animation: ad-drift 2s ease-in-out infinite; }
      ${S}.slide.motion .decor-2 { animation: blob-b 2s ease-in-out infinite; }
      ${S}.slide.motion .decor-3 { animation: kicker-pulse 2s ease-in-out infinite; }
      ${S}.slide.motion.slide-cover .headline { animation: hl-glow 2s ease-in-out infinite; }
      ${S}.slide.motion .swipe { animation: swipe-bob 1s ease-in-out infinite; }
    `,
  };
}

const REGISTRY: Record<ArtDirectionName, () => ResolvedArtDirection> = {
  editorial,
  brutalist,
  spotlight,
  kinetic,
  blueprint,
  poster,
};

/** CSS + motion for a named art direction. */
export function artDirection(name: ArtDirectionName): ResolvedArtDirection {
  return REGISTRY[name]();
}

function isArtDirectionName(v: string): v is ArtDirectionName {
  return (ART_DIRECTIONS as readonly string[]).includes(v);
}

/** Small deterministic string hash (FNV-1a) for stable per-idea seeding. */
function hashStr(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Choose the art direction for a post. Precedence:
 *  1. an explicit `post.art_direction` (author's deliberate choice),
 *  2. a pinned `ART_DIRECTION` setting (a specific style name),
 *  3. `auto`/blank → a deterministic pick seeded by `idea_id` so every idea
 *     gets a stable-but-varied style with no external state.
 */
export function resolveArtDirection(
  post: { idea_id?: string; idea?: string; art_direction?: string },
  setting?: string,
): ResolvedArtDirection {
  if (post.art_direction && isArtDirectionName(post.art_direction)) {
    return artDirection(post.art_direction);
  }
  const pin = (setting ?? 'auto').trim().toLowerCase();
  if (isArtDirectionName(pin)) return artDirection(pin);
  const seed = post.idea_id || post.idea || 'seed';
  const idx = hashStr(seed) % ART_DIRECTIONS.length;
  return artDirection(ART_DIRECTIONS[idx]!);
}
