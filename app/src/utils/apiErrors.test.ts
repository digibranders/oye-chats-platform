/**
 * `requiresSubscription` is the single gate that routes a paywalled API refusal
 * to the upgrade modal instead of a raw error toast. The backend's signal is
 * exactly HTTP 402 + `detail.must_subscribe === true`; anything else — a plain
 * 402, a 403, a network error with no `data`, a truthy-but-not-`true` flag —
 * must NOT be treated as the paywall, or unrelated failures would silently
 * bounce the user into a purchase flow.
 */
import { describe, expect, it } from 'vitest';

import { requiresSubscription } from './apiErrors';

describe('requiresSubscription', () => {
  it('is true for the exact paywall signal (402 + must_subscribe true)', () => {
    expect(requiresSubscription({ status: 402, data: { detail: { must_subscribe: true } } })).toBe(
      true,
    );
  });

  it('is false when the status is not 402', () => {
    expect(requiresSubscription({ status: 403, data: { detail: { must_subscribe: true } } })).toBe(
      false,
    );
    expect(requiresSubscription({ status: 500, data: { detail: { must_subscribe: true } } })).toBe(
      false,
    );
  });

  it('is false when must_subscribe is missing', () => {
    expect(requiresSubscription({ status: 402, data: { detail: {} } })).toBe(false);
    expect(requiresSubscription({ status: 402, data: {} })).toBe(false);
    expect(requiresSubscription({ status: 402 })).toBe(false);
  });

  it('is false when must_subscribe is truthy but not the boolean true', () => {
    // The check is strict `=== true`; a coerced/stringified value must not pass.
    expect(
      requiresSubscription({
        status: 402,
        data: { detail: { must_subscribe: 1 as unknown as boolean } },
      }),
    ).toBe(false);
    expect(
      requiresSubscription({
        status: 402,
        data: { detail: { must_subscribe: 'true' as unknown as boolean } },
      }),
    ).toBe(false);
    expect(
      requiresSubscription({
        status: 402,
        data: { detail: { must_subscribe: false } },
      }),
    ).toBe(false);
  });

  it('is false for a network-style error with no status or data', () => {
    expect(requiresSubscription(new Error('Network Error'))).toBe(false);
    expect(requiresSubscription({})).toBe(false);
  });

  it('is false for null / undefined / primitives (no throw)', () => {
    expect(requiresSubscription(null)).toBe(false);
    expect(requiresSubscription(undefined)).toBe(false);
    expect(requiresSubscription('402')).toBe(false);
    expect(requiresSubscription(402)).toBe(false);
    expect(requiresSubscription(true)).toBe(false);
  });
});
