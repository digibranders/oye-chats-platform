/* eslint-disable react-refresh/only-export-components */
/**
 * NotificationContext - global in-app notification state for the admin
 * dashboard.
 *
 * Responsibilities:
 *
 *   1. Hydrate the bell + dropdown on mount via REST.
 *   2. Maintain a real-time stream over ``/ws/notifications`` so a new
 *      notification appears instantly in every open dashboard tab.
 *   3. Expose typed actions (markRead, markAllRead, dismiss, clear).
 *   4. Surface a transient ``incomingHandoff`` slot the
 *      LiveChatRequestBanner subscribes to. A separate slot - distinct
 *      from the persisted notification feed - lets the banner own its
 *      own dismissal lifecycle without re-rendering the entire bell.
 *
 * Failure modes:
 *
 *   - REST hydrate fails → state stays empty, polling fallback retries.
 *   - WS fails to connect → exponential-backoff reconnect; while
 *     disconnected, a 30s REST poll keeps the unread count fresh so the
 *     bell badge isn't stuck on stale numbers.
 *   - User logs out → connection closed via auth-storage listener.
 */

import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
    type ReactNode,
} from 'react';

import { getAuthItem } from '../utils/authStorage';
import { isImpersonating } from '../utils/impersonation';
import type { NotificationItem } from '../types/domain';
import {
    clearAllNotifications,
    deleteNotification,
    getUnreadNotificationCount,
    listNotifications,
    markAllNotificationsRead,
    markNotificationRead,
} from '../services/api';

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

const NotificationContext = createContext<NotificationContextValue | null>(null);

const HANDOFF_TYPE = 'handoff_request';
const MAX_KEEP = 60;
const POLL_INTERVAL_MS = 30_000;
const RECONNECT_MAX_MS = 30_000;

function resolveWsBase(): string {
    const apiBase = import.meta.env.VITE_API_URL || 'https://api.oyechats.com';
    return apiBase.replace(/^http/, 'ws').replace(/\/+$/, '');
}

function buildAuthSubprotocol(): string | null {
    // Never open this socket from an impersonated tab. The only credential
    // available here is the shared localStorage `admin_token` (the
    // super-admin's OWN key) so connecting would stream the admin's
    // notifications into a tab whose banner says "Viewing <Account>", mixing
    // two identities in one list. The server also cannot revalidate an
    // impersonation token on this channel, so revoke/expiry would not close it.
    // Impersonation is a support-diagnostic scope; live notifications are not
    // part of it.
    if (isImpersonating()) return null;

    const token = getAuthItem('admin_token');
    if (!token) return null;
    const authType = getAuthItem('auth_type');
    // Match the convention used by the live-chat /ws/operator endpoint so
    // the auth shape is identical across all dashboard WebSockets.
    return authType === 'operator' ? `operator-key.${token}` : `api-key.${token}`;
}

function dedupeById(items: NotificationItem[]): NotificationItem[] {
    const seen = new Set<number>();
    const out: NotificationItem[] = [];
    for (const item of items) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        out.push(item);
        if (out.length >= MAX_KEEP) break;
    }
    return out;
}

