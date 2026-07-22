import { useCallback, useEffect, useState } from 'react';
import { getActivityStats, getDashboardStats, getTopQuestions } from '../../../services/api';
import { type ActivityPoint, type TopQuestion } from '../../../types/domain';

/**
 * The subset of the `/analytics/dashboard` payload the Overview reads. The
 * endpoint returns an untyped record (see api.d.ts), so we parse it defensively
 * here rather than trusting its shape.
 */
export interface AgentStats {
  readonly totalConversations: number;
  readonly totalMessages: number;
  readonly activeUsers: number;
  /** Percentage of rated answers marked helpful, 0–100. */
  readonly successRate: number;
}

type LoadStatus = 'loading' | 'success' | 'error';

export interface OverviewData {
  readonly status: LoadStatus;
  /**
   * True while a manual {@link OverviewData.refetch} runs over already-loaded
   * data. Distinct from the initial `status === 'loading'` so the UI can keep
   * stale content visible during a refresh instead of blanking to skeletons.
   */
  readonly isRefetching: boolean;
  readonly stats: AgentStats | null;
  readonly activity: readonly ActivityPoint[];
  readonly questions: readonly TopQuestion[];
  readonly error: string | null;
  /** Re-run every fetch (e.g. a manual "Refresh" action). */
  readonly refetch: () => void;
}

/** Coerces an unknown value to a finite number, falling back to 0. */
function toNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** Parses the raw dashboard record into a typed, safe {@link AgentStats}. */
function parseStats(raw: Record<string, unknown>): AgentStats {
  return {
    totalConversations: toNumber(raw.total_conversations),
    totalMessages: toNumber(raw.total_messages),
    activeUsers: toNumber(raw.active_users),
    successRate: toNumber(raw.success_rate),
  };
}

/** Narrows an unknown error to a human-readable message. */
function toMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return 'We couldn’t load your latest metrics. Please try again.';
}

/**
 * Loads the three Overview data sources (stats, activity, top questions) for a
 * single agent. `botId` is stable for the hook's lifetime (the page remounts
 * this via `key={agent.id}`), so the fetch runs once per agent and only ever
 * calls `setState` from async callbacks — never synchronously inside an effect.
 */
export function useOverviewData(botId: number): OverviewData {
  const [state, setState] = useState<Omit<OverviewData, 'refetch'>>({
    status: 'loading',
    isRefetching: false,
    stats: null,
    activity: [],
    questions: [],
    error: null,
  });
  // Bumped by refetch() to re-trigger the effect without a synchronous reset.
  const [reloadToken, setReloadToken] = useState(0);

  const refetch = useCallback(() => {
    // Called from a user event (never an effect). Keep the resolved status and
    // existing data so a refresh doesn't blank the page back to skeletons; the
    // isRefetching flag drives the Refresh button's spinner instead.
    setState((current) => ({ ...current, isRefetching: true, error: null }));
    setReloadToken((token) => token + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;

    Promise.all([
      getDashboardStats(botId),
      getActivityStats(botId).catch((): ActivityPoint[] => []),
      getTopQuestions(botId).catch((): TopQuestion[] => []),
    ])
      .then(([rawStats, activity, questions]) => {
        if (cancelled) return;
        setState({
          status: 'success',
          isRefetching: false,
          stats: parseStats(rawStats),
          activity,
          questions,
          error: null,
        });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState({
          status: 'error',
          isRefetching: false,
          stats: null,
          activity: [],
          questions: [],
          error: toMessage(error),
        });
      });

    return () => {
      cancelled = true;
    };
  }, [botId, reloadToken]);

  return { ...state, refetch };
}
