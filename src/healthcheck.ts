import { AppConfig, instagramConfigured } from './config.js';
import { createSheetsClient, decodeServiceAccount } from './google-sheets.js';
import { SheetContext, verifyTabs, verifyContentHeaders, readSettings } from './content-tracker.js';
import { createR2, putPrivateJson, getPrivateJson, deletePrivate } from './r2.js';
import { createIgClient, validateCredentials } from './instagram.js';
import { loadActiveToken } from './token-manager.js';
import { log } from './logger.js';
import { sanitizeError } from './security.js';

/**
 * Non-destructive health checks against the real integrations. Never publishes
 * to Instagram. Instagram credential failure is tolerated in TEST mode when it
 * is the only missing integration.
 */

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

export interface HealthReport {
  ok: boolean;
  mode: string;
  checks: CheckResult[];
}

export async function runHealthcheck(cfg: AppConfig): Promise<HealthReport> {
  const checks: CheckResult[] = [];

  // 1. Service-account decode (in memory, no disk write).
  try {
    const sa = decodeServiceAccount(cfg.googleServiceAccountB64);
    checks.push({
      name: 'service-account-decode',
      ok: true,
      detail: `client_email present (${sa.client_email.split('@')[1] ?? '?'})`,
    });
  } catch (err) {
    checks.push({ name: 'service-account-decode', ok: false, detail: sanitizeError(err) });
    return { ok: false, mode: 'UNKNOWN', checks };
  }

  // 2. Google Sheet: auth, tabs, headers, settings.
  let mode = 'TEST';
  try {
    const client = await createSheetsClient(cfg.googleServiceAccountB64, cfg.googleSheetId);
    const ctx: SheetContext = { client, timezone: cfg.timezone };
    await verifyTabs(ctx);
    await verifyContentHeaders(ctx);
    const settings = await readSettings(ctx);
    mode = settings.MODE;
    checks.push({
      name: 'google-sheet',
      ok: true,
      detail: `tabs+headers valid, MODE=${settings.MODE}, niche="${settings.NICHE.slice(0, 40)}"`,
    });
  } catch (err) {
    checks.push({ name: 'google-sheet', ok: false, detail: sanitizeError(err) });
  }

  // 3. R2: private bucket round-trip (write, read, delete a probe object).
  try {
    const r2 = createR2(cfg);
    const probeKey = 'health/probe.json';
    const stamp = { at: Date.now(), check: 'healthcheck' };
    await putPrivateJson(r2, probeKey, stamp);
    const readBack = await getPrivateJson<typeof stamp>(r2, probeKey);
    await deletePrivate(r2, probeKey);
    if (!readBack || readBack.at !== stamp.at) throw new Error('R2 private round-trip mismatch');
    checks.push({
      name: 'r2-private',
      ok: true,
      detail: `bucket ${r2.privateBucket} read/write/delete ok`,
    });
  } catch (err) {
    checks.push({ name: 'r2-private', ok: false, detail: sanitizeError(err) });
  }

  // 4. R2 public bucket reachability (write + public URL 200 verify).
  try {
    const r2 = createR2(cfg);
    const { putPublic, verifyPublicUrl, deletePrivate: _d } = await import('./r2.js');
    void _d;
    const probeKey = 'health/probe.txt';
    const url = await putPublic(r2, probeKey, 'ok', {
      contentType: 'text/plain',
      cacheControl: 'no-store',
    });
    const verify = await verifyPublicUrl(url);
    checks.push({
      name: 'r2-public',
      ok: verify.ok,
      detail: verify.ok
        ? `public URL 200 (${r2.publicBaseUrl})`
        : `public URL returned ${verify.status} — check R2_PUBLIC_BASE_URL/bucket public access`,
    });
  } catch (err) {
    checks.push({ name: 'r2-public', ok: false, detail: sanitizeError(err) });
  }

  // 5. Instagram credential validation (non-publishing).
  if (instagramConfigured(cfg)) {
    try {
      const r2 = createR2(cfg);
      const active = await loadActiveToken(r2, cfg);
      if (!active) throw new Error('no Instagram token available');
      const ig = createIgClient(cfg, active.token, cfg.instagram.userId!);
      const res = await validateCredentials(ig);
      checks.push({
        name: 'instagram',
        ok: res.ok,
        detail: res.ok ? `account ${res.username ?? res.accountId}` : (res.reason ?? 'invalid'),
      });
    } catch (err) {
      checks.push({ name: 'instagram', ok: false, detail: sanitizeError(err) });
    }
  } else {
    checks.push({
      name: 'instagram',
      ok: false,
      detail: `not configured (missing: ${cfg.missingInstagram.join(', ') || 'INSTAGRAM_*'})`,
    });
  }

  // Determine overall health. In TEST mode, Instagram may be the only failure.
  const nonIg = checks.filter((c) => c.name !== 'instagram');
  const igCheck = checks.find((c) => c.name === 'instagram');
  const coreOk = nonIg.every((c) => c.ok);
  let ok: boolean;
  if (mode === 'TEST') {
    ok = coreOk; // Instagram tolerated
  } else {
    ok = coreOk && !!igCheck?.ok;
  }

  log.info('healthcheck complete', {
    ok,
    mode,
    failing: checks.filter((c) => !c.ok).map((c) => c.name),
  });
  return { ok, mode, checks };
}
