/**
 * `pollUntil` re-reads an out-of-band state (a Razorpay webhook settling a
 * subscription, a crawl finishing) until a predicate passes or a deadline
 * elapses. The tests pin the four contracts callers depend on:
 *   - a late `done` is still noticed (settled),
 *   - a `done` that never lands ends in an honest `timeout`, not a hang or lie,
 *   - a rejected read is a transient "not yet", swallowed and retried,
 *   - `cancelled` short-circuits so an unmounted caller stops polling.
 *
 * All timing is driven by fake timers advanced deterministically, so the suite
 * never waits on a real clock and leaves no pending timer behind.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { pollUntil } from './pollUntil';

describe('pollUntil', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('settles on the first read when the predicate already passes', async () => {
    const read = vi.fn().mockResolvedValue('ready');

    const result = await pollUntil({ read, done: (v) => v === 'ready' });

    expect(result).toEqual({ status: 'settled', value: 'ready' });
    expect(read).toHaveBeenCalledTimes(1); // no retry needed
  });

  it('retries across intervals until the predicate passes', async () => {
    let n = 0;
    const read = vi.fn(async () => n++);

    const promise = pollUntil({
      read,
      done: (v) => v >= 3,
      intervalMs: 2000,
      timeoutMs: 60_000,
    });

    await vi.advanceTimersByTimeAsync(6000); // three 2s gaps: reads 0,1,2,3

    await expect(promise).resolves.toEqual({ status: 'settled', value: 3 });
    expect(read).toHaveBeenCalledTimes(4);
  });

  it('waits the full interval between attempts', async () => {
    const read = vi.fn().mockResolvedValue('nope');
    const promise = pollUntil({
      read,
      done: () => false,
      intervalMs: 3000,
      timeoutMs: 60_000,
    });

    await vi.advanceTimersByTimeAsync(0); // flush the first read
    expect(read).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2999); // just short of the interval
    expect(read).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1); // interval elapsed → second read
    expect(read).toHaveBeenCalledTimes(2);

    // Let it wind down against the timeout so no timer outlives the test.
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(promise).resolves.toEqual({ status: 'timeout' });
  });

  it('times out when the predicate never passes', async () => {
    const read = vi.fn().mockResolvedValue('still-free');

    const promise = pollUntil({
      read,
      done: () => false,
      intervalMs: 2000,
      timeoutMs: 5000,
    });

    await vi.advanceTimersByTimeAsync(6000);

    // Reads at t=0,2000,4000,6000; the t=6000 read crosses the 5s deadline.
    await expect(promise).resolves.toEqual({ status: 'timeout' });
    expect(read).toHaveBeenCalledTimes(4);
  });

  it('performs at least one read even when the timeout has already elapsed', async () => {
    const read = vi.fn().mockResolvedValue('nope');

    // Deadline check runs AFTER the attempt, so timeoutMs:0 still reads once.
    const result = await pollUntil({ read, done: () => false, timeoutMs: 0 });

    expect(result).toEqual({ status: 'timeout' });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('treats a rejected read as "not yet" and retries', async () => {
    const read = vi
      .fn()
      .mockRejectedValueOnce(new Error('transient 502'))
      .mockResolvedValueOnce('ready');

    const promise = pollUntil({
      read,
      done: (v) => v === 'ready',
      intervalMs: 2000,
      timeoutMs: 60_000,
    });

    await vi.advanceTimersByTimeAsync(2000);

    await expect(promise).resolves.toEqual({ status: 'settled', value: 'ready' });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('returns cancelled without ever reading when cancelled up front', async () => {
    const read = vi.fn().mockResolvedValue('ready');

    const result = await pollUntil({
      read,
      done: () => true,
      cancelled: () => true,
    });

    expect(result).toEqual({ status: 'cancelled' });
    expect(read).not.toHaveBeenCalled();
  });

  it('returns cancelled when the caller bails out after an in-flight read', async () => {
    let cancel = false;
    const read = vi.fn(async () => {
      cancel = true; // caller unmounts while this read is resolving
      return 'still-free';
    });

    const result = await pollUntil({
      read,
      done: () => false, // would otherwise retry forever
      cancelled: () => cancel,
    });

    expect(result).toEqual({ status: 'cancelled' });
    expect(read).toHaveBeenCalledTimes(1);
  });
});
