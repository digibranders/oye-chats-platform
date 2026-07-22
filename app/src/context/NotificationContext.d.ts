import type { ReactElement, ReactNode } from 'react';
import type { NotificationItem } from '../types/domain';

/**
 * Type shim for the legacy `context/NotificationContext.jsx`. Runtime stays
 * in the `.jsx` (REST hydrate + `/ws/notifications` WebSocket stream +
 * 30s poll fallback while disconnected); this only types the provider and
 * hook the new TopBar bell consumes.
 */
export interface NotificationContextValue {
  items: NotificationItem[];
  unreadCount: number;
  connected: boolean;
  loading: boolean;
  /** Most recent un-dismissed `handoff_request` notification, for the live-chat banner. */
  incomingHandoff: NotificationItem | null;
  dismissIncomingHandoff: () => void;
  markRead: (id: number) => Promise<void>;
  markAllRead: () => Promise<void>;
  dismiss: (id: number) => Promise<void>;
  clearAll: () => Promise<void>;
  refresh: () => Promise<void>;
}

export const NotificationProvider: (props: { children: ReactNode }) => ReactElement;
/**
 * Reads the context. Returns a safe all-empty default (not a throw) when
 * rendered outside `NotificationProvider`, so a component that mounts before
 * the provider (or on a route that doesn't wrap it) never crashes the tree.
 */
export function useNotifications(): NotificationContextValue;
