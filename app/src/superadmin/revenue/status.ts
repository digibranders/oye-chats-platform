import type { Tone } from '../../ui';

/**
 * Subscription lifecycle, as words and a tone.
 *
 * The server's `valid_statuses` set is the source of truth
 * (`superadmin_plan_routes.update_subscription`); this maps it, and falls
 * through to neutral for anything new rather than crashing or inventing a
 * colour. Colour is never the only signal — every badge that uses these also
 * prints the label.
 */
export const SUBSCRIPTION_STATUSES = [
  'active',
  'trialing',
  'past_due',
  'canceled',
  'paused',
  'expired',
] as const;

export type KnownSubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

const SUBSCRIPTION_TONE: Record<KnownSubscriptionStatus, Tone> = {
  active: 'success',
  // Not success: a trial is revenue that has not happened yet, and painting it
  // green makes a board of trials look like a board of customers.
  trialing: 'warning',
  past_due: 'danger',
  canceled: 'neutral',
  paused: 'neutral',
  expired: 'neutral',
};

const SUBSCRIPTION_LABEL: Record<KnownSubscriptionStatus, string> = {
  active: 'Active',
  trialing: 'Trialing',
  past_due: 'Past due',
  canceled: 'Canceled',
  paused: 'Paused',
  expired: 'Expired',
};

function isKnown(status: string): status is KnownSubscriptionStatus {
  return (SUBSCRIPTION_STATUSES as readonly string[]).includes(status);
}

export function subscriptionTone(status: string | null | undefined): Tone {
  if (!status || !isKnown(status)) return 'neutral';
  return SUBSCRIPTION_TONE[status];
}

export function subscriptionLabel(status: string | null | undefined): string {
  if (!status) return 'Unknown';
  if (isKnown(status)) return SUBSCRIPTION_LABEL[status];
  // An unmapped status is shown verbatim. Rewriting it to "Unknown" would hide
  // the one piece of information an operator needs to go and look it up.
  return status;
}

/** The statuses that are money on the books right now. */
export function isPaying(status: string | null | undefined): boolean {
  return status === 'active' || status === 'past_due';
}
