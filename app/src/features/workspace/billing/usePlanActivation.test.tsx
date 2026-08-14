/**
 * The plan is not live when the checkout modal closes.
 *
 * A Razorpay mandate settles out of band, so `/subscriptions/current` keeps
 * answering "Free" for seconds after the money moved. The old code refetched
 * once immediately and once more at 3s, then gave up silently - both reads
 * landed before activation, the customer saw their old plan and no explanation,
 * and clicked Select again. That second click bought a second subscription and
 * charged ₹5,999 twice.
 *
 * These tests pin the three outcomes that matter: a late activation is still
 * noticed, one that never lands ends in an honest timeout rather than a lie,
 * and leaving the page stops everything.
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ACTIVATION_POLL_INTERVAL_MS,
  ACTIVATION_POLL_TIMEOUT_MS,
  resolveActivationInterval,
  usePlanActivation,
} from './usePlanActivation';
import type { PlanView } from '../billingModel';

const getCurrentSubscription = vi.fn();

vi.mock('../../../services/api', () => ({
  getCurrentSubscription: (...args: unknown[]) => getCurrentSubscription(...args),
}));

const ENTERPRISE = {
  id: 4,
  slug: 'enterprise',
  name: 'Enterprise',
  isPaid: true,
} as PlanView;

/** What `/subscriptions/current` answers before the activation webhook lands. */
const STILL_FREE = {
  plan: { id: 1, slug: 'free', name: 'Free' },
  subscription: { status: 'active' },
};

/** ...and after. */
const NOW_ENTERPRISE = {
  plan: { id: 4, slug: 'enterprise', name: 'Enterprise', monthly_price_cents: 599900 },
  subscription: { status: 'active' },
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  getCurrentSubscription.mockReset();
});

/** Run the poll forward by `reads` further intervals. */
async function advanceReads(reads: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ACTIVATION_POLL_INTERVAL_MS * reads);
  });
}

