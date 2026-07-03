import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  loadConfig,
  missingCoreVars,
  missingInstagramVars,
  instagramConfigured,
} from '../../src/config.js';

const CORE = {
  GOOGLE_SHEET_ID: 'sheet',
  GOOGLE_SERVICE_ACCOUNT_B64: 'b64',
  R2_ACCOUNT_ID: 'acct',
  R2_ACCESS_KEY_ID: 'akid',
  R2_SECRET_ACCESS_KEY: 'secret',
  R2_PUBLIC_BUCKET: 'pub',
  R2_PRIVATE_BUCKET: 'priv',
  R2_ENDPOINT: 'https://x.r2.cloudflarestorage.com/',
  R2_PUBLIC_BASE_URL: 'https://cdn.test/',
  TOKEN_ENCRYPTION_KEY: 'k'.repeat(64),
};

describe('config', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    for (const k of Object.keys(CORE)) delete process.env[k];
    delete process.env.INSTAGRAM_ACCESS_TOKEN;
    delete process.env.INSTAGRAM_USER_ID;
    delete process.env.META_GRAPH_API_VERSION;
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it('reports missing core vars by name', () => {
    const missing = missingCoreVars();
    expect(missing).toContain('GOOGLE_SHEET_ID');
    expect(missing).toContain('R2_ENDPOINT');
  });

  it('throws listing only names when core vars absent', () => {
    expect(() => loadConfig()).toThrow(/Missing required environment variables/);
  });

  it('loads config with core vars and trims trailing slashes', () => {
    Object.assign(process.env, CORE);
    const cfg = loadConfig();
    expect(cfg.r2.endpoint).toBe('https://x.r2.cloudflarestorage.com');
    expect(cfg.r2.publicBaseUrl).toBe('https://cdn.test');
    expect(cfg.instagram.graphApiVersion).toBe('v21.0');
    expect(cfg.timezone).toBe('America/Toronto');
  });

  it('tolerates missing Instagram vars in config load', () => {
    Object.assign(process.env, CORE);
    const cfg = loadConfig();
    expect(instagramConfigured(cfg)).toBe(false);
    expect(missingInstagramVars()).toContain('INSTAGRAM_USER_ID');
  });

  it('marks Instagram configured when both present', () => {
    Object.assign(process.env, CORE, { INSTAGRAM_ACCESS_TOKEN: 't', INSTAGRAM_USER_ID: '123' });
    const cfg = loadConfig();
    expect(instagramConfigured(cfg)).toBe(true);
  });

  it('does not throw with real secret values in the error', () => {
    Object.assign(process.env, CORE);
    delete process.env.R2_SECRET_ACCESS_KEY;
    try {
      loadConfig();
    } catch (e) {
      expect((e as Error).message).not.toContain(CORE.R2_SECRET_ACCESS_KEY);
      expect((e as Error).message).toContain('R2_SECRET_ACCESS_KEY');
    }
  });
});
