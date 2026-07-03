import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  redact,
  sanitizeError,
  encryptSecret,
  decryptSecret,
  fingerprint,
} from '../../src/security.js';

describe('security: redaction', () => {
  const KEY = 'super-secret-token-value-abcdef123456';
  beforeEach(() => {
    process.env.INSTAGRAM_ACCESS_TOKEN = KEY;
  });
  afterEach(() => {
    delete process.env.INSTAGRAM_ACCESS_TOKEN;
  });

  it('redacts known secret values from strings', () => {
    const out = redact(`failed with token ${KEY} at end`);
    expect(out).not.toContain(KEY);
    expect(out).toContain('[REDACTED]');
  });

  it('redacts access_token query params', () => {
    const out = redact('GET /media?access_token=EAAB1234abcd&fields=id');
    expect(out).toContain('access_token=[REDACTED]');
    expect(out).not.toContain('EAAB1234abcd');
  });

  it('redacts long meta tokens', () => {
    const token = 'IG' + 'A'.repeat(40);
    expect(redact(`token=${token}`)).not.toContain(token);
  });

  it('sanitizeError produces a safe single line', () => {
    const err = new Error(`boom ${KEY}\nsecond line`);
    const out = sanitizeError(err);
    expect(out).not.toContain(KEY);
    expect(out).not.toContain('\n');
  });
});

describe('security: token encryption', () => {
  const KEY_MATERIAL = 'a'.repeat(64); // 64 hex chars => 32 bytes

  it('round-trips plaintext with AES-256-GCM', () => {
    const blob = encryptSecret('hello-token', KEY_MATERIAL);
    expect(blob.alg).toBe('aes-256-gcm');
    expect(blob.ciphertext).not.toContain('hello-token');
    const back = decryptSecret(blob, KEY_MATERIAL);
    expect(back).toBe('hello-token');
  });

  it('fails to decrypt with wrong key', () => {
    const blob = encryptSecret('hello-token', KEY_MATERIAL);
    expect(() => decryptSecret(blob, 'b'.repeat(64))).toThrow();
  });

  it('detects tampering via auth tag', () => {
    const blob = encryptSecret('hello-token', KEY_MATERIAL);
    const tampered = { ...blob, ciphertext: Buffer.from('tampered').toString('base64') };
    expect(() => decryptSecret(tampered, KEY_MATERIAL)).toThrow();
  });

  it('fingerprint never reveals the middle', () => {
    const fp = fingerprint('abcdef1234567890');
    expect(fp).toContain('len:16');
    expect(fp).not.toContain('cdef123456');
  });
});
