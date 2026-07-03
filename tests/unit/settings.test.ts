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

  it('parseSheetBoolean handles common truthy/falsey forms', () => {
    expect(parseSheetBoolean('TRUE')).toBe(true);
    expect(parseSheetBoolean('yes')).toBe(true);
    expect(parseSheetBoolean('1')).toBe(true);
    expect(parseSheetBoolean('false')).toBe(false);
    expect(parseSheetBoolean('')).toBe(false);
    expect(parseSheetBoolean(undefined)).toBe(false);
  });
});
