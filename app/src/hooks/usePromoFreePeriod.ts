import { useEffect, useState } from 'react';
import { getCurrentSubscription } from '../services/api';

/**
 * usePromoFreePeriod - the launch-promo free-period end for the current account,
 * or null when the account is not on an active offer.
 *
 * Returns the ISO `promo_free_until` string only while it is still in the future
 * (an active free window). The check runs once in the effect, so nothing impure
 * touches render. Callers show a "Free until X" affordance when this is set, so
 * a promo customer knows they are on the offer and not yet being billed.
 */
export function usePromoFreePeriod(): string | null {
  const [freeUntil, setFreeUntil] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getCurrentSubscription()
      .then((raw) => {
        if (cancelled) return;
        const sub = (raw as { subscription?: Record<string, unknown> } | null)?.subscription;
        const value = sub?.promo_free_until;
        if (typeof value === 'string' && new Date(value).getTime() > Date.now()) {
          setFreeUntil(value);
        }
      })
      .catch(() => {
        /* no subscription / not on an offer - leave null */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return freeUntil;
}

export default usePromoFreePeriod;
