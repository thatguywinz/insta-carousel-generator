import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, instagramConfigured } from './config.js';
import { log } from './logger.js';
import { sanitizeError } from './security.js';
import { runHealthcheck } from './healthcheck.js';
import { runWorkflow, WorkflowProviders, SelectionContext, WorkflowResult } from './workflow.js';
import { createSheetsClient } from './google-sheets.js';
import {
  SheetContext,
  verifyTabs,
  verifyContentHeaders,
  readSettings,
  readContentRows,
} from './content-tracker.js';
import {
  selectUnusedIdea,
  unusedSelectOptions,
  selectResumable,
  markSelected,
} from './idea-selection.js';
import { loadBrand, renderPost } from './render.js';
import { validateAll } from './visual-validation.js';
import { PostSchema, Post } from '../schemas/post.js';
import { GeneratedIdeaInput } from './idea-selection.js';
import { createR2, putPublic, headPublic, verifyPublicUrl } from './r2.js';
import { acquireLock, releaseLock } from './locks.js';
import { loadActiveToken, refreshTokenIfNeeded } from './token-manager.js';
import {
  createIgClient,
  validateCredentials,
  createVideoChildContainer,
  getContainerStatus,
  pollUntilReady,
  defaultHttp,
} from './instagram.js';

/**
 * CLI entry point. The creative seams (authoring the carousel / new idea and
 * approving visuals) are wired to files under runtime/ so the operating model
 * writes them between commands. Everything else is fully deterministic.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const RUNTIME = path.join(REPO_ROOT, 'runtime');

async function readJsonIfExists<T>(p: string): Promise<T | null> {
  try {
    const raw = await readFile(p, 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** File-based providers for the CLI-driven workflow. */
function fileProviders(): WorkflowProviders {
  return {
    authorPost: async (ctx: SelectionContext): Promise<Post> => {
      const plan = await readJsonIfExists<unknown>(path.join(RUNTIME, 'post-plan.json'));
      if (!plan) {
        // Emit selection context so the operator can author the carousel.
        await mkdir(RUNTIME, { recursive: true });
        await writeFile(
          path.join(RUNTIME, 'selection-context.json'),
          JSON.stringify(ctx, null, 2),
          'utf8',
        );
        throw new Error(
          'AUTHOR_NEEDED: no runtime/post-plan.json. Selection context written to runtime/selection-context.json — author the carousel, then re-run.',
        );
      }
      return PostSchema.parse({ ...(plan as object), idea_id: ctx.ideaId });
    },
    authorIdea: async (settings, recent): Promise<GeneratedIdeaInput> => {
      const plan = await readJsonIfExists<GeneratedIdeaInput>(path.join(RUNTIME, 'idea-plan.json'));
      if (!plan) {
        await mkdir(RUNTIME, { recursive: true });
        await writeFile(
          path.join(RUNTIME, 'idea-context.json'),
          JSON.stringify({ settings, recent }, null, 2),
          'utf8',
        );
        throw new Error(
          'IDEA_NEEDED: idea queue empty and no runtime/idea-plan.json. Context written to runtime/idea-context.json — author an idea, then re-run.',
        );
      }
      return plan;
    },
    inspectVisuals: async (slides, post) => {
      // Persist rendered slides so the operator can inspect them, then gate on
      // an approval file the operator writes after inspection.
      await mkdir(path.join(RUNTIME, 'slides'), { recursive: true });
      for (const s of slides) {
        const base = `slide-${String(s.index).padStart(2, '0')}`;
        await writeFile(path.join(RUNTIME, 'slides', `${base}.png`), s.png);
        // Motion slides also emit the MP4 so inspection sees the movement.
        if (s.mp4) await writeFile(path.join(RUNTIME, 'slides', `${base}.mp4`), s.mp4);
      }
      const approval = await readJsonIfExists<{ approved: boolean; notes?: string }>(
        path.join(RUNTIME, 'visual-approval.json'),
      );
      if (approval && approval.approved) {
        return { approved: true, notes: approval.notes ?? 'operator-approved' };
      }
      throw new Error(
        `INSPECTION_NEEDED: ${slides.length} slides written to runtime/slides for idea ${post.idea_id}. Inspect them, then write runtime/visual-approval.json {"approved":true} and re-run.`,
      );
    },
  };
}

