import { useCallback } from 'react';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import {
  getActivityStats,
  getDashboardStats,
  getRatingsSummary,
  getResolutionSummary,
  getTopQuestions,
} from '../../../services/api';
import { keys } from '../../../query/keys';
import { parseRatingsSummary, parseResolutionSummary } from '../../analytics/analytics-types';
import type { TrendDirection } from '../../../ui';
import type { ActivityPoint, TopQuestion } from '../../../types/domain';

/**
 * Overview's data, one query per section.
 *
 * Two decisions carry this file.
 *
 * **The period is a parameter.** `/analytics/dashboard` has always accepted
 * `?days=`, and nothing in the product ever passed it — so every figure the
 * customer has ever seen has been all-time, including a card literally titled
 * "7-day performance". The range is a real argument now, it is part of the query
 * key, and it lives in the URL.
 *
 * **Each section fails on its own.** The hook it replaces ran six calls through
 * one `Promise.all` behind one status, so a failing ratings endpoint blanked the
 * conversation counts, the activity chart and the question list as well. Here a
 * broken section is one card with one retry, and everything else still renders.
 *
 * What is *not* windowed is labelled as not windowed. `active_users` is a live
 * fifteen-minute count whatever `days` says, ratings and resolution have no
 * window parameter at all, and `/analytics/activity` returns every day it has.
 * Saying "last 30 days" over any of those would be the same lie in a new place.
 */

export const RANGE_OPTIONS = [7, 30, 90] as const;
export type RangeDays = (typeof RANGE_OPTIONS)[number];

export const DEFAULT_RANGE: RangeDays = 30;

/** Read the range out of the URL, falling back rather than throwing. */
export function parseRange(raw: string | null): RangeDays {
  const value = Number(raw);
  return (RANGE_OPTIONS as readonly number[]).includes(value) ? (value as RangeDays) : DEFAULT_RANGE;
}

export function rangeLabel(days: RangeDays): string {
  return `Last ${days} days`;
}

/**
 * Trim an all-time daily series to the selected window.
 *
 * `/analytics/activity` takes no `days`, so the window is applied here rather
 * than pretended away. Dates arrive as `YYYY-MM-DD` and are compared as strings
 * against a locally-computed cutoff: parsing them as `Date` treats them as UTC
 * midnight, which shifts a day for every viewer west of UTC.
 */
