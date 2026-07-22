/**
 * Shared domain types for the reused backend layer.
 *
 * These describe the shapes returned by the legacy JS API/contexts, so new
 * TypeScript code gets real types when it consumes them (via the `.d.ts` shims
 * next to those JS modules). Kept intentionally minimal — only the fields the
 * new app reads — and widened as more surfaces are migrated.
 */

/**
 * A row from the in-app notification feed (`notifications` table, see
 * `api/app/services/notification_service.py::_serialize`). `type` and `data`
 * are schema-on-read on the backend (new notification types are added
 * without a migration), so `type` stays a plain string rather than a union.
 */
export interface NotificationItem {
  id: number;
  type: string;
  title: string;
  body?: string | null;
  /** Optional in-app route to navigate to on click. */
  link?: string | null;
  data?: Record<string, unknown> | null;
  is_read: boolean;
  read_at?: string | null;
  /** ISO timestamp; the backend `_serialize` can emit null for a row with no created_at. */
  created_at: string | null;
}

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
  /** Set only for clients with an unconfirmed change-email request in flight; null/undefined otherwise. Always unset for operators. */
  pending_email?: string | null;
  company_name?: string;
  website?: string;
  bot_count?: number;
  is_verified?: boolean;
  onboarding_complete?: boolean;
  is_affiliate_only?: boolean;
  is_superadmin?: boolean;
  /** ISO timestamp the account was created — rendered as "Joined {date}" in the profile menu. */
  created_at?: string;
  /** True when the caller is currently marked online (operators only). */
  is_online?: boolean;
  /** 'client' | 'operator' — clients have `role: null`. */
  kind?: string;
  /** Operator role (owner | admin | operator) when `kind === 'operator'`. */
  role?: string | null;
}

/**
 * Numeric plan ceilings. `-1` is the UNLIMITED sentinel (see
 * `plan_entitlements_service.py::UNLIMITED`) — never a real count.
 */
export type LimitKey =
  | 'credits'
  | 'bots'
  | 'operators'
  | 'leads'
  | 'page_scraping'
  | 'documents'
  | 'chat_history_days';

/** Boolean/enum plan feature flags. */
export type FeatureKey =
  | 'live_chat'
  | 'bant'
  | 'branding_removable'
  | 'webhooks'
  | 'api_access'
  | 'online_support'
  | 'topup_allowed'
  | 'integrations';

export type EntitlementLimits = Record<LimitKey, number>;

/**
 * `integrations` is the one non-boolean feature flag: `"all"` grants full
 * integration access, `"reply_to_only"` restricts to reply-to email delivery
 * (see `PlanEntitlements.has_feature` in `plan_entitlements_service.py`).
 */
export interface EntitlementFeatures {
  live_chat: boolean;
  bant: boolean;
  branding_removable: boolean;
  webhooks: boolean;
  api_access: boolean;
  online_support: boolean;
  topup_allowed: boolean;
  integrations: 'all' | 'reply_to_only';
}

/**
 * Current-period usage counters. The backend's `_build_usage` only populates
 * `bots` / `operators` / `documents` / `leads` today — `credits`,
 * `page_scraping`, and `chat_history_days` are reserved keys the service
 * comments as "left to callers that need them" and are NOT currently sent.
 * Typed as a partial map so callers can't assume every `LimitKey` is present.
 */
export type EntitlementUsage = Partial<Record<LimitKey, number>>;

/**
 * Resolved plan entitlements returned by GET /auth/me/entitlements.
 *
 * Verified field-by-field against the backend: `plan_slug` / `plan_name` /
 * `subscription_status` / `limits` / `features` / `usage` come from
 * `PlanEntitlements.to_json_dict()` (`plan_entitlements_service.py`);
 * `is_free` / `is_enterprise` / `topup_allowed` are appended by the route
 * handler (`auth_routes.py::get_my_entitlements`). `client_id` is present
 * via `dataclasses.asdict` but is an internal identifier, not a UI field.
 */
export interface Entitlements {
  client_id?: number;
  plan_slug: string;
  plan_name: string;
  subscription_status: string;
  limits: EntitlementLimits;
  features: EntitlementFeatures;
  usage: EntitlementUsage;
  is_free: boolean;
  is_enterprise: boolean;
  topup_allowed: boolean;
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