function printResult(result: WorkflowResult): void {
  console.log('\n================ RUN REPORT ================');
  console.log(`Mode:            ${result.mode}`);
  console.log(`Run type:        ${result.bootstrap ? 'bootstrap' : 'normal'}`);
  console.log(`Idea:            ${result.idea ?? '(none)'}`);
  console.log(`Idea source:     ${result.source ?? '(n/a)'}`);
  console.log(`Final status:    ${result.status}`);
  console.log(`Slides:          ${result.slideCount ?? '-'}`);
  console.log(`Template:        ${result.template ?? '-'}`);
  console.log(`Preview URL:     ${result.previewUrl ?? '-'}`);
  console.log(`Permalink:       ${result.permalink ?? '-'}`);
  console.log(`Media ID:        ${result.mediaId ?? '-'}`);
  console.log(`Sheet updated:   ${result.sheetUpdated}`);
  console.log(`Token refreshed: ${result.tokenRefreshed}`);
  console.log(`Lock released:   ${result.lockReleased}`);
  if (result.warnings.length) {
    console.log('Warnings:');
    for (const w of result.warnings) console.log(`  - ${w}`);
  }
  console.log('===========================================\n');
}

async function cmdHealthcheck(): Promise<number> {
  const cfg = loadConfig();
  const report = await runHealthcheck(cfg);
  console.log(`\nHealthcheck (MODE=${report.mode}): ${report.ok ? 'OK' : 'FAILED'}`);
  for (const c of report.checks) {
    console.log(`  [${c.ok ? '✓' : '✗'}] ${c.name}: ${c.detail}`);
  }
  return report.ok ? 0 : 1;
}

async function cmdWorkflow(): Promise<number> {
  const cfg = loadConfig();
  const modeOverride =
    process.env.MODE_OVERRIDE === 'TEST'
      ? 'TEST'
      : process.env.MODE_OVERRIDE === 'LIVE'
        ? 'LIVE'
        : undefined;
  const result = await runWorkflow({ cfg, providers: fileProviders(), modeOverride });
  printResult(result);
  const success = ['DRAFT_READY', 'POSTED', 'NO_WORK'].includes(result.status);
  return success ? 0 : 1;
}

async function cmdSelectIdea(): Promise<number> {
  const cfg = loadConfig();
  const client = await createSheetsClient(cfg.googleServiceAccountB64, cfg.googleSheetId);
  const ctx: SheetContext = { client, timezone: cfg.timezone };
  await verifyTabs(ctx);
  await verifyContentHeaders(ctx);
  const settings = await readSettings(ctx);
  const brand = await loadBrand(settings);

  // markSelected mutates the Sheet and (for manual rows without an idea_id)
  // addresses cells by row position — safe only under the workflow lock, so a
  // concurrent scheduled run can't interleave and corrupt the selection.
  const r2 = createR2(cfg);
  const lock = await acquireLock(r2, { stage: 'select-idea' });
  if (!lock) {
    console.error('Another workflow run holds the lock; try again shortly.');
    return 1;
  }
  try {
    const rows = await readContentRows(ctx);

    const resumable = selectResumable(rows);
    const row = resumable ?? selectUnusedIdea(rows, unusedSelectOptions(settings, cfg.timezone));
    if (!row) {
      console.log(
        'No UNUSED or in-progress idea available. Author runtime/idea-plan.json and run workflow.',
      );
      await mkdir(RUNTIME, { recursive: true });
      await writeFile(
        path.join(RUNTIME, 'idea-context.json'),
        JSON.stringify({ settings }, null, 2),
        'utf8',
      );
      return 0;
    }
    const ideaId = row.idea_id.trim() || (await markSelected(ctx, row));
    const context: SelectionContext = { ideaId, idea: row.idea, settings, brand, recentTopics: [] };
    await mkdir(RUNTIME, { recursive: true });
    await writeFile(
      path.join(RUNTIME, 'selection-context.json'),
      JSON.stringify(context, null, 2),
      'utf8',
    );
    console.log(`Selected idea: ${row.idea}`);
    console.log(`idea_id: ${ideaId}`);
    console.log(
      'Context written to runtime/selection-context.json. Author runtime/post-plan.json next.',
    );
    return 0;
  } finally {
    await releaseLock(r2, lock);
  }
}

