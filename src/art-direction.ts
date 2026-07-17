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
 *
 * Design rules every direction follows:
 * - Covers compose the FULL frame (masthead top / headline / deck bottom) —
 *   no floating text block in a void.
 * - `*word*` accent markup (`.hl`) gets a direction-specific graphic move.
 * - Motion-only elements rest OFF-CANVAS so static renders never show a
 *   frozen mid-animation artifact; anything visible at rest is deliberate.
 * - The CTA closer is a designed end-card built ONLY from guaranteed-contrast
 *   role pairs (text/bg inversion or primary/on-primary).
 * - Ghost sequence numerals live inside the clipped decor layer.
 */

export const ART_DIRECTIONS = [
  'signal',
  'editorial',
  'brutalist',
  'spotlight',
  'kinetic',
  'blueprint',
  'poster',
] as const;
export type ArtDirectionName = (typeof ART_DIRECTIONS)[number];

/**
 * SIGNAL is the flagship look and renders on its own dedicated path
 * (`src/signal.ts`) — a generative figure + Geist + flowing motion — so it does
 * not express itself through the `.decor-1/2/3` css/motion the six legacy
 * directions use. The registry entry is a marker: render.ts branches on the
 * name before it ever reads `css`/`motionCss`.
 */
export const SIGNAL_DIRECTION = 'signal';

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
  @keyframes blob-a { 0%,100%{transform:translate(0,0) scale(1)} 50%{transform:translate(72px,-52px) scale(1.12)} }
  @keyframes blob-b { 0%,100%{transform:translate(0,0) scale(1)} 50%{transform:translate(-64px,46px) scale(1.10)} }
  @keyframes spin-slow { from{transform:rotate(0deg)} to{transform:rotate(360deg)} }
  /* Soft focal glow — used sparingly (spotlight/baseline only); strong halos read cheap. */
  @keyframes hl-glow { 0%,100%{text-shadow:0 0 0 color-mix(in srgb, var(--c-accent) 0%, transparent)} 50%{text-shadow:0 0 40px color-mix(in srgb, var(--c-accent) 38%, transparent)} }
  /* Rests at full opacity so frame 0 (the poster) matches the static render. */
  @keyframes kicker-pulse { 0%,100%{opacity:1} 50%{opacity:.55} }
  @keyframes swipe-bob { 0%,100%{transform:translateX(0);opacity:.72} 50%{transform:translateX(16px);opacity:1} }
  /* One-directional light sweep. The bar rests off-canvas (base transform
     translateX(-130%)) and the travel starts/ends off-canvas too (-100% →
     280% of its own width), so static renders never show a frozen beam and
     the loop restart is an invisible teleport. */
  @keyframes ad-sweep { from{transform:translateX(-100%)} to{transform:translateX(280%)} }
  /* Vertical scan line in px (translateY% is relative to the element's own
     height, useless for a 3px line). The element rests hidden above the top;
     -60px→1380px clears the 1350px canvas at both ends. */
  @keyframes ad-scan { from{transform:translateY(-60px)} to{transform:translateY(1380px)} }
  @keyframes ad-breathe { 0%,100%{transform:scale(1);opacity:.72} 50%{transform:scale(1.22);opacity:1} }
  @keyframes ad-drift { 0%,100%{transform:translate(0,0)} 50%{transform:translate(0,-48px)} }
  /* Gentle stage-beam sway for conic light layers; settled upright at t=0. */
  @keyframes ad-sway { 0%,100%{transform:rotate(0deg)} 50%{transform:rotate(6deg)} }
  /* Tiled-pattern crawl: shift by exactly one tile (per-element --crawl) so the
     pattern returns to itself at the seam. Default matches a 60px grid. */
  @keyframes ad-crawl { from{background-position:0 0} to{background-position:0 var(--crawl,-60px)} }
  @keyframes ad-blink { 0%,45%{opacity:1} 50%,95%{opacity:.15} 100%{opacity:1} }
  /* Cover-underline draw: full width at t=0 (a complete poster), retracts and
     redraws mid-loop. Shrink-only, so nothing can clip. */
  @keyframes ad-underline { 0%,100%{transform:scaleX(1)} 45%{transform:scaleX(0.12)} }
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

/** A diagonal light bar sized to sweep across the whole slide. MOTION-ONLY:
 *  it rests off-canvas (translateX(-130%)) so static slides never show a
 *  frozen glare band; ad-sweep carries it through mid-loop. Deliberately
 *  strong — at feed size, after Instagram's compression, a subtle sweep reads
 *  as nothing at all. */
