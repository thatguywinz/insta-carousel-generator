import { describe, it, expect } from 'vitest';
import { jaccard, diceBigram, checkSimilarity, tokenize } from '../../src/similarity.js';

describe('similarity', () => {
  it('tokenize drops stopwords and short tokens', () => {
    const t = tokenize('How to price your freelance projects');
    expect(t).toContain('price');
    expect(t).toContain('freelance');
    expect(t).toContain('projects');
    expect(t).not.toContain('how');
    expect(t).not.toContain('to');
  });

  it('identical strings score ~1', () => {
    expect(jaccard('price freelance projects', 'price freelance projects')).toBeCloseTo(1);
    expect(diceBigram('price freelance', 'price freelance')).toBeCloseTo(1);
  });

  it('flags near-duplicate ideas', () => {
    const corpus = ['How to price your freelance projects on value'];
    const res = checkSimilarity('How to price freelance projects based on value', corpus);
    expect(res.isDuplicate).toBe(true);
    expect(res.mostSimilar).toBe(corpus[0]);
  });

  it('does not flag unrelated ideas', () => {
    const corpus = ['How to price your freelance projects'];
    const res = checkSimilarity('Five houseplants that survive low light', corpus);
    expect(res.isDuplicate).toBe(false);
  });

  it('handles empty corpus safely', () => {
    const res = checkSimilarity('anything at all', []);
    expect(res.isDuplicate).toBe(false);
    expect(res.maxScore).toBe(0);
  });
});