async function cmdRender(): Promise<number> {
  // Deterministic render of runtime/post-plan.json — no sheet/R2 mutation.
  const cfg = loadConfig();
  const plan = await readJsonIfExists<unknown>(path.join(RUNTIME, 'post-plan.json'));
  if (!plan) {
    console.error('runtime/post-plan.json not found.');
    return 1;
  }
  const post = PostSchema.parse(plan);
  const client = await createSheetsClient(cfg.googleServiceAccountB64, cfg.googleSheetId);
  const ctx: SheetContext = { client, timezone: cfg.timezone };
  const settings = await readSettings(ctx);
  const brand = await loadBrand(settings);
  const slides = await renderPost(post, brand, {
    motion: settings.MOTION_SLIDES,
    artDirection: settings.ART_DIRECTION,
  });
  await mkdir(path.join(RUNTIME, 'slides'), { recursive: true });
  for (const s of slides) {
    const base = `slide-${String(s.index).padStart(2, '0')}`;
    await writeFile(path.join(RUNTIME, 'slides', `${base}.png`), s.png);
    // Animated slides also emit an MP4 so the mandatory visual inspection sees
    // the motion, not just the poster still.
    if (s.mp4) await writeFile(path.join(RUNTIME, 'slides', `${base}.mp4`), s.mp4);
  }
  const report = await validateAll(post, slides, settings);
  await writeFile(
    path.join(RUNTIME, 'render-report.json'),
    JSON.stringify(report, null, 2),
    'utf8',
  );
  console.log(`Rendered ${slides.length} slides to runtime/slides/`);
  console.log(`Validation: ${report.ok ? 'OK' : 'FAILED'}`);
  for (const i of report.issues)
    console.log(`  [${i.severity}] slide ${i.slide ?? '-'}: ${i.code} ${i.message}`);
  return report.ok ? 0 : 1;
}

async function cmdRenderFixture(): Promise<number> {
  const cfg = loadConfig();
  const fixturePath = path.join(REPO_ROOT, 'tests', 'fixtures', 'sample-post.json');
  const raw = await readFile(fixturePath, 'utf8');
  const post = PostSchema.parse(JSON.parse(raw));
  const client = await createSheetsClient(cfg.googleServiceAccountB64, cfg.googleSheetId).catch(
    () => null,
  );
  const settings = client ? await readSettings({ client, timezone: cfg.timezone }) : undefined;
  const brand = await loadBrand(
    settings ?? (await import('../schemas/settings.js')).parseSettings({}),
  );
  const slides = await renderPost(post, brand, {
    motion: settings?.MOTION_SLIDES ?? 'off',
    artDirection: settings?.ART_DIRECTION,
  });
  await mkdir(path.join(RUNTIME, 'fixture-slides'), { recursive: true });
  for (const s of slides) {
    await writeFile(
      path.join(RUNTIME, 'fixture-slides', `slide-${String(s.index).padStart(2, '0')}.png`),
      s.png,
    );
  }
  const report = await validateAll(
    post,
    slides,
    settings ?? (await import('../schemas/settings.js')).parseSettings({}),
  );
  console.log(
    `Fixture rendered ${slides.length} slides. Validation: ${report.ok ? 'OK' : 'FAILED'}`,
  );
  for (const i of report.issues)
    console.log(`  [${i.severity}] slide ${i.slide ?? '-'}: ${i.code} ${i.message}`);
  return report.ok ? 0 : 1;
}

async function cmdRecover(): Promise<number> {
  const cfg = loadConfig();
  // Recovery runs the normal workflow, which handles VERIFY_REQUIRED first.
  const result = await runWorkflow({ cfg, providers: fileProviders() });
  printResult(result);
  return 0;
}

/**
 * Non-publishing motion dry-run. Encodes a sample MP4, uploads it, and creates a
 * single VIDEO carousel-item container against the REAL Instagram API, polling to
 * FINISHED — but NEVER creates a parent carousel or publishes (a parent needs >=2
 * children and would post). This validates that Instagram accepts our exact MP4
 * spec before any live motion carousel. Uses the encrypted token from private R2.
 */
