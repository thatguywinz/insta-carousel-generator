/**
 * Research requirement detection and claim validation. Determines whether a
 * topic requires current authoritative sources, and validates that a post
 * which makes volatile claims actually carries sources.
 */

const VOLATILE_PATTERNS: Array<{ pattern: RegExp; category: string }> = [
  { pattern: /\b\d+(\.\d+)?\s?%/, category: 'statistic' },
  { pattern: /\b(percent|percentage|statistic|survey|study|report)\b/i, category: 'statistic' },
  { pattern: /[$€£]\s?\d/, category: 'price' },
  { pattern: /\b(price|cost|fee|rate|salary|wage|interest rate)\b/i, category: 'price' },
  { pattern: /\b(law|legal|regulation|compliance|tax|irs|cra|gdpr|hipaa)\b/i, category: 'law' },
  { pattern: /\b(medical|health|dosage|symptom|diagnosis|treatment|drug)\b/i, category: 'medical' },
  { pattern: /\b(safety|hazard|toxic|recall)\b/i, category: 'safety' },
  {
    pattern: /\b(20\d{2}|this year|next year|latest|current|as of)\b/i,
    category: 'time-sensitive',
  },
  {
    pattern: /\b(algorithm update|platform (rule|policy)|api change)\b/i,
    category: 'platform-rules',
  },
  { pattern: /\b(stock|crypto|market|inflation|gdp|index)\b/i, category: 'market-data' },
];

export interface ResearchNeed {
  required: boolean;
  categories: string[];
}

/** Detect whether the given text likely needs current authoritative sources. */
export function detectResearchNeed(text: string): ResearchNeed {
  const categories = new Set<string>();
  for (const { pattern, category } of VOLATILE_PATTERNS) {
    if (pattern.test(text)) categories.add(category);
  }
  return { required: categories.size > 0, categories: [...categories] };
}

export interface ClaimValidationResult {
  ok: boolean;
  issues: string[];
}

/**
 * Validate that a post which makes volatile claims carries at least one source.
 * `combinedText` is all slide + caption copy; `sourceCount` is post.sources.length.
 */
export function validateClaims(combinedText: string, sourceCount: number): ClaimValidationResult {
  const issues: string[] = [];
  const need = detectResearchNeed(combinedText);

  // A concrete numeric statistic or price with zero sources is suspect.
  const hasHardStat = /\b\d+(\.\d+)?\s?%/.test(combinedText) || /[$€£]\s?\d/.test(combinedText);
  if (hasHardStat && sourceCount === 0) {
    issues.push('Post contains hard statistics or prices but has no sources attached.');
  }

  if (need.categories.includes('law') && sourceCount === 0) {
    issues.push('Post references laws/regulations without a source.');
  }
  if (need.categories.includes('medical') && sourceCount === 0) {
    issues.push('Post references medical/health claims without a source.');
  }

  return { ok: issues.length === 0, issues };
}