describe('usePlanActivation', () => {
  it('keeps looking until the plan really changes, well past the old 3s window', async () => {
    // Free on the first three reads - exactly the window the old two-shot
    // refetch gave up inside - then the webhook lands.
    getCurrentSubscription
      .mockResolvedValueOnce(STILL_FREE)
      .mockResolvedValueOnce(STILL_FREE)
      .mockResolvedValueOnce(STILL_FREE)
      .mockResolvedValue(NOW_ENTERPRISE);

    const onSettled = vi.fn();
    const { result } = renderHook(() => usePlanActivation({ onSettled }));

    await act(async () => {
      result.current.begin(ENTERPRISE);
    });

    // First read already happened and said Free: still pending, still visible.
    expect(getCurrentSubscription).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe('pending');
    expect(result.current.blocking).toBe(true);
    expect(onSettled).not.toHaveBeenCalled();

    // Reads 2 and 3 - past 3s, where the old code had already closed up shop.
    await advanceReads(2);
    expect(result.current.status).toBe('pending');
    expect(onSettled).not.toHaveBeenCalled();

    // Read 4 sees the activated plan.
    await advanceReads(1);
    expect(getCurrentSubscription).toHaveBeenCalledTimes(4);
    expect(result.current.status).toBe('settled');
    expect(result.current.blocking).toBe(false);
    expect(onSettled).toHaveBeenCalledWith(ENTERPRISE);
  });

  it('does not declare victory on the plan slug alone while a trial converts', async () => {
    // A trialing customer converting THEIR OWN plan to paid already matches on
    // slug. Only `active` means the money settled.
    getCurrentSubscription.mockResolvedValue({
      plan: { id: 4, slug: 'enterprise', name: 'Enterprise', monthly_price_cents: 599900 },
      subscription: { status: 'trialing' },
    });
    const onSettled = vi.fn();
    const { result } = renderHook(() => usePlanActivation({ onSettled }));

    await act(async () => {
      result.current.begin(ENTERPRISE);
    });
    await advanceReads(3);

    expect(result.current.status).toBe('pending');
    expect(onSettled).not.toHaveBeenCalled();
  });

  it('ends in a bounded, honest timeout rather than polling forever', async () => {
    getCurrentSubscription.mockResolvedValue(STILL_FREE);
    const onSettled = vi.fn();
    const { result } = renderHook(() => usePlanActivation({ onSettled }));

    await act(async () => {
      result.current.begin(ENTERPRISE);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ACTIVATION_POLL_TIMEOUT_MS + ACTIVATION_POLL_INTERVAL_MS);
    });

    expect(result.current.status).toBe('timeout');
    // Still blocking: a late activation must send the customer to support, not
    // back to a live pay button.
    expect(result.current.blocking).toBe(true);
    expect(onSettled).not.toHaveBeenCalled();

    // And it genuinely stopped - no runaway interval past the deadline.
    const reads = getCurrentSubscription.mock.calls.length;
    await advanceReads(10);
    expect(getCurrentSubscription).toHaveBeenCalledTimes(reads);
  });

  it('stops dead on unmount - no further reads, no setState after teardown', async () => {
    getCurrentSubscription.mockResolvedValue(STILL_FREE);
    const onSettled = vi.fn();
    const { result, unmount } = renderHook(() => usePlanActivation({ onSettled }));

    await act(async () => {
      result.current.begin(ENTERPRISE);
    });
    await advanceReads(1);
    const readsBeforeUnmount = getCurrentSubscription.mock.calls.length;
    expect(readsBeforeUnmount).toBeGreaterThan(0);

    unmount();

    // The plan activates right after the customer navigated away. Nothing may
    // fire: no read, no callback, and (enforced by React's act warnings being
    // errors in this suite) no state update on a dead component.
    getCurrentSubscription.mockResolvedValue(NOW_ENTERPRISE);
    await advanceReads(20);

    expect(getCurrentSubscription).toHaveBeenCalledTimes(readsBeforeUnmount);
    expect(onSettled).not.toHaveBeenCalled();
  });

  it('a second begin supersedes the first instead of racing it', async () => {
    getCurrentSubscription.mockResolvedValue(STILL_FREE);
    const onSettled = vi.fn();
    const { result } = renderHook(() => usePlanActivation({ onSettled }));

    await act(async () => {
      result.current.begin(ENTERPRISE);
    });
    const STANDARD = { ...ENTERPRISE, id: 3, slug: 'standard', name: 'Standard' } as PlanView;
    await act(async () => {
      result.current.begin(STANDARD);
    });
    expect(result.current.planName).toBe('Standard');

    // Only the newer run may settle, and only on ITS plan.
    getCurrentSubscription.mockResolvedValue({
      plan: { id: 3, slug: 'standard', name: 'Standard', monthly_price_cents: 94900 },
      subscription: { status: 'active' },
    });
    await advanceReads(2);

    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(onSettled).toHaveBeenCalledWith(STANDARD);
  });

  it('prefers the server’s retry hint, clamped against nonsense', () => {
    expect(resolveActivationInterval(undefined)).toBe(ACTIVATION_POLL_INTERVAL_MS);
    expect(resolveActivationInterval({})).toBe(ACTIVATION_POLL_INTERVAL_MS);
    expect(resolveActivationInterval({ retryAfterSeconds: 5 })).toBe(5_000);
    // A hint that would hammer the API, or stall the poll past the window.
    expect(resolveActivationInterval({ retryAfterSeconds: 0.01 })).toBe(1_000);
    expect(resolveActivationInterval({ retryAfterSeconds: 600 })).toBe(15_000);
    expect(resolveActivationInterval({ retryAfterSeconds: -3 })).toBe(ACTIVATION_POLL_INTERVAL_MS);
  });

  it('treats a failed read as “not yet”, not as a failed payment', async () => {
    getCurrentSubscription
      .mockRejectedValueOnce(new Error('502 Bad Gateway'))
      .mockResolvedValue(NOW_ENTERPRISE);
    const onSettled = vi.fn();
    const { result } = renderHook(() => usePlanActivation({ onSettled }));

    await act(async () => {
      result.current.begin(ENTERPRISE);
    });
    expect(result.current.status).toBe('pending');

    await advanceReads(1);
    expect(result.current.status).toBe('settled');
    expect(onSettled).toHaveBeenCalledWith(ENTERPRISE);
  });
});
