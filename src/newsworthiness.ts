import { DateTime } from 'luxon';
import { Post } from '../schemas/post.js';
import { Settings } from '../schemas/settings.js';

/**
 * The "is this actually worth posting?" bar.
 *
 * The account exists to break down what is genuinely NEW in AI. Without a gate,
 * an autonomous author drifts toward timeless filler ("5 prompts you need"),
 * which is cheap to write and worthless to read. In `news-first` CONTENT_MODE a
 * post must therefore prove three things, or it does not ship:
 *
 *   1. WHY NOW  — an explicit anchor: what happened, and why it matters this week.
 *   2. SOURCED  — at least one primary source URL (no invented releases).
 *   3. FRESH    — a source published within MAX_STORY_AGE_DAYS.
 *
 * Evergreen how-tos are still allowed, but only when hung on a fresh peg (e.g.
 * "how to use the parallel subagents that shipped Tuesday").
 */

export interface NewsIssue {
  code: string;
  message: string;
  severity: 'error' | 'warning';
}

/**
 * Idea/hook shapes that are almost always low-value listicle filler. These warn
 * rather than block — judgment stays with the operator — but they should make
 * the author stop and find a real story instead.
 */
const LOW_VALUE_PATTERNS: RegExp[] = [
  /\b\d+\s+(ai\s+|chatgpt\s+|claude\s+)?(tools|prompts|tips|tricks|hacks|secrets)\b/i,
  /\b(tools|prompts|apps)\s+you\s+(need|must)\b/i,
  /\b(blow|blew)\s+your\s+mind\b/i,
  /\bmind[-\s]?blowing\b/i,
  /\bchange\s+your\s+life\b/i,
  /\byou\s+won'?t\s+believe\b/i,
  /\bultimate\s+guide\b/i,
  /\b10x\s+your\b/i,
  /\bnobody\s+is\s+talking\s+about\b/i,
];

/** Parse a source date leniently (ISO date or full timestamp). */
export function parseSourceDate(raw: string | undefined, zone = 'utc'): DateTime | null {
  if (!raw || !raw.trim()) return null;
  const s = raw.trim();
  const iso = DateTime.fromISO(s, { zone });
  if (iso.isValid) return iso;
  const fmt = DateTime.fromFormat(s, 'yyyy-MM-dd', { zone });
  return fmt.isValid ? fmt : null;
}

/**
 * Age in days of the freshest dated source, or null when no source carries a
 * parseable date.
 */
export function freshestSourceAgeDays(post: Post, now: DateTime): number | null {
  let best: number | null = null;
  for (const src of post.sources) {
    const dt = parseSourceDate(src.published_at, now.zoneName ?? 'utc');
    if (!dt) continue;
    const age = now.diff(dt, 'days').days;
    if (best === null || age < best) best = age;
  }
  return best;
}

/**
 * Gate a post on newsworthiness. In `news-first` the checks block; in `mixed`
 * they only warn; in `evergreen-ok` the freshness bar is skipped entirely.
 */
export function validateNewsworthiness(
  post: Post,
  settings: Settings,
  now: DateTime = DateTime.utc(),
): NewsIssue[] {
  const issues: NewsIssue[] = [];
  const mode = settings.CONTENT_MODE;

  // Low-value listicle shapes always warn, in every mode.
  const ideaText = `${post.idea} ${post.hook}`;
  for (const pattern of LOW_VALUE_PATTERNS) {
    if (pattern.test(ideaText)) {
      issues.push({
        code: 'LOW_VALUE_IDEA',
        message: `idea/hook reads like generic listicle filler (matched ${pattern}) — anchor it to a real, recent development instead`,
        severity: 'warning',
      });
      break;
    }
  }

  if (mode === 'evergreen-ok') return issues;
  const severity: 'error' | 'warning' = mode === 'news-first' ? 'error' : 'warning';

  // 1. WHY NOW — the explicit newsworthiness anchor.
  const whyNow = (post.why_now ?? '').trim();
  if (whyNow.length < 20) {
    issues.push({
      code: 'NO_WHY_NOW',
      message:
        'post.why_now is missing or too thin — state what actually happened, when, and why it matters now. If you cannot, this is not worth posting.',
      severity,
    });
  }

  // 2. SOURCED — a real primary source, never an invented release.
  if (post.sources.length === 0) {
    issues.push({
      code: 'NO_SOURCE',
      message:
        'a news-first post needs at least one primary source (post.sources) — research the announcement/release notes before authoring',
      severity,
    });
    return issues;
  }

  // 3. FRESH — the story must be recent.
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
      message: `freshest source is ${Math.round(age)} days old (> MAX_STORY_AGE_DAYS ${settings.MAX_STORY_AGE_DAYS}) — this is not news any more; find a current story`,
      severity,
    });
  } else if (age * 24 > settings.BREAKING_WINDOW_HOURS) {
    // Fresh enough to publish, but the first-mover advantage is gone. Warn so the
    // operator prefers a story that broke inside the window — being early is most
    // of the reach.
    issues.push({
      code: 'SLOW_TO_POST',
      message: `story is ~${Math.round(age * 24)}h old (> BREAKING_WINDOW_HOURS ${settings.BREAKING_WINDOW_HOURS}) — still publishable, but you are not first. Prefer something that broke in the last ${settings.BREAKING_WINDOW_HOURS}h if one exists.`,
      severity: 'warning',
    });
  }

  return issues;
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
