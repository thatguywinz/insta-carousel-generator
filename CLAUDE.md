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
# Real story? → NEWS lane. Genuinely nothing shipped? → VALUE lane (education).
npm run select-idea          # or, if queue empty, author runtime/idea-plan.json
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

**Lane 1 — `news` (always preferred).** A real, fresh, sourced development.
**Lane 2 — `value` (fallback ONLY when nothing shipped).** Real AI education: one
concrete technique the reader can use today.

**News always wins.** If a genuine story broke inside `MAX_STORY_AGE_DAYS`
(default 14), you cover it — you do not get to skip it because a tips post is
easier. The value lane exists for quiet weeks, not for lazy ones.

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
3. **Only if the search genuinely comes up empty** do you switch to the value lane —
   and you must then write `post.no_news_reason` saying what you searched and why
   nothing was worth covering.

### Step 2a — authoring a NEWS post (`content_type: "news"`)

- `post.sources[]` — each needs `url`, `description`, `published_at` (`YYYY-MM-DD`).
- `post.why_now` — one honest sentence: what happened, when, why it matters now.
- Then **make it usable**: report the change, then give the takeaway — the setting to
  flip, the workflow it unlocks, what it means for the reader's stack.

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

Kill the idea unless it clears all four:

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
  - news lane: `NO_WHY_NOW`, `NO_SOURCE`, `NO_SOURCE_DATE`, `STALE_STORY`
  - value lane: `NO_VALUE_PROMISE`, `NO_FALLBACK_REASON`, `NOT_ACTIONABLE`
  - either lane: `HYPE_SLOP`
  - `CONTENT_MODE=news-only` additionally rejects the value lane (`VALUE_NOT_ALLOWED`).
- **Report the news, then make it usable.** Lead with what changed, then give the
  takeaway/workflow. Match `NICHE`, `TARGET_AUDIENCE`, `ACCOUNT_GOAL`,
  `POST_LANGUAGE`.
- 5–8 slides normally, within `MIN_SLIDES`..`MAX_SLIDES`. First slide `cover`;
  **last slide must be `cta`** (or `summary`) — `NO_CLOSER` is a hard error.
- Headlines ≤ ~10 words; bodies ~15–40 words. No generic AI filler, no unmet
  clickbait, minimal emoji, natural human wording that sounds like a person.
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

The first slide's `headline` is the scroll-stopper — write it like a viral AI-news
account, not a textbook. Pick a proven pattern and keep it concrete:

- **Concrete number / result** — "GPT-4 beaten by a 7B open model on coding".
- **"X just changed"** — "Claude Code just got parallel subagents".
- **Contrarian** — "Everyone's wrong about long context. Here's the data."
- **Curiosity gap** — "The one setting that doubled our agent's success rate".
- **Direct callout** — "If you use ChatGPT for code, read this."

Rules: ≤ ~10 words, front-load the payoff, no unmet clickbait, and never fabricate
the number/claim (source volatile facts in `post.sources`). Auto-fit shrinks a bold
cover headline to fit (floor ~56px); if it still overflows, **shorten the copy** —
don't accept a tiny hook. Avoid the phrases blocklisted in `src/visual-validation.ts`.

### CTA playbook (the last slide earns the follow)

The final `cta` slide is where a scroller becomes a follower — only if you give them
a concrete reason. Recap the value delivered, then promise more of it. Write it so
someone who just got value thinks "yes, I want the next one".

- **Value-specific, not generic** — "Follow @realestgarg — every new AI tool broken
  down in a 6-slide carousel", not "follow for more".
- **Tie it to what they just got** — "That's how to fan out agents. I post one of
  these every time a tool ships → follow so you don't miss it."
- **One clear action** — save, share, or follow (pick one primary).
- `headline` = the ask ("Want the next drop first?"); `body` = the follow reason;
  `kicker` = a short button label. Leave `body`/`kicker` empty to inherit the Sheet's
  `DEFAULT_CTA` (the body) and `Follow @handle` (the pill) — both wired in
  `src/render.ts`. Never ship an empty, generic closer.

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
  artistic, non-rainbow systems:
  - `editorial` — high-contrast serif magazine, whitespace, hairline accent, grain.
  - `brutalist` — mono type, hard grid, square blocks, bracket labels (how-tos).
  - `spotlight` — dark cinematic stage, one accent glow, centered oversized type.
  - `kinetic` — huge grotesk filling the frame (best for _short_ punchy hooks).
  - `blueprint` — technical graph grid, corner ticks, mono annotations.
  - `poster` — bold Swiss color blocks + oversized type.
    Leave it unset to let the `ART_DIRECTION` Setting rotate it (default `auto`,
    seeded per idea). **Set it deliberately and vary it from recent posts** so every
    post looks like a different designed piece. Match the style to the content
    (kinetic → one-line hooks; brutalist/blueprint → technical how-tos; editorial →
    explainers; spotlight/poster → launches). `kinetic` **and** `brutalist` use
    wide/mono display type — keep their cover hooks short (≤ ~6 words) or auto-fit
    will shrink them to the 56px floor.
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
  parallax/drift, breathing glows, slow-rotating accent marks on already-visible
  elements) so the first frame is a strong still and the overflow check passes.
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
