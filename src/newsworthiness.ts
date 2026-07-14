import { DateTime } from 'luxon';
import { Post, ContentType } from '../schemas/post.js';
import { Settings, isEnforcingMode } from '../schemas/settings.js';

/**
 * The content policy: "is this worth someone's attention?"
 *
 * The account has TWO honest lanes, and the whole point is that neither is filler:
 *
 *   NEWS  (always preferred) — a real, fresh, sourced development. Must prove:
 *         why_now + a primary source + a published_at inside MAX_STORY_AGE_DAYS.
 *
 *   VALUE (fallback only)    — AI education for people who want to actually USE AI.
 *         Allowed only when genuinely nothing shipped. Must prove it teaches one
 *         concrete, testable thing: value_promise + an actionable deck + an honest
 *         no_news_reason. This is NOT the easy default — it costs extra fields on
 *         purpose, so the author only pays that cost after really looking for news.
 *
 * Hype/clickbait shapes are rejected outright in either lane. Numeric listicles
 * only warn — "5 Claude Code settings that actually matter" is fine; "5 AI hacks
 * that will blow your mind" is not.
 */

export interface NewsIssue {
  code: string;
  message: string;
  severity: 'error' | 'warning';
}

/** Hype/clickbait shapes. Never acceptable, in either lane. */
const HYPE_PATTERNS: RegExp[] = [
  /\b(blow|blew)\s+your\s+mind\b/i,
  /\bmind[-\s]?blowing\b/i,
  /\bchange\s+your\s+life\b/i,
  /\byou\s+won'?t\s+believe\b/i,
  /\bultimate\s+guide\b/i,
  /\b10x\s+your\b/i,
  /\bnobody\s+is\s+talking\s+about\b/i,
  /\b(tools|prompts|apps)\s+you\s+(need|must)\b/i,
  /\bgame[-\s]?chang(er|ing)\b/i,
  /\bsecret\s+(ai\s+)?(tools|prompts|hacks)\b/i,
];

/**
 * Bare numeric listicles. These only WARN: a numbered post can be excellent when
 * it is specific ("4 Claude Code settings that cut my token spend"), so judgment
 * stays with the operator — but the shape is a common filler tell.
 */
const LISTICLE_PATTERNS: RegExp[] = [
  // "5 prompts", "4 Claude Code tips", "7 AI tools" — a count, then up to a few
  // qualifier words, then the filler noun.
  /\b\d+\s+(\w+\s+){0,3}(tools|prompts|tips|tricks|hacks|secrets)\b/i,
];

/** Slide types that actually teach something the reader can act on. */
const ACTIONABLE_SLIDE_TYPES = new Set([
  'numbered-point',
  'step',
  'checklist',
  'mistake-solution',
  'comparison',
  'myth-reality',
]);

/** Parse a source date leniently (ISO date or full timestamp). */
export function parseSourceDate(raw: string | undefined, zone = 'utc'): DateTime | null {
  if (!raw || !raw.trim()) return null;
  const s = raw.trim();
  const iso = DateTime.fromISO(s, { zone });
  if (iso.isValid) return iso;
  const fmt = DateTime.fromFormat(s, 'yyyy-MM-dd', { zone });
  return fmt.isValid ? fmt : null;
}

/** Clock-skew allowance before a source date counts as "in the future". */
const FUTURE_SKEW_DAYS = 1;

/**
 * Age in days of the freshest dated source, or null when none is dated.
 * Future-dated sources (beyond skew) are EXCLUDED — a typo'd year would
 * otherwise register as negative age, masking genuinely stale sources and
 * sailing through the freshness gate as "breaking".
 */
export function freshestSourceAgeDays(post: Post, now: DateTime): number | null {
  let best: number | null = null;
  for (const src of post.sources) {
    const dt = parseSourceDate(src.published_at, now.zoneName ?? 'utc');
    if (!dt) continue;
    const age = now.diff(dt, 'days').days;
    if (age < -FUTURE_SKEW_DAYS) continue;
    if (best === null || age < best) best = age;
  }
  return best;
}

/** Source dates in the future (beyond skew) — always an authoring error. */
export function futureSourceDates(post: Post, now: DateTime): string[] {
  const out: string[] = [];
  for (const src of post.sources) {
    const dt = parseSourceDate(src.published_at, now.zoneName ?? 'utc');
    if (dt && now.diff(dt, 'days').days < -FUTURE_SKEW_DAYS) out.push(src.published_at ?? '');
  }
  return out;
}

/** True when a story broke inside the first-mover window (worth racing on). */
export function isBreaking(
  post: Post,
  settings: Settings,
  now: DateTime = DateTime.utc(),
): boolean {
  const age = freshestSourceAgeDays(post, now);
  return age !== null && age * 24 <= settings.BREAKING_WINDOW_HOURS;
}

/**
 * Infer the lane when the author did not declare one. A why_now anchor is the
 * clearest news signal; value_promise / no_news_reason are the clearest value
 * signals. Sources alone do NOT force the news lane — the UNSOURCED_CLAIM rule
 * requires value posts citing hard numbers to carry sources, and those must
 * not be misrouted into news and rejected for missing why_now.
 */
export function resolveContentType(post: Post): ContentType {
  if (post.content_type) return post.content_type;
  if ((post.why_now ?? '').trim()) return 'news';
  if ((post.value_promise ?? '').trim() || (post.no_news_reason ?? '').trim()) return 'value';
  return post.sources.length > 0 ? 'news' : 'value';
}

