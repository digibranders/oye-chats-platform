import { type ReactNode } from 'react';
import { InboxSocketContext } from './inboxSocket';
import { useOperatorSocket } from './useOperatorSocket';

/**
 * Owns the operator websocket, above the inbox's scopes.
 *
 * This is the fix for the worst defect the audit found. The live-chat panel used
 * to call `useOperatorSocket` itself and was rendered conditionally, so
 * switching to the Messages tab unmounted it, tore down `/ws/operator`, and
 * threw away every transcript, unread count, presence flag and typing state on
 * the board. Coming back reconnected from scratch and refetched history — while
 * a visitor was mid-conversation.
 *
 * Mounting the socket here means the connection is owned by the *page*, which is
 * what actually corresponds to "the operator is at their desk". Everything below
 * it is a view onto that one connection.
 */
export function InboxSocketProvider({
  enabled,
  isOperator,
  children,
}: {
  enabled: boolean;
  /** The caller holds an operator seat, whether or not they are on duty. */
  isOperator: boolean;
  children: ReactNode;
}) {
  const socket = useOperatorSocket({ enabled, isOperator });
  return <InboxSocketContext.Provider value={socket}>{children}</InboxSocketContext.Provider>;
}
