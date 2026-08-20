import {
  Activity,
  Boxes,
  CreditCard,
  Database,
  Landmark,
  Settings2,
  Users,
  type LucideIcon,
} from 'lucide-react';

export interface PlatformNavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /** What lives here, for the section index pages. */
  blurb: string;
}

export interface PlatformNavGroup {
  /**
   * Names the group. Omitted for the opening block.
   *
   * A label only earns its place over three or more rows: four of the five
   * groups here introduced a single row each, at roughly 38px of chrome — a
   * 16px margin, a 16px label and 6px of padding — to present one 36px row.
   * The header-to-content ratio in a 248px column was worse than 1:1. Linear
   * and Stripe both flatten below four items and label a group only at three.
   */
  label?: string;
  items: PlatformNavItem[];
}

export const PLATFORM_ROOT = '/platform';

/**
 * The platform console's navigation.
 *
 * Grouped by the job somebody is doing, not by the router file the endpoints
 * happen to live in. There are about a hundred `/superadmin/*` routes and no UI
 * for any of them, so the first decision is what they are *for*: watching the
 * platform, supporting a customer, looking something up, understanding the
 * money, and configuring the machine.
 *
 * One labelled group, not five. It was Watch (1 item), Support (1), Money (3),
 * Data (1) and Machine (1) — four eyebrows existing to introduce a single row
 * each, and about 110px of a 248px column spent on headers nobody needed.
 * Money is the only set of peers here that a reader benefits from seeing named.
 */
export const PLATFORM_NAV: PlatformNavGroup[] = [
  {
    items: [
      {
        to: `${PLATFORM_ROOT}`,
        label: 'Command centre',
        icon: Activity,
        blurb: 'Live platform state: health, workers, errors and the numbers that move.',
      },
      {
        to: `${PLATFORM_ROOT}/customers`,
        label: 'Customers',
        icon: Users,
        blurb: 'Accounts, operators, sign-in identities, and support sessions.',
      },
      {
        to: `${PLATFORM_ROOT}/records`,
        label: 'Records',
        icon: Database,
        blurb: 'Every customer-owned object: chatbots, documents, sessions, leads, feedback.',
      },
    ],
  },
  {
    label: 'Money',
    items: [
      {
        to: `${PLATFORM_ROOT}/revenue`,
        label: 'Revenue',
        icon: CreditCard,
        blurb: 'Subscriptions, invoices, credits and the funnels behind them.',
      },
      {
        to: `${PLATFORM_ROOT}/billing-ops`,
        label: 'Billing operations',
        icon: Landmark,
        blurb: 'Dunning, refunds, reconciliation, GSTR export and the seller profile.',
      },
      {
        to: `${PLATFORM_ROOT}/catalogue`,
        label: 'Catalogue',
        icon: Boxes,
        blurb: 'Plans, pricing, coupons and promotions.',
      },
    ],
  },
  {
    items: [
      {
        to: `${PLATFORM_ROOT}/platform`,
        label: 'Configuration',
        icon: Settings2,
        blurb: 'Feature flags, model config, LLM cost, email templates, webhooks and the audit log.',
      },
    ],
  },
];

export const PLATFORM_ITEMS: PlatformNavItem[] = PLATFORM_NAV.flatMap((group) => group.items);

/** Exact match for the root, prefix match for everything else. */
export function isPlatformItemActive(item: PlatformNavItem, pathname: string): boolean {
  if (item.to === PLATFORM_ROOT) return pathname === PLATFORM_ROOT || pathname === `${PLATFORM_ROOT}/`;
  return pathname === item.to || pathname.startsWith(`${item.to}/`);
}
