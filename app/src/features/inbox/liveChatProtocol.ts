/**
 * liveChatProtocol — the operator ⇄ backend WebSocket contract.
 *
 * Source of truth: `api/app/api/ws_routes.py` (endpoint `/ws/operator`) and
 * `api/app/services/live_chat_service.py` (ConnectionManager outbound payloads).
 * Every inbound `type` here matches a `send_json({"type": …})` the manager emits
 * to an operator socket; every outbound builder matches a branch of the operator
 * `receive_json()` loop. Keep this file in lock-step with those two modules.
 *
 * Pure types + helpers only — no React, no side effects.
 */

// ── Connection status ────────────────────────────────────────────────────────

export type ConnectionStatus =
  | 'idle' // not attempting (operator offline / not an operator)
  | 'connecting' // first handshake in flight
  | 'connected' // socket open
  | 'reconnecting' // dropped, backing off before retry
  | 'duplicate'; // closed 4001 — another tab owns the operator channel

/** WS close code the backend uses when a second tab connects for the operator. */
export const DUPLICATE_TAB_CLOSE_CODE = 4001;
/** WS close code for auth failure — do not hammer-reconnect on this. */
export const AUTH_FAILED_CLOSE_CODE = 4003;

// ── Local view models (normalised from inbound payloads / REST) ───────────────

/** A visitor waiting in the queue (from `queue_update` / REST `/operators/queue`). */
export interface QueueItem {
  session_id: string;
  name: string | null;
  reason: string | null;
  bot_id: number | null;
  bot_name: string | null;
  email?: string | null;
  location?: string | null;
  device?: string | null;
  created_at?: string | null;
}

/** One of the operator's assigned live conversations. */
export interface ActiveChat {
  session_id: string;
  visitor_name: string;
  reason: string | null;
  bot_id: number | null;
  bot_name: string | null;
  visitor_online: boolean;
}

/** A teammate in the roster (from `operators_update`, merged with REST roster). */
export interface RosterOperator {
  operator_id: number;
  name: string;
  active_chats: number;
  is_online: boolean;
}

/** Visitor presence within a live chat. */
export type VisitorPresence = 'online' | 'disconnected';

/** A single rendered message in a conversation thread. */
export interface OperatorMessage {
  /** Stable client key for React lists. */
  key: string;
  /** Server DB id when known — drives read-receipt high-water mark + dedupe. */
  dbId: number | null;
  role: 'user' | 'bot' | 'operator' | 'system';
  content: string;
  timestamp: string | null;
  fileUrl?: string;
  filename?: string;
  contentType?: string;
}

/** Outcome pushed back when a proactive connect-request resolves. */
export type ConnectRequestOutcome = 'accepted' | 'declined' | 'expired' | 'cancelled';

/** A qualified bot-session eligible for proactive takeover (REST). */
export interface QualifiedSession {
  session_id: string;
  bot_id: number | null;
  bot_name: string | null;
  name: string;
  email: string | null;
  phone: string | null;
  company: string | null;
  location: string | null;
  device: string | null;
  bant_tier: string;
  bant_score: number;
  bant_dimensions_count: number;
  last_message_preview: string | null;
  last_message_at: string | null;
}

/** Full visitor/session detail for the right-hand panel (REST). */
export interface SessionDetails {
  session_id: string;
  status: string | null;
  location: string | null;
  device: string | null;
  handoff_reason: string | null;
  created_at: string | null;
  last_active_at: string | null;
  message_count: number | null;
  bot_name: string | null;
  department_name: string | null;
  operator_name: string | null;
  visitor_metadata: Record<string, unknown> | null;
  bant: { need: string | null; timeline: string | null; authority: string | null; budget: string | null } | null;
  lead_info: {
    name: string | null;
    email: string | null;
    phone: string | null;
    company: string | null;
  } | null;
}

// ── Inbound WS messages (discriminated union on `type`) ───────────────────────

