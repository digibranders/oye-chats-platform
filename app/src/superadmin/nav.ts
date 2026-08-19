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
  label: string;
  items: PlatformNavItem[];
}

export const PLATFORM_ROOT = '/platform';

/**
 * The platform console's navigation.
 *
 * Grouped by the job somebody is doing, not by the router file the endpoints
 * happen to live in. There are about a hundred `/superadmin/*` routes and no UI
 * for any of them, so the first decision is what they are *for*: watching the
 * platform, supporting a customer, understanding the money, running billing,
 * shaping the catalogue, looking something up, and configuring the machine.
 * Seven groups, and every endpoint lands in exactly one.
 */
export const PLATFORM_NAV: PlatformNavGroup[] = [
  {
    label: 'Watch',
    items: [
      {
        to: `${PLATFORM_ROOT}`,
        label: 'Command centre',
        icon: Activity,
        blurb: 'Live platform state: health, workers, errors and the numbers that move.',
      },
    ],
  },
  {
    label: 'Support',
    items: [
      {
        to: `${PLATFORM_ROOT}/customers`,
        label: 'Customers',
        icon: Users,
        blurb: 'Accounts, operators, sign-in identities, and support sessions.',
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
    label: 'Data',
    items: [
      {
        to: `${PLATFORM_ROOT}/records`,
        label: 'Records',
        icon: Database,
        blurb: 'Every customer-owned object: chatbots, documents, sessions, leads, feedback.',
      },
    ],
  },
  {
    label: 'Machine',
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
