import { useCallback, useEffect, useRef, useState } from 'react';
import { getChatHistory } from '../../services/api';
import { getAuthItem } from '../../utils/authStorage';
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
} from './liveChatProtocol';
import { mergeHistoryWithLive, parseHistoryMessage } from './liveChatHelpers';

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
  typingBySession: Record<string, boolean>;
  presenceBySession: Record<string, VisitorPresence>;
  unreadBySession: Record<string, number>;
  visitorReadAtBySession: Record<string, number>;
  roster: RosterOperator[];
  /** Bumped whenever the backend signals the qualified-session list may have changed. */
  qualifiedVersion: number;
  /** Latest resolution per session for a proactive connect-request. */
  connectResolutions: Record<string, ConnectResolution>;
  lastError: string | null;
}

export interface OperatorSocketApi extends OperatorSocketState {
  sendMessage: (sessionId: string, content: string) => boolean;
  sendTyping: (sessionId: string) => void;
  sendReadReceipt: (sessionId: string, lastReadId: number) => void;
  loadHistory: (sessionId: string) => Promise<void>;
  clearUnread: (sessionId: string) => void;
  clearConnectResolution: (sessionId: string) => void;
}

const TYPING_THROTTLE_MS = 2000;
const API_BASE_URL = (import.meta.env.VITE_API_URL as string | undefined) || 'https://api.oyechats.com';

interface UseOperatorSocketOptions {
  /** Connect only when true (operator online + workspace ready). */
  enabled: boolean;
}

/**
 * useOperatorSocket — owns the `/ws/operator` connection and every piece of
 * real-time conversation state. Conversation state is keyed by session id and is
 * selection-agnostic: the panel decides which session to render. Handles the full
 * protocol (queue, accept, transfer, close, typing, presence, read receipts,
 * roster, qualified-session invalidation) plus reconnect-with-backoff and the
 * duplicate-tab (4001) close.
 *
 * All `setState` runs inside async socket/timer callbacks — never synchronously in
 * an effect body — to satisfy react-hooks/set-state-in-effect and to avoid
 * updating state after unmount.
 */
export function useOperatorSocket({ enabled }: UseOperatorSocketOptions): OperatorSocketApi {
  const [status, setStatus] = useState<ConnectionStatus>('idle');
  const [operatorId, setOperatorId] = useState<number | null>(null);
  const [operatorName, setOperatorName] = useState<string | null>(null);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [activeChats, setActiveChats] = useState<Record<string, ActiveChat>>({});
  const [messagesBySession, setMessagesBySession] = useState<Record<string, OperatorMessage[]>>({});
  const [typingBySession, setTypingBySession] = useState<Record<string, boolean>>({});
  const [presenceBySession, setPresenceBySession] = useState<Record<string, VisitorPresence>>({});
  const [unreadBySession, setUnreadBySession] = useState<Record<string, number>>({});
  const [visitorReadAtBySession, setVisitorReadAtBySession] = useState<Record<string, number>>({});
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
        break;
      }

      case 'queue_update': {
        setQueue(Array.isArray(msg.waiting) ? msg.waiting : []);
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
        // Prune the session from EVERY per-session map so a closed conversation
        // leaves no transcript/metadata behind for the tab's lifetime.
        const dropKey = <T,>(prev: Record<string, T>): Record<string, T> => {
          if (!(sid in prev)) return prev;
          const next = { ...prev };
          delete next[sid];
          return next;
        };
        setActiveChats(dropKey);
        setPresenceBySession(dropKey);
        setMessagesBySession(dropKey);
        setUnreadBySession(dropKey);
        setTypingBySession(dropKey);
        setVisitorReadAtBySession(dropKey);
        setConnectResolutions(dropKey);
        // Refs are not React state — clear them imperatively.
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
    if (!token) {
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
        return; // another tab owns the channel — do not reconnect
      }
      if (event.code === AUTH_FAILED_CLOSE_CODE) {
        terminalCloseRef.current = true;
        if (mountedRef.current) {
          setStatus('idle');
          setLastError(event.reason || 'Live chat authentication failed.');
        }
        return;
      }

      // Reflect not-OPEN immediately — even on the first drop — so the composer
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
      // `mountedRef` is owned by the dedicated unmount effect — don't flip it here,
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
  useEffect(() => {
    if (!enabled) return;
    const wake = (): void => {
      // Never revive a socket closed on a terminal code (4001 duplicate-tab /
      // 4003 auth-failed) — those deliberately do not reconnect. Reconnecting
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
      // Operator messages are routed to the visitor only — echo optimistically.
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
      const history = await getChatHistory(sessionId, { limit: 50 });
      if (!mountedRef.current) return;
      const parsed = history.map(parseHistoryMessage);
      // Merge (don't replace) so live WS messages that landed between accept and
      // this GET returning aren't discarded.
      setMessagesBySession((prev) => ({ ...prev, [sessionId]: mergeHistoryWithLive(parsed, prev[sessionId]) }));
    } catch {
      if (!mountedRef.current) return;
      setMessagesBySession((prev) => (prev[sessionId] ? prev : { ...prev, [sessionId]: [] }));
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
    typingBySession,
    presenceBySession,
    unreadBySession,
    visitorReadAtBySession,
    roster,
    qualifiedVersion,
    connectResolutions,
    lastError,
    sendMessage,
    sendTyping,
    sendReadReceipt,
    loadHistory,
    clearUnread,
    clearConnectResolution,
  };
}
