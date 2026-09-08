import { useMemo, type ReactNode } from 'react';
import { InboxSocketProvider } from '../features/inbox/InboxSocketContext';
import { useOperatorStatus } from '../features/inbox/useOperatorStatus';
import { useBotContext } from '../context/BotContext';
import { useEntitlements } from '../hooks/useEntitlements';
import { OperatorPresenceContext, type OperatorPresenceValue } from './operatorPresenceContext';

/**
 * Being on duty is a fact about the person, not about the page they are on.
 *
 * The operator websocket used to be owned by the inbox, and the cost of that
 * was not a missing notification — it was the operator going offline without
 * being told. Navigating to Leads unmounted `InboxSocketProvider` and closed
 * the socket; sixty seconds later the server marked them `is_online = False`,
 * dropped them from presence, and RE-QUEUED every live conversation they were
 * holding (`live_chat_service._operator_disconnect_timeout`). Nothing else
 * refreshes presence — `mark_online` is only called from the websocket path,
 * and the shell's waiting-count poll does not touch it — and `useOperatorStatus`
 * reads the status once at mount, so the console went on displaying "Taking
 * chats" the whole time.
 *
 * So the connection lives here, above the router, and follows the on-duty flag
 * instead of the route. This is not an extra socket: the server supersedes
 * duplicates with close code 4001, so the count per operator is unchanged. It
 * is FEWER connection events, because the socket no longer opens and closes on
 * every trip in and out of the inbox.
 *
 * **Going on duty is still the inbox's gesture.** Arriving at the inbox means
 * "I am at my desk"; opening the dashboard to look at a bill does not. That
 * auto-enable lives in `useGoOnDutyOnArrival`, called by the inbox, not here.
 *
 * One provider, one copy of the state. Two components calling
 * `useOperatorStatus` separately would each hold their own `isOnline`, so
 * toggling "Taking chats" in the inbox header would leave the shell's socket
 * gate looking at a stale value.
 */

export function OperatorPresenceProvider({ children }: { children: ReactNode }) {
  const { selectedBot } = useBotContext();
  const { hasFeature, loading: planLoading } = useEntitlements();
  const liveChat = hasFeature('live_chat');
  const operator = useOperatorStatus(liveChat ? selectedBot?.id : undefined);

  // Having a seat is not the same as being at the desk. The reads that DESCRIBE
  // an operator (their working language) are theirs whether or not they are
  // taking chats, so they are gated on this rather than on the connection.
  const isOperator = liveChat && !operator.loading && !operator.unavailable;
  // Connect only when they are genuinely on duty. A socket opened while they
  // are away routes visitors to a desk nobody is sitting at.
  const connect = liveChat && !operator.unavailable && operator.isOnline;

  const value = useMemo<OperatorPresenceValue>(
    () => ({ ...operator, liveChat, isOperator, planLoading }),
    [operator, liveChat, isOperator, planLoading],
  );

  return (
    <OperatorPresenceContext.Provider value={value}>
      <InboxSocketProvider enabled={connect} isOperator={isOperator}>
        {children}
      </InboxSocketProvider>
    </OperatorPresenceContext.Provider>
  );
}