function sweepBar(): string {
  return `background: linear-gradient(100deg, transparent 0%, color-mix(in srgb, var(--c-accent) 42%, transparent) 45%, color-mix(in srgb, #fff 48%, transparent) 50%, color-mix(in srgb, var(--c-accent) 42%, transparent) 55%, transparent 100%); transform: translateX(-130%);`;
}

/**
 * Interior "sparse" slides (numbered/step/standard): a bigger type scale, more
 * vertical rhythm and an optional bottom anchor ornament so a short point never
 * floats in a void. Dense layouts (myth/comparison/checklist pairs) keep the
 * tighter base scale.
 */
function interior(S: string, ornament = ''): string {
  const sel = (suffix: string): string =>
    ['numbered-point', 'standard-content', 'step']
      .map((t) => `${S}.slide-${t} ${suffix}`)
      .join(', ');
  return `
    ${sel('.content')} { gap: 44px; }
    ${sel('.body')} { font-size: 41px; line-height: 1.45; }
    ${ornament ? `${sel('.content::after')} { ${ornament} }` : ''}
  `;
}

/* ─────────────────────────────── EDITORIAL ─────────────────────────────── */
/* Magazine: Fraunces 900 display over structured hairlines, a printed frame,
   an italic accent word, a vertical spine label, paper grain. The cover reads
   like a serious front page, not a slide. */
function editorial(): ResolvedArtDirection {
  const S = '.ad-editorial';
  return {
    name: 'editorial',
    css: `
    ${S} { --g-bg: linear-gradient(180deg, var(--c-bg) 0%, color-mix(in srgb, var(--c-bg) 90%, var(--c-text)) 100%); }
    ${S} .headline { font-family: var(--font-serif); font-weight: 900; letter-spacing: -1.5px; }
    ${S} .headline .hl { font-style: italic; font-weight: 600; color: var(--c-ink-accent); }
    ${S} .body { font-family: var(--font); }
    ${S} .kicker { font-family: var(--font-mono); font-weight: 500; font-size: 26px; letter-spacing: 6px; color: var(--c-muted); background: none; padding: 0; }
    ${S} .decor-1 { inset: 40px; border: 2px solid color-mix(in srgb, var(--c-text) 22%, transparent); }
    ${S} .decor-2 { top: 0; bottom: 0; width: 46%; left: -10%; ${sweepBar()} opacity: .5; }
    ${S} .decor-3 { inset: 0; --crawl: -140px; background: ${GRAIN}; background-size: 140px 140px; opacity: .06; mix-blend-mode: soft-light; }
    ${S} .decor-num { font-family: var(--font-serif); font-weight: 900; font-size: 440px; top: -30px; right: 30px; color: color-mix(in srgb, var(--c-text) 6%, transparent); }
    ${S}.slide-cover .content.cover { justify-content: space-between; padding: 40px 0; }
    ${S}.slide-cover .headline { font-size: 122px; line-height: 1.0; border-top: 2px solid color-mix(in srgb, var(--c-text) 25%, transparent); padding-top: 46px; }
    ${S}.slide-cover .headline::after { content: ''; display: block; width: 132px; height: 5px; margin-top: 44px; background: var(--c-accent); }
    ${S}.slide-cover .content.cover::after { content: 'THE AI BRIEF'; position: absolute; right: -32px; top: 50%; transform: translateY(-50%); writing-mode: vertical-rl; font-family: var(--font-mono); font-size: 26px; letter-spacing: 10px; color: color-mix(in srgb, var(--c-muted) 75%, transparent); }
    ${S}.slide-cover .deck { border-top: 1px solid color-mix(in srgb, var(--c-text) 18%, transparent); padding-top: 34px; gap: 22px; }
    ${S}.slide-cover .body { font-size: 40px; }
    ${S}.slide-cover .swipe { align-self: flex-start; margin-top: 0; padding: 0; border: none; background: none; color: var(--c-muted); font-family: var(--font-mono); font-size: 26px; letter-spacing: 3px; }
    ${S} .headline.small { font-size: 70px; }
    ${S}.slide-cta { --g-bg: linear-gradient(180deg, var(--c-text) 0%, color-mix(in srgb, var(--c-text) 92%, #000) 100%); }
    ${S}.slide-cta .decor-1 { border-color: color-mix(in srgb, var(--c-bg) 28%, transparent); }
    ${S}.slide-cta .decor-num { display: none; }
    ${S}.slide-cta .content.cta { gap: 40px; }
    ${S}.slide-cta .headline { color: var(--c-bg); font-size: 104px; }
    ${S}.slide-cta .headline::after { content: ''; display: block; width: 132px; height: 5px; margin-top: 40px; background: var(--c-accent); }
    ${S}.slide-cta .body { color: color-mix(in srgb, var(--c-bg) 82%, transparent); font-size: 40px; max-width: 820px; }
    ${S}.slide-cta .cta-pill { background: var(--c-bg); color: var(--c-text); font-size: 38px; padding: 24px 48px; }
    ${S}.slide-cta .cta-pill::after { content: ' →'; }
    ${S}.slide-cta .footer, ${S}.slide-cta .handle { color: color-mix(in srgb, var(--c-bg) 70%, transparent); }
    ${interior(S, "content: ''; width: 132px; height: 4px; background: var(--c-accent);")}
    `,
    motionCss: `
      ${S}.slide.motion .decor-2 { animation: ad-sweep 2s linear infinite; }
      ${S}.slide.motion .decor-3 { animation: ad-crawl 2s steps(6) infinite; }
      ${S}.slide.motion.slide-cover .headline::after { animation: ad-underline 2s ease-in-out infinite; transform-origin: 0 50%; }
      ${S}.slide.motion.slide-cta .headline::after { animation: ad-underline 2s ease-in-out infinite; transform-origin: 0 50%; }
      ${S}.slide.motion .swipe { animation: swipe-bob 1s ease-in-out infinite; }
    `,
  };
}

