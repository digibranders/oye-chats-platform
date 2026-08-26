import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  getActivityStats,
  getTopQuestions,
  getRatingsSummary,
  getResolutionSummary,
  getLeadStats,
} from '../../../services/api';
import { type TopQuestion } from '../../../types/domain';
import {
  parseLeadStats,
  parseRatingsSummary,
  parseResolutionSummary,
  type EngagementPoint,
  type LeadStats,
  type RatingsSummary,
  type ResolutionSummary,
} from './analytics.types';
import { t as translateNow } from '../../../i18n/i18n';

export interface AgentAnalytics {
  /** Continuous, gap-filled daily message timeline (oldest → newest). */
  engagement: EngagementPoint[];
  topQuestions: TopQuestion[];
  ratings: RatingsSummary;
  resolution: ResolutionSummary;
  /** Null when the lead-stats endpoint is unavailable for this agent. */
  leads: LeadStats | null;
}

type Status = 'loading' | 'success' | 'error';

interface State {
  status: Status;
  data: AgentAnalytics | null;
  error: string | null;
}

const EMPTY: AgentAnalytics = {
  engagement: [],
  topQuestions: [],
  ratings: { avg: null, total: 0, distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } },
  resolution: { resolved: 0, unresolved: 0, total: 0, rate: null },
  leads: null,
};

/**
 * Upper bound on the gap-filled series. A long-lived agent (years of history)
 * would otherwise materialize thousands of daily points and render them all in
 * the "All time" range - a scalability sharp edge for high-volume accounts. The
 * chart therefore shows at most the most recent year of daily volume.
 */
const MAX_TIMELINE_DAYS = 365;

/** Local `YYYY-MM-DD` key (avoids UTC drift from `toISOString`). */
function localKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Turn the server's sparse `{date, messages}[]` (only days with traffic) into a
 * continuous daily series from the earliest activity to today, so charts render
 * an honest timeline with zero-days rather than a misleading connected line.
 * Mirrors the gap-fill in the legacy `pages/Analytics.jsx:57-93`.
 */
function fillTimeline(points: readonly { date: string; messages: number }[]): EngagementPoint[] {
  const byDay = new Map<string, number>();
  for (const point of points) {
    const key = point.date.slice(0, 10);
    byDay.set(key, (byDay.get(key) ?? 0) + point.messages);
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  let start = new Date(today);
  if (points.length > 0) {
    const earliest = points
      .map((point) => {
        const [y, mo, dy] = point.date.slice(0, 10).split('-').map(Number);
        return new Date(y, (mo ?? 1) - 1, dy ?? 1);
      })
      .reduce((a, b) => (a < b ? a : b));
    start = earliest;
  } else {
    start.setDate(today.getDate() - 6);
  }

  // Bound the window so an old, high-volume agent doesn't build a giant series.
  const floor = new Date(today);
  floor.setDate(today.getDate() - (MAX_TIMELINE_DAYS - 1));
  if (start < floor) start = floor;

  const filled: EngagementPoint[] = [];
  const cursor = new Date(start);
  while (cursor <= today) {
    const key = localKey(cursor);
    filled.push({
      date: key,
      label: cursor.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      messages: byDay.get(key) ?? 0,
    });
    cursor.setDate(cursor.getDate() + 1);
  }
  return filled;
}

/**
 * Fetch every analytics slice for one agent. Loading is *derived* from an
 * internal status flag (no standalone boolean toggled in the effect), and the
 * request is cancellation-guarded so an agent switch can't apply stale data.
 */
export function useAgentAnalytics(
  agentId: number | null,
): State & { loading: boolean; reload: () => void } {
  const [state, setState] = useState<State>(() =>
    agentId === null
      ? { status: 'success', data: EMPTY, error: null }
      : { status: 'loading', data: null, error: null },
  );
  const [trackedId, setTrackedId] = useState<number | null>(agentId);
  // Bumped by `reload()` to force a manual refetch of the current agent.
  const [reloadKey, setReloadKey] = useState(0);
  const [trackedReload, setTrackedReload] = useState(0);

  // Reset when the agent changes (or on manual reload) - adjust state during
  // render (React-approved), which keeps the effect free of synchronous setState.
  if (agentId !== trackedId) {
    setTrackedId(agentId);
    setTrackedReload(reloadKey);
    setState(
      agentId === null
        ? { status: 'success', data: EMPTY, error: null }
        : { status: 'loading', data: null, error: null },
    );
  } else if (reloadKey !== trackedReload) {
    setTrackedReload(reloadKey);
    if (agentId !== null) {
      setState({ status: 'loading', data: null, error: null });
    }
  }

  const reload = useCallback(() => setReloadKey((key) => key + 1), []);

  useEffect(() => {
    if (agentId === null) return;

    let cancelled = false;

    void (async () => {
      try {
        const [activity, questions, ratings, resolution, leads] = await Promise.all([
          getActivityStats(agentId),
          getTopQuestions(agentId),
          getRatingsSummary(agentId),
          getResolutionSummary(agentId),
          getLeadStats(agentId).catch(() => null),
        ]);
        if (cancelled) return;
        setState({
          status: 'success',
          data: {
            engagement: fillTimeline(activity),
            topQuestions: questions,
            ratings: parseRatingsSummary(ratings),
            resolution: parseResolutionSummary(resolution),
            leads: leads ? parseLeadStats(leads) : null,
          },
          error: null,
        });
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : translateNow('agents.failedToLoadAnalytics') || 'Failed to load analytics.';
        setState({ status: 'error', data: null, error: message });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [agentId, reloadKey]);

  return useMemo(
    () => ({ ...state, loading: state.status === 'loading', reload }),
    [state, reload],
  );
}
