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
 * useCountUp - animates a whole number from 0 up to `target` with an ease-out
 * curve whenever `target` changes, returning the current frame's value. Lets a
 * caller render an "odometer" tally (e.g. a lead score counting up when a record
 * is selected).
 *
 * Accessibility: honours `prefers-reduced-motion` - those users get the final
 * value immediately with no animation, and never see the 0 start frame.
 */
export function useCountUp(target: number, durationMs = 600): number {
  const [value, setValue] = useState<number>(() => (prefersReducedMotion() ? target : 0));

  useEffect(() => {
    // Reduced-motion (or a non-positive duration) collapses to a single instant
    // frame - no visible tally. All state writes happen inside the rAF callback
    // so nothing sets state synchronously during the effect.
    const instant = prefersReducedMotion() || durationMs <= 0;
    let frame = 0;
    let startTs: number | null = null;

    const tick = (ts: number): void => {
      if (startTs === null) startTs = ts;
      const progress = instant ? 1 : Math.min((ts - startTs) / durationMs, 1);
      const eased = 1 - Math.pow(1 - progress, 3); // easeOutCubic
      setValue(Math.round(target * eased));
      if (progress < 1) frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target, durationMs]);

  return value;
}

export default useCountUp;