async function cmdVerifyMotion(): Promise<number> {
  const cfg = loadConfig();
  if (!instagramConfigured(cfg)) {
    console.error(
      `verify:motion needs Instagram configured (missing: ${cfg.missingInstagram.join(', ') || 'INSTAGRAM_*'}). ` +
        'Run this in the environment that holds the account credentials.',
    );
    return 1;
  }

  const client = await createSheetsClient(cfg.googleServiceAccountB64, cfg.googleSheetId).catch(
    () => null,
  );
  const settings = client
    ? await readSettings({ client, timezone: cfg.timezone })
    : (await import('../schemas/settings.js')).parseSettings({});
  const brand = await loadBrand(settings);

  // Minimal one-motion-slide post; render just the animated cover to an MP4.
  const post = PostSchema.parse({
    idea_id: 'verify-motion',
    idea: 'Motion publish-path verification',
    hook: 'Confirming Instagram accepts our motion MP4 spec',
    content_pillar: 'internal',
    template: 'numbered-list',
    slides: [
      {
        type: 'cover',
        kicker: 'Dry run',
        headline: 'Motion spec check',
        body: 'No post is created.',
      },
      {
        type: 'summary',
        headline: 'Container only',
        body: 'This validates encoding + acceptance.',
      },
      { type: 'cta', headline: 'Safe', body: 'A parent carousel is never assembled.' },
    ],
    caption: 'verify:motion dry run',
    hashtags: [],
    generated_at: new Date().toISOString(),
    idempotency_key: 'verify-motion',
  });

  const slides = await renderPost(post, brand, { motion: 'cover' });
  const motion = slides.find((s) => s.mp4);
  if (!motion || !motion.mp4) {
    console.error('verify:motion: renderer produced no MP4 (is ffmpeg with libx264 available?).');
    return 1;
  }
  console.log(`Encoded sample MP4: ${motion.mp4.length} bytes.`);

  const r2 = createR2(cfg);
  const key = `carousels/verify-motion/dryrun-${Date.now()}.mp4`;
  const url = await putPublic(r2, key, motion.mp4, { contentType: 'video/mp4' });
  const head = await headPublic(r2, key);
  const reach = await verifyPublicUrl(url);
  if (!reach.ok) {
    console.error(`Uploaded MP4 not publicly reachable (status ${reach.status}): ${url}`);
    return 1;
  }
  console.log(`Uploaded + reachable: ${url} (content-type ${head?.contentType ?? '?'}).`);

  const active = await loadActiveToken(r2, cfg);
  if (!active) {
    console.error('No Instagram token available (expected an encrypted token in private R2).');
    return 1;
  }
  const refresh = await refreshTokenIfNeeded(r2, cfg, active, {
    httpGet: async (u) => defaultHttp.get(u),
  });
  const ig = createIgClient(cfg, refresh.token.token, cfg.instagram.userId!, defaultHttp);
  const cred = await validateCredentials(ig);
  if (!cred.ok) {
    console.error(`Instagram credential invalid: ${cred.reason}`);
    return 1;
  }

  console.log('Creating VIDEO carousel-item container (no parent, no publish)…');
  const childId = await createVideoChildContainer(ig, url);
  console.log(`Container created: ${childId}. Polling to FINISHED…`);
  await pollUntilReady(ig, childId, { maxAttempts: 30, baseDelayMs: 4000 });
  const status = await getContainerStatus(ig, childId);
  console.log(`\n✓ verify:motion PASSED — container ${childId} reached ${status}.`);
  console.log('  No carousel parent was created and nothing was published.');
  return 0;
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'workflow';
  log.info(`cli command: ${command}`);
  let code = 0;
  try {
    switch (command) {
      case 'healthcheck':
        code = await cmdHealthcheck();
        break;
      case 'workflow':
      case 'workflow:test':
      case 'workflow:live':
        code = await cmdWorkflow();
        break;
      case 'select-idea':
        code = await cmdSelectIdea();
        break;
      case 'render':
        code = await cmdRender();
        break;
      case 'render-fixture':
        code = await cmdRenderFixture();
        break;
      case 'recover':
      case 'verify-publication':
        code = await cmdRecover();
        break;
      case 'verify:motion':
      case 'verify-motion':
        code = await cmdVerifyMotion();
        break;
      default:
        console.error(`Unknown command: ${command}`);
        code = 2;
    }
  } catch (err) {
    log.error('cli command failed', { message: sanitizeError(err) });
    code = 1;
  }
  process.exit(code);
}

void main();
