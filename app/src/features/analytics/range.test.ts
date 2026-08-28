import { describe, expect, it } from 'vitest';
import { DEFAULT_RANGE, delta, parseRange, resolveRange } from './range';

/**
 * The range is the whole point of the rebuilt surface, so the two things that
 * can silently corrupt every figure on it are pinned here: what an unknown URL
 * value falls back to, and when a comparison is allowed to exist at all.
 */

describe('parseRange', () => {
  it('accepts every option the control offers', () => {
    expect(parseRange('7d')).toBe('7d');
    expect(parseRange('30d')).toBe('30d');
    expect(parseRange('90d')).toBe('90d');
    expect(parseRange('all')).toBe('all');
  });

  it('falls back to the default for anything else', () => {
    // A hand-edited or stale URL must not produce a window no endpoint accepts.
    expect(parseRange('14d')).toBe(DEFAULT_RANGE);
    expect(parseRange(null)).toBe(DEFAULT_RANGE);
    expect(parseRange('')).toBe(DEFAULT_RANGE);
  });

  it('defaults to a window that has something before it', () => {
    // "All time" cannot be compared with anything, so it is not the default.
    expect(DEFAULT_RANGE).not.toBe('all');
    expect(resolveRange(DEFAULT_RANGE).comparisonLabel).not.toBeNull();
  });
});

describe('resolveRange', () => {
  const now = new Date('2026-08-19T12:00:00Z');

  it('asks for twice the window so the previous one can be subtracted', () => {
    expect(resolveRange('30d', now).extendedDays).toBe(60);
    expect(resolveRange('7d', now).days).toBe(7);
  });

  it('sends no day filter, and offers no comparison, for all time', () => {
    const range = resolveRange('all', now);
    expect(range.days).toBeNull();
    expect(range.since).toBeNull();
    expect(range.extendedDays).toBeNull();
    expect(range.comparisonLabel).toBeNull();
  });

  it('starts the window a whole number of days back', () => {
    const range = resolveRange('7d', now);
    expect(range.since?.toISOString()).toBe('2026-08-12T12:00:00.000Z');
  });
});

describe('delta', () => {
  it('reports a signed percentage against the previous window', () => {
    expect(delta(120, 100)).toEqual({ value: '+20%', direction: 'up', percent: 20 });
    expect(delta(80, 100)).toEqual({ value: '-20%', direction: 'down', percent: -20 });
  });

  it('calls a flat period flat rather than +0%', () => {
    expect(delta(100, 100)).toEqual({ value: 'No change', direction: 'flat', percent: 0 });
  });

  it('refuses to invent a change where there is nothing to compare with', () => {
    // A percentage change from zero is not a percentage, and an absent previous
    // window is not a zero one. Both render as no delta at all, which is what
    // the old fixed seven-day figure on an all-time total got wrong.
    expect(delta(50, 0)).toBeNull();
    expect(delta(50, null)).toBeNull();
    expect(delta(50, undefined)).toBeNull();
  });
});
