import { useQueries, useQuery } from '@tanstack/react-query';
import { getDashboardStats, getLeadStats, getLeads, getOfflineMessages } from '../../services/api';
import { useBotContext } from '../../context/BotContext';
import { keys } from '../../query/keys';
import { agentHealth, type AgentHealth } from './agentHealth';
import type { TrendDirection } from '../../ui';
import type { Bot, Lead } from '../../types/domain';

export interface HomeAgent {
  bot: Bot;
  health: AgentHealth;
  conversations: number;
  /** This row's figure is still in flight. The page does not wait for it. */
  conversationsLoading: boolean;
}

/** The window every figure on Home covers, stated once by the `StatRow`. */
export const HOME_WINDOW_DAYS = 30;

/**
 * How many recent leads the activity card shows.
 *
 * Six, because `Columns` requires the aside to be the shorter track and six rows
 * is what keeps it under the work column at the page's ordinary shape. It is a
 * *sample* with a link to the rest, not a list — the card's header goes to
 * `/leads`, which is where an unbounded one belongs.
 *
 * Sliced here as well as sent as `limit`. A card whose height is decided by
 * whatever the server felt like returning is not a layout: the endpoint honours
 * `limit` today, and the first time it does not the aside grows past the fold
 * and takes the page's bottom edge with it.
 */
const RECENT_LIMIT = 6;

export interface HomeDelta {
  value: string;
  direction: TrendDirection;
  label: string;
}

/**
 * The change between this window and the one before it.
 *
 * `null` when there is nothing to compare against — a workspace in its first
 * month has no previous thirty days, and an arrow drawn from zero would read as
 * infinite growth. A figure with no honest comparison ships without one.
 */
function delta(current: number, previous: number): HomeDelta | null {
  if (previous <= 0) return null;
  const change = Math.round(((current - previous) / previous) * 100);
  return {
    value: `${change > 0 ? '+' : ''}${change}%`,
    direction: change > 0 ? 'up' : change < 0 ? 'down' : 'flat',
    label: `vs previous ${HOME_WINDOW_DAYS} days`,
  };
}

function conversationsIn(data: Record<string, unknown> | undefined): number {
  return Number(data?.total_conversations ?? 0);
}

/**
 * Everything Home needs, in as few requests as the API allows.
 *
 * The dashboard it replaces fanned out roughly `4N + 1` requests — four per
 * chatbot plus the list — and its own source carried a TODO admitting it. This
 * asks for per-chatbot statistics once per chatbot and nothing else, and every
 * response is cached and shared with the pages that need the same numbers, so
 * navigating Home → a chatbot → Home does not refetch any of it.
 *
 * **The headline figures do not come from the fan-out.** They are two
 * workspace-level roll-ups — `/analytics/dashboard` with no `bot_id`, once for
 * the trailing thirty days and once for sixty — which is what makes the
 * conversation figure both *anchored to a window* and *comparable to the window
 * before it*. Summing the per-chatbot responses could only ever produce an
 * unanchored all-time counter with nothing to compare it against.
 *
 * **`loading` covers the chatbot list and nothing else.** It used to be
 * `some(isPending)` across the fan-out, so a twenty-chatbot workspace held the
 * whole page in a skeleton until its slowest per-chatbot request landed. Each
 * row now resolves its own figure and says so.
 *
 * A failing statistics call yields `null` rather than zero. The previous version
 * caught the error and coerced it to `0`, so a broken chatbot rendered as a
 * quiet chatbot with no traffic and the headline totals silently understated
 * the workspace.
 */
export function useHomeData() {
  const { bots, loading: botsLoading, error: botsError, refreshBots } = useBotContext();

  const statQueries = useQueries({
    queries: bots.map((bot) => ({
      queryKey: keys.analytics.dashboard(bot.id, null),
      queryFn: () => getDashboardStats(bot.id),
      staleTime: 60_000,
    })),
  });

  const currentWindow = useQuery({
    queryKey: keys.analytics.dashboard(null, HOME_WINDOW_DAYS),
    queryFn: () => getDashboardStats(undefined, HOME_WINDOW_DAYS),
    staleTime: 60_000,
  });

  const priorWindow = useQuery({
    queryKey: keys.analytics.dashboard(null, HOME_WINDOW_DAYS * 2),
    queryFn: () => getDashboardStats(undefined, HOME_WINDOW_DAYS * 2),
    staleTime: 60_000,
  });

  const leadStats = useQuery({
    queryKey: keys.leads.stats(null),
    queryFn: () => getLeadStats(),
    staleTime: 60_000,
    retry: false,
  });

  const offline = useQuery({
    queryKey: keys.inbox.offline({ status: 'new', limit: 1 }),
    queryFn: () => getOfflineMessages({ status: 'new', limit: 1 }),
    staleTime: 30_000,
    retry: false,
  });

  // The events half of the page. A 403 here is a plan boundary, not a fault, so
  // it retries nothing and the card simply does not render.
  const recent = useQuery({
    queryKey: keys.leads.list({ botId: null, page: 1, limit: RECENT_LIMIT }),
    queryFn: () => getLeads(undefined, { page: 1, limit: RECENT_LIMIT }),
    staleTime: 60_000,
    retry: false,
  });

  const agents: HomeAgent[] = bots.map((bot, index) => ({
    bot,
    health: agentHealth(bot),
    conversations: Number(statQueries[index]?.data?.total_conversations ?? 0),
    conversationsLoading: statQueries[index]?.isPending ?? false,
  }));

  // A partial failure is reported as a partial failure. Rolling it into the
  // totals is what let a broken chatbot read as a quiet one.
  const statsIncomplete = statQueries.some((query) => query.isError);

  const conversations = conversationsIn(currentWindow.data);
  const previousConversations = Math.max(conversationsIn(priorWindow.data) - conversations, 0);
  const live = agents.filter((agent) => agent.health.state === 'live').length;

  return {
    agents,
    loading: botsLoading,
    error: botsError,
    statsIncomplete,
    retry: refreshBots,
    windowDays: HOME_WINDOW_DAYS,
    conversations,
    conversationsLoading: currentWindow.isPending,
    conversationsDelta:
      currentWindow.isPending || priorWindow.isPending ? null : delta(conversations, previousConversations),
    qualifiedLeads: Number(leadStats.data?.qualified ?? leadStats.data?.total ?? 0),
    leadsLocked: leadStats.isError,
    leadsLoading: leadStats.isPending,
    unreadMessages: Number(offline.data?.total ?? 0),
    unreadLoading: offline.isPending,
    live,
    needsAttention: agents.filter((agent) => agent.health.needsAttention),
    recentLeads: ((recent.data?.leads ?? []) as Lead[]).slice(0, RECENT_LIMIT),
    recentLoading: recent.isPending,
    recentAvailable: !recent.isError,
  };
}
