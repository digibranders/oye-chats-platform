import {
  BarChart3,
  Bot,
  Building2,
  CreditCard,
  Gauge,
  Globe,
  House,
  Inbox,
  type LucideIcon,
  MessagesSquare,
  Settings2,
  Sparkles,
  Target,
  Users,
} from 'lucide-react';

/**
 * The console's information architecture.
 *
 * Two scopes, not one tree. A rail that lists every chatbot's six destinations
 * is O(N) in a number we sell — at six chatbots it is already sixteen rows plus
 * a footer, and at twenty it scrolls while "Settings" sits below the fold.
 * Entering a chatbot swaps the rail instead, which is O(1) at any count and is
 * what Chatbase, Vercel and Linear all settled on for the same reason.
 *
 * The other half of that decision lives in the top bar: the active chatbot is
 * named in the breadcrumb in *both* scopes, always. The audit found the
 * Experience tab streaming replies from whichever chatbot the shell switcher
 * happened to hold rather than the one in the URL, and an IA that never lets the
 * current object go unnamed makes that class of bug much harder to ship.
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
}

/**
 * Workspace scope — six destinations.
 *
 * Billing is here rather than inside Settings because running out of credits
 * stops the chatbot answering customers. That is an outage, not a preference,
 * and burying it two levels down is the wrong risk posture for the one failure
 * that silently takes the product offline.
 */
export const WORKSPACE_NAV: readonly NavItem[] = [
  { to: '/', label: 'Home', icon: House, end: true, hint: 'What needs you today' },
  { to: '/inbox', label: 'Inbox', icon: Inbox, hint: 'Live chat and messages', operator: true },
  { to: '/leads', label: 'Leads', icon: Users, hint: 'Captured leads and qualification', operator: true },
  { to: '/analytics', label: 'Analytics', icon: BarChart3, hint: 'Conversations, journeys and outcomes' },
  { to: '/chatbots', label: 'Chatbots', icon: Bot, hint: 'Create, train and deploy chatbots' },
  { to: '/billing', label: 'Billing', icon: CreditCard, hint: 'Plan, credits, invoices and usage' },
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
  { segment: 'behaviour', label: 'Behaviour', icon: Settings2, hint: 'How does it decide what to say?' },
];

/** Bottom of the rail. Settings is one home, with its own secondary column. */
export const FOOTER_NAV: readonly NavItem[] = [
  { to: '/settings', label: 'Settings', icon: Building2, hint: 'Workspace, team, integrations and your account' },
];

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
