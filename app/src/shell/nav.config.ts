import { Home, Bot, Inbox, Users, BarChart3, Building2, Settings, type LucideIcon } from 'lucide-react';
import { JourneyIcon } from './icons/JourneyIcon';

export interface NavItem {
  to: string;
  /**
   * English label. Also the inline fallback when a dictionary has no entry.
   *
   * This list is a module constant, so anything rendered straight from it
   * freezes its English at import and would survive a language switch
   * untouched. Consumers must render `t(item.labelKey) || item.label`.
   */
  label: string;
  /** Dictionary key for {@link label}. */
  labelKey: string;
  icon: LucideIcon;
  /** Match the route exactly (used for the index "/" Home link). */
  end?: boolean;
  /** Short description for the command palette. */
  hint?: string;
  /** Dictionary key for {@link hint}. */
  hintKey?: string;
  /** Visible to a plain operator acting in someone else's workspace. Operators
   *  get an inbox-scoped view; owner/admin surfaces (Home, Chatbots, Analytics,
   *  Workspace) are hidden and route-guarded. */
  allowOperator?: boolean;
}

/**
 * The primary sidebar. Sourced from a single list so the Sidebar and the
 * Command Palette can't drift apart. The Admin Platform 2.0 mandate
 * specified six primary destinations; the scratch ``Journey1`` slot is
 * a temporary extra during ongoing experimentation and will be removed
 * (or promoted) once the design settles.
 */
export const PRIMARY_NAV: NavItem[] = [
  { to: '/', label: 'Home', labelKey: 'nav.home', icon: Home, end: true, hint: 'Daily overview', hintKey: 'nav.homeHint' },
  { to: '/agents', label: 'Chatbots', labelKey: 'nav.agents', icon: Bot, hint: 'Create, train and manage chatbots', hintKey: 'nav.agentsHint' },
  { to: '/inbox', label: 'Support', labelKey: 'nav.inbox', icon: Inbox, hint: 'Live chat and messages', hintKey: 'nav.inboxHint', allowOperator: true },
  { to: '/leads', label: 'Leads', labelKey: 'nav.leads', icon: Users, hint: 'Captured leads and qualification', hintKey: 'nav.leadsHint', allowOperator: true },
  { to: '/journey', label: 'Journey', labelKey: 'nav.journey', icon: JourneyIcon, hint: 'Visitor journey flow', hintKey: 'nav.journeyHint' },
  { to: '/analytics', label: 'Analytics', labelKey: 'nav.analytics', icon: BarChart3, hint: 'Performance across chatbots', hintKey: 'nav.analyticsHint' },
  { to: '/workspace', label: 'Workspace', labelKey: 'nav.workspace', icon: Building2, hint: 'Members, billing and usage', hintKey: 'nav.workspaceHint' },
];

/** Secondary, bottom-anchored nav - preferences, separate from the primary
 *  object-nav. Account/workspace switching stays in the TopBar menu. */
export const SECONDARY_NAV: NavItem[] = [
  { to: '/settings', label: 'Settings', labelKey: 'nav.settings', icon: Settings, hint: 'Profile, workspace and preferences', hintKey: 'nav.settingsHint', allowOperator: true },
];

/**
 * The route prefixes a plain operator may reach. Kept in lock-step with the
 * `allowOperator` flags above and enforced at the route layer by
 * `OperatorRouteGuard` so nav-hiding can never be the only line of defence.
 */
export const OPERATOR_ALLOWED_PREFIXES: readonly string[] = ['/inbox', '/leads', '/settings'];

/** Filter a nav list to what the current seat role is allowed to see. */
export function navForRole(items: NavItem[], isOperator: boolean): NavItem[] {
  return isOperator ? items.filter((item) => item.allowOperator) : items;
}

/** Whether a pathname is reachable by a plain operator (route-guard predicate). */
export function isOperatorAllowedPath(pathname: string): boolean {
  return OPERATOR_ALLOWED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}
