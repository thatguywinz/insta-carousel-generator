import { AppConfig, instagramConfigured } from './config.js';
import { createSheetsClient } from './google-sheets.js';
import {
  SheetContext,
  verifyTabs,
  verifyContentHeaders,
  readSettings,
  readContentRows,
  updateRowFields,
  nowTimestamp,
} from './content-tracker.js';
import { Settings } from '../schemas/settings.js';
import { Post, PostSchema } from '../schemas/post.js';
import {
  selectPublishableDraft,
  selectUnusedIdea,
  selectResumable,
  selectVerifyRequired,
  markSelected,
  buildRecentCorpus,
  insertGeneratedIdea,
  GeneratedIdeaInput,
} from './idea-selection.js';
import {
  createR2,
  R2,
  putPublic,
  putPrivateJson,
  getPrivateJson,
  verifyPublicUrl,
  headPublic,
} from './r2.js';
import { acquireLock, heartbeatLock, releaseLock, LockHandle } from './locks.js';
import { loadActiveToken, refreshTokenIfNeeded } from './token-manager.js';
import {
  createIgClient,
  validateCredentials,
  checkPublishingLimit,
  createChildContainer,
  createCarouselContainer,
  publishContainer,
  pollUntilReady,
  getMedia,
  HttpClient,
  defaultHttp,
  IgApiError,
} from './instagram.js';
import {
  computeIdempotencyKey,
  getIdempotencyRecord,
  saveIdempotencyRecord,
  saveAttemptRecord,
  getAttemptRecord,
  verifyPublication,
  AttemptRecord,
} from './recovery.js';
import { loadBrand, renderPost, RenderedSlide, Brand } from './render.js';
import { validateAll, ValidationReport } from './visual-validation.js';
import { buildPreviewHtml } from './preview.js';
import { DateTime } from 'luxon';
import { log, stage } from './logger.js';
import { sanitizeError } from './security.js';

/**
 * End-to-end content workflow. Processes at most ONE carousel per run. The
 * creative seams — authoring the carousel and (optionally) a new idea, plus the
 * human-grade visual inspection — are injected so the operating model performs
 * them, while all deterministic mechanics live here.
 */

export interface SelectionContext {
  ideaId: string;
  idea: string;
  settings: Settings;
  brand: Brand;
  recentTopics: string[];
}

export interface VisualInspection {
  approved: boolean;
  notes: string;
}

export interface WorkflowProviders {
  /** Author the carousel for a selected idea. */
  authorPost: (ctx: SelectionContext) => Promise<Post>;
  /** Author a brand-new idea when the queue is empty (returns idea text). */
  authorIdea?: (settings: Settings, recentTopics: string[]) => Promise<GeneratedIdeaInput>;
  /** Human-grade visual inspection of rendered slides. Defaults to auto-approve. */
  inspectVisuals?: (slides: RenderedSlide[], post: Post) => Promise<VisualInspection>;
}

export interface WorkflowOptions {
  cfg: AppConfig;
  providers: WorkflowProviders;
  modeOverride?: 'TEST' | 'LIVE';
  http?: HttpClient;
  runId?: string;
}

export interface WorkflowResult {
  mode: 'TEST' | 'LIVE';
  bootstrap: boolean;
  ideaId: string | null;
  idea: string | null;
  source: 'Manual' | 'Claude' | null;
  status: string;
  slideCount: number | null;
  template: string | null;
  previewUrl: string | null;
  permalink: string | null;
  mediaId: string | null;
  sheetUpdated: boolean;
  tokenRefreshed: boolean;
  lockReleased: boolean;
  warnings: string[];
}

interface Manifest {
  post: Post;
  slideUrls: string[];
  previewUrl: string;
  mode: 'TEST' | 'LIVE';
  createdAt: number;
}

const manifestKey = (ideaId: string): string => `manifests/${ideaId}.json`;

function datePath(timezone: string): string {
  const dt = DateTime.now().setZone(timezone);
  const valid = dt.isValid ? dt : DateTime.now().setZone('America/Toronto');
  return valid.toFormat('yyyy/MM/dd');
}

