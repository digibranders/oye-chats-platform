import { createContext, useContext } from 'react';
import type { OperatorSocketApi } from './useOperatorSocket';

/**
 * The operator socket, shared by everything on the inbox.
 *
 * Context and hook live apart from the provider component so the provider file
 * exports a component and nothing else — which is what keeps fast refresh
 * working on the one surface where losing state mid-edit means dropping a live
 * connection.
 */
export const InboxSocketContext = createContext<OperatorSocketApi | null>(null);

export function useInboxSocket(): OperatorSocketApi {
  const socket = useContext(InboxSocketContext);
  if (!socket) {
    throw new Error('useInboxSocket must be used inside an InboxSocketProvider');
  }
  return socket;
}