/* ─────────────────────────────── BRUTALIST ─────────────────────────────── */
/* Raw mono, hard grid, square everything, a hard offset type shadow, bracket
   labels. Nothing soft: the "sweep" is a hard accent column, the pulse is a
   blink. */
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
    ${S} .decor-2 { top: 0; bottom: 0; width: 180px; left: 0; background: color-mix(in srgb, var(--c-accent) 26%, transparent); transform: translateX(-130%); }
    ${S} .decor-3 { width: 220px; height: 220px; right: -40px; top: -40px; border: 10px solid var(--c-accent); }
    ${S} .decor-num { font-family: var(--font-mono); font-weight: 700; font-size: 430px; letter-spacing: -20px; top: -60px; right: -10px; color: color-mix(in srgb, var(--c-accent) 16%, transparent); }
    ${S} .headline { font-family: var(--font-display); font-weight: 700; letter-spacing: -1.5px; }
    ${S} .headline .hl { color: var(--c-ink-accent); }
    ${S} .body { font-family: var(--font); }
    ${S} .kicker { font-family: var(--font-mono); font-weight: 700; font-size: 26px; letter-spacing: 3px; text-transform: uppercase; color: var(--c-text); background: none; border: 3px solid var(--c-text); border-radius: 0; padding: 10px 20px; }
    ${S}.slide-cover .content.cover { justify-content: space-between; padding: 30px 0 40px; }
    ${S}.slide-cover .headline { font-family: var(--font-mono); font-weight: 700; font-size: 94px; line-height: 0.98; text-transform: uppercase; letter-spacing: -3px; }
    ${S}.slide-cover .headline .hl { color: var(--c-ink-accent); }
    ${S}.slide-cover .headline::before { content: '/// LIVE FEED'; display: block; font-size: 26px; font-weight: 700; letter-spacing: 6px; color: color-mix(in srgb, var(--c-text) 55%, transparent); margin-bottom: 30px; }
    ${S}.slide-cover .headline::after { content: ''; display: block; width: 180px; height: 12px; margin-top: 34px; background: var(--c-accent); }
    ${S}.slide-cover .deck { gap: 24px; }
    ${S} .badge { border-radius: 0 !important; font-family: var(--font-mono); box-shadow: none !important; }
    ${S} .cta-pill, ${S} .swipe { border-radius: 0 !important; font-family: var(--font-mono); }
    ${S} .headline.small { font-size: 62px; }
    ${S}.slide-cta { --g-bg: var(--c-primary); }
    ${S}.slide-cta .decor-1 {
      background:
        linear-gradient(color-mix(in srgb, var(--c-on-primary) 10%, transparent) 2px, transparent 2px) 0 0 / 100% 120px,
        linear-gradient(90deg, color-mix(in srgb, var(--c-on-primary) 10%, transparent) 2px, transparent 2px) 0 0 / 120px 100%; }
    ${S}.slide-cta .decor-3 { border-color: var(--c-on-primary); opacity: .8; }
    ${S}.slide-cta .headline { font-family: var(--font-mono); text-transform: uppercase; color: var(--c-on-primary); font-size: 92px; letter-spacing: -3px; }
    ${S}.slide-cta .body { color: color-mix(in srgb, var(--c-on-primary) 84%, transparent); font-size: 38px; }
    ${S}.slide-cta .cta-pill { background: var(--c-on-primary); color: var(--c-primary); font-size: 38px; padding: 24px 44px; }
    ${S}.slide-cta .cta-pill::after { content: ' →'; }
    ${S}.slide-cta .footer, ${S}.slide-cta .handle { color: color-mix(in srgb, var(--c-on-primary) 72%, transparent); }
    ${interior(S, "content: ''; width: 64px; height: 16px; background: var(--c-accent);")}
    `,
    motionCss: `
      ${S}.slide.motion .decor-1 { animation: ad-crawl 2s linear infinite; }
      ${S}.slide.motion .decor-2 { animation: ad-sweep 2s steps(8) infinite; }
      ${S}.slide.motion .decor-3 { animation: ad-blink 2s infinite; }
      ${S}.slide.motion .kicker { animation: ad-blink 1s infinite; }
      ${S}.slide.motion.slide-cover .headline::after { animation: ad-underline 2s ease-in-out infinite; transform-origin: 0 50%; }
      ${S}.slide.motion .swipe { animation: swipe-bob 1s ease-in-out infinite; }
    `,
  };
}

/* ─────────────────────────────── SPOTLIGHT ─────────────────────────────── */
/* Dark cinematic stage: twin conic light beams from above (deliberate at
   rest, swaying in motion), a breathing halo, centered oversized grotesk. */
function spotlight(): ResolvedArtDirection {
  const S = '.ad-spotlight';
  return {
    name: 'spotlight',
    css: `
    ${S} { --g-bg:
      radial-gradient(1300px 900px at 50% -6%, color-mix(in srgb, var(--c-accent) 30%, transparent), transparent 56%),
      radial-gradient(1500px 1300px at 50% 46%, transparent 30%, rgba(0,0,0,0.24) 100%),
      var(--c-bg); }
    ${S} .headline { font-family: var(--font-display); font-weight: 700; letter-spacing: -2px; }
    ${S} .headline .hl { color: var(--c-ink-accent); }
    ${S} .body { font-family: var(--font); }
    ${S} .decor-1 { width: 760px; height: 760px; border-radius: 50%; top: -220px; left: 50%; margin-left: -380px;
      background: radial-gradient(circle, color-mix(in srgb, var(--c-accent) 38%, transparent), transparent 62%); }
    ${S} .decor-2 { inset: -30%; transform-origin: 50% 12%;
      background: conic-gradient(from 156deg at 50% 12%,
        transparent 0deg, color-mix(in srgb, var(--c-accent) 26%, transparent) 18deg, transparent 42deg,
        transparent 318deg, color-mix(in srgb, var(--c-accent) 26%, transparent) 342deg, transparent 360deg); }
    ${S} .decor-3 { width: 560px; height: 560px; border-radius: 50%; top: -180px; left: 50%; margin-left: -280px;
      border: 2px solid color-mix(in srgb, var(--c-accent) 30%, transparent); }
    ${S} .decor-num { font-family: var(--font-display); font-weight: 700; font-size: 520px; top: auto; bottom: -140px; right: -50px; color: color-mix(in srgb, var(--c-accent) 9%, transparent); }
    ${S}.slide-cover .content.cover { justify-content: center; align-items: center; text-align: center; gap: 44px; }
    ${S}.slide-cover .headline { font-size: 112px; line-height: 1.02; }
    ${S}.slide-cover .headline::after { content: ''; display: block; width: 120px; height: 5px; margin: 42px auto 0; border-radius: 4px; background: var(--c-accent); }
    ${S}.slide-cover .body { color: var(--c-muted); max-width: 800px; }
    ${S}.slide-cover .deck { align-items: center; gap: 30px; }
    ${S}.slide-cover .swipe { align-self: center; }
    ${S} .headline.small { font-size: 68px; }
    ${S}.slide-cta .content.cta { align-items: center; text-align: center; gap: 40px; }
    ${S}.slide-cta .decor-1 { opacity: 1; background: radial-gradient(circle, color-mix(in srgb, var(--c-accent) 48%, transparent), transparent 64%); }
    ${S}.slide-cta .decor-num { display: none; }
    ${S}.slide-cta .headline { font-size: 104px; }
    ${S}.slide-cta .body { color: var(--c-muted); max-width: 820px; }
    ${S}.slide-cta .cta-pill { align-self: center; background: var(--c-primary); color: var(--c-on-primary); border: 3px solid color-mix(in srgb, var(--c-accent) 60%, transparent); font-size: 38px; padding: 24px 52px; border-radius: 999px; }
    ${S}.slide-cta .cta-pill::after { content: ' →'; }
    ${interior(S)}
    `,
    motionCss: `
      ${S}.slide.motion .decor-1 { animation: ad-breathe 2s ease-in-out infinite; transform-origin: 50% 40%; }
      ${S}.slide.motion .decor-2 { animation: ad-sway 2s ease-in-out infinite; }
      ${S}.slide.motion .decor-3 { animation: ad-drift 2s ease-in-out infinite; }
      ${S}.slide.motion.slide-cover .headline { animation: hl-glow 2s ease-in-out infinite; }
      ${S}.slide.motion.slide-cover .headline::after { animation: ad-underline 2s ease-in-out infinite; transform-origin: 50% 50%; }
      ${S}.slide.motion .swipe { animation: swipe-bob 1s ease-in-out infinite; }
    `,
  };
}

/* ─────────────────────────────── KINETIC ─────────────────────────────── */
/* Type IS the art: Anton condensed uppercase filling the frame edge-to-edge,
   a marker underline on the accent word, an accent slab, a raking light. */
function kinetic(): ResolvedArtDirection {
  const S = '.ad-kinetic';
  return {
    name: 'kinetic',
    css: `
    ${S} { --g-bg: linear-gradient(165deg, var(--c-bg) 0%, color-mix(in srgb, var(--c-bg) 88%, var(--c-primary)) 100%); }
    ${S} .headline { font-family: var(--font-display); font-weight: 700; letter-spacing: -3px; }
    ${S} .headline .hl { color: var(--c-ink-accent); }
    ${S} .body { font-family: var(--font); }
    ${S} .kicker { font-family: var(--font-display); font-weight: 700; font-size: 30px; letter-spacing: 4px; text-transform: uppercase; color: var(--c-on-primary); background: var(--c-primary); padding: 10px 22px; border-radius: 6px; }
    ${S} .decor-1 { width: 680px; height: 680px; border-radius: 50%; right: -240px; bottom: -240px;
      background: radial-gradient(circle, color-mix(in srgb, var(--c-accent) 26%, transparent), transparent 66%); }
    ${S} .decor-2 { top: 0; bottom: 0; width: 50%; left: -14%; ${sweepBar()} opacity: .75; }
    ${S} .decor-3 { width: 420px; height: 420px; right: -150px; top: -150px; background: var(--c-accent); opacity: .16; }
    ${S} .decor-num { font-family: var(--font-condensed); font-weight: 400; font-size: 560px; top: -80px; right: -10px; color: color-mix(in srgb, var(--c-text) 7%, transparent); }
    ${S}.slide-cover .content.cover { justify-content: space-between; padding: 20px 0 30px; }
    ${S}.slide-cover .headline { font-family: var(--font-condensed); font-weight: 400; font-size: 190px; line-height: 0.95; text-transform: uppercase; letter-spacing: 0; }
    ${S}.slide-cover .headline .hl { color: var(--c-ink-accent); }
    ${S}.slide-cover .headline::after { content: ''; display: block; width: 200px; height: 18px; margin-top: 30px; background: var(--c-accent); }
    ${S}.slide-cover .deck { gap: 24px; }
    ${S}.slide-cover .swipe { align-self: flex-start; }
    ${S} .headline.small { font-size: 74px; text-transform: uppercase; letter-spacing: -1px; }
    ${S}.slide-cta { --g-bg: var(--c-primary); }
    ${S}.slide-cta .decor-1 { background: radial-gradient(circle, color-mix(in srgb, var(--c-accent) 40%, transparent), transparent 66%); }
    ${S}.slide-cta .decor-3 { opacity: .35; }
    ${S}.slide-cta .decor-num { display: none; }
    ${S}.slide-cta .content.cta { gap: 36px; }
    ${S}.slide-cta .headline { font-family: var(--font-condensed); font-weight: 400; text-transform: uppercase; color: var(--c-on-primary); font-size: 150px; line-height: 0.95; letter-spacing: 0; }
    ${S}.slide-cta .headline::after { content: ''; display: block; width: 200px; height: 18px; margin-top: 28px; background: var(--c-accent); }
    ${S}.slide-cta .body { color: color-mix(in srgb, var(--c-on-primary) 85%, transparent); font-size: 40px; }
    ${S}.slide-cta .cta-pill { background: var(--c-on-primary); color: var(--c-primary); font-size: 40px; font-weight: 800; padding: 26px 50px; }
    ${S}.slide-cta .cta-pill::after { content: ' →'; }
    ${S}.slide-cta .footer, ${S}.slide-cta .handle { color: color-mix(in srgb, var(--c-on-primary) 72%, transparent); }
    ${interior(S)}
    `,
    motionCss: `
      ${S}.slide.motion .decor-1 { animation: blob-a 2s ease-in-out infinite; }
      ${S}.slide.motion .decor-2 { animation: ad-sweep 2s linear infinite; }
      ${S}.slide.motion.slide-cover .headline::after { animation: ad-underline 2s ease-in-out infinite; transform-origin: 0 50%; }
      ${S}.slide.motion.slide-cta .headline::after { animation: ad-underline 2s ease-in-out infinite; transform-origin: 0 50%; }
      ${S}.slide.motion .kicker { animation: kicker-pulse 2s ease-in-out infinite; }
      ${S}.slide.motion .swipe { animation: swipe-bob 1s ease-in-out infinite; }
    `,
  };
}

/* ─────────────────────────────── BLUEPRINT ─────────────────────────────── */
/* Technical schematic: fine graph grid, corner ticks, mono FIG. annotations,
   a scanning line. Reads like an engineering spec sheet. */
function blueprint(): ResolvedArtDirection {
  const S = '.ad-blueprint';
  return {
    name: 'blueprint',
    css: `
    ${S} { --g-bg: var(--c-bg); }
    ${S} .decor-1 { inset: 0; opacity: .7;
      background:
        linear-gradient(color-mix(in srgb, var(--c-accent) 16%, transparent) 1px, transparent 1px) 0 0 / 100% 60px,
        linear-gradient(90deg, color-mix(in srgb, var(--c-accent) 16%, transparent) 1px, transparent 1px) 0 0 / 60px 100%; }
    ${S} .decor-2 { left: 40px; right: 40px; height: 3px; top: 0; transform: translateY(-60px);
      background: linear-gradient(90deg, transparent 0%, color-mix(in srgb, var(--c-accent) 55%, transparent) 30%, color-mix(in srgb, #fff 45%, transparent) 50%, color-mix(in srgb, var(--c-accent) 55%, transparent) 70%, transparent 100%); }
    ${S} .decor-3 { inset: 40px; border: 2px solid color-mix(in srgb, var(--c-accent) 40%, transparent);
      background:
        linear-gradient(var(--c-accent), var(--c-accent)) 0 0 / 40px 2px no-repeat,
        linear-gradient(var(--c-accent), var(--c-accent)) 0 0 / 2px 40px no-repeat,
        linear-gradient(var(--c-accent), var(--c-accent)) 100% 100% / 40px 2px no-repeat,
        linear-gradient(var(--c-accent), var(--c-accent)) 100% 100% / 2px 40px no-repeat; }
    ${S} .decor-3::before { content: 'FIG. 001'; position: absolute; top: 20px; right: 28px; font-family: var(--font-mono); font-size: 26px; letter-spacing: 4px; color: color-mix(in srgb, var(--c-accent) 65%, var(--c-muted)); }
    ${S} .decor-3::after { content: '1080 × 1350 / 4:5'; position: absolute; bottom: 20px; right: 28px; font-family: var(--font-mono); font-size: 26px; letter-spacing: 4px; color: color-mix(in srgb, var(--c-accent) 45%, var(--c-muted)); }
    ${S} .decor-num::after { content: 'NO.' attr(data-num); }
    ${S} .decor-num { font-family: var(--font-mono); font-weight: 700; font-size: 110px; letter-spacing: 2px; top: 76px; right: 84px; color: color-mix(in srgb, var(--c-accent) 38%, transparent); }
    ${S} .headline { font-family: var(--font-display); font-weight: 700; letter-spacing: -1.5px; }
    ${S} .headline .hl { color: var(--c-ink-accent); text-decoration: underline; text-decoration-thickness: 6px; text-underline-offset: 14px; text-decoration-color: color-mix(in srgb, var(--c-accent) 55%, transparent); }
    ${S} .body { font-family: var(--font); }
    ${S} .kicker { font-family: var(--font-mono); font-weight: 400; font-size: 26px; letter-spacing: 4px; text-transform: uppercase; color: var(--c-ink-accent); background: none; padding: 0; }
    ${S} .kicker::before { content: '+ '; }
    ${S}.slide-cover .content.cover { justify-content: space-between; padding: 40px 24px; }
    ${S}.slide-cover .headline { font-size: 106px; line-height: 1.0; }
    ${S}.slide-cover .headline::after { content: ''; display: block; width: 100%; height: 2px; margin-top: 36px; background: color-mix(in srgb, var(--c-accent) 45%, transparent); }
    ${S}.slide-cover .deck { gap: 24px; }
    ${S}.slide-cover .swipe { align-self: flex-start; font-family: var(--font-mono); background: none; border: 2px solid color-mix(in srgb, var(--c-accent) 45%, transparent); color: var(--c-ink-accent); }
    ${S} .headline.small { font-size: 66px; }
    ${S}.slide-cta .content.cta { justify-content: center; gap: 38px; border: 2px dashed color-mix(in srgb, var(--c-accent) 50%, transparent); padding: 72px; margin: 40px 0; }
    ${S}.slide-cta .decor-num { display: none; }
    ${S}.slide-cta .headline { font-size: 96px; }
    ${S}.slide-cta .headline::before { content: '+ SUBSCRIBE_PATH'; display: block; font-family: var(--font-mono); font-size: 26px; font-weight: 400; letter-spacing: 4px; color: var(--c-ink-accent); margin-bottom: 26px; }
    ${S}.slide-cta .cta-pill { background: none; border: 3px solid var(--c-ink-accent); color: var(--c-ink-accent); font-family: var(--font-mono); border-radius: 0; font-size: 36px; padding: 22px 44px; }
    ${S}.slide-cta .cta-pill::after { content: ' →'; }
    ${interior(
      S,
      "content: '+ + +'; font-family: var(--font-mono); font-size: 28px; letter-spacing: 12px; color: color-mix(in srgb, var(--c-accent) 55%, transparent);",
    )}
    `,
    motionCss: `
      ${S}.slide.motion .decor-1 { animation: ad-crawl 2s linear infinite; }
      ${S}.slide.motion .decor-2 { animation: ad-scan 2s linear infinite; }
      ${S}.slide.motion .decor-3 { animation: kicker-pulse 2s ease-in-out infinite; }
      ${S}.slide.motion.slide-cover .headline::after { animation: ad-underline 2s ease-in-out infinite; transform-origin: 0 50%; }
      ${S}.slide.motion .swipe { animation: swipe-bob 1s ease-in-out infinite; }
    `,
  };
}

/* ─────────────────────────────── POSTER ─────────────────────────────── */
/* Swiss poster: the cover and closer are FULL-BLEED primary color fields with
   Archivo Black knockout type and solid accent geometry — maximum ink on the
   feed. Interiors stay on paper with bold block accents. */
function poster(): ResolvedArtDirection {
  const S = '.ad-poster';
  return {
    name: 'poster',
    css: `
    ${S} { --g-bg: var(--c-bg); }
    ${S} .decor-1 { width: 900px; height: 900px; border-radius: 50%; right: -320px; top: -320px; background: var(--c-primary); opacity: .12; }
    ${S} .decor-2 { width: 560px; height: 560px; left: -200px; bottom: -220px; background: var(--c-accent); opacity: .16; }
    ${S} .decor-3 { left: 0; top: 0; bottom: 0; width: 22px; background: var(--c-accent); }
    ${S} .decor-num { font-family: var(--font-black); font-size: 460px; top: auto; bottom: -110px; left: 40px; right: auto; color: color-mix(in srgb, var(--c-primary) 9%, transparent); }
    ${S} .headline { font-family: var(--font-display); font-weight: 700; letter-spacing: -2.5px; }
    ${S} .headline .hl { color: var(--c-ink-accent); }
    ${S} .body { font-family: var(--font); }
    ${S} .kicker { font-family: var(--font-display); font-weight: 700; font-size: 28px; letter-spacing: 3px; text-transform: uppercase; color: var(--c-on-primary); background: var(--c-primary); padding: 10px 22px; border-radius: 999px; }
    ${S}.slide-cover { --g-bg: var(--c-primary); }
    ${S}.slide-cover .decor-1 { opacity: 1; width: 520px; height: 520px; right: -140px; top: -140px; background: var(--c-accent); }
    ${S}.slide-cover .decor-2 { width: 420px; height: 420px; border-radius: 50%; left: auto; right: -60px; bottom: auto; top: 260px; background: none; border: 3px solid color-mix(in srgb, var(--c-on-primary) 35%, transparent); opacity: 1; }
    ${S}.slide-cover .decor-3 { background: var(--c-accent); }
    ${S}.slide-cover .content.cover { justify-content: space-between; padding: 30px 0 40px; }
    ${S}.slide-cover .masthead .kicker { background: var(--c-on-primary); color: var(--c-primary); }
    ${S}.slide-cover .brandmark span { color: color-mix(in srgb, var(--c-on-primary) 80%, transparent); }
    ${S}.slide-cover .headline { font-family: var(--font-black); font-weight: 400; color: var(--c-on-primary); font-size: 132px; line-height: 0.98; text-transform: uppercase; letter-spacing: -3px; }
    ${S}.slide-cover .headline .hl { color: var(--c-accent); }
    ${S}.slide-cover .headline::after { content: ''; display: block; width: 220px; height: 20px; margin-top: 36px; background: var(--c-accent); }
    ${S}.slide-cover .body { color: color-mix(in srgb, var(--c-on-primary) 82%, transparent); }
    ${S}.slide-cover .deck { gap: 26px; }
    ${S}.slide-cover .swipe { align-self: flex-start; background: var(--c-on-primary); color: var(--c-primary); border: none; }
    ${S}.slide-cover .footer, ${S}.slide-cover .handle { color: color-mix(in srgb, var(--c-on-primary) 75%, transparent); }
    ${S} .headline.small { font-size: 70px; text-transform: uppercase; letter-spacing: -1.5px; }
    ${S}.slide-cta { --g-bg: var(--c-primary); }
    ${S}.slide-cta .decor-1 { opacity: 1; width: 620px; height: 620px; right: -180px; top: auto; bottom: -200px; background: var(--c-accent); }
    ${S}.slide-cta .decor-2 { opacity: 1; width: 400px; height: 400px; border-radius: 50%; left: auto; right: 60px; top: -160px; bottom: auto; background: none; border: 3px solid color-mix(in srgb, var(--c-on-primary) 30%, transparent); }
    ${S}.slide-cta .decor-num { display: none; }
    ${S}.slide-cta .content.cta { gap: 36px; }
    ${S}.slide-cta .headline { font-family: var(--font-black); font-weight: 400; text-transform: uppercase; color: var(--c-on-primary); font-size: 118px; line-height: 0.98; letter-spacing: -2px; }
    ${S}.slide-cta .headline::after { content: ''; display: block; width: 220px; height: 20px; margin-top: 32px; background: var(--c-accent); }
    ${S}.slide-cta .body { color: color-mix(in srgb, var(--c-on-primary) 85%, transparent); font-size: 40px; max-width: 840px; }
    ${S}.slide-cta .cta-pill { background: var(--c-on-primary); color: var(--c-primary); font-size: 40px; font-weight: 800; padding: 26px 52px; }
    ${S}.slide-cta .cta-pill::after { content: ' →'; }
    ${S}.slide-cta .footer, ${S}.slide-cta .handle { color: color-mix(in srgb, var(--c-on-primary) 75%, transparent); }
    ${interior(S)}
    `,
    motionCss: `
      ${S}.slide.motion .decor-1 { animation: ad-drift 2s ease-in-out infinite; }
      ${S}.slide.motion .decor-2 { animation: blob-b 2s ease-in-out infinite; }
      ${S}.slide.motion .decor-3 { animation: kicker-pulse 2s ease-in-out infinite; }
      ${S}.slide.motion.slide-cover .headline::after { animation: ad-underline 2s ease-in-out infinite; transform-origin: 0 50%; }
      ${S}.slide.motion.slide-cta .headline::after { animation: ad-underline 2s ease-in-out infinite; transform-origin: 0 50%; }
      ${S}.slide.motion .swipe { animation: swipe-bob 1s ease-in-out infinite; }
    `,
  };
}

/** Marker entry — SIGNAL renders on its own path; no decor css/motion here. */
function signal(): ResolvedArtDirection {
  return { name: 'signal', css: '', motionCss: '' };
}

const REGISTRY: Record<ArtDirectionName, () => ResolvedArtDirection> = {
  signal,
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

/** Deterministic per-idea rotation across the six legacy directions (SIGNAL
 *  excluded — it is the pinned flagship, not part of the shuffle). Reachable via
 *  the `rotate` / `legacy` pin for accounts that still want a varied feed. */
function legacyRotation(post: { idea_id?: string; idea?: string }): ResolvedArtDirection {
  const legacy = ART_DIRECTIONS.filter((n) => n !== 'signal');
  const seed = post.idea_id || post.idea || 'seed';
  const idx = hashStr(seed) % legacy.length;
  return artDirection(legacy[idx]!);
}

/**
 * Choose the art direction for a post. Precedence:
 *  1. an explicit `post.art_direction` (author's deliberate choice),
 *  2. a pinned `ART_DIRECTION` setting (a specific style name, or
 *     `rotate`/`legacy` for the per-idea shuffle across the six older styles),
 *  3. `auto`/blank/anything else → SIGNAL, the flagship look every live carousel
 *     uses by default.
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
  if (pin === 'rotate' || pin === 'legacy') return legacyRotation(post);
  return artDirection('signal');
}
