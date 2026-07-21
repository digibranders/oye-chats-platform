/**
 * Analytics — typed views over the legacy analytics endpoints.
 *
 * Several legacy endpoints are declared as `Promise<Record<string, unknown>>`
 * (their server shape varies by widget/plan). This module narrows those loose
 * records into strict, workspace-level view models the UI can trust — no `any`,
 * every field defaulted, so a missing key never crashes a card.
 */
import { type ActivityPoint } from '../../types/domain';

/** Coerce an unknown value into a finite number, defaulting to 0. */
function toNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** Read a numeric field from a loose record, tolerating missing keys. */
function readNumber(record: Record<string, unknown>, ...keys: string[]): number {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return 0;
}

/** Headline workspace totals, from `getDashboardStats` (all agents). */
export interface WorkspaceTotals {
  totalConversations: number;
  totalMessages: number;
  activeVisitors: number;
  /**
   * Percentage 0–100. Share of rated AI answers that got a thumbs-up — the
   * backend `success_rate` is `positive_feedback / total_feedback`, i.e. a
   * message-level positivity ratio, NOT a share of conversations resolved.
   */
  positiveFeedbackRate: number;
}

export function parseWorkspaceTotals(record: Record<string, unknown>): WorkspaceTotals {
  return {
    totalConversations: readNumber(record, 'total_conversations'),
    totalMessages: readNumber(record, 'total_messages'),
    activeVisitors: readNumber(record, 'active_users'),
    positiveFeedbackRate: readNumber(record, 'success_rate'),
  };
}

/** Star-rating breakdown, from `getRatingsSummary`. */
export interface RatingsSummary {
  /** Mean rating 0–5. */
  average: number;
  /** Total number of ratings received. */
  total: number;
  /** Count per star, keyed 1–5. */
  distribution: Record<1 | 2 | 3 | 4 | 5, number>;
}

export function parseRatingsSummary(record: Record<string, unknown>): RatingsSummary {
  const rawDistribution =
    typeof record.distribution === 'object' && record.distribution !== null
      ? (record.distribution as Record<string, unknown>)
      : {};
  const distribution = {
    1: toNumber(rawDistribution['1']),
    2: toNumber(rawDistribution['2']),
    3: toNumber(rawDistribution['3']),
    4: toNumber(rawDistribution['4']),
    5: toNumber(rawDistribution['5']),
  } as Record<1 | 2 | 3 | 4 | 5, number>;
  return {
    average: readNumber(record, 'avg'),
    total: readNumber(record, 'total'),
    distribution,
  };
}

/** Lead qualification funnel, from `getLeadStats`. */
export interface LeadFunnelStats {
  total: number;
  /** Marketing-qualified leads. */
  mql: number;
  /** Sales-accepted leads. */
  sal: number;
  /** Sales-qualified (fully qualified) leads. */
  sql: number;
  /** Not yet qualified. */
  unqualified: number;
}

export function parseLeadFunnelStats(record: Record<string, unknown>): LeadFunnelStats {
  return {
    total: readNumber(record, 'total'),
    // Canonical keys first, legacy warm/hot/qualified aliases as fallback.
    mql: readNumber(record, 'mql', 'warm'),
    sal: readNumber(record, 'sal', 'hot'),
    sql: readNumber(record, 'sql', 'qualified'),
    unqualified: readNumber(record, 'unqualified', 'cold'),
  };
}

// ── Message-activity time series ─────────────────────────────────────────────

/** A single day on the workspace message-volume trend. */
export interface TrendPoint {
  /** ISO date key, `YYYY-MM-DD`. */
  date: string;
  /** Short display label, e.g. "Jul 4". */
  label: string;
  messages: number;
}

function toLocalKey(d: Date): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Turn raw activity points into a gap-free daily series from the earliest
 * recorded day through today, so the chart never shows misleading holes.
 * Days with no traffic render as explicit zeros.
 */
export function buildTrendSeries(activity: ActivityPoint[]): TrendPoint[] {
  const byDay = new Map<string, number>();
  for (const point of activity) {
    const key = point.date.slice(0, 10);
    byDay.set(key, (byDay.get(key) ?? 0) + toNumber(point.messages));
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  let start = new Date(today);
  if (activity.length > 0) {
    const earliest = activity.reduce<Date | null>((acc, point) => {
      const [y, mo, dy] = point.date.slice(0, 10).split('-').map(Number);
      if (!y || !mo || !dy) return acc;
      const candidate = new Date(y, mo - 1, dy);
      return acc === null || candidate < acc ? candidate : acc;
    }, null);
    if (earliest) start = earliest;
    else start.setDate(today.getDate() - 6);
  } else {
    start.setDate(today.getDate() - 6);
  }

  const series: TrendPoint[] = [];
  const cursor = new Date(start);
  while (cursor <= today) {
    const key = toLocalKey(cursor);
    series.push({
      date: key,
      label: cursor.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      messages: byDay.get(key) ?? 0,
    });
    cursor.setDate(cursor.getDate() + 1);
  }
  return series;
}

/** Selectable trend windows. `all` keeps the full series. */
export type TrendRange = '7d' | '30d' | '90d' | 'all';

export const TREND_RANGES: ReadonlyArray<{ id: TrendRange; label: string }> = [
  { id: '7d', label: '7 days' },
  { id: '30d', label: '30 days' },
  { id: '90d', label: '90 days' },
  { id: 'all', label: 'All time' },
];

/** Slice a full daily series down to the trailing window `range` selects. */
export function sliceTrend(series: TrendPoint[], range: TrendRange): TrendPoint[] {
  if (range === 'all') return series;
  const days = range === '7d' ? 7 : range === '30d' ? 30 : 90;
  return series.slice(-days);
}

/** Derived summary of a trend window: volume totals for the selected range. */
export interface TrendSummary {
  total: number;
  dailyAverage: number;
  peak: number;
  peakLabel: string;
}

export function summarizeTrend(points: TrendPoint[]): TrendSummary {
  if (points.length === 0) {
    return { total: 0, dailyAverage: 0, peak: 0, peakLabel: '—' };
  }

  let total = 0;
  let peak = 0;
  let peakLabel = '—';
  for (const point of points) {
    total += point.messages;
    if (point.messages > peak) {
      peak = point.messages;
      peakLabel = point.label;
    }
  }

  return {
    total,
    dailyAverage: Math.round(total / points.length),
    peak,
    peakLabel,
  };
}

/** Number of days each side of the week-over-week momentum comparison. */
export const MOMENTUM_WINDOW_DAYS = 7;

/**
 * Well-defined momentum figure: the trailing 7 days vs the 7 days before them,
 * computed from the full daily series regardless of the range the user is
 * viewing. Returns `null` unless there are two full, non-empty prior weeks, so
 * the headline delta is always a comparable period-over-period number (never an
 * arbitrary split of the whole history).
 */
export function weekOverWeekChange(series: TrendPoint[]): number | null {
  const span = MOMENTUM_WINDOW_DAYS * 2;
  if (series.length < span) return null;

  const window = series.slice(-span);
  const prior = window
    .slice(0, MOMENTUM_WINDOW_DAYS)
    .reduce((sum, p) => sum + p.messages, 0);
  const recent = window
    .slice(MOMENTUM_WINDOW_DAYS)
    .reduce((sum, p) => sum + p.messages, 0);

  if (prior === 0) return null;
  return Math.round(((recent - prior) / prior) * 100);
}
