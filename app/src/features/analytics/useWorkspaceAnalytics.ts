import { useCallback, useEffect, useState } from 'react';
import {
  getActivityStats,
  getDashboardStats,
  getLeadStats,
  getRatingsSummary,
  getTopQuestions,
} from '../../services/api';
import { type TopQuestion } from '../../types/domain';
import {
  buildTrendSeries,
  parseLeadFunnelStats,
  parseRatingsSummary,
  parseWorkspaceTotals,
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
export function useWorkspaceAnalytics(botId: number | null = null): UseWorkspaceAnalyticsResult {
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

  const reload = useCallback(() => {
    setRefreshing(true);
    // Keep populated data mounted during a refresh; only fall back to the
    // skeleton when there is nothing to show yet (initial load or error retry).
    setState((prev) => (prev.data ? prev : { ...prev, status: 'loading', error: null }));
    setReloadToken((token) => token + 1);
  }, []);

  return { status: state.status, data: state.data, error: state.error, refreshing, reload };
}
