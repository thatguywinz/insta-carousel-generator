import { describe, it, expect } from 'vitest';
import {
  loadActiveToken,
  storeToken,
  shouldRefresh,
  refreshTokenIfNeeded,
  TOKEN_KEY,
} from '../../src/token-manager.js';
import { getPrivateJson } from '../../src/r2.js';
import { createFakeR2 } from '../fixtures/fake-r2.js';
import { AppConfig } from '../../src/config.js';

function cfg(token?: string): AppConfig {
  return {
    googleSheetId: 's',
    googleServiceAccountB64: 'b',
    r2: {
      accountId: 'a',
      accessKeyId: 'k',
      secretAccessKey: 's',
      publicBucket: 'p',
      privateBucket: 'pr',
      endpoint: 'e',
      publicBaseUrl: 'u',
    },
    instagram: { accessToken: token, userId: '123', graphApiVersion: 'v21.0' },
    tokenEncryptionKey: 'k'.repeat(64),
    timezone: 'America/Toronto',
    nodeEnv: 'test',
    missingCore: [],
    missingInstagram: [],
  };
}

describe('token manager', () => {
  it('bootstraps env token and encrypts it at rest', async () => {
    const r2 = createFakeR2();
    const active = await loadActiveToken(r2, cfg('env-token-123'));
    expect(active?.token).toBe('env-token-123');
    const stored = await getPrivateJson<{ blob: { ciphertext: string } }>(r2, TOKEN_KEY);
    expect(stored).not.toBeNull();
    expect(JSON.stringify(stored)).not.toContain('env-token-123');
  });

  it('prefers stored token over env on later runs', async () => {
    const r2 = createFakeR2();
    await storeToken(r2, cfg('env-token'), 'stored-token', null, 'refresh');
    const active = await loadActiveToken(r2, cfg('env-token'));
    expect(active?.token).toBe('stored-token');
    expect(active?.fromStore).toBe(true);
  });

  it('shouldRefresh only near expiry', () => {
    expect(shouldRefresh({ token: 't', expiresAt: null, fromStore: true })).toBe(false);
    expect(shouldRefresh({ token: 't', expiresAt: Date.now() + 1000, fromStore: true })).toBe(true);
    expect(
      shouldRefresh({ token: 't', expiresAt: Date.now() + 30 * 86400000, fromStore: true }),
    ).toBe(false);
  });

  it('refreshes an eligible token and stores the new one', async () => {
    const r2 = createFakeR2();
    const active = { token: 'old', expiresAt: Date.now() + 1000, fromStore: true };
    const res = await refreshTokenIfNeeded(r2, cfg('old'), active, {
      httpGet: async () => ({
        status: 200,
        json: { access_token: 'new-token', expires_in: 5184000 },
      }),
    });
    expect(res.refreshed).toBe(true);
    expect(res.token.token).toBe('new-token');
    const stored = await getPrivateJson(r2, TOKEN_KEY);
    expect(JSON.stringify(stored)).not.toContain('new-token');
  });

  it('records sanitized failure without exposing token on refresh error', async () => {
    const r2 = createFakeR2();
    const active = { token: 'old', expiresAt: Date.now() + 1000, fromStore: true };
    const res = await refreshTokenIfNeeded(r2, cfg('old'), active, {
      httpGet: async () => ({ status: 400, json: { error: { message: 'bad' } } }),
    });
    expect(res.refreshed).toBe(false);
    expect(res.token.token).toBe('old');
    expect(res.error).toBeDefined();
  });
});
