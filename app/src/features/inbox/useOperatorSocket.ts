import { useCallback, useEffect, useRef, useState } from 'react';
import { getChatHistory } from '../../services/api';
import { getAuthItem } from '../../utils/authStorage';
import { isImpersonating } from '../../utils/impersonation';
import {
  AUTH_FAILED_CLOSE_CODE,
  buildSubprotocol,
  type ActiveChat,
  type ConnectRequestOutcome,
  type ConnectionStatus,
  deriveWsUrl,
  DUPLICATE_TAB_CLOSE_CODE,
  heartbeatInterval,
  type InboundMessage,
  type OperatorMessage,
  parseInboundMessage,
  type OutboundMessage,
  type QueueItem,
  reconnectDelay,
  type RosterOperator,
  type VisitorPresence,
  type SessionEnding,
} from './liveChatProtocol';
import { mergeHistoryWithLive, parseHistoryMessage } from './liveChatHelpers';
import { alertOperator, ensureNotificationPermission } from './notifications';

/** Resolution of a proactive connect-request, surfaced to the panel. */
export interface ConnectResolution {
  outcome: ConnectRequestOutcome;
  visitorName: string | null;
  at: number;
}

export interface OperatorSocketState {
  status: ConnectionStatus;
  operatorId: number | null;
  operatorName: string | null;
  queue: QueueItem[];
  activeChats: Record<string, ActiveChat>;
  messagesBySession: Record<string, OperatorMessage[]>;
  /** How a conversation ended, for the ones that are no longer active. */
  endedBySession: Record<string, SessionEnding>;
  /** The server's own view of this operator's availability, or null before `init`. */
  serverOnline: boolean | null;
  typingBySession: Record<string, boolean>;
  presenceBySession: Record<string, VisitorPresence>;
  unreadBySession: Record<string, number>;
  visitorReadAtBySession: Record<string, number>;
  /** Whether an older page of history may exist for a session (drives "Load earlier"). */
  hasMoreBySession: Record<string, boolean>;
  roster: RosterOperator[];
  /** Bumped whenever the backend signals the qualified-session list may have changed. */
  qualifiedVersion: number;
  /** Latest resolution per session for a proactive connect-request. */
  connectResolutions: Record<string, ConnectResolution>;
  lastError: string | null;
}

/** An uploaded attachment ready to be broadcast to the visitor. */
export interface OutboundFile {
  file_url: string;
  filename: string;
  content_type: string;
}

export interface OperatorSocketApi extends OperatorSocketState {
  sendMessage: (sessionId: string, content: string) => boolean;
  sendFile: (sessionId: string, file: OutboundFile) => boolean;
  sendTyping: (sessionId: string) => void;
  sendReadReceipt: (sessionId: string, lastReadId: number) => void;
  loadHistory: (sessionId: string) => Promise<void>;
  /** Fetch and prepend the previous page of history for a session. */
  loadOlder: (sessionId: string) => Promise<void>;
  clearUnread: (sessionId: string) => void;
  clearConnectResolution: (sessionId: string) => void;
}

const TYPING_THROTTLE_MS = 2000;
const HISTORY_PAGE_SIZE = 50;
const API_BASE_URL = (import.meta.env.VITE_API_URL as string | undefined) || 'https://api.oyechats.com';

interface UseOperatorSocketOptions {
  /** Connect only when true (operator online + workspace ready). */
  enabled: boolean;
}

/**
 * useOperatorSocket - owns the `/ws/operator` connection and every piece of
 * real-time conversation state. Conversation state is keyed by session id and is
 * selection-agnostic: the panel decides which session to render. Handles the full
 * protocol (queue, accept, transfer, close, typing, presence, read receipts,
 * roster, qualified-session invalidation) plus reconnect-with-backoff and the
 * duplicate-tab (4001) close.
 *
 * All `setState` runs inside async socket/timer callbacks - never synchronously in
 * an effect body - to satisfy react-hooks/set-state-in-effect and to avoid
 * updating state after unmount.
 */
