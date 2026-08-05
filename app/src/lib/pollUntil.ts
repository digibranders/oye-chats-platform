/**
 * pollUntil - re-run an async read until it satisfies a predicate, or give up.
 *
 * Exists because several billing outcomes are settled by an out-of-band Razorpay
 * webhook rather than by the request the user just made. The checkout modal
 * closes, our verify endpoint confirms the signature, and the local subscription
 * row flips over some seconds later when `subscription.activated` lands. A
 * single refetch on success therefore reads pre-webhook state and the UI shows
 * the customer the opposite of what happened - which is exactly how a paid
 * reactivation kept rendering the "won't renew" banner.
 *
 * Deliberately dependency-free: this app has no react-query/SWR, so there is no
 * refetch-until-fresh primitive to reuse.
 *
 * The predicate decides success; a rejected read is treated as "not yet" and
 * retried, because a transient 502 mid-convergence is not a failed payment.
 */
export interface PollUntilOptions<T> {
  /** The read to repeat. Rejections are swallowed and retried. */
  read: () => Promise<T>;
  /** Returns true once the read reflects the state we are waiting for. */
  done: (value: T) => boolean;
  /** Milliseconds between attempts. Default 2000. */
  intervalMs?: number;
  /** Give up after this long. Default 60000. */
  timeoutMs?: number;
  /** Checked before every attempt so an unmounting caller can bail out. */
  cancelled?: () => boolean;
}

export type PollUntilResult<T> =
  | { status: 'settled'; value: T }
  | { status: 'timeout' }
  | { status: 'cancelled' };

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function pollUntil<T>({
  read,
  done,
  intervalMs = 2000,
  timeoutMs = 60000,
  cancelled,
}: PollUntilOptions<T>): Promise<PollUntilResult<T>> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    if (cancelled?.()) return { status: 'cancelled' };

    try {
      const value = await read();
      if (done(value)) return { status: 'settled', value };
    } catch {
      // Swallow and retry - see the note above on transient failures.
    }

    if (cancelled?.()) return { status: 'cancelled' };
    // Check the deadline AFTER an attempt so timeoutMs shorter than intervalMs
    // still performs one read rather than returning without trying.
    if (Date.now() >= deadline) return { status: 'timeout' };

    await sleep(intervalMs);
  }
}
