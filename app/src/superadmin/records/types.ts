/**
 * Response shapes for the customer-owned record endpoints.
 *
 * Read off the handlers in `superadmin_routes_v2.py` (bots, documents,
 * sessions, live queue, leads), `superadmin_ops_routes.py` (crawls, visitors,
 * offline messages, qualification signals, meetings, growth events) and
 * `superadmin_routes.py` (chat feedback, platform feedback).
 *
 * Several fields these endpoints emit do not exist on the model behind them and
 * are therefore constant. They are typed here with a comment saying so, and no
 * screen renders them as data:
 *
 * - `DocumentRow.title` is always `null` and `size_bytes` always `0`: the
 *   handler reads `d.title` / `d.text` through `getattr` defaults, but
 *   `Document` has `document_name` and `content` (`models.py:583,598`).
 *   `chunk_count` is the literal `1`.
 * - `SessionRow.visitor_name`, `visitor_email` and `last_activity_at` are always
 *   `null`: `_session_summary` reads them off `ChatSession` through `getattr`
 *   defaults and none of the three is a column (the real one is
 *   `last_active_at`).
 */

export interface BotRow {
  id: number;
  bot_key: string;
  name: string | null;
  client_id: number;
  client_name: string | null;
  is_active: boolean;
  primary_color: string | null;
  created_at: string | null;
}

export interface BotDetail extends BotRow {
  total_sessions: number;
  total_messages: number;
}

export interface DocumentRow {
  id: number;
  bot_id: number | null;
  bot_name: string | null;
  client_id: number | null;
  /** upload | crawl | … — the real `Document.source` column. */
  source: string;
  /** Always `null`. See the module note. */
  title: string | null;
  /** Always `1`. See the module note. */
  chunk_count: number;
  /** Always `0`. See the module note. */
  size_bytes: number;
  created_at: string;
}

export interface CrawlRow {
  /** The crawl's `file_hash` — this list is grouped, so the id is not a row id. */
  id: string;
  bot_id: number | null;
  bot_name: string | null;
  client_name: string | null;
  url: string;
  chunk_count: number;
  created_at: string | null;
}

export interface SessionRow {
  /** `chat_sessions.id` is a UUID string, not an integer. */
  id: string;
  bot_id: number | null;
  bot_name: string | null;
  client_id: number | null;
  client_name: string | null;
  /** bot | waiting | live | closed */
  status: string;
  /** Always `null`. See the module note. */
  visitor_name: string | null;
  /** Always `null`. See the module note. */
  visitor_email: string | null;
  /** `chat_sessions.visitor_rating`, 1–5, null when the visitor did not rate. */
  rating: number | null;
  created_at: string | null;
  /** Always `null`. See the module note. */
  last_activity_at: string | null;
}

export interface SessionMessage {
  id: number;
  session_id: string;
  /** user | bot | operator | system */
  role: string;
  content: string;
  created_at: string | null;
  trace_id: string | null;
}

export interface SessionDetail {
  session: SessionRow;
  messages: SessionMessage[];
}

export interface LeadRow {
  id: number;
  bot_id: number;
  bot_name: string | null;
  client_id: number | null;
  client_name: string | null;
  name: string | null;
  email: string | null;
  phone: string | null;
  company: string | null;
  created_at: string;
}

export interface OfflineMessageRow {
  id: number;
  bot_id: number;
  bot_name: string | null;
  client_name: string | null;
  visitor_name: string;
  visitor_email: string;
  visitor_phone: string | null;
  message_body: string;
  /** new | read | replied */
  status: string;
  fallback_reason: string | null;
  created_at: string | null;
  read_at: string | null;
  replied_at: string | null;
}

export interface MeetingRow {
  id: number;
  session_id: string;
  bot_id: number;
  bot_name: string | null;
  client_name: string | null;
  booking_url: string | null;
  meeting_time: string | null;
  attendee_email: string | null;
  status: string | null;
  created_at: string | null;
}

export interface BantSignalRow {
  id: number;
  session_id: string;
  message_id: number | null;
  bot_name: string | null;
  client_name: string | null;
  /** budget | authority | need | timeline */
  dimension: string;
  signal_text: string | null;
  extracted_value: string | null;
  confidence: number | null;
  score_before: number | null;
  score_after: number | null;
  /** llm | cta_click */
  source: string | null;
  created_at: string | null;
}

export interface GrowthEventRow {
  id: number;
  bot_id: number;
  bot_name: string | null;
  event_type: string;
  created_at: string | null;
}

export interface VisitorAnalytics {
  total_events: number;
  total_sessions: number;
  by_event_type: { event_type: string; count: number }[];
  top_countries: { country: string; count: number }[];
  top_referrers: { referrer: string; count: number }[];
  top_utm_sources: { source: string; count: number }[];
  /** Trailing 14 days of `page_view` events only. */
  daily: { date: string; count: number }[];
}

export interface ChatFeedbackRow {
  message_id: number;
  client_name: string;
  created_at: string;
  question: string;
  answer: string;
  /** The raw `chat_messages.feedback` integer: 1 for up, -1 for down. */
  feedback: number;
  /** A per-client pseudonym the handler assigns; the session id is stripped before it is returned. */
  user: string;
}

export interface PlatformFeedbackRow {
  id: number;
  client_id: number | null;
  client_name: string;
  client_email: string;
  message: string;
  attachment_url: string | null;
  attachments: { url?: string }[];
  category: string | null;
  /** bug | feature_request | question | other */
  type: string | null;
  /** billing | bots | knowledge | live_chat | dashboard | widget | other */
  area: string | null;
  /** low | medium | high | critical — bug-only, cleared for any other type. */
  severity: string | null;
  context: Record<string, unknown> | null;
  /** open | in_progress | resolved | closed */
  status: string;
  admin_response: string | null;
  resolved_at: string | null;
  resolved_by: number | null;
  created_at: string | null;
}

/** The vocabularies `app/core/feedback.py` is the single source of truth for. */
export const FEEDBACK_STATUSES = ['open', 'in_progress', 'resolved', 'closed'] as const;
export const FEEDBACK_TYPES = ['bug', 'feature_request', 'question', 'other'] as const;
export const FEEDBACK_AREAS = [
  'billing',
  'bots',
  'knowledge',
  'live_chat',
  'dashboard',
  'widget',
  'other',
] as const;
export const FEEDBACK_SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;

export const SESSION_STATUS_TONES: Record<string, 'success' | 'warning' | 'neutral'> = {
  live: 'success',
  waiting: 'warning',
  bot: 'neutral',
  closed: 'neutral',
};

export const FEEDBACK_STATUS_TONES: Record<string, 'success' | 'warning' | 'neutral'> = {
  open: 'warning',
  in_progress: 'warning',
  resolved: 'success',
  closed: 'neutral',
};

export const SEVERITY_TONES: Record<string, 'danger' | 'warning' | 'neutral'> = {
  critical: 'danger',
  high: 'danger',
  medium: 'warning',
  low: 'neutral',
};

/** Turns a snake_case vocabulary value into something a person reads. */
export function humanise(value: string | null | undefined): string {
  if (!value) return '—';
  return value.replace(/_/g, ' ');
}

/**
 * `chat_sessions.id` is a UUID string (`app/db/models.py:769`), but
 * `GET /superadmin/sessions/{session_id}` declares its path parameter as `int`
 * (`app/api/superadmin_routes_v2.py:712`), so FastAPI rejects every real session
 * id with a 422 before the handler runs. The detail screen checks the shape
 * first rather than firing a request that cannot succeed.
 */
export function isFetchableSessionId(id: string): boolean {
  return /^\d+$/.test(id);
}
