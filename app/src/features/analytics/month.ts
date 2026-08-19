/**
 * The journey month.
 *
 * Every journey endpoint takes a calendar month (`YYYY-MM`) and nothing else,
 * so this is the one place on the page that does not speak in trailing windows.
 * The hook it replaces documented a picker — "the picker in the tab lets the
 * owner scroll back through the last 12 months" — that was never built:
 * `period` and `setPeriod` were exposed and no component ever called
 * `setPeriod`, so the tab was pinned to the current calendar month and showed
 * almost nothing on the 1st of it.
 */

/** The backend rejects anything before this, and anything in the future. */
const MIN_YEAR = 2020;

/** How far back the picker offers. Twelve months, as the hook always claimed. */
export const MONTH_OPTION_COUNT = 12;

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

export function toMonthKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

export function currentMonth(now: Date = new Date()): string {
  return toMonthKey(now);
}

/** A readable month, e.g. `August 2026`. */
export function monthLabel(month: string): string {
  const [year, index] = month.split('-').map(Number);
  if (!year || !index) return month;
  return new Date(year, index - 1, 1).toLocaleDateString('en-GB', {
    month: 'long',
    year: 'numeric',
  });
}

/**
 * Narrow an arbitrary URL value to a month the API will accept.
 *
 * Anything malformed, older than the backend's floor, or in the future falls
 * back to the current month — a 422 is not a useful thing to render.
 */
export function parseMonth(raw: string | null | undefined, now: Date = new Date()): string {
  const fallback = currentMonth(now);
  if (!raw || !MONTH_PATTERN.test(raw)) return fallback;
  const [year, index] = raw.split('-').map(Number);
  if (year < MIN_YEAR) return fallback;
  if (year > now.getFullYear() || (year === now.getFullYear() && index > now.getMonth() + 1)) {
    return fallback;
  }
  return raw;
}

/** The last twelve months, newest first, for the picker. */
export function monthOptions(
  now: Date = new Date(),
  count: number = MONTH_OPTION_COUNT,
): { value: string; label: string }[] {
  const options: { value: string; label: string }[] = [];
  for (let offset = 0; offset < count; offset += 1) {
    const date = new Date(now.getFullYear(), now.getMonth() - offset, 1);
    if (date.getFullYear() < MIN_YEAR) break;
    const value = toMonthKey(date);
    options.push({ value, label: monthLabel(value) });
  }
  return options;
}
