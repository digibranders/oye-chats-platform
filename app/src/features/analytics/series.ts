import type { ActivityPoint } from '../../types/domain';

/**
 * The daily message series, and the two windows every comparison on this page
 * is made of.
 *
 * `/analytics/activity` returns one row per day, and is asked for twice the
 * selected window so both of them fit in one request. The splitting is done
 * here, once. That is why the comparison is honest: the current window and the
 * one before it are cut from the same series with the same rule, rather than
 * being two figures from two endpoints with two definitions.
 *
 * The day buckets are cut server-side in the zone `getActivityStats` sends —
 * the reader's own — which is what makes reading each `date` key as a local
 * date below correct rather than a five-and-a-half-hour lie in Kolkata.
 */

/** One day on the message-volume series. */
export interface DailyPoint {
  /** `YYYY-MM-DD`, in the reader's own timezone. */
  date: string;
  /** Short display label, e.g. `4 Jul`. */
  label: string;
  messages: number;
}

function toNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function toLocalKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function toLabel(date: Date): string {
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

/**
 * A gap-free daily series from the first recorded day through today.
 *
 * Days with no traffic are explicit zeros. A series with holes in it draws a
 * line that skips straight from Monday to Thursday, which reads as three days
 * of steady volume rather than as two days of silence.
 */
export function buildDailySeries(
  activity: readonly ActivityPoint[] | null | undefined,
  now: Date = new Date(),
): DailyPoint[] {
  const byDay = new Map<string, number>();
  for (const point of activity ?? []) {
    const key = String(point.date).slice(0, 10);
    if (key.length !== 10) continue;
    byDay.set(key, (byDay.get(key) ?? 0) + toNumber(point.messages));
  }

  const today = new Date(now);
  today.setHours(0, 0, 0, 0);

  let start = new Date(today);
  start.setDate(today.getDate() - 6);
  for (const key of byDay.keys()) {
    const [year, month, day] = key.split('-').map(Number);
    if (!year || !month || !day) continue;
    const candidate = new Date(year, month - 1, day);
    if (candidate < start) start = candidate;
  }

  const series: DailyPoint[] = [];
  const cursor = new Date(start);
  while (cursor <= today) {
    const key = toLocalKey(cursor);
    series.push({ date: key, label: toLabel(cursor), messages: byDay.get(key) ?? 0 });
    cursor.setDate(cursor.getDate() + 1);
  }
  return series;
}

export interface SeriesWindows {
  /**
   * The days the selected range covers.
   *
   * Named `selected` rather than `current` on purpose: React Compiler treats a
   * `.current` property access as a ref read and refuses to optimise any
   * component that memoises on it.
   */
  selected: DailyPoint[];
  /** The same number of days immediately before it. Empty when there is none. */
  preceding: DailyPoint[];
}

/** Cut the current window and the one before it. `null` days means all of it. */
export function splitWindows(series: readonly DailyPoint[], days: number | null): SeriesWindows {
  if (days === null) return { selected: [...series], preceding: [] };
  const start = Math.max(0, series.length - days);
  return {
    selected: series.slice(start),
    preceding: series.slice(Math.max(0, start - days), start),
  };
}

export interface SeriesSummary {
  total: number;
  dailyAverage: number;
  peak: number;
  /** The day the peak fell on, or `null` when nothing was sent at all. */
  peakLabel: string | null;
}

export function summarize(points: readonly DailyPoint[]): SeriesSummary {
  if (points.length === 0) return { total: 0, dailyAverage: 0, peak: 0, peakLabel: null };
  let total = 0;
  let peak = 0;
  let peakLabel: string | null = null;
  for (const point of points) {
    total += point.messages;
    if (point.messages > peak) {
      peak = point.messages;
      peakLabel = point.label;
    }
  }
  return { total, dailyAverage: Math.round(total / points.length), peak, peakLabel };
}

/** One plotted day: this window's figure, and the same day of the last one. */
export interface ComparisonPoint {
  label: string;
  date: string;
  messages: number;
  /** The matching day of the previous window, or `null` where there is none. */
  previous: number | null;
  previousLabel: string | null;
}

/**
 * Align the two windows day-for-day, counting from the start of each.
 *
 * Where the previous window is short — an account younger than two windows —
 * the missing days are its oldest, so the alignment is anchored on the end of
 * each window and the unmatched days carry `null` rather than a zero. A zero
 * would claim a quiet day that never happened.
 */
export function comparisonPoints(windows: SeriesWindows): ComparisonPoint[] {
  const { selected, preceding } = windows;
  const offset = selected.length - preceding.length;
  return selected.map((point, index) => {
    const match = preceding[index - offset];
    return {
      label: point.label,
      date: point.date,
      messages: point.messages,
      previous: match ? match.messages : null,
      previousLabel: match ? match.label : null,
    };
  });
}
