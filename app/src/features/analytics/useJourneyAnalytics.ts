import { useCallback, useEffect, useState } from 'react';
import {
  getJourneyConversionPaths,
  getJourneyPostChat,
  getJourneyPreChatSequences,
  getJourneySummary,
  getJourneyTopPages,
  type JourneyConversionPathsResponse,
  type JourneyConversionType,
  type JourneyPeriod,
  type JourneyPhase,
  type JourneyPostChatResponse,
  type JourneyPreChatSequencesResponse,
  type JourneySummary,
  type JourneyTopPagesResponse,
} from '../../services/api';

/** Conversion types the Journeys tab attributes paths for. */
export const JOURNEY_CONVERSION_TYPES: readonly JourneyConversionType[] = [
  'meeting_booked',
  'handoff_requested',
  'offline_message_sent',
] as const;

/** Fully-resolved payload the tab renders. Every sub-request is loaded together. */
export interface JourneyAnalytics {
  summary: JourneySummary;
  topPages: Record<'all' | JourneyPhase, JourneyTopPagesResponse>;
  conversionPaths: Record<JourneyConversionType, JourneyConversionPathsResponse>;
  postChat: JourneyPostChatResponse;
  /** Top ordered pre-chat page sequences across ALL sessions (converted or not). */
  preChatSequences: JourneyPreChatSequencesResponse;
}

export type JourneyStatus = 'idle' | 'loading' | 'ready' | 'gated' | 'error';

export interface UseJourneyAnalyticsResult {
  status: JourneyStatus;
  data: JourneyAnalytics | null;
  error: string | null;
  refreshing: boolean;
  period: JourneyPeriod;
  setPeriod: (period: JourneyPeriod) => void;
  reload: () => void;
  /** Epoch ms of the last successful fetch. Powers the "updated Xs ago"
   *  indicator so an owner can see the poll is alive. `null` while the
   *  very first fetch is still in flight or the hook is idle. */
  lastUpdatedAt: number | null;
}

/**
 * Loads every Journeys feed for one agent + period in parallel. When any
 * request returns HTTP 402 (the `journey_analytics` plan flag is off), the
 * whole status flips to `gated` so the tab can render the LockedFeatureCard
 * upgrade teaser instead of a broken empty state.
 *
 * `botId` of `null` means "no agent selected" — the hook stays idle rather
 * than hitting the API. Journeys are always per-agent (each embed has one
 * `bot_key`), unlike the workspace-aggregated feeds on the other tabs.
 */
/** Formats a Date as `YYYY-MM` — matches what the backend expects. */
function toMonthKey(date: Date): JourneyPeriod {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

export function useJourneyAnalytics(botId: number | null): UseJourneyAnalyticsResult {
  // Default to the current calendar month. The picker in the tab lets the
  // owner scroll back through the last 12 months.
  const [period, setPeriod] = useState<JourneyPeriod>(() => toMonthKey(new Date()));
  const [reloadToken, setReloadToken] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
  const [state, setState] = useState<{
    status: JourneyStatus;
    data: JourneyAnalytics | null;
    error: string | null;
  }>({ status: botId == null ? 'idle' : 'loading', data: null, error: null });

  useEffect(() => {
    if (botId == null) {
      setState({ status: 'idle', data: null, error: null });
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const [summary, topAll, topPre, topChat, topPost, meeting, handoff, offline, postChat, preChatSequences] =
          await Promise.all([
            getJourneySummary(botId, period),
            getJourneyTopPages(botId, { period, phase: null, limit: 20 }),
            getJourneyTopPages(botId, { period, phase: 'pre', limit: 20 }),
            getJourneyTopPages(botId, { period, phase: 'chat', limit: 20 }),
            getJourneyTopPages(botId, { period, phase: 'post', limit: 20 }),
            getJourneyConversionPaths(botId, 'meeting_booked', { period, limit: 5 }),
            getJourneyConversionPaths(botId, 'handoff_requested', { period, limit: 5 }),
            getJourneyConversionPaths(botId, 'offline_message_sent', { period, limit: 5 }),
            getJourneyPostChat(botId, { period, limit: 10 }),
            // Fetch 6 so the diagram's MAX_SEQUENCE_ROWS=6 slot has data
            // to render — asking for 5 while the UI slot allows 6 meant
            // the sixth row was dead code and never appeared.
            getJourneyPreChatSequences(botId, { period, limit: 6 }),
          ]);

        if (cancelled) return;
        setState({
          status: 'ready',
          error: null,
          data: {
            summary,
            topPages: { all: topAll, pre: topPre, chat: topChat, post: topPost },
            conversionPaths: {
              meeting_booked: meeting,
              handoff_requested: handoff,
              offline_message_sent: offline,
            },
            postChat,
            preChatSequences,
          },
        });
        setLastUpdatedAt(Date.now());
      } catch (cause) {
        if (cancelled) return;
        // The `status` field is set by `buildApiError` on every API error.
        // 402 is the plan gate; everything else is a real failure.
        const status = (cause as { status?: number })?.status;
        const message = cause instanceof Error && cause.message ? cause.message : 'Something went wrong.';
        if (status === 402) {
          setState({ status: 'gated', data: null, error: null });
        } else {
          setState((prev) =>
            prev.data ? { status: 'ready', data: prev.data, error: null } : { status: 'error', data: null, error: message },
          );
        }
      } finally {
        if (!cancelled) setRefreshing(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [botId, period, reloadToken]);

  const reload = useCallback(() => {
    setRefreshing(true);
    setState((prev) =>
      prev.data ? prev : { ...prev, status: prev.status === 'gated' ? 'gated' : 'loading', error: null },
    );
    setReloadToken((n) => n + 1);
  }, []);

  // Auto-refetch when the user brings this tab back to focus. Owners
  // typically test a journey on their site, then flip back to the
  // /journey tab expecting the diagram to reflect what they just did;
  // without this the page keeps showing whatever it fetched on mount.
  useEffect(() => {
    if (botId == null) return;
    const onFocus = (): void => reload();
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') reload();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [botId, reload]);

  // Poll while the tab is visible so a live-facing owner sees fresh
  // sessions land without switching tabs. Skipped when the tab is
  // hidden so we don't waste round-trips on a backgrounded page.
  useEffect(() => {
    if (botId == null) return;
    const POLL_MS = 15_000;
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') reload();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [botId, reload]);

  return {
    status: state.status,
    data: state.data,
    error: state.error,
    refreshing,
    period,
    setPeriod,
    reload,
    lastUpdatedAt,
  };
}
