/**
 * The one reporting window this surface has.
 *
 * The page it replaces ran three independent time vocabularies at once — a
 * message-volume range (7d/30d/90d/All), a funnel period control that lived
 * inside the funnel card, and a journey month nobody could change — so two
 * cards side by side could describe different weeks with nothing saying so. And
 * none of them ever reached the API: `/analytics/dashboard` and
 * `/analytics/unanswered-questions` have always accepted `?days=` and the
 * product never passed it, which meant every figure in Analytics was all-time
 * no matter what the control said.
 *
 * So: one range, in the URL, resolved here, passed to every query on the page.
 * The keys are exactly the vocabulary `/analytics/qualification-funnel` already
 * speaks (`7d|30d|90d|all`), so the funnel takes the selection unmodified.
 *
 * Journey is the documented exception: its endpoints take a calendar month
 * (`YYYY-MM`) and nothing else, so that tab swaps this control for a month
 * picker rather than pretending a 90-day window is a month.
 */

export type RangeKey = '7d' | '30d' | '90d' | 'all';

export const RANGE_OPTIONS: readonly { value: RangeKey; label: string }[] = [
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: '90d', label: '90 days' },
  { value: 'all', label: 'All time' },
];

/**
 * Thirty days, not all time.
 *
 * A default of "all time" is what let the previous page open on a number that
 * cannot move and cannot be compared with anything. The point of this surface
 * is the comparison, so it opens on a window that has a previous one.
 */
export const DEFAULT_RANGE: RangeKey = '30d';

const TRAILING_DAYS: Record<RangeKey, number | null> = {
  '7d': 7,
  '30d': 30,
  '90d': 90,
  all: null,
};

const RANGE_LABEL: Record<RangeKey, string> = {
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  '90d': 'Last 90 days',
  all: 'All time',
};

const COMPARISON_LABEL: Record<RangeKey, string | null> = {
  '7d': 'the previous 7 days',
  '30d': 'the previous 30 days',
  '90d': 'the previous 90 days',
  // All of history has nothing before it. Rendering a delta here would be
  // inventing one, which is precisely what the old page did: a fixed
  // 7-day-versus-prior-7-day figure glued to a card whose value followed the
  // range, so "All time" showed an all-time total with a one-week delta on it.
  all: null,
};

export interface ResolvedRange {
  key: RangeKey;
  /** For a stat tile's period line: "Last 30 days". */
  label: string;
  /** Trailing days for `?days=`. `null` means send no filter at all. */
  days: number | null;
  /** Start of the window, or `null` when the window is all of history. */
  since: Date | null;
  /** Names the comparison in a sentence, or `null` when there is none. */
  comparisonLabel: string | null;
  /**
   * Twice the window, so the previous window can be had by subtraction.
   *
   * `/analytics/dashboard` counts sessions created after `now - days`, so
   * `total(2n) - total(n)` is exactly the window before this one. Both requests
   * use the same clock on the same server, so there is no boundary to get
   * wrong. `null` when the range has no previous window.
   */
  extendedDays: number | null;
}

export function parseRange(raw: string | null | undefined): RangeKey {
  return RANGE_OPTIONS.some((option) => option.value === raw) ? (raw as RangeKey) : DEFAULT_RANGE;
}

export function resolveRange(key: RangeKey, now: Date = new Date()): ResolvedRange {
  const days = TRAILING_DAYS[key];
  return {
    key,
    label: RANGE_LABEL[key],
    days,
    since: days === null ? null : new Date(now.getTime() - days * 86_400_000),
    comparisonLabel: COMPARISON_LABEL[key],
    extendedDays: days === null ? null : days * 2,
  };
}

export type TrendDirection = 'up' | 'down' | 'flat';

export interface Delta {
  /** Pre-formatted for display, e.g. `+18%`. */
  value: string;
  direction: TrendDirection;
  /** The signed percentage, rounded. Kept for insight thresholds. */
  percent: number;
}

/**
 * Period-over-period change, or nothing.
 *
 * `null` rather than a fabricated figure whenever the comparison would be
 * meaningless: an absent previous window, or a previous window of zero (a
 * percentage change from nothing is not a percentage). A tile with no delta
 * still states its period, so the reader is never left guessing what they are
 * looking at.
 */
export function delta(current: number, previous: number | null | undefined): Delta | null {
  if (previous == null || !Number.isFinite(previous) || previous === 0) return null;
  if (!Number.isFinite(current)) return null;
  const percent = Math.round(((current - previous) / previous) * 100);
  if (percent === 0) return { value: 'No change', direction: 'flat', percent: 0 };
  return {
    value: `${percent > 0 ? '+' : ''}${percent}%`,
    direction: percent > 0 ? 'up' : 'down',
    percent,
  };
}
