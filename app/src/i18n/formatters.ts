/**
 * Locale-aware date and number formatting for the dashboard.
 *
 * Why this is first-class Phase 7 scope rather than a follow-up: the admin has
 * ~180 locale-sensitive call sites and almost none of them pass a locale, so
 * they follow the BROWSER, not the application. Translating the copy without
 * fixing this produces a screen whose text is Hindi and whose dates are in
 * whatever the browser happens to prefer. That mismatch is invisible to any
 * string sweep, which is exactly why it needs its own layer.
 *
 * Every function here defaults to the ACTIVE UI LOCALE, never
 * `navigator.language`.
 *
 * TIMEZONE IS NOT TOUCHED. These change presentation only. Passing no
 * `timeZone` keeps `Intl`'s default (the runtime's zone), which is what the
 * call sites already relied on. Do not add a timezone default here: that would
 * silently move every timestamp in the product.
 */

import { getLocale } from './i18n';

type DateInput = Date | string | number | null | undefined;

function toDate(input: DateInput): Date | null {
  if (input === null || input === undefined || input === '') return null;
  const date = input instanceof Date ? input : new Date(input);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * `Intl` throws a RangeError on a malformed locale tag. A formatting helper
 * must never take a screen down, so every entry point degrades to the runtime
 * default rather than propagating.
 */
function safe<T>(fn: () => T, fallback: () => T): T {
  try {
    return fn();
  } catch {
    return fallback();
  }
}

/** "22 Aug 2026" (en-IN) / "22 अग॰ 2026" (hi-IN). */
export function formatDate(
  input: DateInput,
  options: Intl.DateTimeFormatOptions = {},
  locale: string = getLocale(),
): string {
  const date = toDate(input);
  if (!date) return '';
  const opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', year: 'numeric', ...options };
  return safe(
    () => new Intl.DateTimeFormat(locale, opts).format(date),
    () => date.toLocaleDateString(undefined, opts),
  );
}

/** "4:30 pm" (en-IN) / "4:30 अपराह्न" (hi-IN). */
export function formatTime(
  input: DateInput,
  options: Intl.DateTimeFormatOptions = {},
  locale: string = getLocale(),
): string {
  const date = toDate(input);
  if (!date) return '';
  const opts: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit', ...options };
  return safe(
    () => new Intl.DateTimeFormat(locale, opts).format(date),
    () => date.toLocaleTimeString(undefined, opts),
  );
}

/** Date and time together, for table cells and detail headers. */
export function formatDateTime(
  input: DateInput,
  options: Intl.DateTimeFormatOptions = {},
  locale: string = getLocale(),
): string {
  const date = toDate(input);
  if (!date) return '';
  const opts: Intl.DateTimeFormatOptions = {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    ...options,
  };
  return safe(
    () => new Intl.DateTimeFormat(locale, opts).format(date),
    () => date.toLocaleString(undefined, opts),
  );
}

/** Weekday-led form for conversation day dividers: "Sat, 22 Aug". */
export function formatDayLabel(input: DateInput, locale: string = getLocale()): string {
  return formatDate(input, { weekday: 'short', day: 'numeric', month: 'short', year: undefined }, locale);
}

/** Plain number with locale grouping: 1,234 / १,२३४ depending on locale data. */
export function formatNumber(
  value: number | null | undefined,
  options: Intl.NumberFormatOptions = {},
  locale: string = getLocale(),
): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '';
  return safe(
    () => new Intl.NumberFormat(locale, options).format(value),
    () => String(value),
  );
}

/**
 * Currency. `currency` is a real ISO code carried by the data, never guessed
 * from the UI locale: a workspace billed in INR is billed in INR whatever
 * language the dashboard is being read in.
 */
export function formatCurrency(
  value: number | null | undefined,
  currency: string,
  options: Intl.NumberFormatOptions = {},
  locale: string = getLocale(),
): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '';
  return safe(
    () => new Intl.NumberFormat(locale, { style: 'currency', currency, ...options }).format(value),
    () => `${currency} ${value}`,
  );
}

/** `0.42` -> "42%". Pass an already-divided ratio, not 42. */
export function formatPercent(
  ratio: number | null | undefined,
  options: Intl.NumberFormatOptions = {},
  locale: string = getLocale(),
): string {
  if (ratio === null || ratio === undefined || Number.isNaN(ratio)) return '';
  return safe(
    () => new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0, ...options }).format(ratio),
    () => `${Math.round(ratio * 100)}%`,
  );
}

/** "3 days ago" / "3 दिन पहले". Falls back to an absolute date when unsupported. */
export function formatRelativeTime(input: DateInput, locale: string = getLocale()): string {
  const date = toDate(input);
  if (!date) return '';
  const seconds = Math.round((date.getTime() - Date.now()) / 1000);
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['year', 31_536_000],
    ['month', 2_592_000],
    ['week', 604_800],
    ['day', 86_400],
    ['hour', 3_600],
    ['minute', 60],
  ];
  return safe(
    () => {
      const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
      for (const [unit, secondsPerUnit] of units) {
        if (Math.abs(seconds) >= secondsPerUnit) {
          return rtf.format(Math.round(seconds / secondsPerUnit), unit);
        }
      }
      return rtf.format(seconds, 'second');
    },
    () => formatDate(date, {}, locale),
  );
}
