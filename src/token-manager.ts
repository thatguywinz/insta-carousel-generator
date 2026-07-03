import { AppConfig } from './config.js';
import { R2, getPrivateJson, putPrivateJson } from './r2.js';
import { EncryptedBlob, encryptSecret, decryptSecret } from './security.js';
import { log } from './logger.js';

/**
 * Instagram long-lived token lifecycle. The plaintext token is never stored;
 * an AES-256-GCM encrypted record lives in the private R2 bucket. On future
 * runs the encrypted record is preferred over the env token.
 */

export const TOKEN_KEY = 'token/instagram-token.json';
const REFRESH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // refresh when < 7 days to expiry

export interface TokenRecord {
  blob: EncryptedBlob;
  /** epoch ms of last update. */
  updatedAt: number;
  /** epoch ms token expiry, if known. */
  expiresAt: number | null;
  /** provenance for diagnostics (never the token). */
  origin: 'bootstrap-env' | 'refresh';
}

export interface ActiveToken {
  token: string;
  expiresAt: number | null;
  fromStore: boolean;
}

/** Persist a token encrypted at rest in private R2. */
export async function storeToken(
  r2: R2,
  cfg: AppConfig,
  token: string,
  expiresAt: number | null,
  origin: TokenRecord['origin'],
): Promise<void> {
  const blob = encryptSecret(token, cfg.tokenEncryptionKey);
  const record: TokenRecord = { blob, updatedAt: Date.now(), expiresAt, origin };
  await putPrivateJson(r2, TOKEN_KEY, record);
  log.info('stored encrypted Instagram token', { origin, hasExpiry: expiresAt !== null });
}

/**
 * Load the active token. Prefers the encrypted private-R2 record; falls back
 * to the environment token only when no stored record exists. On first use of
 * the env token, it is encrypted and stored (bootstrap).
 */
export async function loadActiveToken(r2: R2, cfg: AppConfig): Promise<ActiveToken | null> {
  const record = await getPrivateJson<TokenRecord>(r2, TOKEN_KEY);
  if (record) {
    try {
      const token = decryptSecret(record.blob, cfg.tokenEncryptionKey);
      return { token, expiresAt: record.expiresAt, fromStore: true };
    } catch {
      log.warn('stored token failed to decrypt; falling back to env token');
    }
  }
  if (cfg.instagram.accessToken) {
    // Bootstrap: encrypt & persist the env token for future runs.
    await storeToken(r2, cfg, cfg.instagram.accessToken, null, 'bootstrap-env');
    return { token: cfg.instagram.accessToken, expiresAt: null, fromStore: false };
  }
  return null;
}

/** Whether an eligible long-lived token should be refreshed now. */
export function shouldRefresh(record: ActiveToken): boolean {
  if (record.expiresAt === null) return false;
  return record.expiresAt - Date.now() < REFRESH_WINDOW_MS;
}

export interface RefreshDeps {
  /** Injected HTTP for testability. Returns parsed JSON + status. */
  httpGet: (url: string) => Promise<{ status: number; json: unknown }>;
}

/**
 * Refresh an eligible long-lived Instagram token via the official refresh
 * endpoint (graph.instagram.com/refresh_access_token). Stores the new token
 * encrypted. Returns the new active token, or null when refresh is ineligible
 * or fails (failure is recorded sanitized, token never exposed).
 */
export async function refreshTokenIfNeeded(
  r2: R2,
  cfg: AppConfig,
  active: ActiveToken,
  deps: RefreshDeps,
): Promise<{ refreshed: boolean; token: ActiveToken; error?: string }> {
  if (!shouldRefresh(active)) {
    return { refreshed: false, token: active };
  }
  const base = `https://graph.instagram.com/${cfg.instagram.graphApiVersion}`;
  const url = `${base}/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(active.token)}`;
  try {
    const res = await deps.httpGet(url);
    if (res.status !== 200) {
      return { refreshed: false, token: active, error: `refresh returned status ${res.status}` };
    }
    const body = res.json as { access_token?: string; expires_in?: number };
    if (!body.access_token) {
      return { refreshed: false, token: active, error: 'refresh response missing access_token' };
    }
    const expiresAt = body.expires_in ? Date.now() + body.expires_in * 1000 : null;
    await storeToken(r2, cfg, body.access_token, expiresAt, 'refresh');
    log.info('refreshed Instagram token', { hasExpiry: expiresAt !== null });
    return { refreshed: true, token: { token: body.access_token, expiresAt, fromStore: true } };
  } catch (err) {
    void err;
    return { refreshed: false, token: active, error: 'token refresh request failed' };
  }
}
