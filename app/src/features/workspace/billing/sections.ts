import type { NavTabItem } from '../../../ui';

/**
 * The three money destinations.
 *
 * Real links, not a tab row: these are three routed pages and not three panels,
 * a `tablist` promises `aria-controls` targets that do not exist, and a customer
 * is quite likely trying to send one of these pages to whoever holds the company
 * card. `NavTabs` is exactly that control — this used to be a verbatim second
 * copy of it inside `billing/BillingNav.tsx`, comment and all.
 */
export const BILLING_SECTIONS: readonly NavTabItem[] = [
  { to: '/billing', label: 'Plan', end: true },
  { to: '/billing/usage', label: 'Usage' },
  { to: '/billing/reports', label: 'Reports' },
];
