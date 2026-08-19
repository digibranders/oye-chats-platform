import { useCallback, useEffect, useState } from 'react';
import { RESEND_COOLDOWN_SECONDS } from './authFlow';

export interface ResendCooldown {
  /** Seconds left before another code can be requested. */
  remaining: number;
  active: boolean;
  start: () => void;
}

/**
 * The wait between one-time codes.
 *
 * Shared by both OTP screens so they cannot drift again: the verify screen
 * enforced thirty seconds while the password reset had no cooldown at all, so
 * one of two near-identical flows let people hammer the same rate limiter with
 * nothing on screen to say why the third code never arrived.
 *
 * The interval is a chain of one-second timeouts keyed on the value, which
 * means the countdown is cancelled by the same cleanup that unmounts it —
 * there is no interval left running against a component that has gone.
 */
export function useResendCooldown(seconds: number = RESEND_COOLDOWN_SECONDS): ResendCooldown {
  const [remaining, setRemaining] = useState(0);

  useEffect(() => {
    if (remaining <= 0) return;
    const timer = window.setTimeout(() => setRemaining((value) => value - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [remaining]);

  const start = useCallback(() => setRemaining(seconds), [seconds]);

  return { remaining, active: remaining > 0, start };
}
