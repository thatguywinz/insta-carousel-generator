import { describe, it, expect } from 'vitest';
import { parseSettings, parseSheetBoolean } from '../../schemas/settings.js';

describe('settings parsing', () => {
  it('defaults MODE to TEST when missing', () => {
    expect(parseSettings({}).MODE).toBe('TEST');
  });

  it('defaults MODE to TEST when malformed/unknown', () => {
    expect(parseSettings({ MODE: 'PRODUCTION' }).MODE).toBe('TEST');
    expect(parseSettings({ MODE: 'live ' }).MODE).toBe('LIVE');
    expect(parseSettings({ MODE: 'TEST' }).MODE).toBe('TEST');
  });

  it('coerces numeric settings with fallbacks', () => {
    const s = parseSettings({ LOOKBACK_DAYS: '14', MIN_SLIDES: '5', MAX_SLIDES: '9' });
    expect(s.LOOKBACK_DAYS).toBe(14);
    expect(s.MIN_SLIDES).toBe(5);
    expect(s.MAX_SLIDES).toBe(9);
  });

  it('falls back on non-numeric values', () => {
    const s = parseSettings({ LOOKBACK_DAYS: 'abc' });
    expect(s.LOOKBACK_DAYS).toBe(30);
  });

  it('guards inverted slide bounds', () => {
    const s = parseSettings({ MIN_SLIDES: '9', MAX_SLIDES: '6' });
    expect(s.MIN_SLIDES).toBeLessThanOrEqual(s.MAX_SLIDES);
  });

  it('parses booleans, defaulting the publish/generate flags to true when absent', () => {
    const s = parseSettings({});
    expect(s.PUBLISH_EXISTING_DRAFT_FIRST).toBe(true);
    expect(s.AUTO_GENERATE_WHEN_EMPTY).toBe(true);
  });

  it('respects explicit false flags', () => {
    const s = parseSettings({
      PUBLISH_EXISTING_DRAFT_FIRST: 'FALSE',
      AUTO_GENERATE_WHEN_EMPTY: 'no',
    });
    expect(s.PUBLISH_EXISTING_DRAFT_FIRST).toBe(false);
    expect(s.AUTO_GENERATE_WHEN_EMPTY).toBe(false);
  });

  it('defaults ART_DIRECTION to auto and lowercases a pinned style', () => {
    expect(parseSettings({}).ART_DIRECTION).toBe('auto');
    expect(parseSettings({ ART_DIRECTION: '  Spotlight ' }).ART_DIRECTION).toBe('spotlight');
    expect(parseSettings({ ART_DIRECTION: '' }).ART_DIRECTION).toBe('auto');
  });

  it('defaults MOTION_SLIDES to cover+key', () => {
    expect(parseSettings({}).MOTION_SLIDES).toBe('cover+key');
  });

  it('parseSheetBoolean handles common truthy/falsey forms', () => {
    expect(parseSheetBoolean('TRUE')).toBe(true);
    expect(parseSheetBoolean('yes')).toBe(true);
    expect(parseSheetBoolean('1')).toBe(true);
    expect(parseSheetBoolean('false')).toBe(false);
    expect(parseSheetBoolean('')).toBe(false);
    expect(parseSheetBoolean(undefined)).toBe(false);
  });

  it('treats an EMPTY boolean cell as missing (documented default true)', () => {
    const s = parseSettings({ PUBLISH_EXISTING_DRAFT_FIRST: '', AUTO_GENERATE_WHEN_EMPTY: '  ' });
    expect(s.PUBLISH_EXISTING_DRAFT_FIRST).toBe(true);
    expect(s.AUTO_GENERATE_WHEN_EMPTY).toBe(true);
  });

  it('falls back to the default and WARNS when a boolean cell contains pasted text', () => {
    const warnings: string[] = [];
    const s = parseSettings(
      { AUTO_GENERATE_WHEN_EMPTY: 'Also attached are the screenshots of the area' },
      (m) => warnings.push(m),
    );
    expect(s.AUTO_GENERATE_WHEN_EMPTY).toBe(true);
    expect(warnings.some((w) => w.includes('AUTO_GENERATE_WHEN_EMPTY'))).toBe(true);
  });

  it('warns when a numeric cell contains pasted text', () => {
    const warnings: string[] = [];
    const s = parseSettings({ MAX_SLIDES: 'could you make it scroll down like a video' }, (m) =>
      warnings.push(m),
    );
    expect(s.MAX_SLIDES).toBe(8);
    expect(warnings.some((w) => w.includes('MAX_SLIDES'))).toBe(true);
  });

  it('rejects an overlong DEFAULT_CTA (pasted text) with a warning', () => {
    const warnings: string[] = [];
    const pasted = 'x'.repeat(300);
    const s = parseSettings({ DEFAULT_CTA: pasted }, (m) => warnings.push(m));
    expect(s.DEFAULT_CTA).toBe('');
    expect(warnings.some((w) => w.includes('DEFAULT_CTA'))).toBe(true);
  });

  it('keeps a normal short DEFAULT_CTA untouched', () => {
    const cta = 'Every new AI tool, broken down. Follow @realestgarg for the next one.';
    expect(parseSettings({ DEFAULT_CTA: cta }).DEFAULT_CTA).toBe(cta);
  });

  it('warns on an unknown MODE while defaulting to TEST', () => {
    const warnings: string[] = [];
    const s = parseSettings({ MODE: 'PRODUCTION' }, (m) => warnings.push(m));
    expect(s.MODE).toBe('TEST');
    expect(warnings.some((w) => w.includes('MODE'))).toBe(true);
  });
});
