/**
 * SIGNAL — the flagship art direction, rendered on its own path.
 *
 * A near-black material field, Geist (modern neo-grotesque) display type with a
 * gold accent word, and — the originality engine — a GENERATIVE FIGURE derived
 * from the post's own argument that evolves across the deck:
 *   fan(n)     one -> many        parallelism, a launch, a breakdown into points
 *   merge(n)   many -> one        coordination cost, consolidation, "the tax"
 *   lanes(n)   parallel, clean    independence, separation
 *   steps(n)   a rising stair     a method, stages, compounding
 *   field      ghost field only   a quiet beat / list + comparison layouts
 *
 * Motion: a bright signal comet flows along every strand (outward on a fan,
 * inward to the merge node, up the stair). Settled at t=0 — the strands are
 * fully drawn at rest so frame 0 is a clean poster — and seamless over a 2s loop
 * (the dash period equals the normalised path length, so one sweep returns to an
 * identical frame). Captured through the shared pipeline in src/motion.ts.
 *
 * This module owns a COMPLETE slide document (fonts + layout + figure + motion),
 * parallel to buildSlideHtml. render.ts branches here when the resolved art
 * direction is `signal`. It deliberately does not import from render.ts (keeps
 * the module graph acyclic); shared types are imported type-only.
 */
import sanitizeHtml from 'sanitize-html';
import { fontFaceCss } from './fonts.js';
import type { Slide } from '../schemas/post.js';
import type { Brand } from './render.js';
import type { ResolvedTheme } from './render.js';

const W = 1080;
const H = 1350;

const AMBER = '#F0A83C';
const AMBER_DEEP = '#B4691A';
const HOT = '#FFE9C2';

/** The figure owns the lower band and bleeds off both edges; it stops short of
 *  the caption/footer lockup so no trace runs under the mono furniture. */
const PLOT = { top: 640, bottom: 1120, left: -40, right: 1120 };

export type FigureKind = 'fan' | 'merge' | 'lanes' | 'steps' | 'field';
interface Figure {
  kind: FigureKind;
  n: number;
  seed: number;
}

function esc(text: string | undefined): string {
  if (!text) return '';
  return sanitizeHtml(text, { allowedTags: [], allowedAttributes: {} });
}

