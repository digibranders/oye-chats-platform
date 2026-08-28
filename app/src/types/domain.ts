/**
 * Shared domain types for the reused backend layer.
 *
 * These describe the shapes returned by the legacy JS API/contexts, so new
 * TypeScript code gets real types when it consumes them (via the `.d.ts` shims
 * next to those JS modules). Kept intentionally minimal - only the fields the
 * new app reads - and widened as more surfaces are migrated.
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
  /** Configured avatar style: 'upload' (bot_logo image) | 'orb' | 'mascot'. */
  avatar_type?: string | null;
  /** Orb avatar colour (used when avatar_type === 'orb'); falls back to primary_color. */
  orb_color?: string | null;
  recommended_colors?: string[];
  widget_installed_at?: string | null;
  /**
   * Widget liveness heartbeat: the last time this chatbot's bundle bootstrapped
   * on a real external page. Refreshed at most twice per bot per hour, so it is
   * a coarse "still out there" signal, never a per-visit clock.
   *
   * `null` means "not seen since the heartbeat shipped" — there is no backfill —
   * so a long-installed chatbot reads null until its widget next loads. Never
   * render that as an outage.
   */
  widget_last_seen_at?: string | null;
  /**
   * Hostname of the most recent bootstrap. **Browser-forgeable, so diagnostic
   * only**: it answers "which domain is it actually running on?" for a support
   * conversation and must never gate anything. Enforcement is `allowed_domains`.
   */
  widget_last_origin?: string | null;
  /**
   * State of the screenshot that backs the hosted demo page.
   *
   * `null` = never attempted, `"pending"` = queued or capturing, `"ready"` = a
   * usable capture is stored, `"failed"` = the site could not be rendered. The
   * demo link falls back to a generic page for anything but `"ready"`, so this
   * is what lets Deploy explain that instead of leaving the reader to guess.
   */
  demo_screenshot_status?: string | null;
  /** When the stored capture was taken. Drives the staleness notice. */
  demo_screenshot_captured_at?: string | null;
  /**
   * False while the chatbot is paused: the widget stops answering and the agent
   * stops counting against the plan's active-bot allowance. Resuming re-runs the
   * create gate server-side and can be refused.
   */
  is_active?: boolean;
  /** Seconds a dropped visitor connection is held before the chat auto-closes. */
  visitor_disconnect_timeout?: number;
  /** True while the manual lead follow-up email is paused for this chatbot. */
  followup_sending_paused?: boolean;
  crawl_completed_at?: string | null;
  last_crawl_status?: string | null;
  indexed_chunk_count?: number;
  created_at?: string | null;
  brand_tone?: string | null;
  business_hours?: Record<string, unknown> | null;
  show_branding?: boolean;
  /**
   * THIS agent's own plan slug, resolved server-side by `bot_plan_slug()` in
   * `bot_routes.py` (the same `get_bot_entitlements` the server's feature gates
   * use, failing closed to `'free'`).
   *
   * Billing attaches to the Bot, so a workspace can hold a Professional agent
   * and a Free agent at once. Per-agent feature gates MUST read this and not
   * `useEntitlements().plan_slug`, which reports the highest-priced plan across
   * the whole workspace.
   */
  plan_slug?: string;
  /** Display name for {@link plan_slug}, resolved in the same server call. */
  plan_name?: string;
}

export interface CurrentUser {
  id: number;
  name?: string;
  email?: string;
  /** Provider avatar (e.g. Google profile picture) when the account signed in via OAuth; null for password accounts. */
  avatar_url?: string | null;
  /** Set only for clients with an unconfirmed change-email request in flight; null/undefined otherwise. Always unset for operators. */
  pending_email?: string | null;
  company_name?: string | null;
  website?: string | null;
  bot_count?: number;
  is_verified?: boolean;
  onboarding_complete?: boolean;
  /** True when the client has an active affiliate row (gates the Affiliate area). */
  is_affiliate?: boolean;
  /** True when the client is ONLY an affiliate (no customer subscription). */
  is_affiliate_only?: boolean;
  is_superadmin?: boolean;
  /** ISO timestamp the account was created - rendered as "Joined {date}" in the profile menu. */
  created_at?: string;
  /** True when the caller is currently marked online (operators only). */
  is_online?: boolean;
  /** 'client' | 'operator' - clients have `role: null`. */
  kind?: string;
  /** Operator role (owner | admin | operator) when `kind === 'operator'`. */
  role?: string | null;
}

