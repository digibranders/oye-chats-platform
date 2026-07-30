/**
 * Type shim for the legacy JS API client (`services/api.js`).
 * The `.js` stays the runtime source; this only supplies types to new TS code.
 * Only the exports the new app consumes are declared - widen as needed.
 */
import type {
  ActivityPoint,
  Bot,
  CannedResponse,
  CannedResponsesResult,
  ChatMessage,
  CrawlDiscovery,
  CurrentUser,
  Department,
  Entitlements,
  KnowledgeSource,
  Lead,
  LeadsQuery,
  LeadsResult,
  OfflineMessagesResult,
  Operator,
  OperatorInvite,
  OperatorInviteCreated,
  OperatorStatus,
  SelfOperatorResult,
  SourcePagesResult,
  TopQuestion,
  Webhook,
  WebhookDeliveriesResult,
  Workspace,
} from '../types/domain';
import type { FeedbackItem } from '../features/feedback/types';

// ── Agents (bots) ────────────────────────────────────────────────────────────
export function createBot(data: { name: string; website?: string; system_prompt?: string }): Promise<Bot>;
/** POST /bots/checkout - start a per-agent Razorpay subscription; returns the Checkout payload. */
export function createBotCheckout(data: {
  name: string;
  website?: string;
  plan_slug: string;
  billing_cycle?: string;
  allowed_domains?: string[] | null;
  domain_check_enabled?: boolean | null;
}): Promise<Record<string, unknown>>;
/** POST /bots/checkout/verify - materialise the new agent after payment; returns `{ status, bot_id }`. */
export function verifyBotCheckout(data: {
  razorpay_payment_id: string;
  razorpay_subscription_id: string;
  razorpay_signature: string;
}): Promise<Record<string, unknown>>;
/** PATCH /bots/{id} returns a status message, NOT the bot - re-fetch/merge for fresh fields. */
export function updateBot(botId: number, data: Record<string, unknown>): Promise<{ message: string }>;
export function getBot(botId: number): Promise<Bot>;
export function getBots(): Promise<Bot[]>;
export function deleteBot(botId: number): Promise<Record<string, unknown>>;
export function getFrameworkPresets(botId: number): Promise<Record<string, unknown>>;

/** Absolute URL of the hosted demo page for a bot. */
export function getBotDemoUrl(botKey: string): string;
/** Backend endpoint configured for this dashboard build. */
export function getApiBaseUrl(): string;
/** Absolute URL of the demo page with an optional overlay website + edit mode. */
export function getBotPreviewUrl(
  botKey: string,
  websiteUrl?: string,
  opts?: { edit?: boolean },
): string;

// ── Knowledge / crawl ────────────────────────────────────────────────────────
export function discoverCrawlUrls(url: string, botId?: number): Promise<CrawlDiscovery>;
export function getDocuments(botId?: number): Promise<KnowledgeSource[]>;
export function getDocumentPages(source: string, botId?: number): Promise<SourcePagesResult>;
export function deleteDocument(documentName: string, botId?: number): Promise<Record<string, unknown>>;

export function getSeedQuestions(botId: number): Promise<string[]>;
export function previewChatStream(
  botId: number,
  question: string,
  sessionId?: string | null,
  handlers?: {
    onChunk?: (text: string) => void;
    onFinal?: (meta: unknown) => void;
    onError?: (err: unknown) => void;
  },
): Promise<void>;

export function getClientSettings(botId?: number): Promise<Record<string, unknown>>;
export function updateClientSettings(
  settings: Record<string, unknown>,
  botId?: number,
): Promise<Record<string, unknown>>;
export function uploadLogo(file: File): Promise<{ url: string }>;
export function uploadDocuments(files: File[], botId?: number): Promise<unknown>;

// ── Onboarding / activation ──────────────────────────────────────────────────
export function completeOnboarding(): Promise<Record<string, unknown> | null>;
export function recordActivationEvent(
  eventType: string,
  opts?: { botId?: number | null; eventData?: unknown },
): Promise<void>;

// ── Identity / workspace ─────────────────────────────────────────────────────
export function getCurrentUser(): Promise<CurrentUser>;
/** GET /auth/me/entitlements. Throws on failure - callers fall back / hide gracefully. */
export function getEntitlements(): Promise<Entitlements>;
export function getMyWorkspaces(): Promise<{ workspaces: Workspace[] }>;
/**
 * Update the authenticated client's display name, company name, or website.
 */
