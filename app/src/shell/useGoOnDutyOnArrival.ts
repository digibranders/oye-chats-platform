import { useEffect, useRef } from 'react';
import type { OperatorPresenceValue } from './operatorPresenceContext';

/**
 * Go on duty on arriving at the inbox, once.
 *
 * Lifted out of `useOperatorStatus` when the status moved up to the shell: the
 * hook is now mounted for the whole session, so an `enableOnMount` option on it
 * would mean "on duty from login", which is a different and much worse promise.
 * Firing it from the inbox keeps the original meaning — opening the inbox IS
 * the act of sitting down at it, and an operator who had to flip the switch
 * every visit spent the first minute of every session invisible to the queue.
 *
 * At most once per mount of the caller, which is the whole safety of it: an
 * operator who then switches themselves off stays off, because the guard has
 * been spent. Nothing re-arms it until they leave the page and come back, which
 * is the same gesture as arriving.
 */
export function useGoOnDutyOnArrival(operator: OperatorPresenceValue): void {
  const { loading, unavailable, isOnline, saving, toggle, liveChat } = operator;
  const spent = useRef(false);
  useEffect(() => {
    if (spent.current) return;
    if (!liveChat || loading || unavailable || isOnline || saving) return;
    spent.current = true;
    void toggle();
  }, [liveChat, loading, unavailable, isOnline, saving, toggle]);
}