export interface WsInit {
  type: 'init';
  operator_id: number;
  operator_name: string;
  is_online: boolean;
}
export interface WsQueueUpdate {
  type: 'queue_update';
  waiting: QueueItem[];
  count: number;
}
export interface WsOperatorsUpdate {
  type: 'operators_update';
  operators: RosterOperator[];
}
export interface WsMessage {
  type: 'message';
  session_id: string;
  role: OperatorMessage['role'];
  content: string;
  timestamp: string | null;
  id?: number;
}
export interface WsFile {
  type: 'file';
  session_id: string;
  role: OperatorMessage['role'];
  file_url: string;
  filename: string;
  content_type: string;
  timestamp: string | null;
  id?: number;
}
export interface WsVisitorTyping {
  type: 'visitor_typing';
  session_id: string;
}
export interface WsVisitorStoppedTyping {
  type: 'visitor_stopped_typing';
  session_id: string;
}
export interface WsChatAccepted {
  type: 'chat_accepted';
  session_id: string;
  visitor_name?: string;
  reason?: string | null;
  bot_id?: number | null;
  bot_name?: string | null;
}
export interface WsChatTransferred {
  type: 'chat_transferred';
  session_id: string;
  transferred_to?: string;
}
export interface WsChatClosed {
  type: 'chat_closed';
  session_id: string;
}
export interface WsActiveChatsRestore {
  type: 'active_chats_restore';
  chats: Array<{
    session_id: string;
    visitor_name?: string;
    reason?: string | null;
    bot_id?: number | null;
    bot_name?: string | null;
    visitor_online?: boolean;
  }>;
}
export interface WsVisitorDisconnected {
  type: 'visitor_disconnected';
  session_id: string;
}
export interface WsVisitorReconnected {
  type: 'visitor_reconnected';
  session_id: string;
}
export interface WsQualifiedBotChanged {
  type: 'qualified_bot_changed';
  session_id: string | null;
}
export interface WsConnectRequestResolved {
  type: 'connect_request_resolved';
  session_id: string;
  outcome: ConnectRequestOutcome;
  visitor_name: string | null;
}
export interface WsReadReceipt {
  type: 'read_receipt';
  session_id?: string;
  last_read_id: number;
  reader: 'visitor' | 'operator';
}
export interface WsPong {
  type: 'pong';
}
export interface WsError {
  type: 'error';
  message: string;
}

export type InboundMessage =
  | WsInit
  | WsQueueUpdate
  | WsOperatorsUpdate
  | WsMessage
  | WsFile
  | WsVisitorTyping
  | WsVisitorStoppedTyping
  | WsChatAccepted
  | WsChatTransferred
  | WsChatClosed
  | WsActiveChatsRestore
  | WsVisitorDisconnected
  | WsVisitorReconnected
  | WsQualifiedBotChanged
  | WsConnectRequestResolved
  | WsReadReceipt
  | WsPong
  | WsError;

/**
 * Parse a raw WS frame into a typed inbound message. Returns `null` for
 * malformed JSON or a payload without a string `type` (the caller ignores it).
 */
export function parseInboundMessage(raw: unknown): InboundMessage | null {
  if (typeof raw !== 'string') return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null) return null;
  const record = data as Record<string, unknown>;
  if (typeof record.type !== 'string') return null;
  // The backend is the authority for the payload shape per `type`; we trust the
  // discriminant and hand back a typed view. Unknown types still flow through as
  // an object with a `type` the reducer's switch simply ignores.
  return record as unknown as InboundMessage;
}

// ── Outbound WS messages ──────────────────────────────────────────────────────

export type OutboundMessage =
  | { type: 'ping' }
  | { type: 'heartbeat' }
  | { type: 'message'; session_id: string; content: string }
  | { type: 'typing'; session_id: string }
  | { type: 'read_receipt'; session_id: string; last_read_id: number }
  | { type: 'close_chat'; session_id: string };

// ── URL / auth helpers ────────────────────────────────────────────────────────

/**
 * Derive the WebSocket origin from the app's HTTP API base URL.
 * `https://api.oyechats.com` → `wss://api.oyechats.com`; trailing slashes trimmed.
 */
export function deriveWsUrl(apiBaseUrl: string): string {
  return apiBaseUrl.replace(/^http/i, 'ws').replace(/\/+$/, '');
}

/**
 * Build the `Sec-WebSocket-Protocol` value carrying the operator's credential —
 * `operator-key.<token>` for operator logins, `api-key.<token>` for the owner.
 * Passing auth via subprotocol (not query param) keeps it out of access logs.
 */
export function buildSubprotocol(token: string, authType: string | null): string {
  return authType === 'operator' ? `operator-key.${token}` : `api-key.${token}`;
}

/** Exponential backoff with jitter: 3s → 6s → 12s → 24s → 30s (capped). */
export function reconnectDelay(attempt: number): number {
  const base = Math.min(3000 * 2 ** attempt, 30000);
  return base + Math.floor(Math.random() * 1000);
}

/** Heartbeat cadence — tighter when the tab is visible, looser when hidden. */
export function heartbeatInterval(visible: boolean): number {
  return visible ? 25000 : 50000;
}