export function updateClientProfile(patch: {
  name?: string;
  company_name?: string;
  website?: string;
}): Promise<{
  id: number;
  name: string;
  email: string;
  company_name?: string | null;
  website?: string | null;
  pending_email: string | null;
}>;

// ── Dashboard / analytics ────────────────────────────────────────────────────
export function getDashboardStats(botId?: number, days?: number | null): Promise<Record<string, unknown>>;
export function getActivityStats(botId?: number): Promise<ActivityPoint[]>;
export function getTopQuestions(botId?: number): Promise<TopQuestion[]>;
export function getRatingsSummary(botId?: number): Promise<Record<string, unknown>>;
export function getResolutionSummary(botId?: number): Promise<Record<string, unknown>>;
export function getFeedbackData(botId?: number): Promise<FeedbackItem[]>;
export function getVisitorsData(botId?: number): Promise<Array<Record<string, unknown>>>;
export function getChatHistory(
  sessionId: string,
  options?: { beforeId?: number; limit?: number },
): Promise<ChatMessage[]>;
export function getQualificationFunnel(botId: number, period?: string): Promise<Record<string, unknown>>;

// ── Leads ────────────────────────────────────────────────────────────────────
export function getLeads(botId?: number, params?: LeadsQuery): Promise<LeadsResult>;
export function getLeadDetail(sessionId: string): Promise<Lead & { messages?: ChatMessage[] }>;
export function getLeadStats(botId?: number): Promise<Record<string, unknown>>;
/** Downloads a CSV of leads (triggers a browser download; resolves to void). */
export function exportLeadsCsv(botId?: number): Promise<void>;
export function markLeadViewed(sessionId: string): Promise<void>;
export function markAllLeadsViewed(botId?: number): Promise<void>;

// ── Inbox / offline messages ─────────────────────────────────────────────────
export function getOfflineMessages(params?: Record<string, unknown>): Promise<OfflineMessagesResult>;
export function updateOfflineMessage(
  messageId: number,
  data: Record<string, unknown>,
): Promise<{ success: boolean; status?: string }>;
export function deleteOfflineMessage(messageId: number): Promise<{ success: boolean }>;

// ── Canned responses (quick replies) ─────────────────────────────────────────
export function getCannedResponses(category?: string | null): Promise<CannedResponsesResult>;
export function createCannedResponse(data: {
  title: string;
  content: string;
  shortcut?: string;
  category?: string | null;
}): Promise<CannedResponse>;
export function updateCannedResponse(
  responseId: number,
  data: Record<string, unknown>,
): Promise<Record<string, unknown>>;
export function deleteCannedResponse(responseId: number): Promise<{ success: boolean }>;

// ── Operator live-chat file upload ───────────────────────────────────────────
export function uploadOperatorChatFile(
  file: File,
  sessionId: string,
): Promise<{ file_url: string; filename: string; content_type: string; size: number }>;

// ── Operator self-status ─────────────────────────────────────────────────────
export function getMyOperatorStatus(opts?: { botId?: number }): Promise<OperatorStatus | null>;
export function toggleOperatorStatus(opts?: { isOnline?: boolean; botId?: number }): Promise<Record<string, unknown>>;

// ── Team: operators ──────────────────────────────────────────────────────────
export function getOperators(): Promise<Operator[]>;
export function createOperator(data: Record<string, unknown>): Promise<Operator>;
export function updateOperator(operatorId: number, data: Record<string, unknown>): Promise<Operator>;
export function deleteOperator(operatorId: number): Promise<Record<string, unknown>>;

// ── Team: departments ────────────────────────────────────────────────────────
export function getDepartments(): Promise<Department[]>;
export function createDepartment(data: Record<string, unknown>): Promise<Department>;
export function updateDepartment(departmentId: number, data: Record<string, unknown>): Promise<Department>;
export function deleteDepartment(departmentId: number): Promise<Record<string, unknown>>;

