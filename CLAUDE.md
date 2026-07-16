# CLAUDE.md — operating guide for this repository

This repository is a **fully built, production-ready** autonomous Instagram
carousel generator. It is already bootstrapped (`SYSTEM_READY` exists). On every
run you are the **operator**, not the builder. **Do not rewrite the
application.** Operate it, fix real defects only, and process exactly one
carousel per run.

---

## What this system does

Each normal run completes exactly **one** end-to-end content workflow:

1. Read settings from Google Sheets (`Settings` tab).
2. Recover any `VERIFY_REQUIRED` publication first (LIVE).
3. Publish an existing `DRAFT_READY` draft first when configured (LIVE).
4. Otherwise select the highest-priority `UNUSED` idea, or generate one.
5. Author one excellent carousel, render it to 1080×1350 images, inspect them.
6. Upload images + preview to Cloudflare R2.
7. `TEST` → save as `DRAFT_READY`. `LIVE` → publish via the official Instagram API.
8. Update the Sheet, commit durable code changes, release the lock.

Never process more than one carousel per run.

---

## Run decision tree (do this every run)

1. **Check bootstrap state.** `SYSTEM_READY` present → NORMAL MODE (this is the
   default now). Absent → re-bootstrap (see README "Bootstrap").
2. `npm ci` (deps). Confirm Chromium is available (see "Rendering" below).
3. `npm run healthcheck` — verifies service account, Sheet tabs/headers, R2
   public+private, Instagram creds. In `TEST` mode a missing Instagram
   integration is tolerated.
4. Determine `MODE` from the Sheet (`TEST` unless it is exactly `LIVE`).
5. Drive the workflow through the staged CLI below.

---

## The Claude-in-the-loop seams

The deterministic mechanics (selection, rendering, validation, R2, locks,
idempotency, Instagram) live in `src/`. **Three creative steps are yours**, wired
through files under `runtime/` (which is gitignored and ephemeral):

| Step                                               | You write                                                                                           | Then run                                                        |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Pick which idea to work on                         | —                                                                                                   | `npm run select-idea` → writes `runtime/selection-context.json` |
| Author a **new** idea (only if the queue is empty) | `runtime/idea-plan.json` `{idea, priority, content_pillar}`                                         | (consumed by workflow)                                          |
| Author the carousel                                | `runtime/post-plan.json` (a `Post`, see `schemas/post.ts`)                                          | `npm run render` to preview                                     |
| Visually inspect the rendered slides               | inspect `runtime/slides/*.png`, then `runtime/visual-approval.json` `{"approved":true,"notes":"…"}` | `npm run workflow`                                              |

Recommended operating sequence for a normal run:

```
npm ci
npm run healthcheck
# RESEARCH FIRST: web-search the last 24-48h (then widen to MAX_STORY_AGE_DAYS).
# Then run the ANGLE TEST + KILL SWITCH (below). Story with a surviving angle →
# NEWS lane. Story killed / nothing shipped → VALUE lane — or NO POST AT ALL.
# A kill means END THE RUN HERE, before select-idea: report the kill reason and
# leave the Sheet untouched. There is no REJECTED status — a row selected and
# then abandoned is burned as FAILED. Killing is free only before selection.
npm run select-idea          # ONLY once you have decided to post; or, if queue
                             # empty, author runtime/idea-plan.json
# author runtime/post-plan.json based on runtime/selection-context.json
#   news  → content_type:"news",  why_now + sources[] (url/description/published_at)
#   value → content_type:"value", value_promise + no_news_reason + 2 actionable slides
npm run render               # renders runtime/slides/*.png + validation report
# READ every runtime/slides/*.png yourself; fix copy/template if anything is off
# write runtime/visual-approval.json {"approved":true,"notes":"..."}
npm run workflow             # selects/generates, renders, validates, uploads, drafts or publishes
```

`MODE_OVERRIDE=TEST npm run workflow:test` forces TEST regardless of the Sheet.

### Two lanes: NEWS first, VALUE as the honest fallback

