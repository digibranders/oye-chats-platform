import type { ReactElement, ReactNode } from 'react';
import type { Bot } from '../types/domain';

/** Type shim for the legacy JS `context/BotContext.jsx`. */

export interface BotContextValue {
  bots: Bot[];
  selectedBot: Bot | null;
  selectBot: (bot: Bot) => void;
  refreshBots: () => Promise<Bot[]>;
  loading: boolean;
  error: { message: string; status: number | null } | null;
}

export const BotProvider: (props: { children: ReactNode }) => ReactElement;
export function useBotContext(): BotContextValue;
