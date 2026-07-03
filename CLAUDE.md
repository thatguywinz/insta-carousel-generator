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

### Content direction & theming

- This account covers **Claude / Claude Code, OpenAI / Codex, and new AI tool +
  tech news**. Keep content timely and accurate.
- For topics that need current facts (new releases, version numbers, dates,
  benchmarks), **research primary sources** and put the URLs in `post.sources`.
  Never invent version numbers, dates, or benchmark stats.
- Set the carousel's `theme` (`claude` / `openai` / `default`) in
  `post-plan.json` to match the subject so the right brand colors + logo apply.
  When unset, the renderer auto-detects the theme from the idea/pillar text
  (`detectTheme` in `src/render.ts`).
- Visual inspection must **reject bland output**: every slide should show the
  themed background gradient and a graphic accent, and the cover must carry the
  theme's logo mark — not plain text on a flat background.

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
verify:publication`

Before committing: format, typecheck, run tests, inspect `git diff`, scan for
secrets, confirm no service-account/token/private-state files are tracked.
