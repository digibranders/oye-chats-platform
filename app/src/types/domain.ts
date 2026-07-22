/**
 * Shared domain types for the reused backend layer.
 *
 * These describe the shapes returned by the legacy JS API/contexts, so new
 * TypeScript code gets real types when it consumes them (via the `.d.ts` shims
 * next to those JS modules). Kept intentionally minimal — only the fields the
 * new app reads — and widened as more surfaces are migrated.
 */

export interface Bot {
  id: number;
  name: string;
  bot_key?: string;
  website?: string;
  company_name?: string;
  primary_color?: string;
  bot_logo?: string | null;
  recommended_colors?: string[];
  widget_installed_at?: string | null;
  crawl_completed_at?: string | null;
  last_crawl_status?: string | null;
  indexed_chunk_count?: number;
}

export interface CurrentUser {
  id: number;
  name?: string;
  email?: string;
  company_name?: string;
  website?: string;
  bot_count?: number;
  is_verified?: boolean;
  onboarding_complete?: boolean;
  is_affiliate_only?: boolean;
  is_superadmin?: boolean;
}

export interface Workspace {
  id: number;
  name: string;
  role: string;
  bot_count?: number;
}

/** A knowledge source as returned by getDocuments — grouped by website or file. */
export interface KnowledgeSource {
  /** URL (website) or filename (document). */
  name: string;
  page_count?: number;
  doc_page_count?: number;
  chunk_count?: number;
  ingested_at?: string;
  duration_seconds?: number;
}

export interface SourcePage {
  url: string;
  title?: string;
}

export interface SourcePagesResult {
  domain?: string;
  total_pages?: number;
  total_chunks?: number;
  pages: SourcePage[];
}

/** Result of discoverCrawlUrls — page count + server-computed credit estimate. */
export interface CrawlDiscovery {
  url?: string;
  total_found: number;
  capped: boolean;
  plan_max?: number;
  urls?: string[];
  exceeds_balance?: boolean;
  credits_required_full?: number;
  balance?: number;
  max_affordable_pages?: number;
  cost_per_page?: number;
}

/** A single message in a conversation, as returned by getChatHistory. */
export interface ChatMessage {
  id: number;
  session_id?: string;
  role: 'user' | 'bot' | 'operator' | 'system';
  content?: string;
  message?: string;
  created_at?: string;
  trace_id?: string | null;
}

// ── Leads ──────────────────────────────────────────────────────────────────

export interface LeadContact {
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  company?: string | null;
}

/** One dimension's decayed value + score inside a lead's framework breakdown. */
export interface LeadDimensionScore {
  value: string | null;
  score: number;
}

/**
 * A qualified/unqualified lead row from getLeads. ``tier`` and ``status`` are
 * the same value (status is a backward-compat alias). Scores are server-decayed.
 */
export interface Lead {
  session_id: string;
  score: number;
  bant_score?: number;
  behavioral_score?: number;
  tier: string;
  status: string;
  dimensions_assessed?: number;
  bant?: Record<string, LeadDimensionScore>;
  behavioral?: Record<string, unknown>;
  contact: LeadContact | null;
  location?: string;
  device?: string;
  chats?: number;
  created_at?: string | null;
  last_active_at?: string | null;
  unread?: boolean;
  lead_viewed_at?: string | null;
  /** Present only on plans with Lead Source Attribution enabled. */
  source?: Record<string, unknown>;
}

/** Paginated lead list envelope from getLeads. */
export interface LeadsResult {
  leads: Lead[];
  total: number;
  page: number;
  limit: number;
}

/** Query filters accepted by getLeads. */
export interface LeadsQuery {
  status?: string;
  min_score?: number;
  page?: number;
  limit?: number;
}

// ── Inbox / offline messages ────────────────────────────────────────────────

export interface OfflineMessage {
  id: number;
  bot_id?: number;
  bot_name?: string | null;
  visitor_name?: string | null;
  visitor_email?: string | null;
  visitor_phone?: string | null;
  message_body?: string;
  status?: string;
  department_id?: number | null;
  created_at?: string | null;
  read_at?: string | null;
  replied_at?: string | null;
}

