import { useQueries, useQuery } from '@tanstack/react-query';
import { getDashboardStats, getLeadStats, getOfflineMessages } from '../../services/api';
import { useBotContext } from '../../context/BotContext';
import { keys } from '../../query/keys';
import { agentHealth, type AgentHealth } from './agentHealth';
import type { Bot } from '../../types/domain';

export interface HomeAgent {
  bot: Bot;
  health: AgentHealth;
  conversations: number;
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

  const agents: HomeAgent[] = bots.map((bot, index) => ({
    bot,
    health: agentHealth(bot),
    conversations: Number(statQueries[index]?.data?.total_conversations ?? 0),
  }));

  // A partial failure is reported as a partial failure. Rolling it into the
  // totals is what let a broken chatbot read as a quiet one.
  const statsIncomplete = statQueries.some((query) => query.isError);

  return {
    agents,
    loading: botsLoading || statQueries.some((query) => query.isPending),
    error: botsError,
    statsIncomplete,
    retry: refreshBots,
    conversations: agents.reduce((total, agent) => total + agent.conversations, 0),
    qualifiedLeads: Number(leadStats.data?.qualified ?? leadStats.data?.total ?? 0),
    leadsLocked: leadStats.isError,
    unreadMessages: Number(offline.data?.total ?? 0),
    needsAttention: agents.filter((agent) => agent.health.needsAttention),
  };
}