/**
 * Numeric plan ceilings. `-1` is the UNLIMITED sentinel (see
 * `plan_entitlements_service.py::UNLIMITED`) - never a real count.
 */
export type LimitKey =
  | 'credits'
  | 'bots'
  | 'operators'
  | 'leads'
  | 'page_scraping'
  | 'documents'
  | 'chat_history_days'
  | 'max_crawl_pages'
  | 'max_crawl_depth';

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
 * `bots` / `operators` / `documents` / `leads` today - `credits`,
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
 * `is_free` / `topup_allowed` are the only fields appended by the route
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
  topup_allowed: boolean;
}

export interface Workspace {
  id: number;
  name: string;
  /** Top-level membership kind: `owner` for the caller's own workspace,
   *  `operator` for every linked-operator membership in another workspace. */
  role: string;
  /** For `role === 'operator'` memberships, the granular seat role granted in
   *  that workspace (`admin` | `operator`). Absent on the owner entry. */
  operator_role?: string | null;
  bot_count?: number;
}

/** A knowledge source as returned by getDocuments - grouped by website or file. */
export interface KnowledgeSource {
  /** URL (website) or filename (document). */
  name: string;
  page_count?: number;
  doc_page_count?: number;
  chunk_count?: number;
  ingested_at?: string;
  duration_seconds?: number;
}

/** Response of `GET /documents/knowledge-state`.
 *
 * `deactivated` is the server's own verdict (`inactive_count > 0`), not
 * something the client should re-derive, a plan lapse to Free marks chunks
 * inactive, and this drives the "re-crawl / re-upload to reactivate" banner.
 */
export interface KnowledgeState {
  active_count: number;
  inactive_count: number;
  deactivated: boolean;
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

/** Result of discoverCrawlUrls - page count + server-computed credit estimate. */
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
  /** The lead-detail API serializes a message's time as `timestamp`; other
   *  endpoints use `created_at`. Read `timestamp ?? created_at`. */
  timestamp?: string | null;
  created_at?: string;
  trace_id?: string | null;
  /** Language `content` is written in (Phase 4). Server-resolved. */
  source_language?: string | null;
  /**
   * Derived translations by target language code. `content` above stays the
   * canonical original; this never replaces it. Returned by
   * `GET /chat/history` so translations survive a reload.
   */
  translations?: Record<string, { content?: string; status: 'ok' | 'failed' }> | null;
}

// ── Leads ──────────────────────────────────────────────────────────────────

export interface LeadContact {
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  company?: string | null;
  /** Present only when the caller's plan includes Visitor Intelligence (Professional). */
  is_valid_email?: boolean | null;
  /** Present only when the caller's plan includes Visitor Intelligence (Professional). */
  email_score?: number | null;
  /**
   * The company behind `company`, resolved from the domain's own declared
   * identity. "infosys.com" becomes "Infosys Limited". Professional-gated,
   * like the rest of visitor intelligence, because the same paid enrichment
   * produces it. `company` above stays the raw domain on every plan.
   */
  company_name?: string | null;
  company_description?: string | null;
  company_logo_url?: string | null;
}

/** One dimension's decayed value + score inside a lead's framework breakdown. */
export interface LeadDimensionScore {
  value: string | null;
  score: number;
}

/**
 * One captured qualification signal, an append-only evidence row. A visitor
 * who states a need (or budget/authority/timeline) several times produces one
 * of these per mention, so the detail view can show every value, not just the
 * single rolling high-water-mark kept in ``LeadDimensionScore``. Returned by the
 * lead-detail endpoint only, and only on plans with the intelligence feature.
 */
export interface LeadSignal {
  dimension: string;
  signal_text: string | null;
  extracted_value: string | null;
  confidence: number | string | null;
  score_before: number | null;
  score_after: number | null;
  /** llm | cta_click | operator_override */
  source: string | null;
  created_at: string | null;
}

/**
 * A qualified/unqualified lead row from getLeads. ``tier`` and ``status`` are
 * the same value (status is a backward-compat alias). Scores are server-decayed.
 */
