import {
  BarChart3,
  Bot,
  Building2,
  Compass,
  CreditCard,
  Gauge,
  Globe,
  House,
  Inbox,
  type LucideIcon,
  MessagesSquare,
  Receipt,
  Settings2,
  Sparkles,
  Target,
  Users,
} from 'lucide-react';

/**
 * The console's information architecture.
 *
 * Two scopes, not one tree. A rail that lists every chatbot's seven destinations
 * is O(N) in a number we sell — at six chatbots it is already forty-two rows plus
 * a footer, and at twenty it scrolls while "Settings" sits below the fold.
 * Entering a chatbot swaps the rail instead, which is O(1) at any count and is
 * what Chatbase, Vercel and Linear all settled on for the same reason.
 *
 * The other half of that decision lives in the top bar: the active chatbot is
 * named in the breadcrumb in *both* scopes, always. The audit found the
 * Experience tab streaming replies from whichever chatbot the shell switcher
 * happened to hold rather than the one in the URL, and an IA that never lets the
 * current object go unnamed makes that class of bug much harder to ship.
 *
 * `WORKSPACE_NAV` is the canonical list of workspace destinations — the command
 * palette, the 404's recovery menu and the breadcrumb all read it, so a
 * destination missing from here is a destination the product cannot find.
 * `placement` says only where the *rail* draws each one; it never removes a
 * destination from the IA.
 */

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /** Match the route exactly. Used for the index route. */
  end?: boolean;
  /** One line, for the command palette. */
  hint: string;
  /** Visible to a plain operator acting in someone else's workspace. */
  operator?: boolean;
  /**
   * Where the rail draws it.
   *
   * `primary` is the block under the workspace switcher. `footer` is the block
   * under the hairline, beside the account menu — reached deliberately rather
   * than scanned. `chatbots` is the tail row of the Chatbots group: the word
   * used to appear twice, forty pixels apart, as a nav row and again as the
   * label of the group listing the chatbots themselves.
   */
  placement?: 'primary' | 'footer' | 'chatbots';
}

/**
 * Workspace scope.
 *
 * Billing sits in the footer rather than the primary block. Running out of
 * credits stops the chatbot answering customers, which is an outage — but the
 * urgency is not the same as the frequency, and this is a screen a customer
 * opens twice a month. Stripe, Linear, Vercel, Intercom and Razorpay all file
 * billing beside the account and surface a failed payment as a banner instead;
 * `ShellBanners` is where that belongs, and it is now a real slot.
 */
export const WORKSPACE_NAV: readonly NavItem[] = [
  { to: '/', label: 'Home', icon: House, end: true, hint: 'What needs you today' },
  { to: '/inbox', label: 'Inbox', icon: Inbox, hint: 'Live chat and messages', operator: true },
  { to: '/leads', label: 'Leads', icon: Users, hint: 'Captured leads and qualification', operator: true },
  { to: '/analytics/journey', label: 'Journey', icon: Compass, hint: 'Visitor journey flow' },
  { to: '/analytics', label: 'Analytics', icon: BarChart3, end: true, hint: 'Conversations, journeys and outcomes' },
  { to: '/chatbots', label: 'Chatbots', icon: Bot, hint: 'Create, train and deploy chatbots', placement: 'chatbots' },
  { to: '/billing', label: 'Billing', icon: CreditCard, hint: 'Plan, credits, invoices and usage', placement: 'footer' },
];

/**
 * Agent scope — the six questions a chatbot has to answer about itself.
 *
 * "Deploy" replaces "Channels", which was a plural noun over exactly one
 * channel. "Behaviour" replaces "Advanced", which read as here-be-dragons and
 * was a dead end on the free plan. Qualification is promoted out of it, because
 * it is a revenue surface and not a technical one.
 */
export interface AgentNavItem extends Omit<NavItem, 'to'> {
  /** Appended to `/chatbots/:agentId`. */
  segment: string;
}