/** Paginated envelope returned by getOfflineMessages. */
export interface OfflineMessagesResult {
  messages: OfflineMessage[];
  total: number;
  page: number;
}

// ── Canned responses (quick replies) ────────────────────────────────────────

export interface CannedResponse {
  id: number;
  title: string;
  content: string;
  shortcut?: string | null;
  category?: string | null;
  created_at?: string | null;
}

/** Envelope returned by getCannedResponses. */
export interface CannedResponsesResult {
  responses: CannedResponse[];
}

// ── Team: operators, departments, invites ───────────────────────────────────

export interface Operator {
  id: number;
  name: string;
  email: string;
  role: 'owner' | 'admin' | 'operator' | string;
  bot_id?: number | null;
  bot_name?: string | null;
  department_id?: number | null;
  department_name?: string | null;
  is_online?: boolean;
  is_active?: boolean;
  avatar_url?: string | null;
  max_concurrent_chats?: number | null;
  active_chats?: number;
  last_seen_at?: string | null;
  created_at?: string | null;
  /** Underlying Client identity for invite-created / self operators; null for legacy. */
  linked_client_id?: number | null;
}

export interface Department {
  id: number;
  name: string;
  description?: string | null;
  business_hours?: Record<string, unknown> | null;
}

/** The operator's own live-chat availability, from getMyOperatorStatus. */
export interface OperatorStatus {
  is_online: boolean;
  operator_name?: string | null;
  operator_id?: number | null;
}

/** A workspace invite row (owner-facing), from listOperatorInvites / createOperatorInvite. */
export interface OperatorInvite {
  id: number;
  email: string;
  role: string;
  bot_id: number;
  department_id: number | null;
  status: string;
  created_at: string;
  expires_at: string;
  invited_by_name: string | null;
  resend_count: number;
  sent_at: string | null;
  accepted_at: string | null;
  revoked_at: string | null;
}

/** Result of createOperatorInvite — includes a copyable accept URL. */
export interface OperatorInviteCreated {
  invite: OperatorInvite;
  accept_url?: string;
}

/** Result of addSelfAsOperator (owner joins live chat in their own workspace). */
export interface SelfOperatorResult {
  operator_id: number;
  role: string;
  is_active: boolean;
  was_existing: boolean;
}

// ── Integrations: webhooks ──────────────────────────────────────────────────

export interface Webhook {
  id: number;
  bot_id?: number;
  url: string;
  events: string[];
  is_active: boolean;
  /** Masked ("••••••••") on list; full value only on create. */
  secret?: string | null;
  created_at?: string | null;
}

export interface WebhookDelivery {
  id: number;
  event_type: string;
  status_code?: number | null;
  attempt: number;
  created_at?: string | null;
  delivered_at?: string | null;
  next_retry_at?: string | null;
}

/** Paginated envelope from getWebhookDeliveries. */
export interface WebhookDeliveriesResult {
  deliveries: WebhookDelivery[];
  total: number;
  page: number;
  limit: number;
}

// ── Analytics (loosely typed — server shapes vary by widget) ─────────────────

/** One point on the message-activity timeline, from getActivityStats. */
export interface ActivityPoint {
  date: string;
  messages: number;
}

/** A frequently-asked question row, from getTopQuestions. */
export interface TopQuestion {
  question: string;
  count: number;
}

export type CrawlStatus =
  | 'idle'
  | 'running'
  | 'cancelling'
  | 'cancelled'
  | 'done'
  | 'failed'
  | 'no_content';

export interface CrawlState {
  status: CrawlStatus;
  urls: string[];
  pagesCrawled: number;
  maxPages: number | null;
  discoveredTotal: number | null;
  currentUrl: string | null;
  phase: string | null;
  startedAt: number | null;
  rootUrl: string | null;
  botId: number | null;
  botName: string | null;
  result: unknown;
  error: string | null;
  cancellable: boolean;
  isStarting: boolean;
  cancelInFlight: boolean;
}
