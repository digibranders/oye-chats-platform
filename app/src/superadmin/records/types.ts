/**
 * Response shapes for the customer-owned record endpoints.
 *
 * Read off the handlers in `superadmin_routes_v2.py` (bots, documents,
 * sessions, live queue, leads), `superadmin_ops_routes.py` (crawls, visitors,
 * offline messages, qualification signals, meetings, growth events) and
 * `superadmin_routes.py` (chat feedback, platform feedback).
 *
 * Several fields these endpoints emitted used to be permanently null or literal
 * constants, because the handlers read attributes the models do not have through
 * `getattr` defaults. That is fixed on the API: the documents list is now
 * grouped per source with real counts, and `_session_summary` joins `LeadInfo`
 * for the visitor's identity and reads the real `last_active_at`. The fields
 * below therefore carry data now, and the screens render them.
 *
 * `SessionRow.last_activity_at` keeps its wire name deliberately — the column
 * behind it is `last_active_at`, and renaming the key would have bought nothing
 * but a coordinated deploy.
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
  /**
   * The source's `file_hash` — this list is grouped per source, so the id is
   * not a row id, exactly as on `CrawlRow`. It is deliberately not a chunk id:
   * a row here stands for a whole document, which may be hundreds of chunks.
   */
  id: string;
  bot_id: number | null;
  bot_name: string | null;
  client_id: number | null;
  /** upload | crawl | … — the real `Document.source` column. */
  source: string;
  /** The real `Document.document_name`. */
  title: string | null;
  /** How many chunks this source was split into. */
  chunk_count: number;
  /**
   * Characters across every chunk's stored text.
   *
   * Post-chunk, so it runs slightly ahead of the original file by the chunking
   * overlap. It is not `source_char_count`, which is replicated onto every
   * chunk and would multiply by the chunk count if summed.
   */
  content_chars: number;
  /** False once a plan lapse has deactivated the source's knowledge. */
  is_active: boolean;
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
  /** The visitor's name from `LeadInfo`, null while they stay anonymous. */
  visitor_name: string | null;
  /** The visitor's email from `LeadInfo`, null while they stay anonymous. */
  visitor_email: string | null;
  /** `chat_sessions.visitor_rating`, 1–5, null when the visitor did not rate. */
  rating: number | null;
  created_at: string | null;
  /** The real `chat_sessions.last_active_at`; see the module note on the name. */
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
 * The shape `GET /superadmin/sessions/{session_id}` will accept.
 *
 * That route used to declare its path parameter as `int` against a `String`
 * primary key, so FastAPI rejected every real session id with a 422 before the
 * handler ran — the endpoint had never worked, and this guard existed to avoid
 * firing a request that could not succeed. The API now types it as the same
 * bounded `Identifier` every other session-scoped route uses, so the guard is
 * no longer about the parameter's type; it mirrors that validator, and its only
 * job now is to skip a request the server would reject on length or shape.
 */
export function isFetchableSessionId(id: string): boolean {
  return id.length > 0 && id.length <= 128 && /^[A-Za-z0-9_.:-]+$/.test(id);
}
