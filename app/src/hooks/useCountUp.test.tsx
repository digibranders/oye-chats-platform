/**
 * `useCountUp` animates 0 → target on an ease-out curve, with one hard
 * accessibility contract: a `prefers-reduced-motion` user gets the final value
 * immediately and NEVER sees the 0 start frame. The animated path must also
 * actually converge on `target` (not overshoot or stall). rAF and matchMedia
 * are stubbed so frames are driven deterministically with no real clock.
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCountUp } from './useCountUp';

let rafCallbacks: FrameRequestCallback[] = [];

/** Run the next queued animation frame with an explicit timestamp. */
function drive(ts: number): void {
  const cb = rafCallbacks.shift();
  if (cb) act(() => cb(ts));
}

function stubReducedMotion(matches: boolean): void {
  vi.stubGlobal(
    'matchMedia',
    (query: string) =>
      ({
        matches,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  );
}

beforeEach(() => {
  rafCallbacks = [];
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback): number => {
    rafCallbacks.push(cb);
    return rafCallbacks.length;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useCountUp — reduced motion', () => {
  it('returns the target immediately and never renders the 0 start frame', () => {
    stubReducedMotion(true);

    const { result } = renderHook(() => useCountUp(100, 600));

    expect(result.current).toBe(100);
  });
});

describe('useCountUp — animated path', () => {
  it('starts at 0 and eases up to exactly the target', () => {
    stubReducedMotion(false);

    const { result } = renderHook(() => useCountUp(100, 600));
    expect(result.current).toBe(0); // start frame

    drive(0); // first rAF: progress 0
    expect(result.current).toBe(0);

    drive(300); // halfway through: eased, strictly between 0 and target
    expect(result.current).toBeGreaterThan(0);
    expect(result.current).toBeLessThan(100);

    drive(600); // duration elapsed: lands exactly on target
    expect(result.current).toBe(100);

    // Animation is complete — no further frame was scheduled.
    expect(rafCallbacks).toHaveLength(0);
  });

  it('collapses to the target in a single frame when duration is non-positive', () => {
    stubReducedMotion(false);

    const { result } = renderHook(() => useCountUp(42, 0));
    expect(result.current).toBe(0);

    drive(0); // instant path forces progress = 1
    expect(result.current).toBe(42);
    expect(rafCallbacks).toHaveLength(0);
  });

  it('rounds to whole numbers while animating', () => {
    stubReducedMotion(false);

    const { result } = renderHook(() => useCountUp(3, 600));
    drive(0);
    drive(200);

    expect(Number.isInteger(result.current)).toBe(true);
  });
});
