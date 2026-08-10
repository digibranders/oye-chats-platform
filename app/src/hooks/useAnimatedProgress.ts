import { useEffect, useState } from 'react';

/** True when the OS "reduce motion" accessibility preference is set. */
function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/**
 * useAnimatedProgress - a continuous eased 0 → 1 value that ramps over
 * `durationMs` (easeOutCubic) and restarts whenever `resetKey` changes.
 *
 * Unlike {@link useCountUp}, this returns an un-rounded float updated every
 * animation frame, so callers can drive *smooth* visuals - an SVG arc sweeping,
 * a bar filling - instead of a value that steps in whole-number jumps. Derive an
 * odometer figure from it with `Math.round(target * progress)` when you want the
 * number and the visual to move as one.
 *
 * Accessibility: honours `prefers-reduced-motion` - those users get `1`
 * immediately with no animation.
 */
export function useAnimatedProgress(durationMs = 600, resetKey: unknown = null): number {
  const [progress, setProgress] = useState<number>(() => (prefersReducedMotion() ? 1 : 0));

  useEffect(() => {
    // Reduced-motion (or a non-positive duration) collapses to the settled
    // frame. All state writes happen inside the rAF callback so nothing sets
    // state synchronously during the effect.
    const instant = prefersReducedMotion() || durationMs <= 0;
    let frame = 0;
    let startTs: number | null = null;

    const tick = (ts: number): void => {
      if (startTs === null) startTs = ts;
      const t = instant ? 1 : Math.min((ts - startTs) / durationMs, 1);
      setProgress(1 - Math.pow(1 - t, 3)); // easeOutCubic
      if (t < 1) frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [durationMs, resetKey]);

  return progress;
}

export default useAnimatedProgress;