// ── Team: invites + self-operator ────────────────────────────────────────────
export function createOperatorInvite(data: {
  email: string;
  botId: number;
  role?: 'operator' | 'admin' | string;
  departmentId?: number | null;
}): Promise<OperatorInviteCreated>;
export function listOperatorInvites(statusFilter?: string | null): Promise<OperatorInvite[]>;
export function resendOperatorInvite(inviteId: number): Promise<OperatorInviteCreated>;
export function revokeOperatorInvite(inviteId: number): Promise<boolean>;
export function getInvitePublic(token: string): Promise<Record<string, unknown>>;
export function acceptInvitePublic(token: string): Promise<Record<string, unknown>>;
export function addSelfAsOperator(botId?: number): Promise<SelfOperatorResult>;
export function removeSelfAsOperator(): Promise<boolean>;

// ── Billing / subscription ───────────────────────────────────────────────────
export function getCurrentSubscription(botId?: number | null): Promise<Record<string, unknown>>;
export function getSubscriptionPlans(): Promise<Array<Record<string, unknown>>>;
export function getSubscriptionUsage(): Promise<Record<string, unknown>>;
export function getInvoices(botId?: number | null): Promise<Array<Record<string, unknown>>>;
export function getBillingDetails(): Promise<Record<string, unknown>>;
export function updateBillingDetails(patch: Record<string, unknown>): Promise<Record<string, unknown>>;

/** Subscription geo/currency profile: `{ country, display_currency, display_rate, checkout_available }`. */
export function getBillingGeo(overrideCountry?: string): Promise<Record<string, unknown>>;
/** First-time checkout for a plan → provider payload (Razorpay `subscription_id`, `key_id`, …). */
export function createCheckoutSession(
  planId: number,
  billingCycle?: 'monthly' | 'annual',
  billingCountry?: string | null,
): Promise<Record<string, unknown>>;
/** Honest pre-checkout quote → `{ amount_display, checkout_supported, reason, contact_sales, … }`. No proration. */
export function getCheckoutQuote(
  planId: number,
  billingCycle?: 'monthly' | 'annual',
  billingCountry?: string | null,
): Promise<Record<string, unknown>>;
/** Change plan on an existing subscription → `{ status | provider, … }` (switched / downgrade_scheduled / checkout). */
export function changePlan(planId: number, billingCycle?: string | null): Promise<Record<string, unknown>>;
/** Start the plan's configured free trial (no card). */
export function startTrial(planSlug: string): Promise<Record<string, unknown>>;
export function cancelScheduledChange(): Promise<Record<string, unknown>>;
export function cancelSubscription(reason?: string | null, botId?: number | null): Promise<Record<string, unknown>>;
export function resumeSubscription(): Promise<Record<string, unknown>>;
/** Server-verify the Razorpay subscription Checkout callback signature. */
export function verifyRazorpaySubscription(payload: {
  razorpay_payment_id: string;
  razorpay_subscription_id: string;
  razorpay_signature: string;
}): Promise<Record<string, unknown>>;
/** Add (delta > 0) or remove (delta < 0) operator seats; may return `{ requires_authorization, checkout }`. */
export function changeOperatorSeats(delta: number, botId?: number | null): Promise<Record<string, unknown>>;
/** Standing referral attribution on the account: `{ attributed, code, discount_pct }`. */
export function getReferralStatus(): Promise<{ attributed?: boolean; code?: string | null; discount_pct?: number } | null>;
/** Apply/validate a referral code. Non-null `code` ⇒ accepted. */
export function applyReferralCode(
  code: string,
): Promise<{ code: string | null; message: string; discount_pct?: number }>;

// ── Affiliate self-service (reused verbatim; see api/app/api/affiliate_routes.py) ──
/** The affiliate's own program terms. Throws (403) when the client is not an affiliate. */
export function getAffiliateMe(): Promise<Record<string, unknown>>;
/** List the affiliate's codes with lifetime click + signup counters. */
export function getAffiliateCodes(): Promise<Array<Record<string, unknown>>>;
/** Per-customer referral breakdown + monthly distribution for one code (emails masked). */
export function getAffiliateCodeReferrals(codeId: number): Promise<Record<string, unknown>>;
/** Create a referral code. The split percents must fit the affiliate's pool. */
export function createAffiliateCode(
  code: string,
  label?: string | null,
  split?: { affiliateCommissionPct?: number; customerDiscountPct?: number },
): Promise<Record<string, unknown>>;
/** Patch a referral code (rename / label / active toggle / split). Every field optional. */
export function updateAffiliateCode(
  codeId: number,
  patch?: {
    code?: string;
    label?: string;
    active?: boolean;
    affiliateCommissionPct?: number;
    customerDiscountPct?: number;
  },
): Promise<Record<string, unknown>>;
/** Aggregate counters for the affiliate dashboard header. */
export function getAffiliateStats(): Promise<Record<string, unknown>>;
/** Look up a magic-link affiliate invite by token. Throws 404 (invalid) / 410 (expired/revoked). */
export function lookupAffiliateInvite(token: string): Promise<{ email: string; expires_at: string }>;
/** Accept an affiliate invite as the signed-in client. Throws 403 (email mismatch) / 409 (already an affiliate). */
export function acceptAffiliateInviteExisting(
  token: string,
): Promise<{ is_affiliate: boolean; message: string }>;