The mission is **AI education** — teaching people who want to actually _use_ AI,
from newcomers to practitioners. There are exactly two ways to do that, and neither
is filler. Every run you pick a lane and declare it in `post.content_type`.

**Lane 1 — `news` (always preferred).** A real, fresh, sourced development —
covered with an ANGLE (see the angle test below), never restated.
**Lane 2 — `value` (fallback ONLY when no news survives).** Real AI education: one
concrete technique the reader can use today.

**Why the bar is this high.** Since April 30, 2026 Instagram applies its
originality rules to photos and carousels: accounts that mostly post content they
didn't create or didn't _meaningfully transform_ are removed from every
recommendation surface — Explore, suggested posts, the non-follower feed —
evaluated automatically on the whole account over a rolling 30-day window.
Crediting a source does not help; restating a headline over a gradient is classed
as aggregation. The account survives only on posts that SAY something the source
didn't. And design for the DM, not the double tap: sends-per-reach is Instagram's
heaviest ranking signal, weighted several times above likes for reaching new
people.

**News with a surviving angle always wins.** If a genuine story broke inside
`MAX_STORY_AGE_DAYS` (default 14) and an angle clears the kill switch, you cover
it — you do not get to skip it because a tips post is easier. The value lane
exists for quiet weeks, not for lazy ones. But a story with no angle is not
coverable news; killing it is the correct call, not a failure.

### Step 1 — always research first

1. **Search, and race.** Being _first_ is most of the reach, so search **the last
   24–48h first** (`BREAKING_WINDOW_HOURS`, default 48): model/tool releases,
   version bumps, pricing or policy changes, notable benchmarks, new features in
   Claude / Claude Code / OpenAI / Codex / Gemini / Grok / Llama / Mistral / new AI
   tools. Widen to `MAX_STORY_AGE_DAYS` only if nothing broke in the window. A story
   older than the breaking window still publishes but raises `SLOW_TO_POST`.
   - If something big broke **today**, post that even if the queue holds older ideas.
     Stale auto-generated queue rows expire automatically, so a breaking story
     preempts the queue. Give a breaking idea `priority: High`.
2. **Go to the primary source** — changelog, release notes, model card, docs, or the
   company's own announcement. Not a rehash, not a rumour thread.
3. **Only if the search genuinely comes up empty** (or every story died in the
   kill switch) do you switch to the value lane — and you must then write
   `post.no_news_reason` saying what you searched and why nothing was worth
   covering.

### Step 1.5 — the angle test, then the kill switch

A story is only coverable if you find an **angle** — one claim the source article
does not contain and would not call obvious. Run through these in order and take
the first one with real substance:

1. **What breaks.** Something that worked yesterday doesn't now. Name it, and who
   was relying on it.
2. **What it costs.** Money, latency, lock-in, migration time. Numbers if you have
   them (sourced, never invented).
3. **What's missing.** The thing the announcement conspicuously did not mention.
4. **What it kills.** The tool, workflow, or job that is now worse off.
5. **Claim vs reality.** The demo does X; the API does 0.6X.
6. **The second-order effect.** What happens downstream in three months that
   nobody is talking about.
7. **The move.** Concrete: if you are building Y, do Z this week.

**The kill switch.** Killing a story is allowed and expected. Kill when ANY of
these is true:

- It is a version bump, funding round, or hire with no consequence you can name.
- Your only angle is "this is big" or "this changes everything".
- You cannot name a specific person or role who is affected, and how.
- The claim you would make is the one every AI account will make today.
- You are padding to reach the slide minimum.

A killed story falls through to the value lane. If no value idea clears its bar
either, **end the run without posting** — state what you searched and why you
killed it in the run report. Posting nothing is free; filler feeds the
aggregation classifier and drags the reach of the next several posts.

**Kill BEFORE selecting.** The pipeline has no REJECTED status: a row selected
and then abandoned mid-run is burned as `FAILED`, and nothing revives it except a
manual Sheet edit. Make the post/kill decision during research — before
`npm run select-idea`, before authoring `idea-plan.json`, before
`npm run workflow`. A no-post run must leave the Sheet untouched.

**The originality check** — all three must be YES before you render:

