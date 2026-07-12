import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { DateTime } from 'luxon';
import {
  validateNewsworthiness,
  freshestSourceAgeDays,
  isBreaking,
  resolveContentType,
} from '../../src/newsworthiness.js';
import { PostSchema, Post } from '../../schemas/post.js';
import { parseSettings } from '../../schemas/settings.js';

const base: Post = PostSchema.parse(
  JSON.parse(readFileSync(path.join(__dirname, '..', 'fixtures', 'sample-post.json'), 'utf8')),
);

const NOW = DateTime.utc(2026, 7, 12);
const preferred = parseSettings({ CONTENT_MODE: 'news-preferred', MAX_STORY_AGE_DAYS: '14' });
const newsOnly = parseSettings({ CONTENT_MODE: 'news-only' });

const errors = (p: Post, s = preferred) =>
  validateNewsworthiness(p, s, NOW).filter((i) => i.severity === 'error');

/** A genuinely newsworthy, sourced, fresh post. */
function newsPost(overrides: Partial<Post> = {}): Post {
  return PostSchema.parse({
    ...base,
    content_type: 'news',
    idea: 'Claude Code ships parallel subagents',
    hook: 'Claude Code just got parallel subagents',
    why_now: 'Anthropic shipped parallel subagents on July 11 — multi-part tasks now fan out.',
    sources: [
      {
        url: 'https://example.com/notes',
        description: 'release notes',
        published_at: '2026-07-11',
      },
    ],
    ...overrides,
  });
}

/** A real AI-education post: teaches one concrete thing, honest fallback. */
function valuePost(overrides: Partial<Post> = {}): Post {
  return PostSchema.parse({
    ...base,
    content_type: 'value',
    idea: 'Cut Claude Code token spend with scoped context',
    hook: 'Your agent is re-reading the whole repo',
    value_promise: 'Scope your context so an agent run stops re-reading files it does not need.',
    no_news_reason:
      'Searched the last 48h across Claude/OpenAI/Gemini — nothing shipped worth a post.',
    sources: [],
    ...overrides,
  });
}

describe('news lane (always preferred)', () => {
  it('passes a sourced, fresh, anchored news post', () => {
    expect(errors(newsPost())).toHaveLength(0);
  });

  it('blocks news with no why_now, no source, no date, or a stale source', () => {
    expect(errors(newsPost({ why_now: '' })).some((i) => i.code === 'NO_WHY_NOW')).toBe(true);
    expect(errors(newsPost({ sources: [] })).some((i) => i.code === 'NO_SOURCE')).toBe(true);
    expect(
      errors(newsPost({ sources: [{ url: 'https://a.com', description: 'x' }] })).some(
        (i) => i.code === 'NO_SOURCE_DATE',
      ),
    ).toBe(true);
    const stale = newsPost({
      sources: [{ url: 'https://a.com', description: 'x', published_at: '2026-05-01' }],
    });
    expect(errors(stale).some((i) => i.code === 'STALE_STORY')).toBe(true);
  });

  it('warns SLOW_TO_POST when fresh but past the first-mover window', () => {
    const late = newsPost({
      sources: [{ url: 'https://a.com', description: 'x', published_at: '2026-07-05' }], // 7d
    });
    const issues = validateNewsworthiness(late, preferred, NOW);
    expect(issues.find((i) => i.code === 'SLOW_TO_POST')?.severity).toBe('warning');
    expect(errors(late)).toHaveLength(0); // still publishable
    expect(isBreaking(late, preferred, NOW)).toBe(false);
    expect(isBreaking(newsPost(), preferred, NOW)).toBe(true);
  });
});

describe('value lane (the fallback — education, never filler)', () => {
  it('passes a real teaching post when no news exists', () => {
    expect(errors(valuePost())).toHaveLength(0);
  });

  it('blocks a value post with no concrete promise', () => {
    expect(
      errors(valuePost({ value_promise: '' })).some((i) => i.code === 'NO_VALUE_PROMISE'),
    ).toBe(true);
  });

  it('blocks a value post that never says why it skipped the news', () => {
    expect(
      errors(valuePost({ no_news_reason: '' })).some((i) => i.code === 'NO_FALLBACK_REASON'),
    ).toBe(true);
  });

  it('blocks a value post that does not actually teach a method', () => {
    const vague = valuePost({
      slides: [
        { type: 'cover', headline: 'AI is changing work', body: '' },
        { type: 'standard-content', headline: 'It is a big deal', body: 'Really big.' },
        { type: 'standard-content', headline: 'Think about it', body: 'Seriously.' },
        { type: 'cta', headline: 'Follow', body: '', kicker: '' },
      ],
    });
    expect(errors(vague).some((i) => i.code === 'NOT_ACTIONABLE')).toBe(true);
  });

  it('news-only rejects the value lane outright', () => {
    expect(errors(valuePost(), newsOnly).some((i) => i.code === 'VALUE_NOT_ALLOWED')).toBe(true);
    expect(errors(newsPost(), newsOnly)).toHaveLength(0);
  });
});

describe('slop rejection', () => {
  it('blocks clickbait hype in either lane', () => {
    const hype = valuePost({ idea: '5 AI hacks', hook: 'These AI hacks will blow your mind' });
    expect(errors(hype).some((i) => i.code === 'HYPE_SLOP')).toBe(true);
    expect(
      errors(newsPost({ hook: 'The ultimate guide to Claude' })).some(
        (i) => i.code === 'HYPE_SLOP',
      ),
    ).toBe(true);
  });

  it('only warns on a numeric listicle — a specific one can be excellent', () => {
    const listicle = valuePost({
      idea: '4 Claude Code settings that cut token spend',
      hook: '4 Claude Code tips that cut my token bill',
    });
    const issues = validateNewsworthiness(listicle, preferred, NOW);
    expect(issues.find((i) => i.code === 'LISTICLE_SHAPE')?.severity).toBe('warning');
    expect(errors(listicle)).toHaveLength(0); // publishable
  });
});

describe('mode + lane resolution', () => {
  it('defaults to news-preferred and maps the legacy news-first name', () => {
    expect(parseSettings({}).CONTENT_MODE).toBe('news-preferred');
    expect(parseSettings({ CONTENT_MODE: 'news-first' }).CONTENT_MODE).toBe('news-only');
  });

  it('infers the lane when the author omits content_type', () => {
    expect(resolveContentType(newsPost({ content_type: undefined }))).toBe('news');
    expect(resolveContentType(valuePost({ content_type: undefined }))).toBe('value');
  });

  it('mixed only warns; evergreen-ok drops the bar', () => {
    const mixed = parseSettings({ CONTENT_MODE: 'mixed' });
    const issues = validateNewsworthiness(base, mixed, NOW);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.every((i) => i.severity === 'warning')).toBe(true);
    expect(
      validateNewsworthiness(base, parseSettings({ CONTENT_MODE: 'evergreen-ok' }), NOW),
    ).toHaveLength(0);
  });
});

describe('freshestSourceAgeDays', () => {
  it('returns the age of the newest dated source, or null when undated', () => {
    const post = newsPost({
      sources: [
        { url: 'https://a.com', description: 'old', published_at: '2026-06-12' },
        { url: 'https://b.com', description: 'new', published_at: '2026-07-10' },
      ],
    });
    expect(Math.round(freshestSourceAgeDays(post, NOW)!)).toBe(2);
    expect(
      freshestSourceAgeDays(
        newsPost({ sources: [{ url: 'https://a.com', description: 'x' }] }),
        NOW,
      ),
    ).toBeNull();
  });
});
