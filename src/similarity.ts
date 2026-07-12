/**
 * Deterministic keyword/token-similarity checks used to avoid generating an
 * idea (or hook) that substantially repeats a recent one. This is the
 * automated half; semantic judgment is applied by the operating model on top.
 */

const STOPWORDS = new Set([
  'the',
  'a',
  'an',
  'and',
  'or',
  'but',
  'to',
  'of',
  'in',
  'on',
  'for',
  'with',
  'your',
  'you',
  'how',
  'why',
  'what',
  'when',
  'is',
  'are',
  'be',
  'this',
  'that',
  'it',
  'as',
  'at',
  'by',
  'from',
  'do',
  'does',
  'not',
  'no',
  'yes',
  'can',
  'will',
  'should',
  'must',
  'more',
  'most',
  'best',
  'top',
  'ways',
  'way',
  'tips',
  'tip',
  'guide',
  'about',
  'into',
  'out',
  'up',
  'down',
  'get',
  'make',
  'using',
  'use',
]);

/** Normalize text to a set of significant lowercase tokens. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

/** Jaccard similarity between two token sets: |A∩B| / |A∪B|. Range 0..1. */
export function jaccard(a: string, b: string): number {
  const setA = new Set(tokenize(a));
  const setB = new Set(tokenize(b));
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const t of setA) if (setB.has(t)) intersection++;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** Character-level Dice coefficient over bigrams; catches reworded phrasings. */
export function diceBigram(a: string, b: string): number {
  const bigrams = (s: string): Map<string, number> => {
    const norm = s.toLowerCase().replace(/\s+/g, ' ').trim();
    const m = new Map<string, number>();
    for (let i = 0; i < norm.length - 1; i++) {
      const bg = norm.slice(i, i + 2);
      m.set(bg, (m.get(bg) ?? 0) + 1);
    }
    return m;
  };
  const A = bigrams(a);
  const B = bigrams(b);
  if (A.size === 0 && B.size === 0) return 1;
  if (A.size === 0 || B.size === 0) return 0;
  let overlap = 0;
  for (const [bg, count] of A) {
    const other = B.get(bg);
    if (other) overlap += Math.min(count, other);
  }
  return (
    (2 * overlap) /
    (Array.from(A.values()).reduce((s, v) => s + v, 0) +
      Array.from(B.values()).reduce((s, v) => s + v, 0))
  );
}

export interface SimilarityResult {
  maxScore: number;
  jaccardScore: number;
  diceScore: number;
  mostSimilar: string | null;
  isDuplicate: boolean;
}

/**
 * Score a candidate string against a corpus of recent strings.
 * A candidate is flagged as a duplicate when either metric crosses threshold.
 */
export function checkSimilarity(
  candidate: string,
  corpus: string[],
  opts: { jaccardThreshold?: number; diceThreshold?: number } = {},
): SimilarityResult {
  const jaccardThreshold = opts.jaccardThreshold ?? 0.5;
  const diceThreshold = opts.diceThreshold ?? 0.6;

  let bestJaccard = 0;
  let bestDice = 0;
  let bestCombined = -1;
  let mostSimilar: string | null = null;

  for (const item of corpus) {
    const j = jaccard(candidate, item);
    const d = diceBigram(candidate, item);
    const combined = Math.max(j, d);
    if (combined > bestCombined) {
      bestCombined = combined;
      mostSimilar = item;
    }
    bestJaccard = Math.max(bestJaccard, j);
    bestDice = Math.max(bestDice, d);
  }

  const isDuplicate = bestJaccard >= jaccardThreshold || bestDice >= diceThreshold;

  return {
    maxScore: Math.max(bestJaccard, bestDice),
    jaccardScore: bestJaccard,
    diceScore: bestDice,
    mostSimilar,
    isDuplicate,
  };
}
