import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  PostSchema,
  validateSlideBounds,
  CONTENT_HEADERS,
  ContentRowSchema,
} from '../../schemas/post.js';
import { detectResearchNeed, validateClaims } from '../../src/research-validation.js';

const fixture = JSON.parse(
  readFileSync(path.join(__dirname, '..', 'fixtures', 'sample-post.json'), 'utf8'),
);

describe('post schema', () => {
  it('accepts the sample fixture', () => {
    const parsed = PostSchema.parse(fixture);
    expect(parsed.slides.length).toBeGreaterThanOrEqual(6);
    expect(parsed.slides[0]?.type).toBe('cover');
  });

  it('rejects too-many hashtags', () => {
    const bad = { ...fixture, hashtags: Array.from({ length: 9 }, (_, i) => `tag${i}`) };
    expect(() => PostSchema.parse(bad)).toThrow();
  });

  it('rejects an unknown template', () => {
    expect(() => PostSchema.parse({ ...fixture, template: 'fancy' })).toThrow();
  });

  it('rejects fewer than 3 slides', () => {
    expect(() => PostSchema.parse({ ...fixture, slides: fixture.slides.slice(0, 2) })).toThrow();
  });

  it('validateSlideBounds enforces min/max', () => {
    expect(validateSlideBounds(7, 6, 8).ok).toBe(true);
    expect(validateSlideBounds(4, 6, 8).ok).toBe(false);
    expect(validateSlideBounds(9, 6, 8).ok).toBe(false);
  });

  it('CONTENT_HEADERS matches the contract length', () => {
    expect(CONTENT_HEADERS).toHaveLength(17);
    expect(CONTENT_HEADERS[0]).toBe('idea_id');
    expect(CONTENT_HEADERS[CONTENT_HEADERS.length - 1]).toBe('error');
  });

  it('ContentRowSchema fills defaults for sparse rows', () => {
    const row = ContentRowSchema.parse({ idea_id: 'x', idea: 'y' });
    expect(row.status).toBe('');
    expect(row.priority).toBe('');
  });
});

describe('research validation', () => {
  it('detects statistics as needing sources', () => {
    expect(detectResearchNeed('Studies show 47% of users churn').required).toBe(true);
  });

  it('treats evergreen advice as no-research', () => {
    expect(detectResearchNeed('Name the outcome before you send the proposal').required).toBe(
      false,
    );
  });

  it('flags hard stats without sources', () => {
    const res = validateClaims('Conversion jumped 32% overnight', 0);
    expect(res.ok).toBe(false);
    expect(res.issues.length).toBeGreaterThan(0);
  });

  it('passes hard stats when sourced', () => {
    expect(validateClaims('Conversion jumped 32% overnight', 1).ok).toBe(true);
  });
});
