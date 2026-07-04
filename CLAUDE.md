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
npm run select-idea          # or, if queue empty, author runtime/idea-plan.json
# author runtime/post-plan.json based on runtime/selection-context.json
npm run render               # renders runtime/slides/*.png + validation report
# READ every runtime/slides/*.png yourself; fix copy/template if anything is off
# write runtime/visual-approval.json {"approved":true,"notes":"..."}
npm run workflow             # selects/generates, renders, validates, uploads, drafts or publishes
```

`MODE_OVERRIDE=TEST npm run workflow:test` forces TEST regardless of the Sheet.

### Authoring rules (must follow)

- One clear lesson. Match `NICHE`, `TARGET_AUDIENCE`, `POST_LANGUAGE`.
- 6–8 slides normally, within `MIN_SLIDES`..`MAX_SLIDES`. First slide `cover`;
  last `summary` or `cta`.
- Headlines ≤ ~10 words; bodies ~15–40 words. No generic AI filler, no unmet
  clickbait, minimal emoji, natural human wording.
- **Never invent** statistics, quotes, case studies, prices, laws, credentials.
  If the topic needs current facts, research primary sources and put them in
  `post.sources`; otherwise prefer evergreen practical content.
- Do not repeat a recent topic/hook/framework — `src/similarity.ts` runs an
  automated dedup check; apply semantic judgment on top.
- The workflow overrides `idea_id` and `idempotency_key`; your `post-plan.json`
  values for those are placeholders.

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

### Content direction & theming

- This account covers **Claude / Claude Code, OpenAI / Codex, Gemini, Grok, Meta
  AI / Llama, Mistral, and new AI tool + tech news**. Keep content timely and
  accurate.
- For topics that need current facts (new releases, version numbers, dates,
  benchmarks), **research primary sources** and put the URLs in `post.sources`.
  Never invent version numbers, dates, or benchmark stats.
- Set the carousel's `theme` in `post-plan.json` to match the subject so the right
  brand colors + logo apply. Themes: `claude`, `openai`, `gemini`, `grok`, `meta`,
  `mistral`, `breaking` (generic high-attention AI-news look for vendorless
  stories), `default`. When unset, the renderer auto-detects from the idea/pillar
  text (`detectTheme` in `src/render.ts`).
- Templates: `numbered-list`, `step-by-step`, `myth-reality`, `mistake-solution`,
  `comparison`, `checklist`, and `breaking-news` (a newsroom chyron + oversized
  hook — pairs well with the `breaking` theme for scroll-stopping news posts).
- Visual inspection must **reject bland output**: every slide should show the
  themed background gradient and a graphic accent, and the cover must carry the
  theme's logo mark — not plain text on a flat background.

### Motion (moving carousels)

- The `MOTION_SLIDES` Setting controls animated (MP4) slides: `off` (image-only),
  `cover` (slide 1 moves), `cover+key` (**default** — cover + any slide flagged
  `animate: true`), `all`. Instagram carousels mix image + video children, so
  motion slides publish as `media_type=VIDEO` alongside static image slides.
- Motion is captured deterministically (CSS `@keyframes` → frame-stepped
  screenshots → H.264 MP4 via `src/motion.ts`) and every motion slide still emits
  a poster PNG (its settled t=0 frame) for inspection and the grid thumbnail.
- **Authoring for motion:** all animation is "settled at t=0" (drift/shimmer/glow
  on already-visible elements) so the first frame is a strong still and the
  overflow check passes. You don't hand-write animations — they're baked into the
  theme/template CSS; you only choose which slides move via `MOTION_SLIDES` /
  `animate`.
- **Before the first LIVE motion post**, run `npm run verify:motion` — it creates
  and polls a real VIDEO container (no parent, no publish) to confirm Instagram
  accepts the MP4 spec. Requires a full `ffmpeg` with libx264 (bundled via
  `@ffmpeg-installer/ffmpeg`; `npm run healthcheck` verifies it when motion is on).

### Visual inspection is mandatory

`npm run render` produces the exact bytes the workflow will upload (rendering is
deterministic). Read each PNG. Check hierarchy, readability, spacing, alignment,
clipping, contrast, branding, sequence, repetition, spelling. If anything is
wrong, fix the copy or choose another template and re-render — do not shrink text
below the accessible minimum. Only write `visual-approval.json` once it passes.

---

## Architecture (files you operate, do not rewrite)

- `src/config.ts` — env validation (names only, never values); URL normalization.
- `src/security.ts` — secret redaction + AES-256-GCM token encryption.
- `src/google-sheets.ts` / `src/content-tracker.ts` — Sheet auth + the exact
  tab/column contract; updates addressed by `idea_id`, never by row position.
- `src/idea-selection.ts` — priority ordering, resumable rows, generated ideas.
- `src/similarity.ts` — deterministic Jaccard + bigram dedup.
- `src/research-validation.ts` — detects volatile claims needing sources.
- `src/render.ts` — HTML/CSS → 1080×1350 PNG via Chromium; brand-color role
  inference; in-page overflow/font metrics.
- `src/visual-validation.ts` — copy, metric, and image (sharp) validation.
- `src/r2.ts` — public (media/previews) vs private (locks/idempotency/token/
  recovery) buckets. Private state must never touch the public bucket.
- `src/locks.ts` — distributed workflow lock in private R2 (stale recovery).
- `src/token-manager.ts` — encrypted token at rest, prefer stored over env,
  refresh near expiry.
- `src/instagram.ts` — official `graph.instagram.com` publish primitives.
- `src/recovery.ts` — idempotency keys/records, ambiguous-publish verification.
- `src/workflow.ts` — the orchestrator (`runWorkflow`); one carousel per run.
- `src/cli.ts` — command entry points.
- `templates/<name>/template.css` — six branded visual systems layered on the
  shared base CSS in `render.ts`.

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
