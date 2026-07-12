import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { DateTime } from 'luxon';
import { validateNewsworthiness, freshestSourceAgeDays } from '../../src/newsworthiness.js';
import { PostSchema, Post } from '../../schemas/post.js';
import { parseSettings } from '../../schemas/settings.js';

const base: Post = PostSchema.parse(
  JSON.parse(readFileSync(path.join(__dirname, '..', 'fixtures', 'sample-post.json'), 'utf8')),
);

const NOW = DateTime.utc(2026, 7, 12);
const newsSettings = parseSettings({ CONTENT_MODE: 'news-first', MAX_STORY_AGE_DAYS: '14' });

/** A well-formed, genuinely newsworthy post. */
function newsPost(overrides: Partial<Post> = {}): Post {
  return PostSchema.parse({
    ...base,
    idea: 'Claude Code ships parallel subagents',
    hook: 'Claude Code just got parallel subagents',
    why_now: 'Anthropic shipped parallel subagents on July 8 — multi-part tasks now fan out.',
    sources: [
      {
        url: 'https://example.com/release-notes',
        description: 'release notes',
        published_at: '2026-07-08',
      },
    ],
    ...overrides,
  });
}

describe('news-first gate', () => {
  it('passes a sourced, fresh, anchored post', () => {
    const issues = validateNewsworthiness(newsPost(), newsSettings, NOW);
    expect(issues.filter((i) => i.severity === 'error')).toHaveLength(0);
  });

  it('blocks a post with no why_now anchor', () => {
    const issues = validateNewsworthiness(newsPost({ why_now: '' }), newsSettings, NOW);
    expect(issues.some((i) => i.code === 'NO_WHY_NOW' && i.severity === 'error')).toBe(true);
  });

  it('blocks a post with no sources', () => {
    const issues = validateNewsworthiness(newsPost({ sources: [] }), newsSettings, NOW);
    expect(issues.some((i) => i.code === 'NO_SOURCE' && i.severity === 'error')).toBe(true);
  });

  it('blocks a source with no published_at date', () => {
    const post = newsPost({
      sources: [{ url: 'https://example.com/x', description: 'x' }],
    });
    const issues = validateNewsworthiness(post, newsSettings, NOW);
    expect(issues.some((i) => i.code === 'NO_SOURCE_DATE' && i.severity === 'error')).toBe(true);
  });

  it('blocks a stale story past MAX_STORY_AGE_DAYS', () => {
    const post = newsPost({
      sources: [
        { url: 'https://example.com/x', description: 'x', published_at: '2026-05-01' }, // ~72d
      ],
    });
    const issues = validateNewsworthiness(post, newsSettings, NOW);
    expect(issues.some((i) => i.code === 'STALE_STORY' && i.severity === 'error')).toBe(true);
  });

  it('warns (never blocks) on listicle filler', () => {
    const post = newsPost({
      idea: '7 AI prompts you need to try',
      hook: '7 AI prompts you need',
    });
    const issues = validateNewsworthiness(post, newsSettings, NOW);
    const lowValue = issues.find((i) => i.code === 'LOW_VALUE_IDEA');
    expect(lowValue?.severity).toBe('warning');
  });
});

describe('CONTENT_MODE behaviour', () => {
  it('mixed downgrades the news gate to warnings', () => {
    const mixed = parseSettings({ CONTENT_MODE: 'mixed' });
    const issues = validateNewsworthiness(base, mixed, NOW);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.every((i) => i.severity === 'warning')).toBe(true);
  });

  it('evergreen-ok skips the freshness bar entirely', () => {
    const ever = parseSettings({ CONTENT_MODE: 'evergreen-ok' });
    const issues = validateNewsworthiness(base, ever, NOW);
    expect(issues.filter((i) => i.code !== 'LOW_VALUE_IDEA')).toHaveLength(0);
  });

  it('defaults to news-first, and the evergreen fixture fails it', () => {
    expect(parseSettings({}).CONTENT_MODE).toBe('news-first');
    expect(parseSettings({}).MAX_STORY_AGE_DAYS).toBe(14);
    const issues = validateNewsworthiness(base, parseSettings({}), NOW);
    expect(issues.some((i) => i.severity === 'error')).toBe(true);
  });
});

describe('freshestSourceAgeDays', () => {
  it('returns the age of the newest dated source', () => {
    const post = newsPost({
      sources: [
        { url: 'https://a.com', description: 'old', published_at: '2026-06-12' },
        { url: 'https://b.com', description: 'new', published_at: '2026-07-10' },
      ],
    });
    expect(Math.round(freshestSourceAgeDays(post, NOW)!)).toBe(2);
  });

  it('returns null when no source is dated', () => {
    const post = newsPost({ sources: [{ url: 'https://a.com', description: 'x' }] });
    expect(freshestSourceAgeDays(post, NOW)).toBeNull();
  });
});
