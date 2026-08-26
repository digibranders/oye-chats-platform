import { describe, expect, it } from 'vitest';

/**
 * The one formatter that does NOT follow the chosen language, and why.
 *
 * Everything else here moved onto the dashboard's locale so figures stop
 * following the browser. `formatCompact` deliberately did not: `en-IN`'s
 * compact scale swaps the UNIT, not the digits — 2,500,000 becomes "25L" — and
 * that abbreviation is labelling conversation and message counts on chart axes
 * and stat tiles, where it has a few characters to be understood in. Grouping
 * carries the locale; the abbreviation stays on a scale every reader parses.
 */
import { formatCompact, formatNumber } from './formatters';
describe('compact', () => {
  it('stays on the K/M scale while grouping follows the locale', () => {
    expect(formatCompact(150_000)).toBe('150K');
    expect(formatCompact(2_500_000)).toBe('2.5M');
    expect(formatNumber(149_900)).toBe('1,49,900');
  });
});