/** The single public entry point. */
export async function runWorkflow(opts: WorkflowOptions): Promise<WorkflowResult> {
  const { cfg, providers } = opts;
  const http = opts.http ?? defaultHttp;
  const warnings: string[] = [];

  const client = await createSheetsClient(cfg.googleServiceAccountB64, cfg.googleSheetId);
  const ctx: SheetContext = { client, timezone: cfg.timezone };
  const r2 = createR2(cfg);

  await verifyTabs(ctx);
  await verifyContentHeaders(ctx);
  const settings = await readSettings(ctx);
  const mode: 'TEST' | 'LIVE' = opts.modeOverride ?? settings.MODE;
  const brand = await loadBrand(settings);

  log.info('workflow starting', { mode, niche: settings.NICHE.slice(0, 40) });

  const result: WorkflowResult = {
    mode,
    bootstrap: false,
    ideaId: null,
    idea: null,
    source: null,
    status: 'STARTED',
    slideCount: null,
    template: null,
    previewUrl: null,
    permalink: null,
    mediaId: null,
    sheetUpdated: false,
    tokenRefreshed: false,
    lockReleased: false,
    warnings,
  };

  let lock: LockHandle | null = null;
  let activeIdeaId: string | null = null;

  try {
    lock = await acquireLock(r2, { runId: opts.runId, stage: 'init' });
    if (!lock) {
      warnings.push(
        'workflow lock is held by another run; aborting to avoid concurrent publishing',
      );
      result.status = 'LOCK_CONTENDED';
      return result;
    }

    const rows = await readContentRows(ctx);

    // ---- 1. Recover any VERIFY_REQUIRED publication first (LIVE integrations) ----
    const vr = selectVerifyRequired(rows);
    if (vr && mode === 'LIVE' && instagramConfigured(cfg)) {
      stage('recover-verify-required');
      activeIdeaId = vr.idea_id;
      await heartbeatLock(r2, lock, { stage: 'recover', ideaId: vr.idea_id });
      const recovered = await recoverRow(r2, ctx, cfg, http, vr.idea_id);
      Object.assign(result, recovered);
      return result;
    } else if (vr) {
      warnings.push(
        `VERIFY_REQUIRED row ${vr.idea_id} present but cannot recover (mode=${mode}, ig configured=${instagramConfigured(cfg)})`,
      );
    }

    // ---- 2. LIVE: publish an existing draft first when configured ----
    if (mode === 'LIVE' && settings.PUBLISH_EXISTING_DRAFT_FIRST) {
      const draft = selectPublishableDraft(rows);
      if (draft) {
        stage('publish-existing-draft');
        activeIdeaId = draft.idea_id;
        await heartbeatLock(r2, lock, { stage: 'publish-draft', ideaId: draft.idea_id });
        const published = await publishExistingDraft(r2, ctx, cfg, http, draft.idea_id);
        Object.assign(result, published);
        return result;
      }
    }

    // ---- 3. Select or generate exactly one idea ----
    stage('select-idea');
    let selectedIdeaId: string;
    let selectedIdeaText: string;
    let source: 'Manual' | 'Claude';

    const resumable = selectResumable(rows);
    const unused = resumable ? null : selectUnusedIdea(rows);
    if (resumable) {
      // Resume an already-selected row (two-phase run or crash recovery).
      selectedIdeaId = resumable.idea_id.trim() || (await markSelected(ctx, resumable));
      selectedIdeaText = resumable.idea;
      source = (resumable.source.trim() as 'Manual' | 'Claude') || 'Manual';
      log.info('resuming in-progress idea', { ideaId: selectedIdeaId, status: resumable.status });
    } else if (unused) {
      selectedIdeaId = await markSelected(ctx, unused);
      selectedIdeaText = unused.idea;
      source = (unused.source.trim() as 'Manual' | 'Claude') || 'Manual';
    } else {
      if (!settings.AUTO_GENERATE_WHEN_EMPTY) {
        warnings.push('no UNUSED ideas and AUTO_GENERATE_WHEN_EMPTY is false; nothing to do');
        result.status = 'NO_WORK';
        return result;
      }
      if (!providers.authorIdea) {
        throw new Error('idea queue empty and no idea author provided');
      }
      const corpus = buildRecentCorpus(rows, settings, cfg.timezone);
      const ideaInput = await providers.authorIdea(settings, corpus);
      const inserted = await insertGeneratedIdea(ctx, ideaInput, corpus);
      selectedIdeaId = inserted.ideaId;
      selectedIdeaText = ideaInput.idea;
      source = 'Claude';
    }
    activeIdeaId = selectedIdeaId;
    result.ideaId = selectedIdeaId;
    result.idea = selectedIdeaText;
    result.source = source;
    result.sheetUpdated = true;
    await heartbeatLock(r2, lock, { stage: 'generate', ideaId: selectedIdeaId });

    // ---- 4. Author + render + validate the carousel ----
    stage('generate-content');
    await updateRowFields(ctx, selectedIdeaId, { status: 'GENERATING' });

    const recentTopics = buildRecentCorpus(rows, settings, cfg.timezone);
    const authored = await providers.authorPost({
      ideaId: selectedIdeaId,
      idea: selectedIdeaText,
      settings,
      brand,
      recentTopics,
    });
    // Ensure the post carries the authoritative idea id.
    const post = PostSchema.parse({ ...authored, idea_id: selectedIdeaId });
    result.template = post.template;

    stage('render');
    await updateRowFields(ctx, selectedIdeaId, {
      status: 'RENDERING',
      hook: post.hook,
      content_pillar: post.content_pillar,
      template: post.template,
    });
    const slides = await renderPost(post, brand);
    result.slideCount = slides.length;

    stage('validate');
    const report: ValidationReport = await validateAll(post, slides, settings);
    const errors = report.issues.filter((i) => i.severity === 'error');
    for (const w of report.issues.filter((i) => i.severity === 'warning')) {
      warnings.push(`slide ${w.slide ?? '-'}: ${w.code} ${w.message}`);
    }
    if (errors.length > 0) {
      throw new Error(
        `automated visual validation failed: ${errors.map((e) => `[s${e.slide}] ${e.code}`).join(', ')}`,
      );
    }

    // Human-grade visual inspection (operating model). Default: approve.
    const inspector =
      providers.inspectVisuals ??
      (async () => ({ approved: true, notes: 'auto-approved (no inspector)' }));
    const inspection = await inspector(slides, post);
    if (!inspection.approved) {
      throw new Error(`visual inspection rejected the carousel: ${inspection.notes}`);
    }
    log.info('visual inspection passed', { notes: inspection.notes.slice(0, 120) });

    // ---- 5. Upload slides + preview to R2 ----
    stage('upload');
    await heartbeatLock(r2, lock, { stage: 'upload', ideaId: selectedIdeaId });
    const dir = `${datePath(cfg.timezone)}/${selectedIdeaId}`;
    const slideUrls: string[] = [];
    for (const s of slides) {
      const key = `carousels/${dir}/slide-${String(s.index).padStart(2, '0')}.png`;
      const url = await putPublic(r2, key, s.png, { contentType: 'image/png' });
      slideUrls.push(url);
    }

    const previewHtml = buildPreviewHtml({ post, slideUrls, mode, label: 'DRAFT' });
    const previewKey = `previews/${dir}/index.html`;
    const previewUrl = await putPublic(r2, previewKey, previewHtml, {
      contentType: 'text/html; charset=utf-8',
      cacheControl: 'public, max-age=300',
    });
    result.previewUrl = previewUrl;

    // Confirm every public URL is live and correctly typed.
    stage('verify-uploads');
    for (const url of slideUrls) {
      const v = await verifyPublicUrl(url);
      if (!v.ok) throw new Error(`uploaded slide not reachable (status ${v.status}): ${url}`);
      if (v.contentType && !v.contentType.startsWith('image/')) {
        throw new Error(`uploaded slide has wrong content-type ${v.contentType}: ${url}`);
      }
    }
    const pv = await verifyPublicUrl(previewUrl);
    if (!pv.ok) warnings.push(`preview URL returned status ${pv.status}`);

    // Compute idempotency key now that the manifest (asset urls) is final.
    const idempotencyKey = computeIdempotencyKey(selectedIdeaId, slideUrls);
    const finalPost = { ...post, idempotency_key: idempotencyKey };

    // Persist manifest to private R2 for later publish/recovery.
    const manifest: Manifest = {
      post: finalPost,
      slideUrls,
      previewUrl,
      mode,
      createdAt: Date.now(),
    };
    await putPrivateJson(r2, manifestKey(selectedIdeaId), manifest);

    // ---- 6. Update sheet → DRAFT_READY ----
    stage('draft-ready');
    await updateRowFields(ctx, selectedIdeaId, {
      status: 'DRAFT_READY',
      hook: finalPost.hook,
      content_pillar: finalPost.content_pillar,
      template: finalPost.template,
      slide_count: String(slides.length),
      caption: composeCaption(finalPost),
      preview_url: previewUrl,
      error: '',
    });
    result.status = 'DRAFT_READY';

    // ---- 7. TEST stops here; LIVE continues to publication ----
    if (mode === 'TEST') {
      log.info('TEST mode: draft saved, no Instagram publication');
      return result;
    }

    // LIVE publication path.
    stage('publish');
    await heartbeatLock(r2, lock, { stage: 'publish', ideaId: selectedIdeaId });
    const published = await publishExistingDraft(r2, ctx, cfg, http, selectedIdeaId);
    Object.assign(result, published);
    return result;
  } catch (err) {
    const message = sanitizeError(err);
    log.error('workflow failed', { message });
    warnings.push(message);
    result.status = 'FAILED';
    if (activeIdeaId) {
      try {
        // Never downgrade a POSTED row.
        const rows = await readContentRows(ctx);
        const row = rows.find((r) => r.idea_id === activeIdeaId);
        if (row && row.status.trim().toUpperCase() !== 'POSTED') {
          await updateRowFields(ctx, activeIdeaId, { status: 'FAILED', error: message });
          result.sheetUpdated = true;
        }
      } catch (inner) {
        warnings.push(`failed to record failure on sheet: ${sanitizeError(inner)}`);
      }
    }
    return result;
  } finally {
    result.lockReleased = await releaseLock(r2, lock);
  }
}