1. Is there a sentence in this deck the source does not contain and would not
   agree is obvious?
2. If someone already read the source, is this still worth reading?
3. Would a specific person send this to a specific friend, with a reason attached?

### Step 2a — authoring a NEWS post (`content_type: "news"`)

- `post.sources[]` — each needs `url`, `description`, `published_at` (`YYYY-MM-DD`).
- `post.why_now` — one honest sentence: what happened, when, why it matters now.
- **Structure the deck as a transformation, not a report.** 6–8 slides, 7 is the
  default. Map the roles onto the slide types like this:
  - Slide 1 (`cover`) — the hook: the consequence, tension, or claim. If it could
    run as a news chyron ("OpenAI releases GPT-5 Turbo"), rewrite it.
  - Slide 2 — the stakes: who this hits and how hard, two sentences. Do not
    explain the news yet. (`standard-content`)
  - Slide 3 — **the only reporting slide.** What actually happened, compressed to
    three lines max. This is the slide that reads as aggregation if you let it
    spread across the deck. One slide, then out. (`standard-content`)
  - Slides 4–6 — the transformation: your claim, the reasoning, the evidence, the
    specific thing nobody is saying. One idea per slide — never four bullets.
    (`standard-content` / `myth-reality` / `comparison` / `mistake-solution`)
  - Second-to-last — the move: something concrete the reader does this week, not
    "keep an eye on this". (`step` / `numbered-point` / `checklist`)
  - Last (`cta`) — the send line (see the CTA playbook below).
- **Every slide except the last leaves something unresolved.** Dwell time comes
  from needing the next slide — end mid-thought, point forward.
- Run the originality check (Step 1.5) on the finished deck before rendering.

### Step 2b — authoring a VALUE post (`content_type: "value"`)

This is AI education, and it must be **worth a stranger's time** — not filler.

- `post.value_promise` — the concrete thing the reader can DO afterwards. "Scope your
  agent's context so it stops re-reading files it doesn't need." **Not** "learn about
  AI", not "understand prompting".
- `post.no_news_reason` — the honest fallback reason (see above).
- **Teach a method, don't describe one.** At least 2 actionable slides
  (`numbered-point` / `step` / `checklist` / `comparison` / `mistake-solution`) —
  `NOT_ACTIONABLE` blocks a deck that is just vibes.
- **Be specific and current**: real settings, real prompts, real workflows, named
  tools and models that exist right now. Specificity is the whole difference between
  education and filler.
- **Serve both ends of the audience**: a newcomer should be able to follow the steps,
  and someone already in AI should still learn a non-obvious detail.
- Good: "The Claude Code setting that stops it re-reading your repo", "Why your RAG
  answers go stale — and the one fix", "Cursor vs Claude Code for refactors".
  Bad: "AI tips everyone should know", "how to use ChatGPT better".

### The bar: is this actually worth posting?

Kill the idea unless it clears all four — plus the three originality questions in
Step 1.5:

- **True** — every version number, date, price and benchmark comes from a real source.
- **Useful** — the reader can _do_ something with it.
- **Non-obvious** — someone who already follows AI still learns something.
- **Specific** — it names real tools, settings, numbers. Vagueness is the tell.

**Auto-rejected outright** (`HYPE_SLOP`, a hard error): "mind-blowing AI hacks",
"tools you need", "ultimate guide to X", "10x your workflow", "game-changing",
"nobody's talking about". Say the actual thing instead. A numbered listicle only
_warns_ (`LISTICLE_SHAPE`) — "4 Claude Code settings that cut my token bill" is
excellent; "5 AI tips" is filler. The number is fine; vagueness is not.

### Authoring rules (must follow)

- **Enforced by validation** — errors here mean the run ships nothing, on purpose:
  - news lane: `NO_WHY_NOW`, `NO_SOURCE`, `NO_SOURCE_DATE`, `STALE_STORY`,
    `FUTURE_SOURCE_DATE` (a published_at after today is always an authoring error)
  - value lane: `NO_VALUE_PROMISE`, `NO_FALLBACK_REASON`, `NOT_ACTIONABLE`
  - either lane: `HYPE_SLOP`
  - `CONTENT_MODE=news-only` additionally rejects the value lane (`VALUE_NOT_ALLOWED`).
