import type { ReactElement, ReactNode } from 'react';
import type { Bot } from '../types/domain';

/** Type shim for the legacy JS `context/BotContext.jsx`. */

export interface BotContextValue {
  bots: Bot[];
  /** The active bot scope. `null` means "All agents" (workspace-aggregated). */
  selectedBot: Bot | null;
  /** Set the active bot scope. Pass `null` to select the All-agents view. */
  selectBot: (bot: Bot | null) => void;
  refreshBots: () => Promise<Bot[]>;
  loading: boolean;
  error: { message: string; status: number | null } | null;
  /** True when the user is viewing the workspace-aggregated scope. */
  isAllAgents: boolean;
}

export const BotProvider: (props: { children: ReactNode }) => ReactElement;
export function useBotContext(): BotContextValue;
