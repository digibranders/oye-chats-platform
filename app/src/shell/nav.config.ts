import { Home, Bot, Inbox, Users, BarChart3, Building2, Settings, type LucideIcon } from 'lucide-react';
import { JourneyIcon } from './icons/JourneyIcon';

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /** Match the route exactly (used for the index "/" Home link). */
  end?: boolean;
  /** Short description for the command palette. */
  hint?: string;
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
  { to: '/', label: 'Home', icon: Home, end: true, hint: 'Daily overview' },
  { to: '/agents', label: 'Chatbots', icon: Bot, hint: 'Create, train and manage chatbots' },
  { to: '/inbox', label: 'Support', icon: Inbox, hint: 'Live chat and messages', allowOperator: true },
  { to: '/leads', label: 'Leads', icon: Users, hint: 'Captured leads and qualification', allowOperator: true },
  { to: '/journey', label: 'Journey', icon: JourneyIcon, hint: 'Visitor journey flow' },
  { to: '/analytics', label: 'Analytics', icon: BarChart3, hint: 'Performance across chatbots' },
  { to: '/workspace', label: 'Workspace', icon: Building2, hint: 'Members, billing and usage' },
];

/** Secondary, bottom-anchored nav - preferences, separate from the primary
 *  object-nav. Account/workspace switching stays in the TopBar menu. */
export const SECONDARY_NAV: NavItem[] = [
  { to: '/settings', label: 'Settings', icon: Settings, hint: 'Profile, workspace and preferences', allowOperator: true },
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
