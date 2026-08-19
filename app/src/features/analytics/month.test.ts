import { describe, expect, it } from 'vitest';
import { MONTH_OPTION_COUNT, currentMonth, monthLabel, monthOptions, parseMonth } from './month';

/**
 * The month picker the previous hook documented — "the picker in the tab lets
 * the owner scroll back through the last 12 months" — was never built, so the
 * journey view was pinned to the current calendar month and showed almost
 * nothing on the 1st of it. This is the model behind the one that now exists.
 *
 * Every value it produces has to be one the backend accepts: `YYYY-MM`, not
 * before 2020, and never in the future, because anything else is a 422 rendered
 * as a broken panel.
 */

const NOW = new Date(2026, 7, 19); // August 2026.

describe('parseMonth', () => {
  it('accepts a well-formed month at or before the current one', () => {
    expect(parseMonth('2026-07', NOW)).toBe('2026-07');
    expect(parseMonth('2026-08', NOW)).toBe('2026-08');
  });

  it('rejects a future month, which the API refuses outright', () => {
    expect(parseMonth('2026-09', NOW)).toBe('2026-08');
    expect(parseMonth('2027-01', NOW)).toBe('2026-08');
  });

  it('rejects anything before the backend floor', () => {
    expect(parseMonth('2019-12', NOW)).toBe('2026-08');
  });

  it('rejects malformed values instead of forwarding them to the API', () => {
    expect(parseMonth('2026-13', NOW)).toBe('2026-08');
    expect(parseMonth('august', NOW)).toBe('2026-08');
    expect(parseMonth(null, NOW)).toBe(currentMonth(NOW));
  });
});

describe('monthOptions', () => {
  it('offers the twelve months the hook always claimed', () => {
    const options = monthOptions(NOW);
    expect(options).toHaveLength(MONTH_OPTION_COUNT);
    expect(options[0].value).toBe('2026-08');
    expect(options[MONTH_OPTION_COUNT - 1].value).toBe('2025-09');
  });

  it('crosses the year boundary correctly', () => {
    expect(monthOptions(new Date(2026, 0, 15), 3).map((option) => option.value)).toEqual([
      '2026-01',
      '2025-12',
      '2025-11',
    ]);
  });

  it('names each month in full, so a picker is never a row of numbers', () => {
    expect(monthLabel('2026-08')).toBe('August 2026');
  });
});
