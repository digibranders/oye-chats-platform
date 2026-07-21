/**
 * useHomeData — loads the workspace-wide Home view.
 *
 * The reused endpoints (getDashboardStats / getLeadStats / getTopQuestions /
 * getFeedbackData) are all per-bot, so we fan out across every agent and
 * aggregate client-side. Inbox messages (getOfflineMessages) are already
 * workspace-wide. Loading is DERIVED (no `data` and no `error` ⇒ loading), and
 * no state is written synchronously inside the effect — the fetch resolves
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
  getTopQuestions,
} from '../../services/api';
import type { Bot, TopQuestion } from '../../types/domain';
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

/** Fetch + aggregate every data source the Home page needs. */
async function loadHomeData(): Promise<HomeData> {
  const bots = await getBots();
  if (bots.length === 0) return EMPTY;

  // Per-agent fan-out. Each call is independently resilient so one bad agent
  // can't blank the whole dashboard.
  const perAgent = await Promise.all(
    bots.map(async (bot: Bot) => {
      const [stats, leads, questions, feedback] = await Promise.all([
        getDashboardStats(bot.id).catch(() => null),
        getLeadStats(bot.id).catch(() => null),
        getTopQuestions(bot.id).catch((): TopQuestion[] => []),
        getFeedbackData(bot.id).catch((): Array<Record<string, unknown>> => []),
      ]);
      return { bot, stats, leads, questions, feedback };
    }),
  );

  // Two separate reads: the activity feed only needs the most recent page,
  // while the "unread" count must reflect EVERY new message — counting unread
  // rows within the capped activity page would silently cap the badge at that
  // page size. `status=new` is the backend's unread state (read/replied both
  // stamp read_at), and the envelope's `total` is the filtered server-side
  // count, so it stays accurate no matter how many are unread.
  const [offlineResult, unreadResult] = await Promise.all([
    getOfflineMessages({ limit: 10 }).catch(() => ({ messages: [], total: 0, page: 1 })),
    getOfflineMessages({ status: 'new', limit: 1 }).catch(() => ({ messages: [], total: 0, page: 1 })),
  ]);

  const agents = perAgent.map(({ bot, stats, leads }) => summarizeAgent({ bot, stats, leads }));
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

export function useHomeData(): UseHomeDataResult {
  const [reloadKey, setReloadKey] = useState(0);
  const [result, setResult] = useState<Fetched>({ data: null, error: null });

  const reload = useCallback(() => {
    // Reset to the loading state from an event handler (never inside the effect).
    setResult({ data: null, error: null });
    setReloadKey((key) => key + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const data = await loadHomeData();
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
  }, [reloadKey]);

  return {
    loading: result.data === null && result.error === null,
    error: result.error,
    data: result.data,
    reload,
  };
}