/** Compose the final caption text (caption body + hashtags). */
export function composeCaption(post: Post): string {
  const tags = post.hashtags.map((h) => (h.startsWith('#') ? h : `#${h}`)).join(' ');
  return tags ? `${post.caption}\n\n${tags}` : post.caption;
}

/**
 * Publish a draft (either just-created or an existing DRAFT_READY row).
 * Loads the manifest from private R2. Idempotent and recovery-aware.
 */
async function publishExistingDraft(
  r2: R2,
  ctx: SheetContext,
  cfg: AppConfig,
  http: HttpClient,
  ideaId: string,
): Promise<Partial<WorkflowResult>> {
  if (!instagramConfigured(cfg)) {
    throw new Error(
      `cannot publish: Instagram not configured (missing ${cfg.missingInstagram.join(', ')})`,
    );
  }
  const manifest = await getPrivateJson<Manifest>(r2, manifestKey(ideaId));
  if (!manifest) throw new Error(`no manifest found for idea ${ideaId}; cannot publish`);
  const post = PostSchema.parse(manifest.post);
  const slideUrls = manifest.slideUrls;
  const idempotencyKey = post.idempotency_key;

  // Idempotency: already published?
  const existing = await getIdempotencyRecord(r2, idempotencyKey);
  if (existing) {
    await markPosted(ctx, cfg, ideaId, existing.mediaId, existing.permalink);
    return {
      ideaId,
      idea: post.idea,
      status: 'POSTED',
      mediaId: existing.mediaId,
      permalink: existing.permalink,
      slideCount: slideUrls.length,
      template: post.template,
      previewUrl: manifest.previewUrl,
      sheetUpdated: true,
    };
  }

  // Confirm public URLs still work before touching Instagram.
  for (const url of slideUrls) {
    const head = await headPublic(r2, urlToKey(r2, url));
    const v = await verifyPublicUrl(url);
    if (!v.ok) throw new Error(`slide URL not reachable before publish: ${url}`);
    void head;
  }

  const active = await loadActiveToken(r2, cfg);
  if (!active) throw new Error('no Instagram token available for publication');
  const refresh = await refreshTokenIfNeeded(r2, cfg, active, {
    httpGet: async (u) => http.get(u),
  });
  const token = refresh.token.token;
  const ig = createIgClient(cfg, token, cfg.instagram.userId!, http);

  const cred = await validateCredentials(ig);
  if (!cred.ok) throw new Error(`Instagram credential invalid before publish: ${cred.reason}`);

  const limit = await checkPublishingLimit(ig);
  if (
    limit.quotaUsage !== null &&
    limit.quotaTotal !== null &&
    limit.quotaUsage >= limit.quotaTotal
  ) {
    throw new Error(`content publishing quota reached (${limit.quotaUsage}/${limit.quotaTotal})`);
  }

  await updateRowFields(ctx, ideaId, { status: 'POSTING' });

  const attempt: AttemptRecord = {
    idempotencyKey,
    ideaId,
    parentContainerId: null,
    childContainerIds: [],
    stage: 'containers-created',
    updatedAt: Date.now(),
  };

  try {
    // Build children.
    for (const url of slideUrls) {
      const childId = await createChildContainer(ig, url);
      attempt.childContainerIds.push(childId);
    }
    await saveAttemptRecord(r2, attempt);

    // Poll children ready.
    for (const childId of attempt.childContainerIds) {
      await pollUntilReady(ig, childId);
    }

    // Parent carousel.
    const caption = composeCaption(post);
    const parentId = await createCarouselContainer(ig, attempt.childContainerIds, caption);
    attempt.parentContainerId = parentId;
    attempt.stage = 'parent-created';
    await saveAttemptRecord(r2, attempt);

    await pollUntilReady(ig, parentId);

    // Publish — after this point the outcome may be ambiguous on failure.
    attempt.stage = 'publish-submitted';
    await saveAttemptRecord(r2, attempt);

    let mediaId: string;
    try {
      mediaId = await publishContainer(ig, parentId);
    } catch (pubErr) {
      // Ambiguous publish: do NOT blindly retry. Mark VERIFY_REQUIRED.
      if (!(pubErr instanceof IgApiError) || !pubErr.permanent) {
        await updateRowFields(ctx, ideaId, {
          status: 'VERIFY_REQUIRED',
          error: `publish outcome uncertain: ${sanitizeError(pubErr)}`,
        });
        await saveAttemptRecord(r2, { ...attempt, stage: 'failed', note: 'ambiguous publish' });
        return {
          ideaId,
          idea: post.idea,
          status: 'VERIFY_REQUIRED',
          sheetUpdated: true,
          template: post.template,
          slideCount: slideUrls.length,
          previewUrl: manifest.previewUrl,
        };
      }
      throw pubErr;
    }

    // Verify ownership + permalink.
    const media = await getMedia(ig, mediaId);
    if (media.ownerId && media.ownerId !== ig.userId) {
      throw new Error('published media owner does not match configured account');
    }
    const permalink = media.permalink;

    await saveIdempotencyRecord(r2, {
      idempotencyKey,
      ideaId,
      mediaId,
      permalink,
      publishedAt: Date.now(),
    });
    await saveAttemptRecord(r2, { ...attempt, stage: 'published' });

    await markPosted(ctx, cfg, ideaId, mediaId, permalink);

    log.info('published carousel', { ideaId, mediaId });
    return {
      ideaId,
      idea: post.idea,
      status: 'POSTED',
      mediaId,
      permalink,
      slideCount: slideUrls.length,
      template: post.template,
      previewUrl: manifest.previewUrl,
      sheetUpdated: true,
      tokenRefreshed: refresh.refreshed,
    };
  } catch (err) {
    await saveAttemptRecord(r2, { ...attempt, stage: 'failed', note: sanitizeError(err) });
    throw err;
  }
}

