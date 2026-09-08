import { createContext, useContext } from 'react';
import type { OperatorStatusState } from '../features/inbox/useOperatorStatus';

/**
 * The operator's presence, shared by everything that needs it.
 *
 * Its own module because `OperatorPresence.tsx` exports a component and a file
 * that exports both components and plain values loses fast refresh. The reason
 * this is ONE value rather than a hook each caller runs: two components calling
 * `useOperatorStatus` separately would each hold their own `isOnline`, so
 * toggling "Taking chats" in the inbox header would leave the shell's socket
 * gate reading a stale one.
 */
export interface OperatorPresenceValue extends OperatorStatusState {
  /** The workspace's plan includes live chat at all. */
  liveChat: boolean;
  /** Holds an operator seat, whether or not they are on duty right now. */
  isOperator: boolean;
  /** Entitlements are still resolving; nothing should be concluded yet. */
  planLoading: boolean;
}

export const OperatorPresenceContext = createContext<OperatorPresenceValue | null>(null);

export function useOperatorPresence(): OperatorPresenceValue {
  const value = useContext(OperatorPresenceContext);
  if (!value) throw new Error('useOperatorPresence must be used inside an OperatorPresenceProvider');
  return value;
}