// ── Credits / top-ups ────────────────────────────────────────────────────────
export function getCreditBalance(): Promise<Record<string, unknown>>;
export function getCreditHistory(params?: { page?: number; limit?: number; botId?: number | null }): Promise<Record<string, unknown>>;
/** Daily consumption trend → `{ days, series: [{ date, credits_used }] }` (zero-filled, ascending). */
export function getCreditDaily(params?: { days?: number; botId?: number | null }): Promise<Record<string, unknown>>;
export function getTopupPacks(): Promise<Array<Record<string, unknown>>>;
/** Start a top-up purchase → Razorpay order payload (`order_id`, `amount`, `key_id`, …). */
export function initiateTopup(
  amount: number,
  opts?: { botId?: number | null },
): Promise<Record<string, unknown>>;
/** Server-verify the top-up Razorpay callback signature. */
export function verifyTopupPayment(payload: {
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
}): Promise<Record<string, unknown>>;

// ── Security / account ───────────────────────────────────────────────────────
export function changeClientPassword(currentPassword: string, newPassword: string): Promise<{ ok: boolean }>;
/** POST /auth/operator-change-password - an operator changes their own password. */
export function operatorChangePassword(
  currentPassword: string,
  newPassword: string,
): Promise<{ message: string }>;
/**
 * Start an email change: verifies the current password, stores the new
 * address as pending, and emails it a confirmation code. The login email
 * does not change until confirmClientEmailChange succeeds.
 */
export function requestClientEmailChange(
  newEmail: string,
  currentPassword: string,
): Promise<{ message: string; pending_email: string }>;
/** Confirm a pending email change with the OTP sent to the new address. */
export function confirmClientEmailChange(
  otp: string,
): Promise<{ id: number; name: string; email: string; pending_email: null }>;
/** Cancel a pending email change before it's confirmed. */
export function cancelClientEmailChange(): Promise<{ ok: boolean }>;
export function getClientApiKey(): Promise<{ api_key_masked: string }>;
export function regenerateClientApiKey(): Promise<{ ok: boolean; api_key: string; api_key_masked: string }>;

// ── Integrations: webhooks ───────────────────────────────────────────────────
export function getWebhooks(botId?: number): Promise<Webhook[]>;
export function createWebhook(botId: number, data: Record<string, unknown>): Promise<Webhook>;
export function updateWebhook(webhookId: number, data: Record<string, unknown>): Promise<Webhook>;
export function deleteWebhook(webhookId: number): Promise<Record<string, unknown>>;
export function getWebhookDeliveries(webhookId: number, page?: number): Promise<WebhookDeliveriesResult>;
export function testWebhook(webhookId: number): Promise<Record<string, unknown>>;

// ── Platform feedback (admin → OyeChats product feedback widget) ────────────
// Distinct from `FeedbackItem` (`features/feedback/types`), which is the
// visitor thumbs-up/down rating log on a bot's own conversations.

/** A single feedback attachment as persisted/returned by the backend. */
export interface PlatformFeedbackAttachment {
  url: string;
  name?: string;
  content_type?: string;
}

/** One row from `GET /client/feedback` - the caller's own submitted feedback. */
export interface PlatformFeedbackItem {
  id: number;
  message: string;
  type: 'bug' | 'feature_request' | 'question' | 'other';
  area: 'billing' | 'bots' | 'knowledge' | 'live_chat' | 'dashboard' | 'widget' | 'other' | null;
  severity: 'low' | 'medium' | 'high' | 'critical' | null;
  context: Record<string, unknown> | null;
  attachments: PlatformFeedbackAttachment[] | null;
  status: 'open' | 'in_progress' | 'resolved' | 'closed';
  admin_response: string | null;
  created_at: string;
  resolved_at: string | null;
}