export function useOperatorSocket({ enabled }: UseOperatorSocketOptions): OperatorSocketApi {
  const [status, setStatus] = useState<ConnectionStatus>('idle');
  const [operatorId, setOperatorId] = useState<number | null>(null);
  const [operatorName, setOperatorName] = useState<string | null>(null);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [activeChats, setActiveChats] = useState<Record<string, ActiveChat>>({});
  const [messagesBySession, setMessagesBySession] = useState<Record<string, OperatorMessage[]>>({});
  /** How a conversation ended, kept so the board can say so rather than just losing it. */
  const [endedBySession, setEndedBySession] = useState<Record<string, SessionEnding>>({});
  /** The server's view of this operator's availability, from `init`. */
  const [serverOnline, setServerOnline] = useState<boolean | null>(null);
  const [typingBySession, setTypingBySession] = useState<Record<string, boolean>>({});
  const [presenceBySession, setPresenceBySession] = useState<Record<string, VisitorPresence>>({});
  const [unreadBySession, setUnreadBySession] = useState<Record<string, number>>({});
  const [visitorReadAtBySession, setVisitorReadAtBySession] = useState<Record<string, number>>({});
  const [hasMoreBySession, setHasMoreBySession] = useState<Record<string, boolean>>({});
  const [roster, setRoster] = useState<RosterOperator[]>([]);
  const [qualifiedVersion, setQualifiedVersion] = useState(0);
  const [connectResolutions, setConnectResolutions] = useState<Record<string, ConnectResolution>>({});
  const [lastError, setLastError] = useState<string | null>(null);

  // ── Refs (stable across renders; avoid stale closures + reconnect churn) ──
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const pingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const typingSentAtRef = useRef<Record<string, number>>({});
  const sentReadIdRef = useRef<Record<string, number>>({});
  const typingTimeoutsRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const operatorIdRef = useRef<number | null>(null);
  // Mirror of messagesBySession so `loadOlder` can read the current oldest DB id
  // (before its fetch) without depending on state in its callback. Synced in an
  // effect - `loadOlder` only runs on a user click, well after commit.
  const messagesBySessionRef = useRef<Record<string, OperatorMessage[]>>({});
  // Last-known waiting-queue size, so a `queue_update` only alerts when the
  // queue actually grew (not on every roster/state refresh that reships it).
  const prevQueueCountRef = useRef(0);
  const mountedRef = useRef(true);
  const manualCloseRef = useRef(false);
  // Set when the socket closes on a terminal code (4001 duplicate-tab / 4003
  // auth-failed) that must NOT auto-reconnect. Guards wake() so a visibility/
  // online event can't restart a reconnect war or hammer a rejected auth.
  const terminalCloseRef = useRef(false);
  // Bumped by the backoff timer to re-run the connect effect.
  const [reconnectNonce, setReconnectNonce] = useState(0);

  const send = useCallback((payload: OutboundMessage): boolean => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    try {
      socket.send(JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  }, []);

  const applyInbound = useCallback((msg: InboundMessage): void => {
    switch (msg.type) {
      case 'pong':
        break;

      case 'init': {
        operatorIdRef.current = msg.operator_id;
        setOperatorId(msg.operator_id);
        setOperatorName(msg.operator_name);
        // The server's own view of whether this operator is taking chats. It
        // was typed by the protocol and never read, so availability came only
        // from a REST poll and the two could disagree indefinitely — the badge
        // said "Online" while the server had stopped routing to them.
        if (typeof msg.is_online === 'boolean') setServerOnline(msg.is_online);
        break;
      }

      case 'queue_update': {
        const waiting = Array.isArray(msg.waiting) ? msg.waiting : [];
        if (waiting.length > prevQueueCountRef.current) {
          alertOperator('New chat waiting', 'A visitor is waiting for a live agent.');
        }
        prevQueueCountRef.current = waiting.length;
        setQueue(waiting);
        break;
      }

      case 'operators_update': {
        setRoster(Array.isArray(msg.operators) ? msg.operators : []);
        break;
      }

      case 'message':
      case 'file': {
        const sid = msg.session_id;
        const dbId = typeof msg.id === 'number' ? msg.id : null;
        const entry: OperatorMessage =
          msg.type === 'file'
            ? {
                key: dbId != null ? `srv-${dbId}` : `file-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                dbId,
                role: msg.role,
                content: msg.file_url,
                timestamp: msg.timestamp,
                fileUrl: msg.file_url,
                filename: msg.filename,
                contentType: msg.content_type,
              }
            : {
                key: dbId != null ? `srv-${dbId}` : `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                dbId,
                role: msg.role,
                content: msg.content,
                timestamp: msg.timestamp,
              };
        setMessagesBySession((prev) => {
          const existing = prev[sid] ?? [];
          // Dedupe echoes of a persisted message by DB id.
          if (dbId != null && existing.some((m) => m.dbId === dbId)) return prev;
          return { ...prev, [sid]: [...existing, entry] };
        });
        if (msg.role === 'user') {
          setUnreadBySession((prev) => ({ ...prev, [sid]: (prev[sid] ?? 0) + 1 }));
          setTypingBySession((prev) => (prev[sid] ? { ...prev, [sid]: false } : prev));
          const preview =
            msg.type === 'file'
              ? msg.filename || 'Sent a file'
              : typeof msg.content === 'string' && msg.content.trim()
                ? msg.content.slice(0, 120)
                : 'New message';
          alertOperator('New message from a visitor', preview);
        }
        break;
      }

      case 'visitor_typing': {
        const sid = msg.session_id;
        setTypingBySession((prev) => ({ ...prev, [sid]: true }));
        const timers = typingTimeoutsRef.current;
        if (timers[sid]) clearTimeout(timers[sid]);
        timers[sid] = setTimeout(() => {
          if (!mountedRef.current) return;
          setTypingBySession((prev) => (prev[sid] ? { ...prev, [sid]: false } : prev));
        }, 3000);
        break;
      }

      case 'visitor_stopped_typing': {
        const sid = msg.session_id;
        const timers = typingTimeoutsRef.current;
        if (timers[sid]) clearTimeout(timers[sid]);
        setTypingBySession((prev) => (prev[sid] ? { ...prev, [sid]: false } : prev));
        break;
      }

      case 'chat_accepted': {
        const sid = msg.session_id;
        const chat: ActiveChat = {
          session_id: sid,
          visitor_name: msg.visitor_name || 'Anonymous',
          reason: msg.reason ?? null,
          bot_id: msg.bot_id ?? null,
          bot_name: msg.bot_name ?? null,
          visitor_online: true,
        };
        setActiveChats((prev) => ({ ...prev, [sid]: chat }));
        setPresenceBySession((prev) => ({ ...prev, [sid]: 'online' }));
        setQueue((prev) => prev.filter((q) => q.session_id !== sid));
        break;
      }

      case 'chat_transferred':
      case 'chat_closed': {
        const sid = msg.session_id;
        const dropKey = <T,>(prev: Record<string, T>): Record<string, T> => {
          if (!(sid in prev)) return prev;
          const next = { ...prev };
          delete next[sid];
          return next;
        };

        /*
          Record HOW the conversation ended, and by whom.

          These two cases used to share one branch and one outcome: the chat
          simply vanished from the board. An operator who transferred a
          conversation got no confirmation that it had reached anyone, and
          `transferred_to` — which the protocol has always carried — was never
          read. Closing behaved the same way, so a conversation the operator had
          just resolved disappeared with no way to re-read what was said.
        */
        setEndedBySession((prev) => ({
          ...prev,
          [sid]: {
            reason: msg.type === 'chat_transferred' ? 'transferred' : 'closed',
            transferredTo:
              msg.type === 'chat_transferred'
                ? ((msg as { transferred_to?: string }).transferred_to ?? null)
                : null,
            at: Date.now(),
          },
        }));

        setActiveChats(dropKey);
        setPresenceBySession(dropKey);
        // The transcript deliberately survives. An operator who has just closed
        // or handed off a conversation still needs to read it — to write a note,
        // to answer a colleague, or to check what they promised.
        setUnreadBySession(dropKey);
        setTypingBySession(dropKey);
        setVisitorReadAtBySession(dropKey);
        setConnectResolutions(dropKey);
        // Refs are not React state - clear them imperatively.
        delete typingSentAtRef.current[sid];
        delete sentReadIdRef.current[sid];
        const pendingTyping = typingTimeoutsRef.current[sid];
        if (pendingTyping) {
          clearTimeout(pendingTyping);
          delete typingTimeoutsRef.current[sid];
        }
        break;
      }

      case 'active_chats_restore': {
        const chats = Array.isArray(msg.chats) ? msg.chats : [];
        if (chats.length === 0) break;
        setActiveChats((prev) => {
          const next = { ...prev };
          for (const c of chats) {
            next[c.session_id] = {
              session_id: c.session_id,
              visitor_name: c.visitor_name || 'Anonymous',
              reason: c.reason ?? null,
              bot_id: c.bot_id ?? null,
              bot_name: c.bot_name ?? null,
              visitor_online: Boolean(c.visitor_online),
            };
          }
          return next;
        });
        setPresenceBySession((prev) => {
          const next = { ...prev };
          for (const c of chats) next[c.session_id] = c.visitor_online ? 'online' : 'disconnected';
          return next;
        });
        break;
      }

      case 'visitor_disconnected': {
        setPresenceBySession((prev) => ({ ...prev, [msg.session_id]: 'disconnected' }));
        break;
      }

      case 'visitor_reconnected': {
        setPresenceBySession((prev) => ({ ...prev, [msg.session_id]: 'online' }));
        break;
      }

      case 'qualified_bot_changed': {
        setQualifiedVersion((v) => v + 1);
        break;
      }

      case 'connect_request_resolved': {
        const sid = msg.session_id;
        setConnectResolutions((prev) => ({
          ...prev,
          [sid]: { outcome: msg.outcome, visitorName: msg.visitor_name ?? null, at: Date.now() },
        }));
        break;
      }

      case 'read_receipt': {
        // Only the visitor→operator direction reaches an operator socket.
        if (msg.reader === 'visitor' && msg.session_id) {
          setVisitorReadAtBySession((prev) => ({ ...prev, [msg.session_id as string]: Date.now() }));
        }
        break;
      }

      case 'error': {
        setLastError(msg.message || 'A live-chat error occurred.');
        break;
      }

      default:
        break;
    }
  }, []);

  // ── Connection lifecycle ──
  useEffect(() => {
    mountedRef.current = true;
    if (!enabled) {
      // Tear down any existing socket; report idle asynchronously.
      manualCloseRef.current = true;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (pingTimerRef.current) clearInterval(pingTimerRef.current);
      socketRef.current?.close();
      socketRef.current = null;
      reconnectAttemptsRef.current = 0;
      queueMicrotask(() => {
        if (mountedRef.current) setStatus('idle');
      });
      // No socket to tear down; the dedicated unmount effect owns `mountedRef`.
      return undefined;
    }

    const token = getAuthItem('admin_token');
    const authType = getAuthItem('auth_type');
    // Never open the operator channel from an impersonated tab. The only
    // credential available is the shared `admin_token` (the super-admin's own
    // key) so the socket would join live-chat as the ADMIN while the rest of
    // the page shows the impersonated Account, and the backend cannot
    // revalidate an impersonation token on this channel (revoke/expiry would
    // not close it). Taking over a live visitor conversation is outside the
    // support-diagnostic scope anyway (design §6.2).
    if (!token || isImpersonating()) {
      queueMicrotask(() => {
        if (mountedRef.current) setStatus('idle');
      });
      return undefined;
    }

    manualCloseRef.current = false;
    terminalCloseRef.current = false;
    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);

    const wsUrl = `${deriveWsUrl(API_BASE_URL)}/ws/operator`;
    const subprotocol = buildSubprotocol(token, authType);

    queueMicrotask(() => {
      if (mountedRef.current) {
        setStatus(reconnectAttemptsRef.current > 0 ? 'reconnecting' : 'connecting');
      }
    });

    let socket: WebSocket;
    try {
      socket = new WebSocket(wsUrl, [subprotocol]);
    } catch {
      // Schedule a retry via the backoff path.
      const delay = reconnectDelay(reconnectAttemptsRef.current);
      reconnectAttemptsRef.current += 1;
      reconnectTimerRef.current = setTimeout(() => {
        if (mountedRef.current) setReconnectNonce((n) => n + 1);
      }, delay);
      return () => {
        mountedRef.current = false;
      };
    }
    socketRef.current = socket;

    const startHeartbeat = (): void => {
      if (pingTimerRef.current) clearInterval(pingTimerRef.current);
      const delay = heartbeatInterval(typeof document === 'undefined' || document.visibilityState === 'visible');
      pingTimerRef.current = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) {
          try {
            socket.send(JSON.stringify({ type: 'ping' }));
            socket.send(JSON.stringify({ type: 'heartbeat' }));
          } catch {
            socket.close();
          }
        }
      }, delay);
    };

    const onVisibility = (): void => startHeartbeat();

    socket.onopen = () => {
      reconnectAttemptsRef.current = 0;
      if (mountedRef.current) {
        setStatus('connected');
        setLastError(null);
      }
      startHeartbeat();
      if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);
    };

    socket.onmessage = (event: MessageEvent) => {
      const parsed = parseInboundMessage(event.data);
      if (parsed && mountedRef.current) applyInbound(parsed);
    };

    socket.onclose = (event: CloseEvent) => {
      if (pingTimerRef.current) clearInterval(pingTimerRef.current);
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
      if (manualCloseRef.current) return;

      if (event.code === DUPLICATE_TAB_CLOSE_CODE) {
        terminalCloseRef.current = true;
        if (mountedRef.current) setStatus('duplicate');
        return; // another tab owns the channel - do not reconnect
      }
      if (event.code === AUTH_FAILED_CLOSE_CODE) {
        terminalCloseRef.current = true;
        if (mountedRef.current) {
          setStatus('idle');
          setLastError(event.reason || 'Live chat authentication failed.');
        }
        return;
      }

      // Reflect not-OPEN immediately - even on the first drop - so the composer
      // disables and the badge stops claiming "Live" before the backoff elapses.
      const delay = reconnectDelay(reconnectAttemptsRef.current);
      if (mountedRef.current) setStatus('reconnecting');
      reconnectAttemptsRef.current += 1;
      reconnectTimerRef.current = setTimeout(() => {
        if (mountedRef.current) setReconnectNonce((n) => n + 1);
      }, delay);
    };

    socket.onerror = () => {
      // `onclose` always follows and owns the reconnect decision.
    };

    return () => {
      // `mountedRef` is owned by the dedicated unmount effect - don't flip it here,
      // or a reconnect (deps re-run) would wrongly mark the still-mounted hook dead.
      manualCloseRef.current = true;
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
      if (pingTimerRef.current) clearInterval(pingTimerRef.current);
      socket.onopen = null;
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
      socket.close();
    };
  }, [enabled, reconnectNonce, applyInbound]);

  // Immediate reconnect when the operator returns to the tab / network restored.
  // Keep the messages ref in step with state for `loadOlder`.
  useEffect(() => {
    messagesBySessionRef.current = messagesBySession;
  }, [messagesBySession]);

  // Ask for native-notification permission once the operator goes online, so a
  // hidden tab can still surface new-chat alerts.
  useEffect(() => {
    if (enabled) ensureNotificationPermission();
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    const wake = (): void => {
      // Never revive a socket closed on a terminal code (4001 duplicate-tab /
      // 4003 auth-failed) - those deliberately do not reconnect. Reconnecting
      // here would start a duplicate-tab war or re-hammer a rejected auth.
      if (terminalCloseRef.current) return;
      const socket = socketRef.current;
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        reconnectAttemptsRef.current = 0;
        if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
        setReconnectNonce((n) => n + 1);
      }
    };
    const onVisible = (): void => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') wake();
    };
    window.addEventListener('online', wake);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('online', wake);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [enabled]);

  useEffect(
    () => () => {
      mountedRef.current = false;
      const timers = typingTimeoutsRef.current;
      for (const key of Object.keys(timers)) clearTimeout(timers[key]);
    },
    [],
  );

  // ── Actions ──
  const sendMessage = useCallback(
    (sessionId: string, content: string): boolean => {
      const trimmed = content.trim();
      if (!trimmed) return false;
      const ok = send({ type: 'message', session_id: sessionId, content: trimmed });
      if (!ok) return false;
      // Operator messages are routed to the visitor only - echo optimistically.
      const entry: OperatorMessage = {
        key: `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        dbId: null,
        role: 'operator',
        content: trimmed,
        timestamp: new Date().toISOString(),
      };
      setMessagesBySession((prev) => ({ ...prev, [sessionId]: [...(prev[sessionId] ?? []), entry] }));
      return true;
    },
    [send],
  );

  const sendFile = useCallback(
    (sessionId: string, file: OutboundFile): boolean => {
      const ok = send({
        type: 'file',
        session_id: sessionId,
        role: 'operator',
        file_url: file.file_url,
        filename: file.filename,
        content_type: file.content_type,
      });
      if (!ok) return false;
      // Echo optimistically, mirroring sendMessage - the file is delivered to
      // the visitor only, so the server does not bounce it back to us.
      const entry: OperatorMessage = {
        key: `local-file-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        dbId: null,
        role: 'operator',
        content: file.file_url,
        timestamp: new Date().toISOString(),
        fileUrl: file.file_url,
        filename: file.filename,
        contentType: file.content_type,
      };
      setMessagesBySession((prev) => ({ ...prev, [sessionId]: [...(prev[sessionId] ?? []), entry] }));
      return true;
    },
    [send],
  );

  const sendTyping = useCallback(
    (sessionId: string): void => {
      const now = Date.now();
      const last = typingSentAtRef.current[sessionId] ?? 0;
      if (now - last < TYPING_THROTTLE_MS) return;
      typingSentAtRef.current[sessionId] = now;
      send({ type: 'typing', session_id: sessionId });
    },
    [send],
  );

  const sendReadReceipt = useCallback(
    (sessionId: string, lastReadId: number): void => {
      if (!lastReadId) return;
      if ((sentReadIdRef.current[sessionId] ?? 0) >= lastReadId) return;
      const ok = send({ type: 'read_receipt', session_id: sessionId, last_read_id: lastReadId });
      if (ok) sentReadIdRef.current[sessionId] = lastReadId;
    },
    [send],
  );

  const loadHistory = useCallback(async (sessionId: string): Promise<void> => {
    try {
      const history = await getChatHistory(sessionId, { limit: HISTORY_PAGE_SIZE });
      if (!mountedRef.current) return;
      const parsed = history.map(parseHistoryMessage);
      // Merge (don't replace) so live WS messages that landed between accept and
      // this GET returning aren't discarded.
      setMessagesBySession((prev) => ({ ...prev, [sessionId]: mergeHistoryWithLive(parsed, prev[sessionId]) }));
      // A full page back implies there may be an earlier page to page into.
      setHasMoreBySession((prev) => ({ ...prev, [sessionId]: history.length >= HISTORY_PAGE_SIZE }));
    } catch {
      if (!mountedRef.current) return;
      setMessagesBySession((prev) => (prev[sessionId] ? prev : { ...prev, [sessionId]: [] }));
    }
  }, []);

  // Prepend the previous page, anchored before the oldest DB message we hold.
  const loadOlder = useCallback(async (sessionId: string): Promise<void> => {
    const current = messagesBySessionRef.current[sessionId] ?? [];
    let oldestDbId = 0;
    for (const m of current) {
      if (typeof m.dbId === 'number' && (oldestDbId === 0 || m.dbId < oldestDbId)) oldestDbId = m.dbId;
    }
    if (!oldestDbId) return;
    try {
      const older = await getChatHistory(sessionId, { beforeId: oldestDbId, limit: HISTORY_PAGE_SIZE });
      if (!mountedRef.current) return;
      const parsed = older.map(parseHistoryMessage);
      setMessagesBySession((prev) => {
        const existing = prev[sessionId] ?? [];
        const knownDbIds = new Set<number>();
        for (const m of existing) if (m.dbId != null) knownDbIds.add(m.dbId);
        const fresh = parsed.filter((m) => m.dbId == null || !knownDbIds.has(m.dbId));
        return fresh.length === 0 ? prev : { ...prev, [sessionId]: [...fresh, ...existing] };
      });
      setHasMoreBySession((prev) => ({ ...prev, [sessionId]: older.length >= HISTORY_PAGE_SIZE }));
    } catch {
      /* leave hasMore as-is so the operator can retry */
    }
  }, []);

  const clearUnread = useCallback((sessionId: string): void => {
    setUnreadBySession((prev) => (prev[sessionId] ? { ...prev, [sessionId]: 0 } : prev));
  }, []);

  const clearConnectResolution = useCallback((sessionId: string): void => {
    setConnectResolutions((prev) => {
      if (!(sessionId in prev)) return prev;
      const next = { ...prev };
      delete next[sessionId];
      return next;
    });
  }, []);

  return {
    status,
    operatorId,
    operatorName,
    queue,
    activeChats,
    messagesBySession,
    endedBySession,
    serverOnline,
    typingBySession,
    presenceBySession,
    unreadBySession,
    visitorReadAtBySession,
    hasMoreBySession,
    roster,
    qualifiedVersion,
    connectResolutions,
    lastError,
    sendMessage,
    sendFile,
    sendTyping,
    sendReadReceipt,
    loadHistory,
    loadOlder,
    clearUnread,
    clearConnectResolution,
  };
}
