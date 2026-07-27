import { Home, Bot, Inbox, Users, BarChart3, Building2, Settings, type LucideIcon } from 'lucide-react';

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /** Match the route exactly (used for the index "/" Home link). */
  end?: boolean;
  /** Short description for the command palette. */
  hint?: string;
}

/**
 * The ONE sidebar. Exactly six primary destinations, per the Admin Platform
 * 2.0 mandate. No Build, no standalone Settings, no duplicated navigation.
 * This is the single source of truth consumed by both the Sidebar and the
 * Command Palette.
 */
export const PRIMARY_NAV: NavItem[] = [
  { to: '/', label: 'Home', icon: Home, end: true, hint: 'Daily overview' },
  { to: '/agents', label: 'Chatbots', icon: Bot, hint: 'Create, train and manage chatbots' },
  { to: '/inbox', label: 'Support', icon: Inbox, hint: 'Live chat and messages' },
  { to: '/leads', label: 'Leads', icon: Users, hint: 'Captured leads and qualification' },
  { to: '/analytics', label: 'Analytics', icon: BarChart3, hint: 'Performance across agents' },
  { to: '/workspace', label: 'Workspace', icon: Building2, hint: 'Members, billing and usage' },
];

/** Secondary, bottom-anchored nav — preferences, separate from the primary
 *  object-nav. Account/workspace switching stays in the TopBar menu. */
export const SECONDARY_NAV: NavItem[] = [
  { to: '/settings', label: 'Settings', icon: Settings, hint: 'Profile, workspace and preferences' },
];
