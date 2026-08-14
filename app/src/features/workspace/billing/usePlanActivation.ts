/**
 * usePlanActivation - wait for a paid plan to actually go live before the UI
 * stops talking about it.
 *
 * A Razorpay mandate moves `created → authenticated → active` out of band, and
 * the local subscription row only flips when the `subscription.activated`
 * webhook (or a lagging inline reconcile) lands. Everything the checkout call
 * itself can tell us is therefore inconclusive: `/subscriptions/verify` answers
 * `subscription_known: false`, and the plan card keeps rendering Free.
 *
 * The old behaviour - refetch now, refetch once more at 3s, then close - read
 * pre-activation state both times and left the customer looking at their old
 * plan with no explanation. That silence is what produced a second Razorpay
 * subscription and a second charge: from where they sat, nothing had happened.
 *
 * So: poll `/subscriptions/current` (the only pollable source - there is no
 * server push) until it agrees the purchased plan is live, and keep a
 * persistent, honest state on screen for the whole window. On timeout we say
 * the payment landed and activation is slow - never "try again".
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { pollUntil } from '../../../lib/pollUntil';
import { getCurrentSubscription } from '../../../services/api';
import { buildPlan, buildSubscription, type PlanView } from '../billingModel';

/**
 * One read every 2.5s. Fast enough that a typical activation (a few seconds)
 * is reflected almost immediately, slow enough that the worst case is ~36
 * cheap GETs rather than a poll storm from every customer who just paid.
 */
export const ACTIVATION_POLL_INTERVAL_MS = 2_500;

/**
 * Give up after 90s. The backend's own copy promises "usually under a minute",
 * so the window has to outlast that promise before we change our story - and
 * it comfortably outlasts the 44s of silence that produced the duplicate
 * charge in production. Past 90s this is an operations problem, not something
 * more waiting will fix.
 */
export const ACTIVATION_POLL_TIMEOUT_MS = 90_000;

/**
 * Bounds for a server-supplied `retry_after_seconds`. The hint is advice from
 * an endpoint that knows how far along the mandate is, so we prefer it - but a
 * hostile or simply wrong value must not turn this into a poll storm (too
 * small) or a poll that never reads again inside the window (too large).
 */
const MIN_HINTED_INTERVAL_MS = 1_000;
const MAX_HINTED_INTERVAL_MS = 15_000;

/**
 * Server advice about how soon the plan is worth re-reading. Sent by
 * `/subscriptions/verify-razorpay-subscription` as `retry_after_seconds`;
 * absent on older builds, in which case the local default applies.
 */
export interface ActivationHint {
  retryAfterSeconds?: number;
}

/** Resolve the hint to a poll interval, or fall back to our own default. */
export function resolveActivationInterval(hint?: ActivationHint): number {
  const seconds = hint?.retryAfterSeconds;
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) {
    return ACTIVATION_POLL_INTERVAL_MS;
  }
  return Math.min(Math.max(seconds * 1_000, MIN_HINTED_INTERVAL_MS), MAX_HINTED_INTERVAL_MS);
}

export type PlanActivationStatus = 'idle' | 'pending' | 'settled' | 'timeout';

export interface UsePlanActivationOptions {
  /** Subscription scope to read, matching the surface's own scope. */
  botId?: number | null;
  /** Fired once `/subscriptions/current` reports the purchased plan live. */
  onSettled?: (plan: PlanView) => void;
}

export interface PlanActivationResult {
  status: PlanActivationStatus;
  /** Name of the plan being activated - drives the copy. Null while idle. */
  planName: string | null;
  /**
   * True while no further purchase may be offered. Covers `timeout` as well as
   * `pending`: a customer whose activation is late must be sent to support, not
   * back to the pay button.
   */
  blocking: boolean;
  /**
   * Start (or restart) the poll for `plan`. `hint` carries the server's
   * `retry_after_seconds` when the response included one.
   */
  begin: (plan: PlanView, hint?: ActivationHint) => void;
  /** Return to idle and abandon any in-flight poll. */
  reset: () => void;
}

export function usePlanActivation({
  botId = null,
  onSettled,
}: UsePlanActivationOptions = {}): PlanActivationResult {
  const [status, setStatus] = useState<PlanActivationStatus>('idle');
  const [planName, setPlanName] = useState<string | null>(null);

  // Two ways a run stops mattering: the component went away, or a newer
  // `begin` superseded it. Both are read synchronously by `pollUntil`'s
  // `cancelled` hook, so no timer outlives the surface and no setState
  // reaches an unmounted component.
  const unmountedRef = useRef(false);
  const runRef = useRef(0);
  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
      // Invalidate the in-flight run too, so its `sleep` resolving after
      // unmount finds a cancelled generation rather than racing the flag.
      runRef.current += 1;
    };
  }, []);

  // Held in a ref so a caller passing an inline closure (every one of them
  // does) cannot re-create `begin` and, with it, restart a poll mid-flight.
  const onSettledRef = useRef(onSettled);
  useEffect(() => {
    onSettledRef.current = onSettled;
  }, [onSettled]);

  const begin = useCallback(
    (plan: PlanView, hint?: ActivationHint): void => {
      const run = runRef.current + 1;
      runRef.current = run;
      setPlanName(plan.name);
      setStatus('pending');

      const stale = (): boolean => unmountedRef.current || runRef.current !== run;

      void (async () => {
        const outcome = await pollUntil({
          read: () => getCurrentSubscription(botId ?? undefined),
          // "Live" is the purchased plan AND an `active` subscription. Status
          // matters as much as slug: a trialing customer converting their own
          // plan to paid already matches on slug, so slug alone would declare
          // victory before a single rupee had settled.
          done: (raw) => {
            const envelope = (raw ?? {}) as Record<string, unknown>;
            return (
              buildPlan(envelope.plan)?.slug === plan.slug &&
              buildSubscription(envelope.subscription).status === 'active'
            );
          },
          intervalMs: resolveActivationInterval(hint),
          timeoutMs: ACTIVATION_POLL_TIMEOUT_MS,
          cancelled: stale,
        });

        if (outcome.status === 'cancelled' || stale()) return;
        if (outcome.status === 'settled') {
          setStatus('settled');
          onSettledRef.current?.(plan);
          return;
        }
        setStatus('timeout');
      })();
    },
    [botId],
  );

  const reset = useCallback((): void => {
    runRef.current += 1;
    setStatus('idle');
    setPlanName(null);
  }, []);

  return {
    status,
    planName,
    blocking: status === 'pending' || status === 'timeout',
    begin,
    reset,
  };
}
