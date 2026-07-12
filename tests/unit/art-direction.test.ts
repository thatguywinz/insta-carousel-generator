import { describe, it, expect } from 'vitest';
import {
  ART_DIRECTIONS,
  artDirection,
  resolveArtDirection,
  MOTION_KEYFRAMES,
} from '../../src/art-direction.js';
import { fontFaceCss } from '../../src/fonts.js';
import { buildSlideHtml, Brand } from '../../src/render.js';
import { Slide } from '../../schemas/post.js';

const brand: Brand = {
  brandName: 'Test',
  instagramHandle: '@test',
  colors: {
    primary: '#0F172A',
    secondary: '#0F172A',
    accent: '#D4AF37',
    background: '#FFFFFF',
    surface: '#FFFFFF',
    text: '#0F172A',
    textMuted: '#5A6478',
    onPrimary: '#FFFFFF',
  },
  style: 'bold',
  language: 'en',
  defaultCta: 'Follow @test — value line.',
};

const cover: Slide = { type: 'cover', headline: 'Hook', body: 'Sub', kicker: 'K' };

describe('art-direction registry', () => {
  it('exposes six styles, each with scoped css + motion', () => {
    expect(ART_DIRECTIONS.length).toBe(6);
    for (const name of ART_DIRECTIONS) {
      const ad = artDirection(name);
      expect(ad.name).toBe(name);
      expect(ad.css).toContain(`.ad-${name}`);
      expect(ad.css).toContain('--g-bg');
      expect(ad.motionCss).toContain('.slide.motion');
    }
  });

  it('every direction animates the cover underline (settled-at-t0 draw)', () => {
    expect(MOTION_KEYFRAMES).toContain('ad-underline');
    // The draw must rest at full width so frame 0 is a complete poster.
    expect(MOTION_KEYFRAMES).toMatch(/ad-underline \{ 0%,100%\{transform:scaleX\(1\)\}/);
    for (const name of ART_DIRECTIONS) {
      expect(artDirection(name).motionCss).toContain('ad-underline');
    }
  });

  it('every direction upsizes sparse interior slides so points never float in a void', () => {
    for (const name of ART_DIRECTIONS) {
      const css = artDirection(name).css;
      expect(css).toContain(`.ad-${name}.slide-numbered-point .content`);
      expect(css).toContain('gap: 44px');
    }
  });
});

describe('resolveArtDirection precedence', () => {
  it('an explicit art_direction wins over the setting', () => {
    expect(resolveArtDirection({ idea_id: 'x', art_direction: 'poster' }, 'kinetic').name).toBe(
      'poster',
    );
  });

  it('a pinned ART_DIRECTION setting is used when no explicit style', () => {
    expect(resolveArtDirection({ idea_id: 'x' }, 'blueprint').name).toBe('blueprint');
  });

  it('auto/blank/unknown falls back to a deterministic per-idea pick', () => {
    const a = resolveArtDirection({ idea_id: 'idea-42' }, 'auto').name;
    const b = resolveArtDirection({ idea_id: 'idea-42' }, 'auto').name;
    expect(a).toBe(b); // stable per idea
    expect(ART_DIRECTIONS).toContain(a);
    // unknown setting is treated as auto, not an error
    expect(ART_DIRECTIONS).toContain(resolveArtDirection({ idea_id: 'z' }, 'nonsense').name);
  });
});

describe('embedded fonts', () => {
  it('emits @font-face blocks and the display/serif/mono vars', () => {
    const css = fontFaceCss();
    expect(css).toContain('@font-face');
    expect(css).toContain('data:font/woff2;base64,');
    expect(css).toContain('--font-display');
    expect(css).toContain('--font-serif');
    expect(css).toContain('--font-mono');
  });
});

describe('buildSlideHtml with an art direction', () => {
  it('adds the ad-<name> class and embeds fonts', () => {
    const ad = artDirection('spotlight');
    const html = buildSlideHtml(cover, 1, 6, brand, '', undefined, false, ad);
    expect(html).toContain('ad-spotlight');
    expect(html).toContain('@font-face');
    expect(html).not.toContain('motion');
  });

  it('injects shared keyframes + the art motion only when animated', () => {
    const ad = artDirection('kinetic');
    const animated = buildSlideHtml(cover, 1, 6, brand, '', undefined, true, ad);
    expect(animated).toContain('ad-kinetic motion');
    expect(animated).toContain('@keyframes bg-shimmer');
    expect(MOTION_KEYFRAMES).toContain('ad-sweep');
  });
});