export function NotificationProvider({ children }: { children: ReactNode }) {
    const [items, setItems] = useState<NotificationItem[]>([]);
    const [unreadCount, setUnreadCount] = useState(0);
    const [connected, setConnected] = useState(false);
    const [loading, setLoading] = useState(true);
    const [incomingHandoff, setIncomingHandoff] = useState<NotificationItem | null>(null);

    const wsRef = useRef<WebSocket | null>(null);
    // Handle types are derived rather than pinned to `number`: the suite runs
    // under jsdom, where the Node and DOM timer signatures differ.
    const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const mountedRef = useRef(true);
    const attemptRef = useRef(0);
    const seenHandoffSessionsRef = useRef(new Set<unknown>());

    useEffect(() => {
        // Reset on every mount - critical for React StrictMode double-mount
        // in development where the ref persists across unmount→remount.
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
        };
    }, []);

    const isAuthed = useCallback((): boolean => {
        return Boolean(buildAuthSubprotocol());
    }, []);

    const hydrate = useCallback(async (): Promise<void> => {
        if (!isAuthed()) {
            setLoading(false);
            return;
        }
        try {
            const data = await listNotifications({ limit: 30 });
            if (!mountedRef.current) return;
            setItems(dedupeById(data.items || []));
            setUnreadCount(data.unread_count || 0);
        } catch (err) {
            console.warn('[Notifications] hydrate failed', err);
        } finally {
            if (mountedRef.current) setLoading(false);
        }
    }, [isAuthed]);

    const refreshUnread = useCallback(async (): Promise<void> => {
        if (!isAuthed()) return;
        try {
            const next = await getUnreadNotificationCount();
            if (mountedRef.current) setUnreadCount(next);
        } catch {
            // Silent - the WS will catch us up.
        }
    }, [isAuthed]);

    // Re-hydrate on workspace switch - notifications (handoff requests,
    // offline messages, chat transfers) are workspace-scoped, so a switch
    // from workspace A to workspace B must pull B's notifications or the
    // bell counter, dropdown, and incoming-handoff banner stay pointed at
    // A's data. Complements the abort-controller cancellation in api.js:
    // that stops A's in-flight requests, this fires the fresh fetch under B.
    useEffect(() => {
        function onWorkspaceSwitched() {
            if (isAuthed()) {
                // Reset the seen-handoff dedup set - a session id from A
                // that we've already surfaced there shouldn't suppress a
                // legitimate new handoff banner in B.
                seenHandoffSessionsRef.current = new Set();
                setIncomingHandoff(null);
                hydrate();
            }
        }
        window.addEventListener('oyechats:workspace-switched', onWorkspaceSwitched);
        return () => window.removeEventListener('oyechats:workspace-switched', onWorkspaceSwitched);
    }, [hydrate, isAuthed]);

    // ── Incoming handoff slot ──
    // Surfaces the most recent handoff request that has NOT yet been
    // dismissed by the operator. The banner subscribes to this. We track
    // already-shown session_ids in a ref so a REST hydrate after refresh
    // doesn't pop the banner for a chat the operator already saw.
    const maybeShowHandoff = useCallback((notification: NotificationItem): void => {
        if (notification?.type !== HANDOFF_TYPE) return;
        const sid = notification?.data?.session_id;
        if (!sid || seenHandoffSessionsRef.current.has(sid)) {
            console.log('[Notifications] maybeShowHandoff skipped - already seen session:', sid);
            return;
        }
        console.log('[Notifications] maybeShowHandoff - showing banner for session:', sid);
        seenHandoffSessionsRef.current.add(sid);
        setIncomingHandoff(notification);
    }, []);

    const dismissIncomingHandoff = useCallback((): void => {
        setIncomingHandoff(null);
    }, []);

    // ── Mutations ──

    const markRead = useCallback(async (id: number): Promise<void> => {
        setItems((prev) =>
            prev.map((item) =>
                item.id === id && !item.is_read
                    ? { ...item, is_read: true, read_at: new Date().toISOString() }
                    : item,
            ),
        );
        try {
            const data = await markNotificationRead(id);
            if (mountedRef.current && typeof data?.unread_count === 'number') {
                setUnreadCount(data.unread_count);
            }
        } catch (err) {
            console.warn('[Notifications] markRead failed', err);
            refreshUnread();
        }
    }, [refreshUnread]);

    const markAllRead = useCallback(async (): Promise<void> => {
        setItems((prev) =>
            prev.map((item) =>
                item.is_read ? item : { ...item, is_read: true, read_at: new Date().toISOString() },
            ),
        );
        setUnreadCount(0);
        try {
            await markAllNotificationsRead();
        } catch (err) {
            console.warn('[Notifications] markAllRead failed', err);
            refreshUnread();
        }
    }, [refreshUnread]);

    const dismiss = useCallback(async (id: number): Promise<void> => {
        // The dismissed row is read from the `items` snapshot this callback
        // closed over, NOT out of the `setItems` updater. React only promises
        // the updater runs during the subsequent render - it evaluates it
        // inline when the update queue happens to be empty - so a value
        // assigned inside it is not reliably visible to the lines below, and
        // an unread dismissal would leave the badge counting a row the user
        // has already removed until the next hydrate. Updaters stay pure.
        const removed = items.find((item) => item.id === id);
        setItems((prev) => prev.filter((item) => item.id !== id));
        if (removed && !removed.is_read) {
            setUnreadCount((n) => Math.max(0, n - 1));
        }
        try {
            await deleteNotification(id);
        } catch (err) {
            console.warn('[Notifications] dismiss failed', err);
            // On failure, re-hydrate to recover the truth.
            hydrate();
        }
    }, [hydrate, items]);

    const clearAll = useCallback(async (): Promise<void> => {
        setItems([]);
        setUnreadCount(0);
        try {
            await clearAllNotifications();
        } catch (err) {
            console.warn('[Notifications] clearAll failed', err);
            hydrate();
        }
    }, [hydrate]);

    // ── WebSocket lifecycle ──

    const connect = useCallback((): void => {
        if (!mountedRef.current) return;
        const subprotocol = buildAuthSubprotocol();
        const wsUrl = `${resolveWsBase()}/ws/notifications`;
        console.log('[Notifications] connect() invoked. URL:', wsUrl, 'Subprotocol:', subprotocol);
        if (!subprotocol) {
            console.warn('[Notifications] connect() aborted: subprotocol (token) is empty/null.');
            return;
        }
        if (wsRef.current && wsRef.current.readyState <= 1) {
            console.log('[Notifications] connect() aborted: WebSocket is already connecting or open.');
            return;
        }

        let ws;
        try {
            ws = new WebSocket(wsUrl, [subprotocol]);
        } catch (err) {
            console.warn('[Notifications] WS construct failed', err);
            scheduleReconnect();
            return;
        }
        wsRef.current = ws;

        let pingTimer: ReturnType<typeof setInterval> | null = null;

        ws.onopen = () => {
            console.log('[Notifications] WebSocket connection established successfully');
            if (!mountedRef.current) return;
            attemptRef.current = 0;
            setConnected(true);
            pingTimer = setInterval(() => {
                if (ws.readyState === WebSocket.OPEN) {
                    try { ws.send('ping'); } catch { /* swallowed */ }
                }
            }, 25_000);
        };

        ws.onmessage = (event: MessageEvent<string>) => {
            if (!mountedRef.current) return;
            // pong arrives as a plain string - JSON.parse would throw.
            if (event.data === 'pong') return;
            // Server-controlled, but still parsed into `unknown` and read
            // through optional access: a malformed frame must drop to the 30s
            // poll fallback, not corrupt the feed.
            let payload: { event?: string; unread_count?: number; notification?: NotificationItem } | null;
            try {
                payload = JSON.parse(event.data);
            } catch {
                return;
            }
            console.log('[Notifications] WebSocket message received:', payload);
            if (payload?.event === 'hello' && typeof payload.unread_count === 'number') {
                setUnreadCount(payload.unread_count);
                return;
            }
            if (payload?.event === 'notification.created' && payload.notification) {
                const notif = payload.notification;
                setItems((prev) => dedupeById([notif, ...prev]));
                if (!notif.is_read) setUnreadCount((n) => n + 1);
                maybeShowHandoff(notif);
            }
        };

        ws.onerror = (err) => {
            console.error('[Notifications] WebSocket encountered an error:', err);
        };

        ws.onclose = (event) => {
            console.warn('[Notifications] WebSocket closed. Code:', event.code, 'Reason:', event.reason);
            if (pingTimer) clearInterval(pingTimer);
            if (!mountedRef.current) return;
            setConnected(false);
            wsRef.current = null;
            scheduleReconnect();
        };
        // `scheduleReconnect` and `connect` reference each other to form
        // the reconnect loop - that mutual dependency is intentional and
        // both callbacks are wrapped in their own ``useCallback``.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [maybeShowHandoff]);

    const scheduleReconnect = useCallback((): void => {
        if (!mountedRef.current) return;
        if (reconnectTimerRef.current) return;
        attemptRef.current += 1;
        const delay = Math.min(1_000 * 2 ** Math.min(attemptRef.current - 1, 5), RECONNECT_MAX_MS);
        reconnectTimerRef.current = setTimeout(() => {
            reconnectTimerRef.current = null;
            connect();
        }, delay);
    }, [connect]);

    // Initial mount: hydrate + connect + poll fallback. Re-runs when the
    // auth credential changes (login/logout in another tab).
    useEffect(() => {
        // Ensure the flag is correct on remount (React StrictMode dev mode
        // preserves ref values across its unmount→remount cycle).
        mountedRef.current = true;

        if (!isAuthed()) {
            setLoading(false);
            return undefined;
        }

        hydrate();
        connect();

        pollTimerRef.current = setInterval(() => {
            // The WS is the primary delivery channel; polling is the
            // safety net for the (rare) sustained disconnect. When the
            // WS is down we re-hydrate the full list (not just the
            // unread count) so a notification created server-side
            // actually appears in the bell instead of just bumping the
            // badge with nothing behind it.
            if (wsRef.current?.readyState === WebSocket.OPEN) return;
            hydrate();
        }, POLL_INTERVAL_MS);

        const onFocus = () => {
            // Tab regained focus - re-hydrate unconditionally. The WS may
            // be alive but missed events while the browser throttled the
            // background tab, so an authoritative REST refresh is the
            // safer move.
            hydrate();
        };
        window.addEventListener('focus', onFocus);

        return () => {
            window.removeEventListener('focus', onFocus);
            if (pollTimerRef.current) clearInterval(pollTimerRef.current);
            if (reconnectTimerRef.current) {
                clearTimeout(reconnectTimerRef.current);
                reconnectTimerRef.current = null;
            }
            const ws = wsRef.current;
            wsRef.current = null;
            if (ws) {
                try { ws.close(1000, 'unmount'); } catch { /* ignore */ }
            }
        };
        // The `isAuthed` reference is stable (useCallback with []), so this
        // intentionally runs once per mount.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const value = useMemo<NotificationContextValue>(
        () => ({
            items,
            unreadCount,
            connected,
            loading,
            incomingHandoff,
            dismissIncomingHandoff,
            markRead,
            markAllRead,
            dismiss,
            clearAll,
            refresh: hydrate,
        }),
        [
            items,
            unreadCount,
            connected,
            loading,
            incomingHandoff,
            dismissIncomingHandoff,
            markRead,
            markAllRead,
            dismiss,
            clearAll,
            hydrate,
        ],
    );

    return (
        <NotificationContext.Provider value={value}>{children}</NotificationContext.Provider>
    );
}

export function useNotifications(): NotificationContextValue {
    const ctx = useContext(NotificationContext);
    if (!ctx) {
        // Soft fallback so a component that renders before the provider
        // mounts doesn't crash the whole tree.
        return {
            items: [],
            unreadCount: 0,
            connected: false,
            loading: false,
            incomingHandoff: null,
            dismissIncomingHandoff: () => {},
            // Async actions resolve to a Promise (not undefined) so a caller
            // that `await`s the no-provider fallback path can't throw on
            // `undefined.then`. Matches the real methods' `() => Promise<void>`
            // signature declared in NotificationContext.d.ts.
            markRead: () => Promise.resolve(),
            markAllRead: () => Promise.resolve(),
            dismiss: () => Promise.resolve(),
            clearAll: () => Promise.resolve(),
            refresh: () => Promise.resolve(),
        };
    }
    return ctx;
}
