import { useCallback, useEffect, useState } from 'react';
import {
  getActivityStats,
  getBot,
  getDashboardStats,
  getRatingsSummary,
  getResolutionSummary,
  getTopQuestions,
} from '../../../services/api';
import { type ActivityPoint, type Bot, type TopQuestion } from '../../../types/domain';
import { parseRatingsSummary, parseResolutionSummary } from '../../analytics/analytics-types';
import { t as translateNow } from '../../../i18n/i18n';

/**
 * The subset of overview analytics and stats.
 */
export interface AgentStats {
  readonly totalConversations: number;
  readonly totalMessages: number;
  readonly activeUsers: number;
  /** Percentage of rated answers marked helpful, 0 to 100. */
  readonly successRate: number;
  readonly resolutionRate: number | null;
  readonly averageRating: number | null;
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
  readonly details: Bot | null;
  readonly error: string | null;
  /** Re-run every fetch (e.g. a manual "Refresh" action). */
  readonly refetch: () => void;
}

/** Coerces an unknown value to a finite number, falling back to 0. */
function toNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** Parses the raw dashboard record into a typed, safe {@link AgentStats}. */
function parseStats(
  raw: Record<string, unknown>,
  rawRatings: Record<string, unknown>,
  rawResolution: Record<string, unknown>,
): AgentStats {
  const ratings = parseRatingsSummary(rawRatings);
  const resolution = parseResolutionSummary(rawResolution);

  const averageRating =
    ratings.total > 0 && ratings.average > 0
      ? ratings.average
      : typeof rawRatings.avg === 'number' && Number.isFinite(rawRatings.avg)
        ? rawRatings.avg
        : null;

  return {
    totalConversations: toNumber(raw.total_conversations),
    totalMessages: toNumber(raw.total_messages),
    activeUsers: toNumber(raw.active_users),
    successRate: toNumber(raw.success_rate),
    resolutionRate: resolution.rate,
    averageRating,
  };
}

/** Narrows an unknown error to a human-readable message. */
function toMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return translateNow('agents.weCouldntLoadYourLatest') || 'We couldn’t load your latest metrics. Please try again.';
}

/**
 * Loads the overview data sources (stats, activity, top questions, bot details,
 * ratings, resolution summary) for a single agent.
 */
export function useOverviewData(botId: number): OverviewData {
  const [state, setState] = useState<Omit<OverviewData, 'refetch'>>({
    status: 'loading',
    isRefetching: false,
    stats: null,
    activity: [],
    questions: [],
    details: null,
    error: null,
  });
  const [reloadToken, setReloadToken] = useState(0);

  const refetch = useCallback(() => {
    setState((current) => ({ ...current, isRefetching: true, error: null }));
    setReloadToken((token) => token + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;

    Promise.all([
      getDashboardStats(botId),
      getActivityStats(botId).catch((): ActivityPoint[] => []),
      getTopQuestions(botId).catch((): TopQuestion[] => []),
      getBot(botId).catch((): Bot | null => null),
      getRatingsSummary(botId).catch((): Record<string, unknown> => ({})),
      getResolutionSummary(botId).catch((): Record<string, unknown> => ({})),
    ])
      .then(([rawStats, activity, questions, details, rawRatings, rawResolution]) => {
        if (cancelled) return;
        setState({
          status: 'success',
          isRefetching: false,
          stats: parseStats(rawStats, rawRatings, rawResolution),
          activity,
          questions,
          details,
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
          details: null,
          error: toMessage(error),
        });
      });

    return () => {
      cancelled = true;
    };
  }, [botId, reloadToken]);

  return { ...state, refetch };
}