/** POST /client/feedback - submit a classified feedback entry. */
export function submitPlatformFeedback(payload: {
  message: string;
  type?: string;
  area?: string | null;
  severity?: string | null;
  context?: Record<string, unknown> | null;
  attachments?: PlatformFeedbackAttachment[] | null;
}): Promise<{ ok: true }>;

/** POST /client/feedback/upload (multipart) - upload one attachment, returns its hosted URL. */
export function uploadFeedbackAttachment(file: File): Promise<{ url: string }>;

/** GET /client/feedback - the caller's own feedback, newest first. */
export function getMyFeedback(): Promise<PlatformFeedbackItem[]>;

// ── Live chat: operator console ──────────────────────────────────────────────
// Runtime wrappers live in services/api.js; typed loosely (callers cast to a
// local response shape). Consumed by the Inbox live-chat operator console.

/** GET /operators/queue - waiting sessions + this operator's active chats. */
export function getOperatorQueue(): Promise<Record<string, unknown>>;
/** GET /operators/qualified-sessions - bot sessions eligible for proactive takeover. */
export function getQualifiedBotSessions(limit?: number): Promise<Record<string, unknown>>;
/** POST /operators/accept/{sessionId} - take a waiting visitor (bot→live). */
export function acceptChat(sessionId: string, operatorId?: number | null): Promise<Record<string, unknown>>;
/** POST /operators/close/{sessionId} - end an active chat (live→bot). */
export function closeOperatorChat(sessionId: string): Promise<Record<string, unknown>>;
export function resolveOperatorChat(sessionId: string): Promise<Record<string, unknown>>;
/** POST /operators/transfer/{sessionId} - hand a chat to another operator/department. */
export function transferChat(sessionId: string, data: Record<string, unknown>): Promise<Record<string, unknown>>;
/** GET /operators/session/{sessionId} - visitor identity/geo/device + history. */
export function getSessionDetails(sessionId: string): Promise<Record<string, unknown>>;
/** POST /operators/connect-request - proactively invite a bot-session visitor to a human. */
export function sendConnectRequest(
  sessionId: string,
  operatorId?: number | null,
): Promise<Record<string, unknown>>;
/** POST /operators/connect-request/{sessionId}/cancel - withdraw a pending connect invite. */
export function cancelConnectRequest(sessionId: string): Promise<Record<string, unknown>>;

// ── Knowledge: recrawl lifecycle ─────────────────────────────────────────────
/** POST /bots/{id}/crawl/cancel - stop an in-progress crawl. */
export function cancelCrawl(botId: number): Promise<Record<string, unknown>>;
/** Preview a recrawl diff (unchanged/new/removed) before spending credits; mode 'full' | 'delta'. */
export function diffRecrawl(
  url: string,
  replaceSource?: string | null,
  botId?: number,
  mode?: string,
): Promise<Record<string, unknown>>;
/** GET recrawl history/status for a bot's sources. */
export function getRecrawlStatus(botId: number): Promise<Record<string, unknown>>;

// ── Notifications: web push (settings) ───────────────────────────────────────
/** GET /operators/push/vapid-public-key - server VAPID key + whether push is enabled. */
export function getVapidPublicKey(): Promise<{ public_key: string; enabled: boolean }>;
/** POST /operators/push/subscribe - persist a PushSubscription for this operator. */
export function subscribePush(subscription: unknown): Promise<Record<string, unknown>>;
/** DELETE /operators/push/subscribe - remove a stored push subscription. */
export function unsubscribePush(endpoint: string, keys?: unknown): Promise<boolean>;

// ── Personality: brand-tone AI assist (experience) ───────────────────────────
/** GET /bots/brand-tone-presets - the selectable brand-tone presets. */
export function getBrandTonePresets(): Promise<Array<Record<string, unknown>>>;
/** POST /bots/{id}/brand-tone/detect - infer a brand tone from the crawled site. */
export function detectBrandTone(botId: number): Promise<Record<string, unknown>>;

// ── Demo share tracking (channels) ───────────────────────────────────────────
/** POST /bots/{id}/demo-share-click - record a shared demo-link click. */
export function trackDemoShareClick(botId: number): Promise<Record<string, unknown>>;
