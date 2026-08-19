import { PLATFORM_ROOT } from '../nav';

/**
 * Billing operations' sub-navigation, as data.
 *
 * Ordered by how time-critical the screen is rather than alphabetically:
 * dunning is a queue of customers about to lose access, and everything else
 * here can wait a day.
 */

export const BILLING_OPS_BASE = `${PLATFORM_ROOT}/billing-ops`;

export interface BillingOpsTab {
  value: string;
  label: string;
  /** Relative to `BILLING_OPS_BASE`. The empty string is the index route. */
  path: string;
}

export const BILLING_OPS_TABS: readonly BillingOpsTab[] = [
  { value: 'dunning', label: 'Dunning', path: '' },
  { value: 'reconciliation', label: 'Reconciliation', path: 'reconciliation' },
  { value: 'gstr', label: 'GSTR export', path: 'gstr' },
  { value: 'seller', label: 'Seller profile', path: 'seller' },
  { value: 'webhooks', label: 'Webhook log', path: 'webhooks' },
];

/** The tab a pathname is on. Anything unrecognised falls back to dunning. */
export function billingOpsTabFor(pathname: string): string {
  const rest = pathname.startsWith(BILLING_OPS_BASE)
    ? pathname.slice(BILLING_OPS_BASE.length).replace(/^\//, '')
    : '';
  const segment = rest.split('/')[0] ?? '';
  return BILLING_OPS_TABS.find((tab) => tab.path === segment)?.value ?? 'dunning';
}

/** The absolute path for a tab value, or `null` when the value is not a tab. */
export function billingOpsTabPath(value: string): string | null {
  const tab = BILLING_OPS_TABS.find((candidate) => candidate.value === value);
  if (!tab) return null;
  return tab.path ? `${BILLING_OPS_BASE}/${tab.path}` : BILLING_OPS_BASE;
}
