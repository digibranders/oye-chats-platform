import { describe, expect, it } from 'vitest';

import { dayKey, formatDayLabel, isNewDay } from './messageDay';

// Fixed "now" so Today/Yesterday are deterministic.
const NOW = new Date('2026-08-18T10:00:00');

describe('dayKey', () => {
  it('returns a stable local-day key', () => {
    expect(dayKey('2026-08-18T09:00:00')).toBe(dayKey('2026-08-18T23:59:00'));
    expect(dayKey('2026-08-18T09:00:00')).not.toBe(dayKey('2026-08-19T00:01:00'));
  });

  it('returns null for missing/unparseable input', () => {
    expect(dayKey(null)).toBeNull();
    expect(dayKey('not a date')).toBeNull();
  });
});

describe('formatDayLabel', () => {
  it('labels today and yesterday', () => {
    expect(formatDayLabel('2026-08-18T08:00:00', NOW)).toBe('Today');
    expect(formatDayLabel('2026-08-17T22:00:00', NOW)).toBe('Yesterday');
  });

  it('uses an absolute date for older days', () => {
    expect(formatDayLabel('2026-08-14T12:00:00', NOW)).toBe('Aug 14');
  });

  it('includes the year for a prior year', () => {
    expect(formatDayLabel('2025-08-14T12:00:00', NOW)).toBe('Aug 14, 2025');
  });

  it('is empty for missing input', () => {
    expect(formatDayLabel(null, NOW)).toBe('');
  });
});

describe('isNewDay', () => {
  it('true on the first message with a valid timestamp', () => {
    expect(isNewDay('2026-08-18T08:00:00', undefined)).toBe(true);
  });

  it('false when same day as the previous message', () => {
    expect(isNewDay('2026-08-18T14:00:00', '2026-08-18T09:00:00')).toBe(false);
  });

  it('true when the day rolls over', () => {
    expect(isNewDay('2026-08-19T00:05:00', '2026-08-18T23:55:00')).toBe(true);
  });

  it('false for a message with no timestamp (e.g. system row)', () => {
    expect(isNewDay(null, '2026-08-18T09:00:00')).toBe(false);
  });
});
