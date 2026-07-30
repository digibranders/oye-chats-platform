import {
  createContext,
  useContext,
  useMemo,
  type ReactElement,
  type ReactNode,
} from 'react';
import { useParams } from 'react-router-dom';
import { useBotContext, type BotContextValue } from './BotContext';
import { type Bot } from '../types/domain';

/**
 * AgentContext - the URL-scoped agent layer.
 *
 * An "AI Agent" in the new product IS a legacy Bot. This provider reads
 * `:agentId` from the route and resolves the matching bot from the reused
 * `BotContext`, so every agent page can read the active agent by URL alone.
 *
 * Deliberately does NOT touch `BotContext.selectedBot`: the shell-level
 * BotSwitcher is the sole writer of that scope, and having the agent route
 * mirror the URL into it would silently override the user's shell choice
 * every time they clicked into an agent. Per-agent pages that need the
 * current agent read it from `useAgent()` (URL-driven); workspace-wide pages
 * read `useBotContext().selectedBot` (switcher-driven). Two clean sources.
 */
export interface AgentContextValue {
  /** The resolved agent for the current `:agentId`, or null while loading / not found. */
  agent: Bot | null;
  /** The raw `:agentId` route param, or null when the route is missing it. */
  agentId: string | null;
  /** True while the underlying bot list is still loading. */
  loading: boolean;
  /** Non-null when the bot list failed to load. */
  error: BotContextValue['error'];
  /** Re-fetch the bot list; resolves to the fresh list. */
  refresh: () => Promise<Bot[]>;
}

const AgentContext = createContext<AgentContextValue | null>(null);

export function AgentProvider({ children }: { children: ReactNode }): ReactElement {
  const { agentId } = useParams<{ agentId: string }>();
  const { bots, refreshBots, loading, error } = useBotContext();

  // Route params are strings; Bot.id is numeric - match on the string form so a
  // missing/NaN id simply resolves to null rather than a false positive.
  const agent = useMemo<Bot | null>(() => {
    if (!agentId) return null;
    return bots.find((bot) => String(bot.id) === agentId) ?? null;
  }, [bots, agentId]);

  const value = useMemo<AgentContextValue>(
    () => ({
      agent,
      agentId: agentId ?? null,
      loading,
      error,
      refresh: refreshBots,
    }),
    [agent, agentId, loading, error, refreshBots],
  );

  return <AgentContext.Provider value={value}>{children}</AgentContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAgent(): AgentContextValue {
  const ctx = useContext(AgentContext);
  if (!ctx) {
    throw new Error('useAgent must be used within an AgentProvider');
  }
  return ctx;
}