/**
 * One line a visitor put in their quote, priced against the bot's catalog at
 * the moment the lead was read.
 *
 * Mirrors `QuoteLine` in `api/app/api/quotation_routes.py` field for field. The
 * names are RESOLVED server-side from the catalog rather than stored on the
 * session, so a service renamed or repriced after the chat shows its current
 * identity. A service deleted from the catalog outright falls back to its id
 * and a zero price - the line stays, because dropping it would silently change
 * a total the visitor was quoted.
 *
 * A line is now one REQUIREMENT within a service, not one service: a visitor
 * answering three questions about "Photography" produces three lines that share
 * a `service_id` and `service_name` and differ by `requirement_id` and `label`.
 * That is why `requirement_id` is the render key, not `service_id`, which is no
 * longer unique across the list.
 */
export interface LeadQuotationLine {
  service_id: string;
  /** The parent service's display name, repeated on each of its lines. */
  service_name: string;
  /** Unique within a quote; the correct React key. */
  requirement_id: string;
  /** This line's own label, e.g. the requirement or the chosen option. */
  label: string;
  quantity: number;
  /** Server default is an empty string, so treat it as optional in copy. */
  unit_label: string;
  price: number;
  subtotal: number;
}

/**
 * The quotation flow's outcome for one session. Present only when the session
 * actually entered the flow; `status` distinguishes "never finished" from
 * "declined", which are different facts about the same empty quote.
 *
 * Amounts here are MAJOR units in `currency` (rupees, not paise) — the catalog
 * is authored in whole currency by the customer, unlike the billing rail.
 */
export interface LeadQuotation {
  /**
   * `QuotationStateOut` in quotation_routes.py emits
   * `idle | selecting | choosing | quoting | complete | skipped`. `answering`
   * is the pre-rename spelling of `choosing` and is kept because sessions
   * persisted before that rename still carry it.
   */
  status: 'idle' | 'selecting' | 'choosing' | 'answering' | 'quoting' | 'complete' | 'skipped';
  currency: string;
  line_items: LeadQuotationLine[];
  total: number;
  activated_at: string | null;
  completed_at: string | null;
}

export interface Lead {
  session_id: string;
  score: number;
  bant_score?: number;
  behavioral_score?: number;
  tier: string;
  status: string;
  dimensions_assessed?: number;
  bant?: Record<string, LeadDimensionScore>;
  /**
   * Full evidence trail. Every captured value across all dimensions. Present
   * only on the single-lead detail response, and only on intelligence plans.
   */
  signals?: LeadSignal[];
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
  /**
   * IP-based company/threat signal (ipapi.is), captured for every visitor
   * regardless of plan but only ever returned on plans with Visitor
   * Intelligence (Professional).
   */
  visitor_metadata?: Record<string, unknown> | null;
  /**
   * The quotation the visitor built, itemised. Detail response only, and only
   * when the session reached the flow at all.
   */
  quotation?: LeadQuotation | null;
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
  /** Trailing window in days, matching `/leads/stats`. Omitted = all time. */
  days?: number;
  /** Custom range start (`YYYY-MM-DD`), inclusive. Wins over `days` when both are sent. */
  from_date?: string;
  /** Custom range end (`YYYY-MM-DD`), inclusive. */
  to_date?: string;
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

/** Result of createOperatorInvite - includes a copyable accept URL. */
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

// ── Analytics (loosely typed - server shapes vary by widget) ─────────────────

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

/**
 * A knowledge gap: a question visitors asked that the AI could not answer from
 * its knowledge base, grouped by question. From getUnansweredQuestions.
 */
export interface UnansweredQuestion {
  question: string;
  count: number;
  /** ISO timestamp of the most recent time this gap was hit, or null. */
  last_asked: string | null;
}

export type CrawlStatus =
  | 'idle'
  | 'running'
  | 'cancelling'
  | 'cancelled'
  | 'done'
  | 'failed'
  // Terminal, and NOT a rendering problem: ingestion stopped because the
  // workspace ran out of credits or reached its knowledge-base ceiling. It was
  // reported as `no_content` until the trial work, which sent customers to
  // debug JavaScript when the answer was to upgrade.
  | 'limit'
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
