/**
 * `usePromoFreePeriod` surfaces "Free until X" only while a launch-promo window
 * is genuinely still open. The behaviour that matters: it returns the ISO string
 * ONLY when `promo_free_until` is in the future, and stays `null` for an expired
 * window, a missing field, no subscription, or a failed fetch — a promo customer
 * must never be told they're free when they're being billed, and vice versa.
 */
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getCurrentSubscription = vi.fn();

vi.mock('../services/api', () => ({
  getCurrentSubscription: (...args: unknown[]) => getCurrentSubscription(...args),
}));

import { usePromoFreePeriod } from './usePromoFreePeriod';

const FUTURE = '2999-01-01T00:00:00.000Z';
const PAST = '2000-01-01T00:00:00.000Z';

beforeEach(() => {
  getCurrentSubscription.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('usePromoFreePeriod', () => {
  it('returns the promo end when it is still in the future', async () => {
    getCurrentSubscription.mockResolvedValue({ subscription: { promo_free_until: FUTURE } });

    const { result } = renderHook(() => usePromoFreePeriod());

    await waitFor(() => expect(result.current).toBe(FUTURE));
  });

  it('stays null for an expired promo window', async () => {
    getCurrentSubscription.mockResolvedValue({ subscription: { promo_free_until: PAST } });

    const { result } = renderHook(() => usePromoFreePeriod());

    // Give the resolved effect a chance to run, then assert it stayed null.
    await Promise.resolve();
    await waitFor(() => expect(getCurrentSubscription).toHaveBeenCalled());
    expect(result.current).toBeNull();
  });

  it('stays null when the field is absent', async () => {
    getCurrentSubscription.mockResolvedValue({ subscription: {} });

    const { result } = renderHook(() => usePromoFreePeriod());

    await waitFor(() => expect(getCurrentSubscription).toHaveBeenCalled());
    expect(result.current).toBeNull();
  });

  it('stays null when there is no subscription object', async () => {
    getCurrentSubscription.mockResolvedValue(null);

    const { result } = renderHook(() => usePromoFreePeriod());

    await waitFor(() => expect(getCurrentSubscription).toHaveBeenCalled());
    expect(result.current).toBeNull();
  });

  it('stays null (and does not throw) when the fetch rejects', async () => {
    getCurrentSubscription.mockRejectedValue(new Error('no subscription'));

    const { result } = renderHook(() => usePromoFreePeriod());

    await waitFor(() => expect(getCurrentSubscription).toHaveBeenCalled());
    expect(result.current).toBeNull();
  });

  it('ignores a non-string promo_free_until value', async () => {
    getCurrentSubscription.mockResolvedValue({
      subscription: { promo_free_until: 1234567890 },
    });

    const { result } = renderHook(() => usePromoFreePeriod());

    await waitFor(() => expect(getCurrentSubscription).toHaveBeenCalled());
    expect(result.current).toBeNull();
  });

  it('does not set state when the caller unmounts before the fetch resolves', async () => {
    let resolveFetch: (v: unknown) => void = () => {};
    getCurrentSubscription.mockReturnValue(
      new Promise((resolve) => {
        resolveFetch = resolve;
      }),
    );

    const { result, unmount } = renderHook(() => usePromoFreePeriod());
    unmount();
    resolveFetch({ subscription: { promo_free_until: FUTURE } });
    await Promise.resolve();

    // The cancelled guard means the late resolve is dropped; last value is null.
    expect(result.current).toBeNull();
  });
});
