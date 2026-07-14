# Visual elevation — feed-stopping v2

Date: 2026-07-14. Operator-audit of the full render matrix (6 art directions ×
8 themes; covers, interiors, CTA, motion frames) against the scroll-stop bar.

## What the audit found (current output ≈ "fine", which fails the bar)

1. **Frozen sweep-bar artifact.** The diagonal light beam (`decor-2`,
   `sweepBar()`) was designed as a motion element, but its resting position is
   visible on every static render — it reads as glare/light-leak, not design.
   Worst on editorial (plastic sheen on paper) and brutalist (soft gradient
   contradicts the hard-edge language).
2. **hl-glow halo looks cheap.** The 56px/70% text-shadow pulse produces a
   burnt halo around headlines mid-loop (worst on mistral/kinetic).
3. **Boxed kickers stretch full-width.** `.kicker` is a flex child of a column
   (`align-items: stretch`), so chip-styled kickers (brutalist box, kinetic
   slab, poster pill) become full-width bars. Clearly unintentional.
4. **Masthead redundancy.** Cover stacks brandmark ("AI News" label) over the
   kicker ("AI NEWS") — duplicated text on the breaking theme.
5. **Dead-zone compositions.** Covers and sparse interiors float in the middle
   of the frame with 30–45% empty canvas; brutalist bottom-anchors with an
   empty top half. Nothing fills the frame deliberately.
6. **Type isn't distinctive enough.** 4 of 6 directions headline in Space
   Grotesk 700. The feed looks samey; kinetic ("type IS the art") lacks a true
   display weight.
7. **Flat monochrome headlines.** No accent-word emphasis — the single biggest
   cheap win for scroll-stopping covers.
8. **CTA closers are generic.** Same headline/body/pill layout in every
   direction; no designed end-card moment to earn the follow.
9. **Editorial grain is invisible on dark themes** (multiply blend on black).

## Design (approach: elevate the existing 3-axis system; no new axes)

Rejected alternatives: (B) adding more art directions — dilutes quality, the
six need to be excellent first; (C) image-led covers — non-deterministic,
off-mission for an autonomous pipeline.

1. **Motion hygiene.** Sweep bars rest off-canvas (`translateX(-100%)`) in the
   art CSS so static slides never show them and motion t=0 == static byte-wise.
   Kill `hl-glow` on all directions (soften the keyframe; spotlight keeps a
   gentle version). Brutalist sweep becomes a hard-edged accent column.
   Spotlight gains a rotating two-fold conic stage beam (seamless at 180°/2s,
   deliberate at rest).
2. **Masthead row.** Cover brandmark + kicker merge into one `.masthead` flex
   row; kicker suppressed when it duplicates the theme label. Base
   `.kicker { align-self: flex-start }` kills the stretch bug everywhere.
3. **Accent-word markup.** `*word*` in any headline renders as
   `<em class="hl">` styled per direction (editorial: italic serif in accent;
   kinetic: accent + thick underline slab; brutalist: accent block; blueprint:
   accent + ruler-tick underline; spotlight/poster: accent). Escape first,
   then transform. Validation strips markers before phrase/word checks and
   warns (never blocks) when a cover headline carries no marker.
4. **Typography per direction.** New vendored SIL-OFL faces (latin woff2,
   embedded as data URIs like the rest): **Anton** → kinetic display,
   **Archivo Black** → poster display, **Fraunces 900 + Fraunces 600 italic**
   → editorial display + accent words. Brutalist stays Space Mono, blueprint/
   spotlight stay Space Grotesk. Five distinct display voices across six
   directions.
5. **Cover compositions** (fill the frame, per direction):
   - editorial: masthead top / Fraunces-900 headline center / deck + swipe
     bottom (space-between), vertical mono spine label on the right.
   - brutalist: masthead top, mono headline anchored low with a hard offset
     text-shadow, ghost index block.
   - spotlight: ring repositioned to halo the masthead (no headline collision),
     softened glow, centered.
   - kinetic: Anton stacked uppercase at ~170px filling the frame.
   - blueprint: mono schematic annotations (FIG. index top-right, coords
     bottom-left) + dashed leader; headline 108px.
   - poster: full-bleed `--c-primary` field, `--c-on-primary` Archivo Black
     uppercase type, solid accent circle + ring geometry. Guaranteed-contrast
     roles only.
6. **Ghost slide numerals** on sparse interiors (numbered/step): a huge
   per-direction numeral rendered from `data-num` inside the clipped decor
   layer (skipped by overflow measurement), killing interior dead space and
   adding sequence energy.
7. **CTA end-cards per direction** using only guaranteed-contrast role pairs
   (ink/paper inversion for editorial; primary/on-primary fields for
   brutalist/kinetic/poster; staged glow for spotlight; framed schematic for
   blueprint). Pills get an arrow and real presence; footer recolored to stay
   readable on filled fields.
8. **Grain blend** switches to soft-light so it reads on dark and light.
9. **CLAUDE.md** authoring guidance: accent-word marker on every cover hook,
   direction-specific hook length limits (Anton/Archivo huge type → ≤6 words),
   updated pairing notes and inspection checklist.

## Contracts preserved

Six directions; `.ad-<name>` scoping; `--g-bg` present; `ad-underline` rests at
`scaleX(1)`; interior `gap: 44px` under `.ad-<name>.slide-numbered-point
.content`; brandmark markup class on themed covers (none on default);
`bg-shimmer`/`ad-sweep` keyframes; CTA DEFAULT_CTA/handle wiring; settled-at-t0
motion; MEASURE/AUTOFIT semantics; MIN font 26px.

## Verification

Re-render the full matrix (now with accent-marked hooks), inspect every cover,
interior, CTA and motion frame at full size; then `npm run format`, `npm run
typecheck`, `npm test`, targeted fixture render, secret-scan, commit, push.
