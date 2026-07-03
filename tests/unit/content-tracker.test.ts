import { describe, it, expect } from 'vitest';
import { columnLetter, nowTimestamp } from '../../src/content-tracker.js';
import { decodeServiceAccount } from '../../src/google-sheets.js';

describe('content-tracker helpers', () => {
  it('columnLetter maps 1-based indexes to A1 letters', () => {
    expect(columnLetter(1)).toBe('A');
    expect(columnLetter(17)).toBe('Q');
    expect(columnLetter(26)).toBe('Z');
    expect(columnLetter(27)).toBe('AA');
  });

  it('nowTimestamp returns a valid formatted string', () => {
    const ts = nowTimestamp('America/Toronto');
    expect(ts).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
  });

  it('nowTimestamp falls back gracefully on bad timezone', () => {
    const ts = nowTimestamp('Not/AZone');
    expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}/);
  });
});

describe('service account decoding', () => {
  it('rejects non-base64 / non-json', () => {
    expect(() => decodeServiceAccount('%%%not-base64%%%')).toThrow();
  });

  it('rejects a decoded object missing credential fields', () => {
    const bad = Buffer.from(JSON.stringify({ foo: 'bar' })).toString('base64');
    expect(() => decodeServiceAccount(bad)).toThrow(/credential fields/);
  });

  it('accepts a well-formed service account structure', () => {
    const sa = {
      type: 'service_account',
      project_id: 'p',
      private_key_id: 'kid',
      private_key: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n',
      client_email: 'svc@p.iam.gserviceaccount.com',
    };
    const b64 = Buffer.from(JSON.stringify(sa)).toString('base64');
    const decoded = decodeServiceAccount(b64);
    expect(decoded.client_email).toContain('gserviceaccount.com');
  });
});