/** Escape, then turn `*word*` into a gold accent span. One marker per headline. */
function fmtHeadline(text: string | undefined): string {
  return esc(text).replace(/\*([^*\n]+)\*/g, '<em class="hl">$1</em>');
}

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Small deterministic string hash (FNV-1a) for stable per-slide seeding. */
function hashStr(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function lane(i: number, n: number): number {
  const span = PLOT.bottom - PLOT.top;
  return PLOT.top + span * ((i + 0.5) / n);
}

/** The hero paths, per figure kind. Each is the claim, drawn. */
function paths(f: Figure): string[] {
  const midY = (PLOT.top + PLOT.bottom) / 2;
  const out: string[] = [];
  if (f.kind === 'fan') {
    for (let i = 0; i < f.n; i++) {
      const y = lane(i, f.n);
      out.push(`M ${PLOT.left} ${midY} C 190 ${midY}, 300 ${y}, 560 ${y} L ${PLOT.right} ${y}`);
    }
  } else if (f.kind === 'merge') {
    for (let i = 0; i < f.n; i++) {
      const y = lane(i, f.n);
      out.push(
        `M ${PLOT.left} ${midY} C 150 ${midY}, 240 ${y}, 430 ${y} C 640 ${y}, 720 ${midY}, 880 ${midY} L ${PLOT.right} ${midY}`,
      );
    }
  } else if (f.kind === 'lanes') {
    for (let i = 0; i < f.n; i++) {
      const y = lane(i, f.n);
      out.push(`M ${PLOT.left} ${y} L ${PLOT.right} ${y}`);
    }
  } else if (f.kind === 'steps') {
    const span = PLOT.bottom - PLOT.top;
    let d = `M ${PLOT.left} ${PLOT.bottom}`;
    for (let i = 0; i < f.n; i++) {
      const x0 = 60 + i * (940 / f.n);
      const x1 = 60 + (i + 1) * (940 / f.n);
      const y = PLOT.bottom - span * ((i + 1) / f.n);
      d += ` L ${x0} ${y} L ${x1} ${y}`;
    }
    out.push(d + ` L ${PLOT.right} ${PLOT.top}`);
  }
  return out;
}

function nodes(f: Figure): Array<{ x: number; y: number; label: string }> {
  if (f.kind === 'fan' || f.kind === 'lanes') {
    return Array.from({ length: f.n }, (_, i) => ({
      x: 830,
      y: lane(i, f.n),
      label: String(i + 1).padStart(2, '0'),
    }));
  }
  if (f.kind === 'merge') {
    return [{ x: 880, y: (PLOT.top + PLOT.bottom) / 2, label: 'MERGE' }];
  }
  return [];
}

/**
 * The figure as SVG: a STATIC layer (finished figure == poster) and a MOTION
 * layer (the travelling comet). `pathLength="1000"` normalises every strand so
 * one dash pattern reads identically across curves of different length; the
 * comets are hidden on static (non-motion) renders so posters stay clean.
 */
function figureSvg(f: Figure): string {
  const r = rng(f.seed);

  // Ghost traces — material depth (the difference between a diagram and an image).
  const ghostCount = f.kind === 'field' ? 30 : 44;
  const ghosts: string[] = [];
  for (let g = 0; g < ghostCount; g++) {
    const y0 = PLOT.top - 60 + r() * (PLOT.bottom - PLOT.top + 120);
    const y1 = PLOT.top - 60 + r() * (PLOT.bottom - PLOT.top + 120);
    ghosts.push(
      `<path d="M ${PLOT.left} ${y0} C 300 ${y0}, 620 ${y1}, ${PLOT.right} ${y1}" fill="none" stroke="${AMBER}" stroke-width="${0.6 + r() * 1.1}" opacity="${0.035 + r() * 0.05}"/>`,
    );
  }

  const hero = paths(f);
  const bloom = hero
    .map(
      (d) =>
        `<path d="${d}" fill="none" stroke="${AMBER}" stroke-width="20" opacity=".30" filter="url(#sig-glow)"/>`,
    )
    .join('');
  const core = hero
    .map(
      (d) =>
        `<path d="${d}" fill="none" stroke="url(#sig-stroke)" stroke-width="6.5" stroke-linecap="round"/>`,
    )
    .join('');

  const N = Math.max(hero.length, 1);
  const cometBloom = hero
    .map((d, i) => {
      const o0 = -Math.round((i / N) * 1000);
      return `<path class="pulse-bloom" style="--o0:${o0}px" pathLength="1000" d="${d}" fill="none" stroke="${AMBER}" stroke-width="17" stroke-linecap="round" filter="url(#sig-glow)"/>`;
    })
    .join('');
  const cometCore = hero
    .map((d, i) => {
      const o0 = -Math.round((i / N) * 1000);
      return `<path class="pulse-core" style="--o0:${o0}px" pathLength="1000" d="${d}" fill="none" stroke="${HOT}" stroke-width="7.5" stroke-linecap="round"/>`;
    })
    .join('');

  const marks = nodes(f)
    .map(
      (n) =>
        `<circle class="node" cx="${n.x}" cy="${n.y}" r="13" fill="#07090D" stroke="${AMBER}" stroke-width="4"/>` +
        (n.label.length > 2
          ? `<text x="${n.x}" y="${n.y - 34}" fill="${AMBER}" font-family="Space Mono" font-size="22" letter-spacing="3" text-anchor="middle">${n.label}</text>`
          : `<text x="${n.x - 4}" y="${n.y - 30}" fill="${AMBER}" font-family="Space Mono" font-size="21" letter-spacing="2" text-anchor="middle">${n.label}</text>`),
    )
    .join('');

  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid slice">
    <defs>
      <filter id="sig-glow" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="14"/></filter>
      <linearGradient id="sig-stroke" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="${AMBER_DEEP}"/>
        <stop offset=".45" stop-color="${AMBER}"/>
        <stop offset="1" stop-color="#FFD79A"/>
      </linearGradient>
    </defs>
    <g class="ghosts">${ghosts.join('')}</g>
    <g class="bloom">${bloom}</g>
    <g class="core">${core}</g>
    <g class="comet">${cometBloom}${cometCore}</g>
    <g class="nodes">${marks}</g>
  </svg>`;
}

/* ─────────────────────────── figure selection ─────────────────────────── */

const HERO_TYPES = new Set([
  'cover',
  'numbered-point',
  'step',
  'standard-content',
  'cta',
  'summary',
]);

/** Which figure carries a slide's argument. Explicit `slide.figure` wins;
 *  otherwise inferred from slide type, position, and a keyword scan of the copy. */
function figureFor(slide: Slide, index: number): Figure {
  const seed = hashStr(`${slide.type}:${index}:${slide.headline}`);
  const explicit = (slide as { figure?: string }).figure;
  const nOverride = (slide as { figure_n?: number }).figure_n;
  const text = `${slide.headline} ${slide.body ?? ''}`.toLowerCase();

  const mk = (kind: FigureKind, n: number): Figure => ({ kind, n: nOverride ?? n, seed });

  if (explicit && explicit !== 'auto') {
    const k = explicit as FigureKind;
    if (k === 'fan' || k === 'merge' || k === 'lanes') return mk(k, 6);
    if (k === 'steps') return mk('steps', 4);
    if (k === 'field') return mk('field', 0);
  }

  // Layout-heavy slide types get a quiet field so the content owns the frame.
  if (!HERO_TYPES.has(slide.type)) return mk('field', 0);

  if (slide.type === 'cover') return mk('fan', 6);
  if (slide.type === 'cta' || slide.type === 'summary') return mk('lanes', 6);

  // Interior single-idea slides: infer from the argument.
  if (/\b(cost|tax|expensive|price|merge|converge|combin|consolidat|collid|overhead)/.test(text))
    return mk('merge', 6);
  if (/\b(independ|parallel|separate|isolat|no.crossing|lane|on its own|never touch)/.test(text))
    return mk('lanes', 6);
  if (/\b(step|move|method|stage|first|then|next|process|scope|four|three|two)/.test(text))
    return mk('steps', 4);
  // Default alternates so a run of interiors still reads as an evolving argument.
  return mk(index % 2 === 0 ? 'lanes' : 'merge', 6);
}

/* ─────────────────────────── slide body markup ─────────────────────────── */

function contentFor(slide: Slide): string {
  const headline = `<h1 class="headline">${fmtHeadline(slide.headline)}</h1>`;
  const body = slide.body ? `<p class="body">${esc(slide.body)}</p>` : '';
  const caption = (slide as { caption?: string }).caption;
  const captionEl = caption ? `<div class="caption">${esc(caption)}</div>` : '';

  switch (slide.type) {
    case 'checklist': {
      const items = (slide.items ?? [])
        .map((it) => `<li class="check-item">${esc(it)}</li>`)
        .join('');
      return `${headline}${body}<ul class="check-list">${items}</ul>${captionEl}`;
    }
    case 'comparison': {
      const col = (head: string | undefined, pts: string[] | undefined): string =>
        `<div class="cmp-col"><div class="cmp-head">${esc(head)}</div><ul class="cmp-points">${(
          pts ?? []
        )
          .map((p) => `<li>${esc(p)}</li>`)
          .join('')}</ul></div>`;
      return `${headline}${body}<div class="cmp">${col(slide.optionA, slide.pointsA)}<div class="cmp-div"></div>${col(slide.optionB, slide.pointsB)}</div>${captionEl}`;
    }
    case 'myth-reality':
      return `${headline}<div class="pair"><div class="pair-block bad"><span class="pair-tag">Myth</span><p>${esc(slide.myth)}</p></div><div class="pair-block good"><span class="pair-tag">Reality</span><p>${esc(slide.reality)}</p></div></div>${captionEl}`;
    case 'mistake-solution':
      return `${headline}<div class="pair"><div class="pair-block bad"><span class="pair-tag">Mistake</span><p>${esc(slide.mistake)}</p></div><div class="pair-block good"><span class="pair-tag">Fix</span><p>${esc(slide.solution)}</p></div></div>${captionEl}`;
    case 'cta':
    case 'summary': {
      // The sendmark already occupies the mono-label role here, so the bottom
      // caption strip is suppressed to avoid a duplicated "SEND THIS".
      const send = (slide.kicker ?? (slide.type === 'cta' ? 'Send this' : 'In summary')).trim();
      return `<div class="sendmark">${esc(send)}</div>${headline}${body}`;
    }
    default:
      return `${headline}${body}${captionEl}`;
  }
}

/** Mono section label in the masthead (top-right). Author via `kicker`. */
function labelFor(slide: Slide): string {
  const k = (slide.kicker ?? '').trim();
  if (k && slide.type !== 'cta' && slide.type !== 'summary') return k;
  switch (slide.type) {
    case 'cover':
      return 'The Brief';
    case 'cta':
      return 'The Move';
    case 'summary':
      return 'In Summary';
    default:
      return 'The Signal';
  }
}

/* ─────────────────────────────── the CSS ─────────────────────────────── */

const SIGNAL_CSS = `
  ${fontFaceCss()}
  /* One comet sweep == one path period (1000) => byte-seamless 2s loop. */
  @keyframes sig-flow { from { stroke-dashoffset: var(--o0, 0); } to { stroke-dashoffset: calc(var(--o0, 0) - 1000px); } }
  @keyframes sig-drift { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-16px); } }
  @keyframes sig-node  { 0%,100% { opacity: 1; } 50% { opacity: .45; } }
  @keyframes sig-dot   { 0%,100% { opacity: 1; } 50% { opacity: .55; } }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: ${W}px; height: ${H}px; overflow: hidden; }
  :root { --ink:#07090D; --paper:#F7F5F0; --amber:${AMBER}; --sub:#8C97A8; --hair:rgba(247,245,240,.16); }
  body { background: var(--ink); color: var(--paper); font-family: 'Geist','Inter',sans-serif; -webkit-font-smoothing: antialiased; }
  .slide { position:relative; width:${W}px; height:${H}px; padding:80px;
    background:var(--ink); color:var(--paper); overflow:hidden; display:flex; flex-direction:column; }
  .fig { position:absolute; inset:0; z-index:0; }
  .pulse-core, .pulse-bloom { stroke-dasharray: 60 940; stroke-dashoffset: var(--o0,0); }
  .pulse-bloom { opacity:.55; }
  .slide.motion .pulse-core, .slide.motion .pulse-bloom { animation: sig-flow 2s linear infinite; }
  .slide.motion .ghosts { animation: sig-drift 2s ease-in-out infinite; }
  .slide.motion .node { animation: sig-node 2s ease-in-out infinite; }
  .slide.motion .dot { animation: sig-dot 2s ease-in-out infinite; }
  .slide:not(.motion) .comet { display:none; }

  .depth { position:absolute; inset:0; z-index:1; background:
    radial-gradient(120% 75% at 50% 78%, rgba(240,168,60,.10) 0%, rgba(7,9,13,0) 60%),
    linear-gradient(180deg, rgba(7,9,13,.97) 0%, rgba(7,9,13,.93) 34%, rgba(7,9,13,.45) 47%, rgba(7,9,13,0) 56%),
    linear-gradient(0deg, rgba(7,9,13,.96) 0%, rgba(7,9,13,.78) 7%, rgba(7,9,13,0) 15%),
    radial-gradient(140% 100% at 50% 50%, rgba(7,9,13,0) 40%, rgba(7,9,13,.75) 100%); }
  .grain { position:absolute; inset:0; z-index:4; pointer-events:none; opacity:.075; mix-blend-mode:overlay;
    background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='200'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='4'/%3E%3C/filter%3E%3Crect width='200' height='200' filter='url(%23n)'/%3E%3C/svg%3E"); }
  .masthead, .content, .footer { position:relative; z-index:2; }

  .masthead { display:flex; align-items:center; gap:20px; flex-shrink:0; }
  .dot { width:11px; height:11px; border-radius:50%; background:var(--amber); box-shadow:0 0 18px var(--amber); flex-shrink:0; }
  .vendor { font-family:'Space Mono',monospace; font-size:26px; font-weight:700; letter-spacing:1px; }
  .rail { flex:1; height:1px; background:rgba(247,245,240,.20); }
  .label { font-family:'Space Mono',monospace; font-size:26px; letter-spacing:6px; text-transform:uppercase; color:var(--sub); }

  .content { flex:1; display:flex; flex-direction:column; justify-content:flex-start; padding-top:54px; font-size:var(--scale,90px); }
  .headline { font-family:'Geist','Inter',sans-serif; font-weight:800; font-size:1.16em; line-height:1.0; letter-spacing:-.03em; text-wrap:balance; }
  .headline .hl { font-style:normal; color:var(--amber); }
  /* Scaling text is clamped to the 26px accessibility floor: if copy is too long
     to fit above the floor, fill-fit reports overflow (author shortens) rather
     than shipping sub-legible type. */
  .body { font-size:max(26px, .335em); line-height:1.42; color:var(--sub); max-width:16.5em; margin-top:.40em; font-weight:500; }
  .caption { margin-top:auto; font-family:'Space Mono',monospace; font-size:26px; letter-spacing:4px; text-transform:uppercase; color:var(--sub); padding-top:28px; }
  .sendmark { font-family:'Space Mono',monospace; font-size:26px; letter-spacing:6px; text-transform:uppercase; color:var(--amber); margin-bottom:30px; flex-shrink:0; }

  /* checklist */
  .check-list { list-style:none; margin-top:.5em; display:flex; flex-direction:column; gap:.42em; }
  .check-item { position:relative; font-size:max(26px, .36em); line-height:1.3; padding-left:1.7em; color:var(--paper); font-weight:500; }
  .check-item::before { content:''; position:absolute; left:0; top:.05em; width:1.05em; height:1.05em; border-radius:6px;
    background:linear-gradient(180deg, var(--amber), ${AMBER_DEEP}); box-shadow:0 0 18px rgba(240,168,60,.35); }
  .check-item::after { content:''; position:absolute; left:.34em; top:.34em; width:.38em; height:.20em;
    border-left:.09em solid #07090D; border-bottom:.09em solid #07090D; transform:rotate(-45deg); }

  /* comparison */
  .cmp { display:flex; gap:0; margin-top:.5em; align-items:stretch; }
  .cmp-col { flex:1; padding:0 .5em; }
  .cmp-div { width:1px; background:var(--hair); }
  .cmp-head { font-family:'Space Mono',monospace; font-size:max(26px, .30em); letter-spacing:3px; text-transform:uppercase; color:var(--amber); margin-bottom:.5em; }
  .cmp-points { list-style:none; display:flex; flex-direction:column; gap:.34em; }
  .cmp-points li { font-size:max(26px, .32em); line-height:1.3; color:var(--paper); font-weight:500; }

  /* myth-reality / mistake-solution */
  .pair { display:flex; flex-direction:column; gap:.34em; margin-top:.55em; }
  .pair-block { border:1px solid var(--hair); border-radius:16px; padding:.5em .6em; background:rgba(247,245,240,.02); }
  .pair-block.bad { border-color:rgba(214,69,69,.4); }
  .pair-block.good { border-color:rgba(240,168,60,.5); }
  .pair-tag { display:inline-block; font-family:'Space Mono',monospace; font-size:26px; letter-spacing:3px; text-transform:uppercase; margin-bottom:.35em; }
  .pair-block.bad .pair-tag { color:#E88; }
  .pair-block.good .pair-tag { color:var(--amber); }
  .pair-block p { font-size:max(26px, .32em); line-height:1.32; color:var(--paper); font-weight:500; }

  .footer { display:flex; align-items:center; gap:22px; flex-shrink:0; padding-top:30px; font-family:'Space Mono',monospace; font-size:26px; z-index:2; position:relative; }
  .handle { color:var(--amber); font-weight:700; }
  .frule { flex:1; height:1px; background:var(--hair); }
  .pagenum { color:var(--sub); font-variant-numeric:tabular-nums; }
`;

/**
 * Fill-fit: one binary search on --scale grows short copy and shrinks long copy
 * until the content block fills the frame. The FIGURE, depth scrim and grain are
 * excluded — they bleed off-canvas by design and counting them collapses the
 * search to its floor.
 */
export const SIGNAL_FILLFIT_FN = `(async () => {
  try { await document.fonts.ready; } catch (e) {}
  const slide = document.querySelector('.slide');
  const content = document.querySelector('.content');
  if (!slide || !content) return { fitted:false };
  const pad = parseFloat(getComputedStyle(slide).paddingTop);
  const box = { top:pad, left:pad, right:${W}-pad, bottom:${H}-pad };
  const measured = () => [...slide.querySelectorAll('.masthead,.masthead *,.content,.content *,.footer,.footer *')];
  const fits = () => {
    for (const n of measured()) {
      const r = n.getBoundingClientRect();
      if (r.width<=0 && r.height<=0) continue;
      if (r.right>box.right+1.5||r.bottom>box.bottom+1.5||r.left<box.left-1.5||r.top<box.top-1.5) return false;
      if (n.scrollWidth > n.clientWidth+1) return false;
    }
    return content.scrollHeight <= content.clientHeight+1;
  };
  const CAP = parseFloat(slide.dataset.cap || '92');
  let lo=28, hi=CAP, best=28;
  for (let i=0;i<20;i++){ const mid=(lo+hi)/2; content.style.setProperty('--scale',mid+'px');
    if (fits()){best=mid;lo=mid;} else {hi=mid;} }
  content.style.setProperty('--scale',best+'px');
  return { fitted:true, px: Math.round(best) };
})()`;

export interface SignalBuildOpts {
  animate?: boolean;
  theme?: ResolvedTheme;
}

/** Build a complete standalone HTML document for one SIGNAL slide. */
export function buildSignalHtml(
  slide: Slide,
  index: number,
  total: number,
  brand: Brand,
  opts: SignalBuildOpts = {},
): string {
  const animate = opts.animate ?? false;
  const fig = figureFor(slide, index);
  const svg = figureSvg(fig);
  // Vendor line: the subject's label (theme) over the constant gold spine.
  const vendor = esc(opts.theme?.label || brand.brandName || 'Signal');
  const motionClass = animate ? ' motion' : '';
  // Denser layouts get a slightly smaller type cap so lists/pairs never overflow.
  const cap = slide.type === 'comparison' || slide.type === 'checklist' ? '78' : '92';

  return `<!doctype html><html lang="${esc(brand.language)}"><head><meta charset="utf-8">
    <style>${SIGNAL_CSS}</style></head>
    <body><div class="slide slide-${slide.type} signal${motionClass}" data-cap="${cap}">
      <div class="fig" aria-hidden="true">${svg}</div>
      <div class="depth" aria-hidden="true"></div>
      <div class="masthead">
        <span class="dot"></span><span class="vendor">${vendor}</span>
        <span class="rail"></span><span class="label">${esc(labelFor(slide))}</span>
      </div>
      <div class="content">${contentFor(slide)}</div>
      <div class="footer">
        <span class="handle">${esc(brand.instagramHandle)}</span>
        <span class="frule"></span>
        <span class="pagenum">${index} / ${total}</span>
      </div>
      <div class="grain" aria-hidden="true"></div>
    </div></body></html>`;
}
