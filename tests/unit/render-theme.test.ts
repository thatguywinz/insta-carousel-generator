import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { detectTheme, resolveTheme, buildSlideHtml, Brand } from '../../src/render.js';
import { PostSchema, Slide } from '../../schemas/post.js';

const fixture = JSON.parse(
  readFileSync(path.join(__dirname, '..', 'fixtures', 'sample-post.json'), 'utf8'),
);

const brand: Brand = {
  brandName: 'Test',
  instagramHandle: '@test',
  colors: {
    primary: '#1A2B4A',
    secondary: '#3B6FE0',
    accent: '#F2B705',
    background: '#FBFAF7',
    surface: '#FFFFFF',
    text: '#141B2E',
    textMuted: '#5A6478',
    onPrimary: '#FFFFFF',
  },
  style: 'clean-editorial',
  language: 'en',
};

describe('theme detection', () => {
  it('detects claude from idea/pillar keywords', () => {
    expect(detectTheme({ content_pillar: 'AI tools', idea: 'Claude Code setup tips' })).toBe(
      'claude',
    );
    expect(detectTheme({ content_pillar: 'Anthropic news', idea: 'model update' })).toBe('claude');
  });

  it('detects openai from idea/pillar keywords', () => {
    expect(detectTheme({ content_pillar: 'AI tools', idea: 'Codex CLI workflows' })).toBe('openai');
    expect(detectTheme({ content_pillar: 'News', idea: 'ChatGPT tips for writers' })).toBe(
      'openai',
    );
    expect(detectTheme({ content_pillar: 'News', idea: 'GPT-5 prompting guide' })).toBe('openai');
    expect(detectTheme({ content_pillar: 'News', idea: 'What OpenAI shipped' })).toBe('openai');
  });

  it('is case-insensitive and defaults otherwise', () => {
    expect(detectTheme({ content_pillar: 'ai', idea: 'CLAUDE tips' })).toBe('claude');
    expect(detectTheme({ content_pillar: 'Pricing', idea: 'freelance rates' })).toBe('default');
    // "gpt" must not fire inside unrelated words.
    expect(detectTheme({ content_pillar: 'Egypt travel', idea: 'sightseeing' })).toBe('default');
  });

  it('detects the expanded AI-brand themes', () => {
    expect(detectTheme({ content_pillar: 'News', idea: 'Gemini 2 doubles context' })).toBe(
      'gemini',
    );
    expect(detectTheme({ content_pillar: 'News', idea: 'Grok gains live search' })).toBe('grok');
    expect(detectTheme({ content_pillar: 'News', idea: 'Llama 4 released by Meta AI' })).toBe(
      'meta',
    );
    expect(detectTheme({ content_pillar: 'News', idea: 'Mistral ships Mixtral update' })).toBe(
      'mistral',
    );
  });

  it('uses the generic breaking theme for vendorless attention hooks', () => {
    expect(detectTheme({ content_pillar: 'AI', idea: 'Breaking: a new model just dropped' })).toBe(
      'breaking',
    );
    // A named vendor still wins over the generic breaking keyword.
    expect(detectTheme({ content_pillar: 'AI', idea: 'Breaking: Claude just shipped X' })).toBe(
      'claude',
    );
    // "meta" must not fire inside unrelated words like "metadata".
    expect(detectTheme({ content_pillar: 'Data', idea: 'metadata best practices' })).toBe(
      'default',
    );
  });

  it('resolves each themed subject to a mark + label', () => {
    for (const [idea, name, label] of [
      ['Gemini update', 'gemini', 'Gemini'],
      ['Grok update', 'grok', 'Grok'],
      ['Meta AI Llama', 'meta', 'Meta AI'],
      ['Mistral update', 'mistral', 'Mistral'],
      ['Breaking news dropped', 'breaking', 'AI News'],
    ] as const) {
      const theme = resolveTheme({ content_pillar: 'x', idea });
      expect(theme.name).toBe(name);
      expect(theme.label).toBe(label);
      expect(theme.logo).toMatch(/^data:image\/svg\+xml;base64,/);
    }
  });

  it('claude wins when both subjects appear', () => {
    expect(detectTheme({ content_pillar: 'AI', idea: 'Claude vs ChatGPT compared' })).toBe(
      'claude',
    );
  });

  it('explicit theme field overrides detection', () => {
    expect(detectTheme({ content_pillar: 'AI', idea: 'Claude tips', theme: 'openai' })).toBe(
      'openai',
    );
  });
});

describe('post schema theme field', () => {
  it('accepts a valid optional theme and rejects unknown values', () => {
    expect(PostSchema.parse({ ...fixture, theme: 'claude' }).theme).toBe('claude');
    expect(PostSchema.parse(fixture).theme).toBeUndefined();
    expect(() => PostSchema.parse({ ...fixture, theme: 'neon' })).toThrow();
  });
});

describe('themed slide html', () => {
  const cover: Slide = {
    type: 'cover',
    headline: 'Test headline',
    body: 'Test body',
    kicker: 'Kicker',
  };

  it('embeds the mark as a data URI on cover and footer for themed posts', () => {
    const theme = resolveTheme({ content_pillar: 'AI', idea: 'Claude Code tips' });
    expect(theme.name).toBe('claude');
    expect(theme.logo).toMatch(/^data:image\/svg\+xml;base64,/);
    const html = buildSlideHtml(cover, 1, 6, brand, '', theme);
    expect(html).toContain('class="brandmark"');
    expect(html).toContain('class="footer-logo"');
    expect(html).toContain('data:image/svg+xml;base64,');
  });

  it('renders a decor layer and gradient background for every theme', () => {
    for (const idea of ['Claude tips', 'ChatGPT tips', 'freelance pricing']) {
      const theme = resolveTheme({ content_pillar: 'x', idea });
      const html = buildSlideHtml(cover, 1, 6, brand, '', theme);
      expect(html).toContain('decor-layer');
      expect(html).toContain('--g-bg');
    }
  });

  it('default theme carries no third-party mark', () => {
    const theme = resolveTheme({ content_pillar: 'Pricing', idea: 'rates' });
    expect(theme.logo).toBeUndefined();
    const html = buildSlideHtml(cover, 1, 6, brand, '', theme);
    // The class names exist in the base stylesheet; assert no rendered markup.
    expect(html).not.toContain('class="footer-logo"');
    expect(html).not.toContain('class="brandmark"');
    expect(html).not.toContain('data:image/svg+xml');
  });
});

describe('cta slide wiring', () => {
  const ctaBrand: Brand = { ...brand, defaultCta: 'Follow @test — the value line.' };

  it('fills body from DEFAULT_CTA and pill from the handle when blank', () => {
    const cta: Slide = { type: 'cta', headline: 'Want the next one?', body: '', kicker: '' };
    const html = buildSlideHtml(cta, 6, 6, ctaBrand, '');
    expect(html).toContain('Follow @test — the value line.');
    expect(html).toContain('Follow @test'); // pill label
    expect(html).not.toContain('Save &amp; share');
  });

  it('keeps author-written cta body + kicker when provided', () => {
    const cta: Slide = { type: 'cta', headline: 'Ask', body: 'Save this now', kicker: 'Save' };
    const html = buildSlideHtml(cta, 6, 6, ctaBrand, '');
    expect(html).toContain('Save this now');
    expect(html).toContain('>Save<');
  });
});
