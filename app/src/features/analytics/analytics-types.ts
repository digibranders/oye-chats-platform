/**
 * Analytics - typed views over the legacy analytics endpoints.
 *
 * Several legacy endpoints are declared as `Promise<Record<string, unknown>>`
 * (their server shape varies by widget/plan). This module narrows those loose
 * records into strict, workspace-level view models the UI can trust - no `any`,
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
   * Percentage 0 to 100. Share of rated AI answers that got a thumbs-up - the
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
  /** Mean rating 0 to 5. */
  average: number;
  /** Total number of ratings received. */
  total: number;
  /** Count per star, keyed 1 to 5. */
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

/** Conversation resolution metrics, from `getResolutionSummary`. */
export interface ResolutionSummary {
  /** Resolution rate 0-100 or null if unavailable. */
  rate: number | null;
  total: number;
}

export function parseResolutionSummary(record: Record<string, unknown>): ResolutionSummary {
  const rawRate = record.rate ?? record.resolution_rate;
  const rate = typeof rawRate === 'number' && Number.isFinite(rawRate) ? rawRate : null;
  return {
    rate,
    total: readNumber(record, 'total'),
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

/**
 * The reporting period, as the backend's `?period=` parameter spells it.
 *
 * Structurally identical to {@link TrendRange} and deliberately so: one
 * control on the Analytics page drives both the client-side trend window and
 * the server-side language breakdown, so a customer never has to reconcile two
 * different notions of "last 30 days" on the same screen. The alias exists to
 * make that shared meaning explicit at the call sites that talk to the API.
 */
export type AnalyticsPeriod = TrendRange;

export const TREND_RANGES: ReadonlyArray<{ value: TrendRange; label: string }> = [
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: '90d', label: '90 days' },
  { value: 'all', label: 'All time' },
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
    return { total: 0, dailyAverage: 0, peak: 0, peakLabel: '-' };
  }

  let total = 0;
  let peak = 0;
  let peakLabel = '-';
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

// ── Language analytics (Phase 5C) ────────────────────────────────────────────

/** One language's share of an agent's conversations. */
export interface LanguageRow {
  /** Base language code, or null for sessions with no detected language. */
  languageCode: string | null;
  /** Display name, resolved server-side. Never derived in the client. */
  label: string;
  total: number;
  /** Conversations the visitor explicitly marked resolved. A subset of `total`. */
  resolved: number;
  /** Conversations that reached an operator, including ones since closed. */
  liveChat: number;
}

/**
 * Rolling translation activity. NOT history: these come from Redis counters
 * that expire after roughly a day, so `windowHours` bounds everything here and
 * the UI is required to say so.
 */
export interface TranslationActivity {
  requests: number;
  ok: number;
  failed: number;
  timeout: number;
  windowHours: number;
}

export interface LanguageBreakdown {
  /** False when the agent has multilingual off; the whole tab is hidden. */
  multilingualEnabled: boolean;
  /** False when operator translation is off; the translation card is hidden. */
  operatorTranslationEnabled: boolean;
  rows: LanguageRow[];
  totals: { total: number; resolved: number; liveChat: number; languages: number };
  /** Rolling. Expires. */
  translation: TranslationActivity;
  /** Durable, from the credit ledger, scoped to the requested period. */
  creditsSpent: number;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Narrow the `/analytics/language-breakdown` payload.
 *
 * Totals are the server's and are NOT recomputed from the rows, so the cards
 * always show the same figures the endpoint reported. Recomputing here would
 * let a client-side parsing quirk silently disagree with the API.
 */
export function parseLanguageBreakdown(record: Record<string, unknown>): LanguageBreakdown {
  const rowsRaw = Array.isArray(record.conversations) ? record.conversations : [];
  const totals = asRecord(record.totals);
  const translation = asRecord(record.translation);
  const cost = asRecord(record.cost);

  const rows: LanguageRow[] = rowsRaw.map((entry) => {
    const row = asRecord(entry);
    const code = typeof row.language_code === 'string' && row.language_code ? row.language_code : null;
    return {
      languageCode: code,
      // The server always sends a label, including for the null row. Falling
      // back keeps a malformed payload readable rather than blank.
      label:
        typeof row.label === 'string' && row.label
          ? row.label
          : (code?.toUpperCase() ?? 'Not detected'),
      total: toNumber(row.total),
      resolved: toNumber(row.resolved),
      liveChat: toNumber(row.live_chat),
    };
  });

  return {
    multilingualEnabled: record.multilingual_enabled === true,
    operatorTranslationEnabled: record.operator_translation_enabled === true,
    rows,
    totals: {
      total: toNumber(totals.total),
      resolved: toNumber(totals.resolved),
      liveChat: toNumber(totals.live_chat),
      languages: toNumber(totals.languages),
    },
    translation: {
      requests: toNumber(translation.requests),
      ok: toNumber(translation.ok),
      failed: toNumber(translation.failed),
      timeout: toNumber(translation.timeout),
      // Defaulted so the UI never renders "last 0 hours".
      windowHours: toNumber(translation.window_hours) || 24,
    },
    creditsSpent: toNumber(cost.credits),
  };
}
