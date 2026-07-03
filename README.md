# insta-carousel-generator

Autonomous Instagram carousel content-generation and publishing system. It reads
ideas and settings from Google Sheets, has Claude author one excellent carousel,
renders polished 1080×1350 slides with Chromium, stores them on Cloudflare R2,
and either saves a draft (`TEST`) or publishes through the **official Instagram
API with Instagram Login** (`LIVE`). It runs on a Claude Max Remote Routine — no
VPS, no browser automation of Instagram, no third-party schedulers, no unofficial
APIs. The only recurring cost is the existing Claude Max subscription; all
infrastructure is free-tier.

> **Operators:** read [`CLAUDE.md`](./CLAUDE.md) first. The app is already built.
> Each run you operate it and process exactly one carousel.

## Architecture

```
Google Sheets  ──▶  idea selection ──▶ Claude authors carousel ──▶ render (Chromium)
 (queue/settings/       │                                              │
  tracker)              │                                     visual validation
                        ▼                                              │
                Cloudflare R2 ◀── upload slides + preview ◀────────────┘
                 ├─ public  : carousel images, preview HTML
                 └─ private : locks, idempotency, encrypted token, recovery
                        │
              TEST ─────┴──── LIVE ──▶ official Instagram API ──▶ media id + permalink
             (DRAFT_READY)                                          (POSTED)
```

- Deterministic mechanics in `src/`; three creative seams (idea, carousel,
  visual approval) are performed by Claude and passed through `runtime/` files.
- No database. Google Sheets is the human-visible tracker, R2 private storage
  holds distributed state, GitHub holds code and non-secret config.

## Environment variables

Injected at runtime by the routine environment. `.env.example` holds
**placeholders only**; never create a real `.env`. Presence is validated without
printing values; missing required variables are reported by name only.

| Variable                                                    | Purpose                                                     |
| ----------------------------------------------------------- | ----------------------------------------------------------- |
| `GOOGLE_SHEET_ID`                                           | Spreadsheet id                                              |
| `GOOGLE_SERVICE_ACCOUNT_B64`                                | Base64 service-account JSON (decoded in memory)             |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | R2 credentials                                              |
| `R2_PUBLIC_BUCKET`, `R2_PRIVATE_BUCKET`                     | Bucket names                                                |
| `R2_ENDPOINT`, `R2_PUBLIC_BASE_URL`                         | S3 endpoint + public CDN base (scheme optional; normalized) |
| `INSTAGRAM_ACCESS_TOKEN`, `INSTAGRAM_USER_ID`               | Long-lived token + professional account id (LIVE)           |
| `META_GRAPH_API_VERSION`                                    | Graph API version (default `v21.0`)                         |
| `TOKEN_ENCRYPTION_KEY`                                      | 32-byte key (hex/base64) for AES-256-GCM token encryption   |
| `TIMEZONE`                                                  | Timestamp zone (default `America/Toronto`)                  |
| `NODE_ENV`                                                  | Runtime env (default `production`)                          |

## Google Sheet schema

Three tabs, never renamed: `Instructions`, `Settings`, `Content`.

**`Settings`** is read as key/value rows (`A:B`). Keys: `MODE`, `NICHE`,
`TARGET_AUDIENCE`, `ACCOUNT_GOAL`, `BRAND_NAME`, `INSTAGRAM_HANDLE`,
`BRAND_COLORS`, `BRAND_STYLE`, `CONTENT_PILLARS`, `DEFAULT_CTA`, `POST_LANGUAGE`,
`LOOKBACK_DAYS`, `MIN_SLIDES`, `MAX_SLIDES`, `PUBLISH_EXISTING_DRAFT_FIRST`,
`AUTO_GENERATE_WHEN_EMPTY`. `MODE` defaults safely to `TEST` when missing or
unknown.

**`Content`** has exactly these columns, in order:
`idea_id, idea, priority, source, status, added_at, selected_at, hook,
content_pillar, template, slide_count, caption, preview_url, published_at,
instagram_media_id, permalink, error`.

- Statuses: `UNUSED, SELECTED, GENERATING, RENDERING, DRAFT_READY, POSTING,
POSTED, FAILED, VERIFY_REQUIRED`.
- Priority: `High, Medium, Low`. Source: `Manual, Claude`.
- Rows are never deleted; updates are addressed by `idea_id`. Headers are
  verified exactly before any write — mismatches fail safely.

## TEST vs LIVE behaviour

- **TEST** (required for the first bootstrap draft): select/generate → author →
  render → inspect → upload → preview → set `DRAFT_READY`. No Instagram
  containers, no publish, row never marked `POSTED`. The preview URL _is_ the
  draft.
