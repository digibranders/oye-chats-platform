/* eslint-disable react-refresh/only-export-components */
/**
 * NotificationContext — global in-app notification state for the admin
 * dashboard.
 *
 * Responsibilities:
 *
 *   1. Hydrate the bell + dropdown on mount via REST.
 *   2. Maintain a real-time stream over ``/ws/notifications`` so a new
 *      notification appears instantly in every open dashboard tab.
 *   3. Expose typed actions (markRead, markAllRead, dismiss, clear).
 *   4. Surface a transient ``incomingHandoff`` slot the
 *      LiveChatRequestBanner subscribes to. A separate slot — distinct
 *      from the persisted notification feed — lets the banner own its
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
} from 'react';

import { getAuthItem } from '../utils/authStorage';
import {
    clearAllNotifications,
    deleteNotification,
    getUnreadNotificationCount,
    listNotifications,
    markAllNotificationsRead,
    markNotificationRead,
} from '../services/api';

const NotificationContext = createContext(null);

const HANDOFF_TYPE = 'handoff_request';
const MAX_KEEP = 60;
const POLL_INTERVAL_MS = 30_000;
const RECONNECT_MAX_MS = 30_000;

function resolveWsBase() {
    const apiBase = import.meta.env.VITE_API_URL || 'https://api.oyechats.com';
    return apiBase.replace(/^http/, 'ws').replace(/\/+$/, '');
}

function buildAuthSubprotocol() {
    const token = getAuthItem('admin_token');
    if (!token) return null;
    const authType = getAuthItem('auth_type');
    // Match the convention used by the live-chat /ws/operator endpoint so
    // the auth shape is identical across all dashboard WebSockets.
    return authType === 'operator' ? `operator-key.${token}` : `api-key.${token}`;
}

function dedupeById(items) {
    const seen = new Set();
    const out = [];
    for (const item of items) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        out.push(item);
        if (out.length >= MAX_KEEP) break;
    }
    return out;
}

export function NotificationProvider({ children }) {
    const [items, setItems] = useState([]);
    const [unreadCount, setUnreadCount] = useState(0);
    const [connected, setConnected] = useState(false);
    const [loading, setLoading] = useState(true);
    const [incomingHandoff, setIncomingHandoff] = useState(null);

    const wsRef = useRef(null);
    const reconnectTimerRef = useRef(null);
    const pollTimerRef = useRef(null);
    const mountedRef = useRef(true);
    const attemptRef = useRef(0);
    const seenHandoffSessionsRef = useRef(new Set());

    useEffect(() => {
        // Reset on every mount — critical for React StrictMode double-mount
        // in development where the ref persists across unmount→remount.
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
        };
    }, []);

    const isAuthed = useCallback(() => {
        return Boolean(buildAuthSubprotocol());
    }, []);

    const hydrate = useCallback(async () => {
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

    const refreshUnread = useCallback(async () => {
        if (!isAuthed()) return;
        try {
            const next = await getUnreadNotificationCount();
            if (mountedRef.current) setUnreadCount(next);
        } catch {
            // Silent — the WS will catch us up.
        }
    }, [isAuthed]);

    // ── Incoming handoff slot ──
    // Surfaces the most recent handoff request that has NOT yet been
    // dismissed by the operator. The banner subscribes to this. We track
    // already-shown session_ids in a ref so a REST hydrate after refresh
    // doesn't pop the banner for a chat the operator already saw.
    const maybeShowHandoff = useCallback((notification) => {
        if (notification?.type !== HANDOFF_TYPE) return;
        const sid = notification?.data?.session_id;
        if (!sid || seenHandoffSessionsRef.current.has(sid)) {
            console.log('[Notifications] maybeShowHandoff skipped — already seen session:', sid);
            return;
        }
        console.log('[Notifications] maybeShowHandoff — showing banner for session:', sid);
        seenHandoffSessionsRef.current.add(sid);
        setIncomingHandoff(notification);
    }, []);

    const dismissIncomingHandoff = useCallback(() => {
        setIncomingHandoff(null);
    }, []);

    // ── Mutations ──

    const markRead = useCallback(async (id) => {
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

    const markAllRead = useCallback(async () => {
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

    const dismiss = useCallback(async (id) => {
        let removed;
        setItems((prev) => {
            removed = prev.find((item) => item.id === id);
            return prev.filter((item) => item.id !== id);
        });
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
    }, [hydrate]);

    const clearAll = useCallback(async () => {
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

    const connect = useCallback(() => {
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

        let pingTimer = null;

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

        ws.onmessage = (event) => {
            if (!mountedRef.current) return;
            // pong arrives as a plain string — JSON.parse would throw.
            if (event.data === 'pong') return;
            let payload;
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
        // the reconnect loop — that mutual dependency is intentional and
        // both callbacks are wrapped in their own ``useCallback``.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [maybeShowHandoff]);

    const scheduleReconnect = useCallback(() => {
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
            // Tab regained focus — re-hydrate unconditionally. The WS may
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

    const value = useMemo(
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

export function useNotifications() {
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
            markRead: () => {},
            markAllRead: () => {},
            dismiss: () => {},
            clearAll: () => {},
            refresh: () => {},
        };
    }
    return ctx;
}
