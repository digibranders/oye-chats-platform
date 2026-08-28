import { useQuery } from '@tanstack/react-query';
import { getCreditBalance, getCurrentUser } from '../services/api';
import { keys } from '../query/keys';
import type { TrialState } from '../types/domain';

/**
 * The account's trial snapshot, as `/auth/me` reports it.
 *
 * One query for both trial surfaces, sharing the session cache the rest of the
 * shell already reads, so the rail card and the banner can never disagree about
 * how many days are left.
 *
 * `null` means "no trial UI at all", which is the answer for every account that
 * never had a trial and every account long past one. The server decides that,
 * not the client: the payload is absent unless the row is trialing, lapsed, or
 * carries a mid-trial purchase whose billing has not started.
 */
export function useTrialState(): TrialState | null {
  return useSessionMe().data?.trial ?? null;
}

function useSessionMe() {
  return useQuery({
    queryKey: keys.session.me(),
    queryFn: getCurrentUser,
    staleTime: 60_000,
  });
}

/**
 * The signed-in client's id, from the same session query.
 *
 * The banner keys its dismissal on this so a shared browser cannot leak one
 * person's dismissal to the next. Reading it here rather than threading a prop
 * keeps the two trial surfaces reading one source.
 */
export function useSessionClientId(): number | null {
  return useSessionMe().data?.id ?? null;
}

/** True while the account is inside its trial and has not bought yet. */
export function isCountingDown(trial: TrialState | null): boolean {
  return trial != null && trial.status === 'trialing' && !trial.paid_plan_starts_at;
}

/**
 * Whether credits, not days, are the binding constraint.
 *
 * A customer burning credits faster than the clock needs to hear about credits;
 * one with credits to spare needs to hear about days. Comparing the two as
 * fractions of their starting values is what makes them comparable at all.
 */
export function creditsAreBinding(
  creditsRemaining: number | null | undefined,
  creditsGranted: number | null | undefined,
  daysRemaining: number | null | undefined,
  trialDays = 14,
): boolean {
  if (creditsRemaining == null || !creditsGranted || daysRemaining == null) return false;
  if (trialDays <= 0) return false;
  return creditsRemaining / creditsGranted < daysRemaining / trialDays;
}


/**
 * The account's credit balance, for the card's credits-are-binding state.
 *
 * Its own query rather than a prop, so the card can be dropped into the rail
 * without the rail knowing anything about credits. `null` while it loads, which
 * `creditsAreBinding` reads as "not binding" so the card never flickers into
 * the credits state on a cold cache.
 */
export function useTrialCreditBalance(enabled: boolean): number | null {
  const { data } = useQuery({
    queryKey: keys.billing.credits(null),
    queryFn: getCreditBalance,
    enabled,
    staleTime: 60_000,
  });
  const raw = data?.balance;
  return typeof raw === 'number' ? raw : null;
}