/** NEWS lane: real, sourced, fresh. */
function checkNewsLane(
  post: Post,
  settings: Settings,
  now: DateTime,
  severity: 'error' | 'warning',
): NewsIssue[] {
  const issues: NewsIssue[] = [];

  if ((post.why_now ?? '').trim().length < 20) {
    issues.push({
      code: 'NO_WHY_NOW',
      message:
        'post.why_now is missing or too thin — state what actually happened, when, and why it matters now.',
      severity,
    });
  }

  if (post.sources.length === 0) {
    issues.push({
      code: 'NO_SOURCE',
      message:
        'a news post needs at least one primary source (post.sources) — read the announcement/release notes before authoring',
      severity,
    });
    return issues;
  }

  const future = futureSourceDates(post, now);
  if (future.length > 0) {
    issues.push({
      code: 'FUTURE_SOURCE_DATE',
      message: `source published_at is in the future (${future.join(', ')}) — fix the date; never invent release dates`,
      severity,
    });
  }

  const age = freshestSourceAgeDays(post, now);
  if (age === null) {
    issues.push({
      code: 'NO_SOURCE_DATE',
      message:
        'no source carries a published_at date — add published_at (YYYY-MM-DD) so freshness can be verified',
      severity,
    });
  } else if (age > settings.MAX_STORY_AGE_DAYS) {
    issues.push({
      code: 'STALE_STORY',
      message: `freshest source is ${Math.round(age)} days old (> MAX_STORY_AGE_DAYS ${settings.MAX_STORY_AGE_DAYS}) — this is not news any more. Either find a current story, or switch to a value post (content_type: "value").`,
      severity,
    });
  } else if (age * 24 > settings.BREAKING_WINDOW_HOURS) {
    issues.push({
      code: 'SLOW_TO_POST',
      message: `story is ~${Math.round(age * 24)}h old (> BREAKING_WINDOW_HOURS ${settings.BREAKING_WINDOW_HOURS}) — still worth posting, but you are not first.`,
      severity: 'warning',
    });
  }

  return issues;
}

/**
 * VALUE lane: real AI education, never filler. The fallback must still earn the
 * reader's time — it teaches ONE concrete thing they can do today.
 */
function checkValueLane(post: Post, severity: 'error' | 'warning'): NewsIssue[] {
  const issues: NewsIssue[] = [];

  if ((post.value_promise ?? '').trim().length < 20) {
    issues.push({
      code: 'NO_VALUE_PROMISE',
      message:
        'post.value_promise is missing or too thin — name the concrete thing the reader can DO after this (a workflow, a setting, a technique). "Learn about AI" is not a promise.',
      severity,
    });
  }

  if ((post.no_news_reason ?? '').trim().length < 20) {
    issues.push({
      code: 'NO_FALLBACK_REASON',
      message:
        'post.no_news_reason is missing — the value lane is a FALLBACK. Say what you searched and why nothing shipped was worth covering. If real news exists, cover the news instead.',
      severity,
    });
  }

  // A value post must actually teach: steps, a checklist, a comparison — not vibes.
  const actionable = post.slides.filter((s) => ACTIONABLE_SLIDE_TYPES.has(s.type)).length;
  if (actionable < 2) {
    issues.push({
      code: 'NOT_ACTIONABLE',
      message:
        'a value post needs at least 2 actionable slides (numbered-point / step / checklist / comparison / mistake-solution) — teach a concrete method, do not just describe one',
      severity,
    });
  }

  return issues;
}

/**
 * Gate a post. News is always preferred; value is the honest fallback. In
 * `news-only` a value post is rejected outright; in `mixed` everything only warns;
 * in `evergreen-ok` only the hype check applies.
 */
export function validateNewsworthiness(
  post: Post,
  settings: Settings,
  now: DateTime = DateTime.utc(),
): NewsIssue[] {
  const issues: NewsIssue[] = [];
  const mode = settings.CONTENT_MODE;
  const ideaText = `${post.idea} ${post.hook}`;

  // Hype/clickbait is never acceptable — this is exactly what the account must
  // not look like. Blocks in any enforcing mode, regardless of lane.
  for (const pattern of HYPE_PATTERNS) {
    if (pattern.test(ideaText)) {
      issues.push({
        code: 'HYPE_SLOP',
        message: `idea/hook uses clickbait hype (matched ${pattern}) — say the actual thing instead`,
        severity: isEnforcingMode(mode) ? 'error' : 'warning',
      });
      break;
    }
  }

  for (const pattern of LISTICLE_PATTERNS) {
    if (pattern.test(ideaText)) {
      issues.push({
        code: 'LISTICLE_SHAPE',
        message: `idea/hook is a bare numeric listicle (matched ${pattern}) — fine only if each item is genuinely specific and useful; otherwise anchor it to a real development`,
        severity: 'warning',
      });
      break;
    }
  }

  if (mode === 'evergreen-ok') return issues;

  const severity: 'error' | 'warning' = isEnforcingMode(mode) ? 'error' : 'warning';
  const lane = resolveContentType(post);

  if (lane === 'news') {
    issues.push(...checkNewsLane(post, settings, now, severity));
    return issues;
  }

  // lane === 'value'
  if (mode === 'news-only') {
    issues.push({
      code: 'VALUE_NOT_ALLOWED',
      message:
        'CONTENT_MODE=news-only accepts news posts only — find a real, sourced story (or set CONTENT_MODE=news-preferred to allow the value fallback)',
      severity: 'error',
    });
    return issues;
  }

  issues.push(...checkValueLane(post, severity));
  return issues;
}
