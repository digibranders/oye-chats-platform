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
  days: RangeDays,
  now: Date = new Date(),
): ActivityPoint[] {
  const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1));
  const iso = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, '0')}-${String(
    cutoff.getDate(),
  ).padStart(2, '0')}`;
  return points.filter((point) => typeof point.date === 'string' && point.date >= iso);
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

  const refreshAll = useCallback(() => {
    void dashboard.refetch();
    void activity.refetch();
    void questions.refetch();
    void ratings.refetch();
    void resolution.refetch();
  }, [dashboard, activity, questions, ratings, resolution]);

  return {
    figures: toSection(dashboard, parseAgentFigures, EMPTY_FIGURES),
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
      activity.isFetching ||
      questions.isFetching ||
      ratings.isFetching ||
      resolution.isFetching,
    refreshAll,
  };
}
