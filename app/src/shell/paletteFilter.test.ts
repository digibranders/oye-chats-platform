import { describe, expect, it } from 'vitest';
import { makePaletteFilter } from './paletteFilter';

/**
 * Stands in for Base UI's real `contains`: case-insensitive, single
 * substring — close enough to its actual `Intl.Collator` behaviour to test
 * word-splitting in isolation from React and from Base UI itself.
 */
function stubContains(item: string, query: string): boolean {
  return item.toLowerCase().includes(query.toLowerCase());
}

describe('makePaletteFilter', () => {
  const filter = makePaletteFilter(stubContains);

  it('matches every word regardless of order', () => {
    expect(filter('Business Hours', 'hours business', undefined)).toBe(true);
  });

  it('still matches a plain substring, unchanged from before', () => {
    expect(filter('Business Hours', 'business hour', undefined)).toBe(true);
  });

  it('fails when one word is entirely absent', () => {
    expect(filter('Business Hours', 'business pricing', undefined)).toBe(false);
  });

  it('matches everything on an empty query', () => {
    expect(filter('Business Hours', '', undefined)).toBe(true);
    expect(filter('Business Hours', '   ', undefined)).toBe(true);
  });

  it('collapses repeated whitespace between words', () => {
    expect(filter('Business Hours', 'business    hours', undefined)).toBe(true);
  });

  it('does not forgive a typo — no fuzzy matching, by design', () => {
    expect(filter('Business Hours', 'buisness hours', undefined)).toBe(false);
  });
});