export function windowActivity(
  points: readonly ActivityPoint[],
  days: number,
  now: Date = new Date(),
): ActivityPoint[] {
  const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1));
  const iso = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, '0')}-${String(
    cutoff.getDate(),
  ).padStart(2, '0')}`;
  return points.filter((point) => typeof point.date === 'string' && point.date >= iso);
}

/**
 * A figure's comparison against the window before it.
 *
 * Without one a number is a receipt rather than an instrument: nothing on this
 * page told the reader whether 412 conversations was good, while `StatTile` had
 * shipped `delta` from the start and no surface in the app passed it.
 */
export interface FigureDelta {
  value: string;
  direction: TrendDirection;
  /** What it is compared against. The arrow means nothing without it. */
  label: string;
}

/**
 * The change from one window to the next, as a percentage.
 *
 * `null` when the previous window is zero. A rise from nothing is not a
 * percentage, and "+100%" over a baseline of one conversation is a number that
 * misleads more than it informs — so the tile simply shows no delta rather than
 * inventing one.
 */
export function pctChange(previous: number, current: number, label: string): FigureDelta | null {
  if (!Number.isFinite(previous) || !Number.isFinite(current) || previous <= 0) return null;
  const change = ((current - previous) / previous) * 100;
  const rounded = Math.round(change);
  const direction: TrendDirection = rounded === 0 ? 'flat' : rounded > 0 ? 'up' : 'down';
  const sign = rounded > 0 ? '+' : rounded < 0 ? '\u2212' : '';
  return { value: `${sign}${Math.abs(rounded)}%`, direction, label };
}

/** Total the message counts on a daily series. */
export function sumMessages(points: readonly ActivityPoint[]): number {
  return points.reduce((total, point) => total + (point.messages ?? 0), 0);
}

/**
 * The window before the selected one, trimmed from the same all-time series.
 *
 * `/analytics/activity` returns every day it has, so the comparison costs no
 * extra request: take twice the window and drop the days the current one
 * already covers.
 */
export function previousWindow(
  points: readonly ActivityPoint[],
  days: RangeDays,
  now: Date = new Date(),
): ActivityPoint[] {
  const current = windowActivity(points, days, now);
  const doubled = windowActivity(points, days * 2, now);
  return current.length === 0 ? doubled : doubled.slice(0, doubled.length - current.length);
}

/** The windowed figures from `/analytics/dashboard`. */
export interface AgentFigures {
  conversations: number;
  messages: number;
  /** Live: sessions active in the last fifteen minutes, whatever `days` says. */
  activeVisitors: number;
  demoShares: number;
  demoOpens: number;
  /** Percentage 0–100, or `null` when nothing has been shared yet. */
  demoOpenRate: number | null;
}

function readNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export function parseAgentFigures(record: Record<string, unknown>): AgentFigures {
  const shares = readNumber(record, 'demo_shares');
  return {
    conversations: readNumber(record, 'total_conversations'),
    messages: readNumber(record, 'total_messages'),
    activeVisitors: readNumber(record, 'active_users'),
    demoShares: shares,
    demoOpens: readNumber(record, 'demo_opens'),
    // A rate over zero shares is not zero, it is absent. The server sends 0 for
    // both, which would render an honest-looking "0%" for a chatbot nobody has
    // ever shared.
    demoOpenRate: shares > 0 ? readNumber(record, 'demo_open_rate') : null,
  };
}

/** One card's worth of data, in the four states every surface owes its user. */
export interface Section<T> {
  data: T;
  loading: boolean;
  error: string | null;
  retry: () => void;
}

function messageFrom(cause: unknown): string {
  return cause instanceof Error && cause.message
    ? cause.message
    : 'We could not load this. Please try again.';
}

function toSection<TRaw, TData>(
  query: UseQueryResult<TRaw>,
  select: (raw: TRaw) => TData,
  fallback: TData,
): Section<TData> {
  return {
    data: query.data === undefined ? fallback : select(query.data),
    loading: query.isPending,
    error: query.isError ? messageFrom(query.error) : null,
    retry: () => void query.refetch(),
  };
}

export interface OverviewData {
  figures: Section<AgentFigures>;
  /**
   * The comparison for the two figures that genuinely have a previous window.
   *
   * Ratings and resolution have no period parameter at all, so they carry no
   * delta rather than a fabricated one.
   */
  deltas: { conversations: FigureDelta | null; messages: FigureDelta | null };
  activity: Section<ActivityPoint[]>;
  questions: Section<TopQuestion[]>;
  ratings: Section<{ average: number | null; total: number }>;
  resolution: Section<{ rate: number | null; total: number }>;
  /** True while any section is fetching, for the Refresh control. */
  refreshing: boolean;
  /** Refetch everything on this page. */
  refreshAll: () => void;
}

const EMPTY_FIGURES: AgentFigures = {
  conversations: 0,
  messages: 0,
  activeVisitors: 0,
  demoShares: 0,
  demoOpens: 0,
  demoOpenRate: null,
};

export function useOverviewData(botId: number, days: RangeDays): OverviewData {
  const dashboard = useQuery({
    queryKey: keys.analytics.dashboard(botId, days),
    queryFn: () => getDashboardStats(botId, days),
    staleTime: 60_000,
  });

  // Keyed with `null` days because the endpoint genuinely has none — the key
  // has to describe the request, or two windows would share one cache entry.
  const activity = useQuery({
    queryKey: keys.analytics.activity(botId, null),
    queryFn: () => getActivityStats(botId),
    staleTime: 60_000,
  });

  const questions = useQuery({
    queryKey: keys.analytics.topQuestions(botId),
    queryFn: () => getTopQuestions(botId),
    staleTime: 60_000,
  });

  const ratings = useQuery({
    queryKey: keys.analytics.ratings(botId),
    queryFn: () => getRatingsSummary(botId),
    staleTime: 60_000,
  });

  const resolution = useQuery({
    queryKey: keys.analytics.resolution(botId),
    queryFn: () => getResolutionSummary(botId),
    staleTime: 60_000,
  });

  /**
   * The same endpoint over twice the window, so the previous period is
   * `total(2N) - total(N)`. It is a second request, on its own cache key with
   * the same one-minute staleness, and it is what makes every headline figure
   * on this page mean something.
   */
  const doubled = useQuery({
    queryKey: keys.analytics.dashboard(botId, days * 2),
    queryFn: () => getDashboardStats(botId, days * 2),
    staleTime: 60_000,
  });

  const refreshAll = useCallback(() => {
    void dashboard.refetch();
    void doubled.refetch();
    void activity.refetch();
    void questions.refetch();
    void ratings.refetch();
    void resolution.refetch();
  }, [dashboard, doubled, activity, questions, ratings, resolution]);

  const comparedTo = `vs previous ${days} days`;
  const current = dashboard.data === undefined ? null : parseAgentFigures(dashboard.data);
  const wider = doubled.data === undefined ? null : parseAgentFigures(doubled.data);
  const activityPoints = Array.isArray(activity.data) ? activity.data : [];

  return {
    figures: toSection(dashboard, parseAgentFigures, EMPTY_FIGURES),
    deltas: {
      conversations:
        current && wider
          ? pctChange(wider.conversations - current.conversations, current.conversations, comparedTo)
          : null,
      // From the series already in hand rather than from the second dashboard
      // call, because the series is daily and exact where the pair is a
      // subtraction of two server-rounded totals.
      messages: activity.isPending
        ? null
        : pctChange(
            sumMessages(previousWindow(activityPoints, days)),
            sumMessages(windowActivity(activityPoints, days)),
            comparedTo,
          ),
    },
    activity: toSection(activity, (raw) => (Array.isArray(raw) ? raw : []), []),
    questions: toSection(questions, (raw) => (Array.isArray(raw) ? raw : []), []),
    ratings: toSection(
      ratings,
      (raw) => {
        const parsed = parseRatingsSummary(raw);
        // Zero ratings means no average, not an average of zero.
        return { average: parsed.total > 0 ? parsed.average : null, total: parsed.total };
      },
      { average: null, total: 0 },
    ),
    resolution: toSection(resolution, parseResolutionSummary, { rate: null, total: 0 }),
    refreshing:
      dashboard.isFetching ||
      doubled.isFetching ||
      activity.isFetching ||
      questions.isFetching ||
      ratings.isFetching ||
      resolution.isFetching,
    refreshAll,
  };
}
