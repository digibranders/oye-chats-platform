import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import {
  getActivityStats,
  getDashboardStats,
  getLeadStats,
  getQualificationFunnel,
  getRatingsSummary,
  getTopQuestions,
  getUnansweredQuestions,
  getVisitorsData,
} from '../../services/api';
import { keys } from '../../query/keys';
import { parseLeadFunnelStats, parseRatingsSummary, parseWorkspaceTotals } from './analytics-types';
import { buildDailySeries } from './series';
import { parseVisitors } from './visitors';
import type { ResolvedRange } from './range';

/**
 * Every server read this surface makes, one hook per endpoint.
 *
 * One hook per endpoint is the rule that keeps the page honest. The version
 * this replaces mounted a single journey hook in three sibling panels, each
 * firing ten requests, each with its own fifteen-second poll and its own focus
 * listener — roughly thirty requests on load and thirty more every fifteen
 * seconds, for one dataset. Here the cache is the sharing mechanism: two panels
 * asking the same question get one request, and a stale answer is refreshed
 * when the window regains focus rather than on a timer nobody can see.
 */

/** A user-facing message for a failed query, never a status code. */
export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/** HTTP 402 is the backend's plan gate. Everything else is a real failure. */
export function isPlanGate(error: unknown): boolean {
  return (error as { status?: number } | null)?.status === 402;
}

/** 403 means the workspace's plan does not include the endpoint at all. */
export function isForbidden(error: unknown): boolean {
  const status = (error as { status?: number } | null)?.status;
  return status === 402 || status === 403;
}

const scope = (botId: number | null): number | undefined => botId ?? undefined;

/**
 * Headline totals for the window, and for the window before it.
 *
 * The previous window is the same endpoint asked for twice the days: the server
 * counts sessions created after `now - days`, so subtracting the inner window
 * from the outer one leaves exactly the period before this one. It is one extra
 * request, and it is the only reason this page can answer "compared to what?".
 */
export function useHeadlineTotals(botId: number | null, range: ResolvedRange) {
  const current = useQuery({
    queryKey: keys.analytics.dashboard(botId, range.days),
    queryFn: () => getDashboardStats(scope(botId), range.days),
    select: parseWorkspaceTotals,
    enabled: botId != null,
  });

  const extended = useQuery({
    queryKey: keys.analytics.dashboard(botId, range.extendedDays),
    queryFn: () => getDashboardStats(scope(botId), range.extendedDays),
    select: parseWorkspaceTotals,
    enabled: botId != null && range.extendedDays != null,
  });

  const previousConversations =
    current.data && extended.data
      ? Math.max(0, extended.data.totalConversations - current.data.totalConversations)
      : null;

  return {
    totals: current.data ?? null,
    previousConversations,
    loading: current.isPending,
    error: current.error,
    refetch: current.refetch,
  };
}

/** The full daily message series. One request, windowed on the client. */
export function useMessageSeries(botId: number | null) {
  const query = useQuery({
    queryKey: keys.analytics.activity(botId, null),
    queryFn: () => getActivityStats(scope(botId)),
    select: (activity) => buildDailySeries(activity),
    enabled: botId != null,
  });
  return {
    series: query.data ?? [],
    loading: query.isPending,
    error: query.error,
    refetch: query.refetch,
  };
}

export function useTopQuestions(botId: number | null) {
  const query = useQuery({
    queryKey: keys.analytics.topQuestions(botId),
    queryFn: () => getTopQuestions(scope(botId)),
    enabled: botId != null,
  });
  return {
    questions: query.data ?? [],
    loading: query.isPending,
    error: query.error,
    refetch: query.refetch,
  };
}

/** How many rows of knowledge gaps to ask for. The endpoint caps at 200. */
const UNANSWERED_LIMIT = 100;

export function useUnansweredQuestions(botId: number | null, days: number | null) {
  const query = useQuery({
    queryKey: keys.analytics.unanswered(botId, days),
    queryFn: () =>
      getUnansweredQuestions(scope(botId), {
        limit: UNANSWERED_LIMIT,
        days: days ?? undefined,
      }),
    enabled: botId != null,
  });
  return {
    questions: query.data ?? [],
    loading: query.isPending,
    error: query.error,
    refetch: query.refetch,
  };
}

export function useRatings(botId: number | null) {
  const query = useQuery({
    queryKey: keys.analytics.ratings(botId),
    queryFn: () => getRatingsSummary(scope(botId)),
    select: parseRatingsSummary,
    enabled: botId != null,
  });
  return {
    ratings: query.data ?? null,
    loading: query.isPending,
    error: query.error,
    refetch: query.refetch,
  };
}

export function useLeadStats(botId: number | null) {
  const query = useQuery({
    queryKey: keys.leads.stats(botId),
    queryFn: () => getLeadStats(scope(botId)),
    select: parseLeadFunnelStats,
    enabled: botId != null,
  });
  return {
    leads: query.data ?? null,
    loading: query.isPending,
    // A Free workspace is refused this endpoint outright. That is a plan
    // answer, not an outage, and the caller renders it as one.
    locked: isForbidden(query.error),
    error: query.error,
    refetch: query.refetch,
  };
}

/**
 * The qualification funnel for the selected window.
 *
 * `period` is the page's own range, unmodified: this endpoint already speaks
 * `7d|30d|90d|all`, which is why the page's vocabulary is that one.
 */
export function useQualificationFunnel(botId: number | null, period: string, enabled: boolean) {
  const query = useQuery({
    queryKey: keys.analytics.funnel(botId, period),
    queryFn: () => getQualificationFunnel(botId as number, period),
    enabled: enabled && botId != null,
  });
  return {
    funnel: query.data ?? null,
    loading: query.isPending,
    locked: isForbidden(query.error),
    error: query.error,
    refetch: query.refetch,
  };
}

export function useVisitors(botId: number | null) {
  const query = useQuery({
    queryKey: keys.analytics.visitors(botId),
    queryFn: () => getVisitorsData(scope(botId)),
    select: parseVisitors,
    enabled: botId != null,
  });
  return {
    visitors: query.data ?? [],
    loading: query.isPending,
    locked: isForbidden(query.error),
    error: query.error,
    refetch: query.refetch,
  };
}

/**
 * One refresh for the whole surface.
 *
 * The journey view alone shipped three refresh buttons and three clocks over a
 * single dataset, and one of its three panels had no refresh control at all.
 * This invalidates every analytics query at once, from the page header, where
 * it exists in all four states rather than only once the page has loaded.
 */
export function useAnalyticsRefresh() {
  const client = useQueryClient();
  return useCallback(() => {
    void client.invalidateQueries({ queryKey: ['analytics'] });
    void client.invalidateQueries({ queryKey: ['leads', 'stats'] });
  }, [client]);
}
