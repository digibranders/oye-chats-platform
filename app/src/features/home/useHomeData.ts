/**
 * useHomeData - loads the workspace-wide Home view.
 *
 * The reused endpoints (getDashboardStats / getLeadStats / getTopQuestions /
 * getFeedbackData) are all per-bot, so we fan out across every agent and
 * aggregate client-side. Inbox messages (getOfflineMessages) are already
 * workspace-wide. Loading is DERIVED (no `data` and no `error` ⇒ loading), and
 * no state is written synchronously inside the effect - the fetch resolves
 * first, matching the codebase pattern.
 *
 * TODO(perf): this issues ~4×N + 1 requests. Replace with a single server-side
 * `/dashboard/overview` aggregate endpoint once available on the API.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  getBots,
  getDashboardStats,
  getFeedbackData,
  getLeadStats,
  getOfflineMessages,
  getOperators,
  getTopQuestions,
} from '../../services/api';
import type { Bot, TopQuestion } from '../../types/domain';
import type { FeedbackItem } from '../feedback/types';
import {
  aggregateTotals,
  buildActivity,
  mergeTopQuestions,
  summarizeAgent,
  toText,
  type FeedbackBucket,
  type HomeData,
  type OfflineActivityInput,
} from './home-data';

export interface UseHomeDataResult {
  loading: boolean;
  error: string | null;
  data: HomeData | null;
  reload: () => void;
}

interface Fetched {
  data: HomeData | null;
  error: string | null;
}

const EMPTY: HomeData = {
  agents: [],
  totals: {
    conversations: 0,
    messages: 0,
    leads: 0,
    hotLeads: 0,
    successRate: 0,
  },
  topQuestions: [],
  activity: [],
  unreadMessages: 0,
};

/**
 * Fetch + aggregate every data source the Home page needs.
 *
 * When `scopedBotId` is a number, the page is scoped to that single agent (one
 * call per endpoint). When it's null, the shell is on "All agents" and Home
 * fans out across every bot and aggregates client-side.
 */
async function loadHomeData(scopedBotId: number | null): Promise<HomeData> {
  const allBots = await getBots();
  if (allBots.length === 0) return EMPTY;

  // Narrow the fan-out to the selected agent when the shell BotSwitcher has
  // one chosen; otherwise keep the workspace-wide aggregate behaviour. Falling
  // back to `allBots` when the id is stale (deleted / just switched workspaces)
  // avoids rendering an empty dashboard on the transition.
  const scopedBot = scopedBotId != null ? allBots.find((b) => b.id === scopedBotId) : null;
  const bots: Bot[] = scopedBot ? [scopedBot] : allBots;

  // Operator seats are per-bot (see MembersPage). Fetch the workspace roster
  // once and tally active operators per agent so the plan-usage meter can scope
  // "Members" to the selected agent. Non-fatal: a failure leaves the tally empty
  // (0 seats shown) rather than blanking the dashboard.
  const operatorsByBot = new Map<number, number>();
  try {
    const opsRes: unknown = await getOperators();
    const rows: Array<{ bot_id?: number | null }> = Array.isArray(opsRes)
      ? (opsRes as Array<{ bot_id?: number | null }>)
      : Array.isArray((opsRes as { operators?: unknown })?.operators)
        ? (opsRes as { operators: Array<{ bot_id?: number | null }> }).operators
        : [];
    for (const op of rows) {
      if (typeof op.bot_id === 'number') {
        operatorsByBot.set(op.bot_id, (operatorsByBot.get(op.bot_id) ?? 0) + 1);
      }
    }
  } catch {
    // Supplementary data only. Keep the dashboard rendering without seat tallies.
  }

  // Per-agent fan-out. Each call is independently resilient so one bad agent
  // can't blank the whole dashboard.
  const perAgent = await Promise.all(
    bots.map(async (bot: Bot) => {
      const [stats, leads, questions, feedback] = await Promise.all([
        getDashboardStats(bot.id).catch(() => null),
        getLeadStats(bot.id).catch(() => null),
        getTopQuestions(bot.id).catch((): TopQuestion[] => []),
        getFeedbackData(bot.id).catch((): FeedbackItem[] => []),
      ]);
      return { bot, stats, leads, questions, feedback };
    }),
  );

  // Two separate reads: the activity feed only needs the most recent page,
  // while the "unread" count must reflect EVERY new message - counting unread
  // rows within the capped activity page would silently cap the badge at that
  // page size. `status=new` is the backend's unread state (read/replied both
  // stamp read_at), and the envelope's `total` is the filtered server-side
  // count, so it stays accurate no matter how many are unread. Both reads
  // honour the current scope via `bot_id` when a single agent is active.
  const scopeParams: Record<string, unknown> = scopedBot ? { bot_id: scopedBot.id } : {};
  const [offlineResult, unreadResult] = await Promise.all([
    getOfflineMessages({ ...scopeParams, limit: 10 }).catch(() => ({ messages: [], total: 0, page: 1 })),
    getOfflineMessages({ ...scopeParams, status: 'new', limit: 1 }).catch(() => ({ messages: [], total: 0, page: 1 })),
  ]);

  const agents = perAgent.map(({ bot, stats, leads }) =>
    summarizeAgent({ bot, stats, leads, operators: operatorsByBot.get(bot.id) ?? 0 }),
  );
  const totals = aggregateTotals(agents);

  const topQuestions = mergeTopQuestions(perAgent.map(({ questions }) => questions));

  const feedbackBuckets: FeedbackBucket[] = perAgent.map(({ bot, feedback }) => ({
    botName: bot.name,
    items: feedback,
  }));
  const offline: OfflineActivityInput[] = offlineResult.messages.map((msg) => ({
    visitorName: toText(msg.visitor_name),
    message: toText(msg.message_body),
    botName: toText(msg.bot_name),
    createdAt: toText(msg.created_at),
  }));
  const activity = buildActivity(feedbackBuckets, offline);
  const unreadMessages = unreadResult.total;

  return { agents, totals, topQuestions, activity, unreadMessages };
}

export function useHomeData(botId: number | null = null): UseHomeDataResult {
  const [reloadKey, setReloadKey] = useState(0);
  const [result, setResult] = useState<Fetched>({ data: null, error: null });

  const reload = useCallback(() => {
    // Reset to the loading state from an event handler (never inside the effect).
    setResult({ data: null, error: null });
    setReloadKey((key) => key + 1);
  }, []);

  useEffect(() => {
    // On scope change the previously-loaded data briefly stays on screen while
    // the new scope's fetch runs - mirrors `useWorkspaceAnalytics` and keeps
    // this effect strictly post-await (no synchronous `setState`, per the
    // codebase's `react-hooks/set-state-in-effect` rule).
    let cancelled = false;
    void (async () => {
      try {
        const data = await loadHomeData(botId);
        if (!cancelled) setResult({ data, error: null });
      } catch (err) {
        if (!cancelled) {
          setResult({
            data: null,
            error: err instanceof Error ? err.message : 'Something went wrong loading your dashboard.',
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadKey, botId]);

  return {
    loading: result.data === null && result.error === null,
    error: result.error,
    data: result.data,
    reload,
  };
}