- **LIVE**: first recover any `VERIFY_REQUIRED` row; then, if
  `PUBLISH_EXISTING_DRAFT_FIRST`, publish the oldest eligible `DRAFT_READY`;
  otherwise select/generate → build → publish in the same run. A LIVE run
  succeeds only after a verified published media id + permalink and Sheet
  `POSTED`.

## R2 structure

- **Public** (`R2_PUBLIC_BUCKET`): `carousels/YYYY/MM/DD/<idea_id>/slide-NN.png`
  and `previews/YYYY/MM/DD/<idea_id>/index.html`. Correct content types + cache
  control; every URL is verified `200` before proceeding.
- **Private** (`R2_PRIVATE_BUCKET`): `locks/workflow.json`,
  `idempotency/<key>.json`, `attempts/<key>.json`, `token/instagram-token.json`
  (encrypted), `manifests/<idea_id>.json`. **Never** placed in the public bucket.

## Instagram integration

Official API on `graph.instagram.com` with a long-lived Instagram User token and
permissions `instagram_business_basic` + `instagram_business_content_publish`.
Publishing creates one child container per slide (carousel items), polls them
ready, creates the parent `CAROUSEL` container with the caption, polls it,
publishes, then verifies media ownership + permalink. Temporary errors use
bounded backoff; permanent auth/permission/validation errors are not retried.

## Running manually

```
npm ci
npm run healthcheck
npm run select-idea      # writes runtime/selection-context.json
# author runtime/post-plan.json (see schemas/post.ts and CLAUDE.md)
npm run render           # renders runtime/slides/*.png + report; inspect them
# write runtime/visual-approval.json {"approved":true,"notes":"..."}
npm run workflow         # TEST: draft. LIVE (Sheet MODE=LIVE): publish.
```

`npm run render:fixture` renders the bundled sample post to prove the renderer.

## Recovery

`npm run recover` (alias `verify:publication`) runs the workflow, which first
handles any `VERIFY_REQUIRED` row: it checks the idempotency record, the saved
parent container, and recent account media by caption fingerprint. If the post
actually published it is marked `POSTED`; otherwise it is returned to
`DRAFT_READY` for a future publish. Ambiguous publishes are never blindly
retried.

## Token maintenance

On first successful credential validation the env token is encrypted
(AES-256-GCM) and stored in private R2; later runs prefer the stored token.
Tokens are validated before publishing and refreshed via the official
long-lived-token refresh endpoint when within 7 days of expiry, then re-stored
encrypted. If refresh fails, a sanitized failure is recorded and the run reports
that the env token may need manual replacement — the plaintext token is never
exposed.

## Security

Secrets come only from env vars and are never printed, committed, or embedded in
HTML/captions/previews/Sheet cells/errors. `src/security.ts` redacts known secret
values and token-like patterns from all logs. `.gitignore` excludes `.env*`,
service-account/token/credential files, private runtime output, Playwright temp
files, and `node_modules`. The plaintext Instagram token is never stored in the
public bucket.

## Common failures

- **Missing env var** → healthcheck names it. Provide it in the environment.
- **R2 "Invalid URL"** → endpoint/base URL lacked a scheme; config normalizes
  this, but confirm the values are correct hosts.
- **Public URL not 200** → the public bucket isn't served at
  `R2_PUBLIC_BASE_URL`; fix bucket public access / custom domain.
- **Chromium not found** → the renderer resolves `/opt/pw-browsers/chromium` or
  `PLAYWRIGHT_CHROMIUM_EXECUTABLE`; set that env var to your Chromium binary.
- **Validation failed (overflow/tiny font/dimensions)** → shorten copy, adjust
  line breaks, or pick another template; re-render. Never shrink below the
  accessible minimum.
- **Instagram permanent error** → auth/permission/validation problem; not
  retried. Check token scopes and account type.

## Changing templates

The six templates live in `templates/<name>/template.css` and layer on the shared
base CSS in `src/render.ts`. Edit a template's CSS (it uses brand CSS variables
`--c-primary/secondary/accent/bg/surface/text/muted/on-primary`), then
`npm run render` and inspect. Brand colours from the Sheet are mapped to roles by
luminance/chroma so text stays high-contrast and the vivid colour is used as a
decorative accent.

## Pausing publishing

Set `Settings!MODE` to `TEST`. Every run then stops at `DRAFT_READY` and never
publishes. Set it back to `LIVE` to resume.

## Reviewing drafts

Open the `preview_url` saved on each `DRAFT_READY` row — a self-contained page
showing every slide, the idea, hook, caption, hashtags, pillar, template,
timestamp, mode, and a clear DRAFT/PUBLISHED label. It contains no secrets and is
marked `noindex`.
