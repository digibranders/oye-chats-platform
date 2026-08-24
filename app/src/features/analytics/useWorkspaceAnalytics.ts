import { useCallback, useEffect, useState } from 'react';
import {
  getActivityStats,
  getDashboardStats,
  getLanguageBreakdown,
  getLeadStats,
  getRatingsSummary,
  getTopQuestions,
} from '../../services/api';
import { type TopQuestion } from '../../types/domain';
import {
  buildTrendSeries,
  parseLanguageBreakdown,
  parseLeadFunnelStats,
  parseRatingsSummary,
  parseWorkspaceTotals,
  type AnalyticsPeriod,
  type LanguageBreakdown,
  type LeadFunnelStats,
  type RatingsSummary,
  type TrendPoint,
  type WorkspaceTotals,
} from './analytics-types';

/** Fully-resolved, strictly-typed analytics for the whole workspace. */
export interface WorkspaceAnalytics {
  totals: WorkspaceTotals;
  trend: TrendPoint[];
  topQuestions: TopQuestion[];
  ratings: RatingsSummary;
  leads: LeadFunnelStats;
}

export type AnalyticsStatus = 'loading' | 'ready' | 'error';

export interface UseWorkspaceAnalyticsResult {
  status: AnalyticsStatus;
  data: WorkspaceAnalytics | null;
  error: string | null;
  /**
   * True while a background refetch runs on top of already-loaded data. Lets
   * the UI show a subtle inline spinner instead of unmounting to a skeleton.
   */
  refreshing: boolean;
  /** Re-run every request. Safe to wire to a "Try again" / "Refresh" button. */
  reload: () => void;
  /**
   * Language breakdown for the selected agent and period.
   *
   * Deliberately NOT part of {@link WorkspaceAnalytics}: it is the only feed
   * that takes a period, so it reloads on its own when the period changes
   * while the others, which have no period parameter, stay put. Folding it
   * into the same object would mean either refetching all of them for nothing
   * or lying about when the object last changed.
   *
   * Null when there is no agent to scope to, and when the feed is
   * unavailable. `/analytics/language-breakdown` requires a `bot_id`, and a
   * language mix summed across agents that each support different languages
   * would not mean anything. Null hides the Languages tab, which is what we
   * want in both cases.
   *
   * In practice `botId` is null only for a workspace with no agents at all:
   * the aggregate "All agents" scope was removed from `BotContext`, which now
   * always resolves to a concrete agent whenever any exist.
   */
  language: LanguageBreakdown | null;
  /** True while a period or agent change refetches the breakdown in place. */
  languageRefreshing: boolean;
}

function errorMessage(cause: unknown): string {
  if (cause instanceof Error && cause.message) return cause.message;
  return 'We couldn’t load your analytics. Please try again.';
}

/**
 * Loads every analytics feed in parallel and exposes a single status machine.
 * When `botId` is a number, every request is scoped to that agent via the
 * backend's `?bot_id=` filter; when `botId` is null (the shell's "All agents"
 * scope), no filter is passed and the backend aggregates across the workspace.
 * Loading is *derived* from the state machine rather than toggled inside the
 * effect: `setState` only runs after an `await` (never synchronously during
 * render), and a `reloadToken` drives re-fetches. Lead stats are optional - a
 * workspace with qualification disabled still gets a full page.
 */
export function useWorkspaceAnalytics(
  botId: number | null = null,
  period: AnalyticsPeriod = 'all',
): UseWorkspaceAnalyticsResult {
  const [reloadToken, setReloadToken] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [state, setState] = useState<{
    status: AnalyticsStatus;
    data: WorkspaceAnalytics | null;
    error: string | null;
  }>({ status: 'loading', data: null, error: null });

  useEffect(() => {
    let active = true;
    // The API wrappers treat `undefined` as "no filter" - normalize null → undefined.
    const scope = botId ?? undefined;

    void (async () => {
      try {
        const [dashboard, activity, questions, ratings, leads] = await Promise.all([
          getDashboardStats(scope),
          getActivityStats(scope),
          getTopQuestions(scope),
          getRatingsSummary(scope),
          // Optional surface - never fail the whole page if leads are unavailable.
          getLeadStats(scope).catch(() => ({}) as Record<string, unknown>),
        ]);

        if (!active) return;
        setState({
          status: 'ready',
          error: null,
          data: {
            totals: parseWorkspaceTotals(dashboard),
            trend: buildTrendSeries(activity),
            topQuestions: questions,
            ratings: parseRatingsSummary(ratings),
            leads: parseLeadFunnelStats(leads),
          },
        });
      } catch (cause) {
        if (!active) return;
        // A failed background refresh keeps the already-loaded data on screen
        // rather than blowing the whole page away; only a cold load surfaces
        // the full error state.
        setState((prev) =>
          prev.data
            ? { status: 'ready', data: prev.data, error: null }
            : { status: 'error', data: null, error: errorMessage(cause) },
        );
      } finally {
        if (active) setRefreshing(false);
      }
    })();

    return () => {
      active = false;
    };
  }, [reloadToken, botId]);

  // The language breakdown is the ONLY feed with a period, so it gets its own
  // effect keyed on it. Sharing the main effect would refetch the dashboard,
  // activity, questions, ratings and leads every time someone moved the range
  // control, none of which take a period, and would flash the whole page.
  const [language, setLanguage] = useState<LanguageBreakdown | null>(null);
  const [languageRefreshing, setLanguageRefreshing] = useState(false);

  useEffect(() => {
    let active = true;
    const scope = botId ?? undefined;

    if (scope === undefined) {
      // No agent to scope the breakdown to. Reached only by a workspace with
      // no agents, since `BotContext` no longer has an aggregate scope.
      setLanguage(null);
      setLanguageRefreshing(false);
      return;
    }

    setLanguageRefreshing(true);
    void (async () => {
      // Optional surface, like lead stats: a workspace that cannot load this
      // still gets the rest of the page rather than an error screen.
      const raw = await getLanguageBreakdown(scope, period).catch(() => null);
      if (!active) return;
      setLanguage(raw ? parseLanguageBreakdown(raw) : null);
      setLanguageRefreshing(false);
    })();

    return () => {
      active = false;
    };
  }, [reloadToken, botId, period]);

  const reload = useCallback(() => {
    setRefreshing(true);
    // Keep populated data mounted during a refresh; only fall back to the
    // skeleton when there is nothing to show yet (initial load or error retry).
    setState((prev) => (prev.data ? prev : { ...prev, status: 'loading', error: null }));
    setReloadToken((token) => token + 1);
  }, []);

  return {
    status: state.status,
    data: state.data,
    error: state.error,
    refreshing,
    reload,
    language,
    languageRefreshing,
  };
}