async function markPosted(
  ctx: SheetContext,
  cfg: AppConfig,
  ideaId: string,
  mediaId: string,
  permalink: string | null,
): Promise<void> {
  await updateRowFields(ctx, ideaId, {
    status: 'POSTED',
    published_at: nowTimestamp(cfg.timezone),
    instagram_media_id: mediaId,
    permalink: permalink ?? '',
    error: '',
  });
}

/** Recover a VERIFY_REQUIRED row: verify whether it actually published. */
async function recoverRow(
  r2: R2,
  ctx: SheetContext,
  cfg: AppConfig,
  http: HttpClient,
  ideaId: string,
): Promise<Partial<WorkflowResult>> {
  const manifest = await getPrivateJson<Manifest>(r2, manifestKey(ideaId));
  if (!manifest) {
    log.warn('no manifest for VERIFY_REQUIRED row; manual review needed', { ideaId });
    return { ideaId, status: 'VERIFY_REQUIRED' };
  }
  const post = PostSchema.parse(manifest.post);
  const active = await loadActiveToken(r2, cfg);
  if (!active) throw new Error('no token for recovery');
  const ig = createIgClient(cfg, active.token, cfg.instagram.userId!, http);
  const attempt = await getAttemptRecord(r2, post.idempotency_key);
  const outcome = await verifyPublication(r2, ig, post, attempt);

  if (outcome.published && outcome.mediaId) {
    await saveIdempotencyRecord(r2, {
      idempotencyKey: post.idempotency_key,
      ideaId,
      mediaId: outcome.mediaId,
      permalink: outcome.permalink,
      publishedAt: Date.now(),
    });
    await markPosted(ctx, cfg, ideaId, outcome.mediaId, outcome.permalink);
    return {
      ideaId,
      idea: post.idea,
      status: 'POSTED',
      mediaId: outcome.mediaId,
      permalink: outcome.permalink,
      sheetUpdated: true,
    };
  }

  // Not published — safe to hand back to DRAFT_READY for a future publish.
  log.warn('recovery found no published media', { ideaId, reason: outcome.reason });
  await updateRowFields(ctx, ideaId, {
    status: 'DRAFT_READY',
    error: `recovery: ${outcome.reason}`,
  });
  return { ideaId, idea: post.idea, status: 'DRAFT_READY', sheetUpdated: true };
}

function urlToKey(r2: R2, url: string): string {
  return url.startsWith(r2.publicBaseUrl) ? url.slice(r2.publicBaseUrl.length + 1) : url;
}