export const AGENT_NAV: readonly AgentNavItem[] = [
  { segment: 'overview', label: 'Overview', icon: Gauge, hint: 'Is this chatbot healthy?' },
  { segment: 'knowledge', label: 'Knowledge', icon: Sparkles, hint: 'What does it know?' },
  { segment: 'experience', label: 'Experience', icon: MessagesSquare, hint: 'What do visitors see?' },
  { segment: 'deploy', label: 'Deploy', icon: Globe, hint: 'Where is it live?' },
  { segment: 'qualification', label: 'Qualification', icon: Target, hint: 'How are leads scored?' },
  { segment: 'quotation', label: 'Quotation', icon: Receipt, hint: 'What can it price?' },
  { segment: 'behaviour', label: 'Behaviour', icon: Settings2, hint: 'How does it decide what to say?' },
];

/** Bottom of the rail. Settings is one home, with its own secondary column. */
export const FOOTER_NAV: readonly NavItem[] = [
  { to: '/settings', label: 'Settings', icon: Building2, hint: 'Workspace, team, integrations and your account', placement: 'footer' },
];

/**
 * Second-level sections, for the breadcrumb.
 *
 * Eleven routes used to render a single crumb naming their *parent*, carrying
 * `aria-current="page"` — so a screen-reader user on `/billing/usage` was told
 * the current page was "Billing". A shortened trail is fine; a wrong one is not.
 */
export const NAV_SECTIONS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  // Analytics' four sub-views became real paths (`features/analytics/tabs.ts`),
  // so the trail names all of them. It knew only `journey` — the one that had a
  // path before — which would have left `/analytics/feedback` with a bare
  // "Analytics" crumb while `/analytics/journey` got two.
  '/analytics': {
    conversations: 'Conversations',
    journey: 'Journeys',
    visitors: 'Visitors',
    feedback: 'Feedback',
  },
  '/billing': { usage: 'Usage', reports: 'Reports' },
  '/settings': {
    workspace: 'Workspace',
    team: 'Team',
    integrations: 'Integrations',
    developers: 'Developers',
    affiliate: 'Affiliate',
  },
};

/**
 * Destinations with no entry in `WORKSPACE_NAV`.
 *
 * Onboarding and the account screens are reached from the checklist and the
 * account menu rather than from the rail, so the trail used to come back empty
 * on all of them — including `/welcome`, the first screen a new customer sees.
 */
export const STANDALONE_CRUMBS: Readonly<Record<string, string>> = {
  '/setup': 'Setup',
  '/welcome': 'Welcome',
  '/account': 'Account',
};

export const ACCOUNT_SECTIONS: Readonly<Record<string, string>> = {
  preferences: 'Preferences',
};

/**
 * What a plain operator may reach.
 *
 * Kept as one list and enforced at the router, so hiding a rail row can never be
 * the only line of defence — the previous shell maintained two hand-synced lists
 * and relied on convention to keep them agreeing.
 *
 * Note what is *not* here: settings. For an operator that word means their own
 * profile and notification preferences, which is a different object at the same
 * label and the same URL as workspace settings. They reach it from the account
 * menu instead.
 */
export const OPERATOR_PREFIXES: readonly string[] = ['/inbox', '/leads', '/account'];

export function navForRole(items: readonly NavItem[], isOperator: boolean): NavItem[] {
  return isOperator ? items.filter((item) => item.operator) : [...items];
}

/** The rail's primary block: everything not filed under the fold or the group. */
export function railPrimary(isOperator: boolean): NavItem[] {
  return navForRole(WORKSPACE_NAV, isOperator).filter(
    (item) => (item.placement ?? 'primary') === 'primary',
  );
}

/** The rail's footer block, under the hairline: billing, then settings. */
export function railFooter(isOperator: boolean): NavItem[] {
  return navForRole([...WORKSPACE_NAV, ...FOOTER_NAV], isOperator).filter(
    (item) => item.placement === 'footer',
  );
}

/** The Chatbots group's tail row — the list of every chatbot. */
export const CHATBOTS_ITEM: NavItem = WORKSPACE_NAV.find((item) => item.to === '/chatbots')!;

export function isOperatorAllowedPath(pathname: string): boolean {
  return OPERATOR_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

/** The agent-scope path for a chatbot, so no caller assembles it by hand. */
export function agentPath(agentId: number | string, segment?: string): string {
  return segment ? `/chatbots/${agentId}/${segment}` : `/chatbots/${agentId}`;
}

/** True when the URL is inside a single chatbot, which is what swaps the rail. */
export function agentIdFromPath(pathname: string): string | null {
  const match = /^\/chatbots\/(\d+)(?:\/|$)/.exec(pathname);
  return match ? match[1] : null;
}
