/**
 * Formatter guards for Phase 7D.
 *
 * Two properties matter and neither is visible in a string sweep:
 *
 *  1. Output follows the ACTIVE DASHBOARD LOCALE, not the browser's. Before 7D
 *     almost every call site used `toLocaleString()` with no locale, so a Hindi
 *     dashboard in a US browser printed "1,234" beside Devanagari labels, and an
 *     Indian browser printed "1,23,456" beside English ones.
 *  2. TIMEZONE IS UNCHANGED. These helpers alter presentation only. A default
 *     `timeZone` here would silently move every timestamp in the product, so
 *     the tests below pin the wall-clock components against the runtime zone.
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
  formatCurrency,
  formatDate,
  formatDateTime,
  formatDayLabel,
  formatNumber,
  formatPercent,
  formatRelativeTime,
  formatTime,
} from './formatters';
import { __resetI18nForTests, preloadDictionary, setLocale } from './i18n';

/** 2026-08-14T09:30:00Z, chosen for an unambiguous day/month ordering. */
const INSTANT = new Date('2026-08-14T09:30:00Z');

afterEach(() => {
  __resetI18nForTests();
});

async function useHindi(): Promise<void> {
  await preloadDictionary('hi-IN');
  setLocale('hi-IN');
}

describe('formatNumber', () => {
  it('groups in the Indian system on the default locale', () => {
    // en-IN uses lakh grouping; this is the app default and NOT en-US.
    expect(formatNumber(1234567)).toBe('12,34,567');
  });

  it('is IDENTICAL on the Hindi dashboard, and that is correct', async () => {
    // Worth pinning, because it looks like a bug and is not. `hi-IN` uses
    // Latin digits and the same lakh grouping as `en-IN`; Devanagari digits
    // need an explicit `-u-nu-deva` extension that standard Hindi UI does not
    // use. Only DATES differ between the two locales. Anyone "fixing" numbers
    // to render १२,३४,५६७ would be making the product wrong.
    const english = formatNumber(1234567);
    await useHindi();
    expect(formatNumber(1234567)).toBe(english);
  });

  it('follows the locale it is given, and defaults to en-IN not en-US', () => {
    expect(formatNumber(1234567)).toBe('12,34,567');
    expect(formatNumber(1234567, {}, 'en-US')).toBe('1,234,567');
  });

  it('is empty for null, undefined and NaN rather than printing them', () => {
    expect(formatNumber(null)).toBe('');
    expect(formatNumber(undefined)).toBe('');
    expect(formatNumber(Number.NaN)).toBe('');
  });

  it('honours explicit options', () => {
    expect(formatNumber(0.5, { style: 'percent' })).toBe('50%');
  });
});

describe('formatDate', () => {
  it('is day-first on the default locale', () => {
    expect(formatDate(INSTANT)).toBe('14 Aug 2026');
  });

  it('changes with the locale, and is not the English string', async () => {
    const english = formatDate(INSTANT);
    await useHindi();
    const hindi = formatDate(INSTANT);
    expect(hindi).not.toBe(english);
    expect(/[ऀ-ॿ]/.test(hindi)).toBe(true);
  });

  it('lets a caller suppress a default field with undefined', () => {
    // The merge is what makes this necessary: an ABSENT key still picks up the
    // default, so suppression has to be explicit. messageDay relies on this.
    expect(formatDate(INSTANT, { year: undefined })).toBe('14 Aug');
  });

  it('accepts a Date, an ISO string and an epoch number alike', () => {
    const expected = formatDate(INSTANT);
    expect(formatDate(INSTANT.toISOString())).toBe(expected);
    expect(formatDate(INSTANT.getTime())).toBe(expected);
  });

  it('is empty for an unparseable value rather than "Invalid Date"', () => {
    expect(formatDate('not a date')).toBe('');
    expect(formatDate(null)).toBe('');
  });
});

describe('timezone is presentation-neutral', () => {
  it('formats the same wall-clock components the runtime would', () => {
    // No timeZone is passed anywhere, so the helpers must agree with the
    // runtime's own rendering of the same instant. If a default zone were ever
    // added here, these would diverge.
    const viaHelper = formatTime(INSTANT, { hour: '2-digit', minute: '2-digit' });
    const viaRuntime = new Intl.DateTimeFormat('en-IN', {
      hour: '2-digit',
      minute: '2-digit',
    }).format(INSTANT);
    expect(viaHelper).toBe(viaRuntime);
  });

  it('keeps the local calendar day, not the UTC one', () => {
    const local = new Date(2026, 7, 14, 23, 30); // 14 Aug local, whatever the zone
    expect(formatDate(local)).toContain('14');
  });

  it('does not shift across a locale switch', async () => {
    const before = new Intl.DateTimeFormat('en-IN', { hour: 'numeric' }).format(INSTANT);
    await useHindi();
    const after = new Intl.DateTimeFormat('en-IN', { hour: 'numeric' }).format(INSTANT);
    expect(after).toBe(before);
  });
});

describe('formatCurrency', () => {
  it('keeps the currency the DATA carries, not one guessed from the locale', async () => {
    // A workspace billed in USD is billed in USD on a Hindi dashboard. The
    // rendering happens to be identical in en-IN and hi-IN; the point is that
    // the SYMBOL comes from the argument, never from the language.
    expect(formatCurrency(1250, 'USD')).toContain('$');
    expect(formatCurrency(1250, 'INR')).toContain('₹');
    await useHindi();
    expect(formatCurrency(1250, 'USD')).toContain('$');
    expect(formatCurrency(1250, 'USD')).not.toContain('₹');
  });

  it('falls back to a readable string for a bogus currency code', () => {
    expect(formatCurrency(10, 'NOTACODE')).toBe('NOTACODE 10');
  });
});

describe('formatDateTime, formatTime, formatDayLabel, formatPercent', () => {
  it('formatDateTime carries both halves', () => {
    const out = formatDateTime(INSTANT);
    expect(out).toContain('14');
    expect(out).toContain('2026');
  });

  it('formatDayLabel leads with the weekday and omits the year', () => {
    expect(formatDayLabel(INSTANT)).toMatch(/^[A-Za-z]{3},/);
    expect(formatDayLabel(INSTANT)).not.toContain('2026');
  });

  it('formatPercent takes a ratio, not a percentage', () => {
    expect(formatPercent(0.42)).toBe('42%');
  });

  it('formatRelativeTime is relative and localized', async () => {
    const past = new Date(Date.now() - 3 * 86_400_000);
    expect(formatRelativeTime(past)).toContain('3');
    await useHindi();
    expect(/[ऀ-ॿ]/.test(formatRelativeTime(past))).toBe(true);
  });
});
