import { PLATFORM_ROOT } from '../nav';

/**
 * Revenue's sub-navigation, as data.
 *
 * In its own module because the page that renders it must export a component
 * and nothing else — a `.tsx` file exporting a helper alongside its component
 * silently breaks Fast Refresh for the whole file, which the lint rule catches
 * and which is exactly the kind of small rot this rebuild exists to avoid.
 */

export const REVENUE_BASE = `${PLATFORM_ROOT}/revenue`;

export interface RevenueTab {
  value: string;
  label: string;
  /** Relative to `REVENUE_BASE`. The empty string is the index route. */
  path: string;
}

export const REVENUE_TABS: readonly RevenueTab[] = [
  { value: 'overview', label: 'Overview', path: '' },
  { value: 'subscriptions', label: 'Subscriptions', path: 'subscriptions' },
  { value: 'invoices', label: 'Invoices', path: 'invoices' },
  { value: 'usage', label: 'Usage & credits', path: 'usage' },
  { value: 'payments', label: 'Payments', path: 'payments' },
  { value: 'growth', label: 'Growth', path: 'growth' },
];

/** The tab a pathname is on. Anything unrecognised falls back to the overview. */
export function revenueTabFor(pathname: string): string {
  const rest = pathname.startsWith(REVENUE_BASE)
    ? pathname.slice(REVENUE_BASE.length).replace(/^\//, '')
    : '';
  const segment = rest.split('/')[0] ?? '';
  return REVENUE_TABS.find((tab) => tab.path === segment)?.value ?? 'overview';
}

/** The absolute path for a tab value, or `null` when the value is not a tab. */
export function revenueTabPath(value: string): string | null {
  const tab = REVENUE_TABS.find((candidate) => candidate.value === value);
  if (!tab) return null;
  return tab.path ? `${REVENUE_BASE}/${tab.path}` : REVENUE_BASE;
}