- **One reporting slide, then transform.** Lead with the consequence, compress
  what changed into a single slide, then spend the deck on your claim and the
  move. Match `NICHE`, `TARGET_AUDIENCE`, `ACCOUNT_GOAL`, `POST_LANGUAGE`.
- 6–8 slides normally (7 is the default), within `MIN_SLIDES`..`MAX_SLIDES`.
  First slide `cover`; **last slide must be `cta`** (or `summary`) — `NO_CLOSER`
  is a hard error.
- Hook 6–12 words (validation warns past 12); interior bodies ~20–40 words. Short
  sentences; fragments are fine. Second person — "you", never "users" or
  "developers". No em dashes in slide or caption copy — use periods. Numbers,
  names, versions, dates over vague gestures. No generic AI filler, no unmet
  clickbait, minimal emoji, natural human wording that sounds like a person.
- **Caption:** the first line is the only line most people see — it carries the
  same weight as the hook and must be DIFFERENT from it (≤ ~125 chars before the
  fold). The body is 3–5 sentences that add something the slides don't have: a
  caveat, your read, the counterargument, the thing you're not sure about — never
  a restatement of the deck. End with ONE send-or-save ask ("Send this to whoever
  owns your retrieval stack"), never a follow ask, and never the same CTA twice
  in a week.
- **Hashtags: exactly 3–5, specific and descriptive** — they are classification
  labels, not discovery (#ragpipeline #inferencecost #llmops). Never generic tags
  (#ai #tech #innovation #artificialintelligence): stacking those reads as spam
  and suppresses reach. The validator only errors above 8; the bar is 3–5.
- Banned phrases beyond the enforced blocklist: "in today's rapidly evolving…",
  "here's what you need to know", "this is huge / changes everything", "the AI
  landscape", "let's dive in / break it down", "revolutionary", "groundbreaking",
  "cutting-edge", "unlock", "leverage", "the future of X is here", and rhetorical
  questions as hooks ("Ever wondered…?"). If one appears, rewrite the slide.
- **Never invent** statistics, quotes, case studies, prices, laws, version numbers,
  release dates or credentials. A post with a hard statistic/price and zero
  `sources` fails validation (`UNSOURCED_CLAIM`).
- Do not repeat a recent topic/hook/framework — `src/similarity.ts` runs an
  automated dedup check; apply semantic judgment on top. Also **vary the
  `art_direction`** from recent posts (see below) so the feed never looks samey.
- The workflow overrides `idea_id` and `idempotency_key`; your `post-plan.json`
  values for those are placeholders.

### Authoring a new idea (when the queue is empty)

`runtime/idea-plan.json` is `{idea, priority, content_pillar}`. **Research first**
(above), then write the idea as the concrete story — "Claude Code ships parallel
subagents", not "how to use AI agents". Set `priority: High` for something that
shipped in the last few days; `Medium` otherwise. Never invent a release.

### Hook playbook (the cover is the whole game)

The first slide's `headline` is the scroll-stopper. It is not the headline and it
is not the news — it is the **consequence, the tension, or the claim**. If it
could run as a news chyron, rewrite it. Pick a proven pattern and keep it
concrete:

- **The reversal** — the accepted thing is now wrong: "Everyone's wrong about
  long context. Here's the data."
- **The cost** — what this quietly makes expensive: "Your RAG pipeline just
  became the expensive way to do this."
- **The specific victim** — name the workflow that just died: "This ships Tuesday
  and breaks three tools you use."
- **The overlooked line** — the detail buried on page four: "Everyone read the
  benchmark. Nobody read the pricing page."
- **The deadline** — something changes on a date and people are not ready.
- **The number that does not add up** — "GPT-4 beaten by a 7B open model on coding".
- **"X just changed"** — "Claude Code just got parallel subagents".
- **Direct callout** — "If you use ChatGPT for code, read this."

Rules: 6–12 words, front-load the payoff, no rhetorical questions ("Ever
wondered…?" warns as `HOOK_RHETORICAL`), no unmet clickbait, and never fabricate
the number/claim (source volatile facts in `post.sources`). Auto-fit shrinks a bold
cover headline to fit (floor ~56px); if it still overflows, **shorten the copy** —
don't accept a tiny hook. Avoid the phrases blocklisted in `src/visual-validation.ts`.

**Mark the payoff word.** Wrap the ONE payoff word/phrase of every cover headline
(and optionally an interior headline) in asterisks — `"Claude Code just got
*parallel subagents*"`. The renderer turns `*…*` into the art direction's signature
accent move (italic clay serif on editorial, red display lines on kinetic, accent
knockout on poster…). A cover without a marker renders flat and warns
(`HOOK_NO_ACCENT`). Never mark more than one span per headline.

### CTA playbook (the last slide earns the send)

The final `cta` slide is the **send line** — one sentence that makes the reader
forward the whole thing. It should be the sharpest thing in the carousel, not a
summary of it. Sends-per-reach outranks likes several times over for reaching new
people, so the ask is a **send or a save — never a follow**.

- `headline` = the send line itself ("Read the pricing page before the benchmark
  chart. Every time.").
- `body` = the send/save ask, tied to what they just got ("Send this to whoever
  signs off on your API bill.").
- `kicker` = a short pill label — author it every time ("Send this", "Save this");
  left empty, the pill falls back to a generic "Send this".
- **One clear action** — send or save, pick one. Vary the ask every post; never
  the same CTA twice in a week.
- Leaving `body` empty inherits the Sheet's `DEFAULT_CTA` (wired in
  `src/render.ts`) — keep that cell written as a send/save ask, and treat it as an
  emergency fallback, not the plan. Never ship an empty, generic closer.

### Content direction & theming

- This account covers **Claude / Claude Code, OpenAI / Codex, Gemini, Grok, Meta
  AI / Llama, Mistral, and new AI tool + tech news**. Keep content timely and
  accurate.
- For topics that need current facts (new releases, version numbers, dates,
  benchmarks), **research primary sources** and put the URLs in `post.sources`.
  Never invent version numbers, dates, or benchmark stats.

**The visual system has three independent axes** — mix them freely:

- **`theme`** = brand _palette only_ (colors + logo). `claude`, `openai`, `gemini`,
  `grok`, `meta`, `mistral`, `breaking` (vendorless high-attention news), `default`.
  Set it to match the subject; when unset the renderer auto-detects from idea/pillar
  (`detectTheme` in `src/render.ts`). Themes no longer carry gradients/decor — no
  more rainbow washes.
- **`template`** = content _layout only_. `numbered-list`, `step-by-step`,
  `myth-reality`, `mistake-solution`, `comparison`, `checklist`, `breaking-news`.
  Pick the one that fits the content shape.
- **`art_direction`** = the _style_ (typography + background treatment + decor +
  motion personality), owned by `src/art-direction.ts`. Six distinct, deliberately
  artistic, non-rainbow systems — each also styles the `*accent*` word, a ghost
  sequence numeral on sparse interiors, and a designed CTA end-card:
  - `editorial` — Fraunces-900 magazine front page: masthead row, hairlines,
    italic accent word, vertical spine label, grain; CTA inverts to an ink card.
  - `brutalist` — mono type, hard grid, square blocks, `/// LIVE FEED` strip,
    bracket labels (how-tos); CTA is a primary-filled slab card.
  - `spotlight` — dark cinematic stage: twin conic beams + breathing glow,
    centered oversized type; CTA is a glowing finale card.
  - `kinetic` — Anton condensed uppercase filling the whole frame (the type IS
    the art); CTA is a primary-filled Anton card.
  - `blueprint` — technical graph grid, corner ticks, `FIG.` annotations, ruler
    underline on the accent word; CTA is a dashed-frame spec card.
  - `poster` — full-bleed primary color field + Archivo Black knockout type +
    solid accent geometry (maximum ink in the feed); CTA bookends the same field.
    Leave it unset to let the `ART_DIRECTION` Setting rotate it (default `auto`,
    seeded per idea). **Set it deliberately and vary it from recent posts** so every
    post looks like a different designed piece. Match the style to the content
    (kinetic → punchy hooks; brutalist/blueprint → technical how-tos; editorial →
    explainers; spotlight/poster → launches). `brutalist` (mono) and `poster`
    (ultra-wide Archivo Black) need short hooks (≤ ~6 words); `kinetic` (condensed
    Anton) stacks up to ~8 words. Auto-fit protects the whole layout (headline,
    deck AND footer) down to the 56px floor — if it floors, shorten the copy.
- Visual inspection must **reject bland output**: every slide must show the art
  direction's background treatment + a graphic accent, real display typography (not
  a plain system sans), and the cover must carry the theme's logo mark and a
  scroll-stopping hook — it should look like a piece of art.

### Motion (moving carousels)

- The `MOTION_SLIDES` Setting controls animated (MP4) slides: `off` (image-only),
  `cover` (slide 1 moves), `cover+key` (**default** — cover + any slide flagged
  `animate: true`), `all`. Instagram carousels mix image + video children, so
  motion slides publish as `media_type=VIDEO` alongside static image slides.
- Motion is captured deterministically (CSS `@keyframes` → frame-stepped
  screenshots → H.264 MP4 via `src/motion.ts`) and every motion slide still emits
  a poster PNG (its settled t=0 frame) for inspection and the grid thumbnail.
- **Authoring for motion:** all animation is "settled at t=0" (light sweeps,
  parallax/drift, breathing glows, swaying stage beams on already-visible
  elements) so the first frame is a strong still and the overflow check passes.
  Motion-only elements (the light-sweep bars) rest OFF-canvas, so static slides
  never show a frozen mid-animation beam — if a static render shows a stray
  glare band or a half-drawn underline, that is a defect, not a style.
  Each `art_direction` has its own motion personality (`motionCss` +
  `MOTION_KEYFRAMES` in `src/art-direction.ts`); you don't hand-write animations —
  you only choose which slides move via `MOTION_SLIDES` / per-slide `animate: true`
  (flag the one or two "key" slides worth animating under `cover+key`).
- **Before the first LIVE motion post**, run `npm run verify:motion` — it creates
  and polls a real VIDEO container (no parent, no publish) to confirm Instagram
  accepts the MP4 spec. Requires a full `ffmpeg` with libx264 (bundled via
  `@ffmpeg-installer/ffmpeg`; `npm run healthcheck` verifies it when motion is on).

### Visual inspection is mandatory

`npm run render` produces the exact bytes the workflow will upload (rendering is
deterministic). Read each PNG (and step the MP4s). Check hierarchy, readability,
spacing, alignment, clipping, contrast, branding, sequence, repetition, spelling.
If anything is wrong, fix the copy or choose another art direction and re-render —
do not shrink text below the accessible minimum.

**The scroll-stop test (the cover must earn the stop).** Before approving, look at
slide 1 the way a stranger scrolling at speed would, and answer honestly:

1. **Would I stop?** If it is merely "fine", it has failed. Fine gets scrolled past.
2. **Is the hook legible in half a second?** One idea, front-loaded payoff, big type.
3. **Does it look designed** — real display typeface, a deliberate graphic move,
   the theme's logo — or does it look like a template with words dropped in?
4. **Is the promise real?** The deck must pay off exactly what the cover claims.
5. **Is it a claim, not a chyron?** If slide 1 merely reports that something was
   released, it is aggregation bait — rewrite it as the consequence.

If it fails any of these, **rewrite the hook or change the art direction and
re-render** — do not approve it. Shipping a forgettable post costs more than
shipping nothing. Only write `visual-approval.json` once it genuinely passes.

---

## Architecture (files you operate, do not rewrite)

- `src/config.ts` — env validation (names only, never values); URL normalization.
- `src/security.ts` — secret redaction + AES-256-GCM token encryption.
- `src/google-sheets.ts` / `src/content-tracker.ts` — Sheet auth + the exact
  tab/column contract; updates addressed by `idea_id`, never by row position.
- `src/idea-selection.ts` — priority ordering, resumable rows, generated ideas.
- `src/similarity.ts` — deterministic Jaccard + bigram dedup.
- `src/research-validation.ts` — detects volatile claims needing sources.
- `src/newsworthiness.ts` — the "is this worth posting?" bar: `why_now` anchor,
  primary sources, story freshness (`MAX_STORY_AGE_DAYS`), listicle-filler
  detection. Blocks the run in `CONTENT_MODE=news-first`.
- `src/render.ts` — HTML/CSS → 1080×1350 PNG via Chromium; palette-only themes;
  brand-color role inference; in-page overflow/font metrics; CTA wiring.
- `src/fonts.ts` — embedded `woff2` faces (Inter / Space Grotesk / Fraunces /
  Space Mono) as `data:` URIs; exposes `--font` / `--font-display` / `--font-serif`
  / `--font-mono`.
- `src/art-direction.ts` — the six art-direction styles (typography + background
  treatment + decor + per-style motion) and `resolveArtDirection` (explicit →
  `ART_DIRECTION` pin → deterministic per-idea rotation).
- `src/visual-validation.ts` — copy, metric, and image (sharp) validation; closer
  - unsourced-claim gates.
- `src/r2.ts` — public (media/previews) vs private (locks/idempotency/token/
  recovery) buckets. Private state must never touch the public bucket.
- `src/locks.ts` — distributed workflow lock in private R2 (stale recovery).
- `src/token-manager.ts` — encrypted token at rest, prefer stored over env,
  refresh near expiry.
- `src/instagram.ts` — official `graph.instagram.com` publish primitives.
- `src/recovery.ts` — idempotency keys/records, ambiguous-publish verification.
- `src/workflow.ts` — the orchestrator (`runWorkflow`); one carousel per run.
- `src/cli.ts` — command entry points.
- `templates/<name>/template.css` — seven content-layout systems (layout only;
  palette + style come from the theme + art direction) layered on the shared base
  CSS in `render.ts`.
- `assets/fonts/*.woff2` — vendored SIL-OFL faces embedded by `src/fonts.ts`.

---

## Safety invariants (never violate)

- Never print, commit, or embed secrets (tokens, service account, keys) anywhere
  — logs, HTML, captions, previews, Sheet cells, error messages.
- Never store the plaintext Instagram token; only the AES-256-GCM record in
  private R2.
- Never publish when any record (Sheet status, media id, idempotency record,
  recent media) indicates the post already exists.
- Never blindly retry a media-publish after a timeout/unknown response → mark
  `VERIFY_REQUIRED`, save the parent container id, verify before any new publish.
- Never downgrade a `POSTED` row to `FAILED`. Never delete Content rows.
- Release the lock in a `finally` block. Only one workflow at a time.
- Do not update dependencies or redesign templates during a normal content run.

---

## Commands

`npm run build | typecheck | lint | test | healthcheck | workflow |
workflow:test | select-idea | render | render:fixture | recover |
verify:publication | verify:motion`

Before committing: format, typecheck, run tests, inspect `git diff`, scan for
secrets, confirm no service-account/token/private-state files are tracked.

---

## Self-improvement & pushing changes

- After a successful run, if you fixed a real defect or made a durable
  improvement (including updating CLAUDE.md itself), commit and push to `main`
  so future runs inherit it. Only meaningful, durable changes — never generated
  images or runtime state.
- Before pushing: run `npm run format`, `npm run typecheck`, `npm test`, and
  scan the diff for secrets. Never push red tests.
- The environment's default git credential is read-only, so push with the write
  token in the `GH_PUSH_TOKEN` env var, bypassing the read-only proxy, using
  exactly this command:

  ```
  GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null GIT_SSL_CAINFO=/root/.ccr/ca-bundle.crt git push "https://x-access-token:${GH_PUSH_TOKEN}@github.com/thatguywinz/insta-carousel-generator.git" HEAD:main
  ```

- Never print `GH_PUSH_TOKEN`. If it is unset or the push fails, skip pushing,
  keep the work local, and note it in the run report — never block the content
  workflow on a failed push.
