import axios from 'axios';
import type { AxiosInstance, AxiosRequestHeaders, InternalAxiosRequestConfig } from 'axios';
import { ApiError, type ApiAxiosError } from './apiTypes';
import type { InstallDomains } from '../features/agents/channels/installDomainsModel';
import { t as translateNow } from '../i18n/i18n';
import { getAuthItem, setAuthItem, clearAuthStorage } from '../utils/authStorage';
import {
    IMPERSONATION_FORBIDDEN_MESSAGE,
    endImpersonationSession,
    getImpersonationToken,
    isImpersonating,
    isImpersonationSessionEnded,
} from '../utils/impersonation';

import type {
  ActivityPoint,
  Bot,
  CannedResponse,
  CannedResponsesResult,
  ChatMessage,
  CrawlDiscovery,
  CrawlStatus,
  CurrentUser,
  Department,
  Entitlements,
  KnowledgeSource,
  KnowledgeState,
  Lead,
  LeadsQuery,
  LeadsResult,
  NotificationItem,
  OfflineMessagesResult,
  Operator,
  OperatorInvite,
  OperatorInviteCreated,
  OperatorStatus,
  SelfOperatorResult,
  SourcePagesResult,
  TopQuestion,
  UnansweredQuestion,
  Webhook,
  WebhookDeliveriesResult,
  Workspace,
} from '../types/domain';
import type { FeedbackItem } from '../features/feedback/types';

/* ────────────────────────────────────────────────────────────────────────────
 * Response shapes
 *
 * Relocated verbatim from the api.d.ts shim, which is what consumers imported
 * these from. They describe wire payloads, so they live with the client that
 * parses them rather than in types/domain, which holds the app's own model.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * The caller's in-flight crawl, from Redis. Never rejects: a network failure
 * resolves to `idle`.
 *
 * `status` is the `CrawlStatus` union (see `types/domain`), which is the exact
 * vocabulary the worker writes: `set_crawl_progress` callers and
 * `_terminal_status` in `crawl_orchestrator.py`. It used to carry a `| string`
 * tail, which collapsed the union to `string` and let consumers branch on
 * `'completed'` — a status the backend has never emitted — without the compiler
 * objecting. Server strings are still validated at runtime before they reach
 * the app's own state; see `toCrawlStatus` in `context/CrawlContext`.
 */
export interface CrawlProgress {
  status: CrawlStatus;
  urls?: string[];
  pages_crawled?: number;
  max_pages?: number;
  current_url?: string | null;
  /** Epoch SECONDS as a float. The worker stamps `time.time()`
   *  (crawl_orchestrator.py), so this is a number, not an ISO string. */
  started_at?: number | null;
  /** Server-side phase label, e.g. "Scanning pages" /
   *  "Embedding 3,400/9,795 chunks". Written by `set_crawl_progress`. */
  phase?: string | null;
  cancellable?: boolean;
  result?: Record<string, unknown> | null;
  error?: string | null;
}

export interface UploadCostPreview {
  per_file: Array<{
    filename: string;
    words: number;
    credits: number;
    reason?: string;
    detail?: string;
    size_bytes?: number;
  }>;
  total_credits: number;
  current_balance: number;
  sufficient: boolean;
}

/**
 * One background ingestion job, as reported by `GET /ingest/status/{job_id}`.
 *
 * `status` mirrors ARQ's own job states. `not_found` is a real answer, not an
 * error: ARQ drops finished job records after its retention window, so a job
 * polled late reads as missing rather than as complete.
 */
export interface IngestJobStatus {
  job_id: string;
  status: 'queued' | 'in_progress' | 'complete' | 'failed' | 'not_found' | (string & {});
  function?: string;
  enqueue_time?: string | null;
  start_time?: string;
  finish_time?: string;
  result?: unknown;
}

/** What `POST /bots/{botId}/install-invite` reports back. */
export interface InstallInviteResult {
  email: string;
  sent_at: string;
  /** True when this address had already been mailed for this chatbot. */
  resent: boolean;
}

/** `POST /auth/login` — the customer/admin credential. */
export interface ClientLoginResult {
  access_token: string;
  token_type?: string;
  client_id: number;
  name: string;
  is_superadmin?: boolean;
  is_verified?: boolean;
  company_name?: string | null;
  website?: string | null;
}

/**
 * `POST /auth/operator-login` — the team-member credential.
 *
 * A separate endpoint with a separate password, and it answers a bad attempt
 * with the same 401 the customer endpoint does, so nothing in the response
 * distinguishes "wrong password" from "not an operator".
 */
export interface OperatorLoginResult {
  access_token: string;
  token_type?: string;
  operator_id: number;
  client_id: number;
  default_bot_id?: number | null;
  name: string;
  role: string;
  department_id?: number | null;
  company_name?: string | null;
  website?: string | null;
}

/** `POST /auth/register`. `is_verified` is true only where the backend auto-verifies. */
export interface RegisterResult {
  access_token: string;
  token_type?: string;
  client_id: number;
  name: string;
  is_superadmin?: boolean;
  is_verified?: boolean;
  company_name?: string | null;
  website?: string | null;
  message?: string;
}

/** The OTP endpoints all answer with the server's own wording under `message`. */
export interface AuthMessageResult {
  message?: string;
}

export interface SessionAuditEntry {
  action: string;
  operator_id: number | null;
  details: Record<string, unknown> | null;
  created_at: string | null;
}

export interface QueueSummary {
  current_depth: number;
  avg_wait_seconds: number | null;
  resolved_count: number;
  abandoned_count: number;
}

/** One agent's activity in the reporting window. Agents with no activity at
 *  all are omitted by the backend, so a row always has a non-zero metric. */
export interface PerAgentReportRow {
  bot_id: number;
  bot_name: string;
  /** Consumption credits only - grants, top-ups, refunds and expiries excluded. */
  credits_spent: number;
  conversations: number;
  leads: number;
}

export interface PerAgentReport {
  /** ISO-8601 window bounds, both inclusive. */
  since: string;
  until: string;
  rows: PerAgentReportRow[];
  totals: {
    credits_spent: number;
    conversations: number;
    leads: number;
  };
}

export type JourneyPeriod = string;

export type JourneyPhase = 'pre' | 'chat' | 'post';

export type JourneyConversionType =
  | 'meeting_booked'
  | 'handoff_requested'
  | 'offline_message_sent';

export interface JourneySummary {
  sessions_with_journey: number;
  meeting_booked: number;
  handoff_requested: number;
  offline_message_sent: number;
  /** Sessions with a journey but no conversion event AND no post-chat
   *  page, the honest drop-off count. Prefer this over deriving
   *  drop-off by subtraction; subtraction double-counts sessions that
   *  both converted AND kept browsing. Optional for backward compat
   *  with older API builds. */
  sessions_no_activity?: number;
  /** Sessions with a journey that fired NO conversion event but DID
   *  visit at least one post-chat page. "kept browsing, no outcome".
   *  The right-hand outcome column needs this bucket to reconcile with
   *  `sessions_with_journey`: conversions + this + `sessions_no_activity`
   *  partition every journey exactly once. Optional for backward compat
   *  with older API builds (card is simply omitted when absent). */
  sessions_browsed_no_conversion?: number;
  leads_captured: number;
}

export interface JourneyTopPageRow {
  path: string;
  sessions: number;
  visits: number;
}

export interface JourneyTopPagesResponse {
  period: JourneyPeriod;
  phase: JourneyPhase | null;
  rows: JourneyTopPageRow[];
}

export interface JourneyPathRow {
  sequence: string[];
  sessions: number;
  conversion_rate: number;
}

export interface JourneyConversionPathsResponse {
  period: JourneyPeriod;
  conversion_type: JourneyConversionType;
  total_conversions: number;
  total_sessions: number;
  paths: JourneyPathRow[];
}

export interface JourneyPostChatResponse {
  period: JourneyPeriod;
  sessions_with_post_chat_activity: number;
  /** DISTINCT sessions where each page was the visitor's FIRST post-chat stop. */
  first_hops: Array<{ path: string; sessions: number }>;
  /** DISTINCT sessions where each page appeared ANYWHERE in the post-chat path. */
  all_hops: Array<{ path: string; sessions: number }>;
  full_sequences: Array<{ sequence: string[]; sessions: number }>;
}

export interface JourneyPreChatSequencesResponse {
  period: JourneyPeriod;
  total_sessions: number;
  sessions_with_pre_chat: number;
  sequences: Array<{
    sequence: string[];
    /** Top post-chat continuation for THIS pre-chat pattern,
     *  the ordered pages visitors most commonly took after opening
     *  chat. Empty array when no session with this pre-pattern had
     *  any post-chat activity. Drives the per-row post-chain that
     *  flows rightward from the chatbot in the diagram. */
    post_sequence: string[];
    /** Number of sessions that ACTUALLY took the winning post_sequence
     *  above. Distinct from `sessions` (which is the pre-pattern's
     *  total): a pre-pattern with 100 sessions where only 3 took the
     *  top post-continuation has `sessions: 100` and `post_sessions: 3`.
     *  The diagram labels post-chain cards with this count so numbers
     *  don't overstate reach. Optional for backward compat with older
     *  API builds. */
    post_sessions?: number;
    sessions: number;
  }>;
}

export interface SendFollowUpResult {
  success: boolean;
}

/** One address on a bot's permanent do-not-email list. */
export interface EmailSuppression {
  id: number;
  bot_id: number;
  bot_name: string | null;
  email: string;
  reason: string;
  created_at: string | null;
}

export interface EmailSuppressionsResult {
  suppressions: EmailSuppression[];
  total: number;
  page: number;
  limit: number;
}

/** What the server recomputes after an operator corrects one dimension's score. */
export interface QualificationOverrideResult {
  session_id: string;
  dimension: string;
  score_before: number;
  score_after: number;
  bant_score: number;
  bant_tier: string;
}

/** Per-event push opt-outs. Mirrors `_PUSH_EVENT_KEYS` in `operator_routes.py`. */
export interface PushEventPreferences {
  handoff_request: boolean;
  chat_transferred: boolean;
  offline_message: boolean;
}

/** A nightly window during which push is withheld. `HH:MM`, 24-hour. */
export interface PushQuietHours {
  start: string;
  end: string;
  tz: string;
}

export interface NotificationPreferences {
  push: {
    enabled: boolean;
    events: PushEventPreferences;
    quiet_hours: PushQuietHours | null;
  };
}

/**
 * Subscription geo/currency profile: `{ country, display_currency, display_rate, checkout_available, … }`.
 * `display_currency` tracks the charge path: `"INR"` for India and for an unresolved country
 * (an unconfirmed buyer is domestic), `"USD"` only for a stored/detected non-IN country.
 */
export interface BillingGeoResponse extends Record<string, unknown> {
  /** ISO-2 billing country, or null when nothing resolved it. */
  country?: string | null;
  /** Trust grade of `country`. A 'detected' country is DISPLAY-ONLY. */
  country_source?: 'stored' | 'detected' | null;
  /** 'INR' | 'USD'. */
  display_currency?: string;
  display_rate?: number;
  /**
   * Tax ADDED to this caller's charges, in basis points (1800 = 18%), because
   * every published price is exclusive of tax. Absent on builds that predate
   * the field. **0 is a real answer**: an export pays no Indian GST, and an
   * unregistered seller adds none. Never assume 18.
   */
  tax_rate_bps?: number;
  checkout_available?: boolean;
  razorpay_enabled?: boolean;
  razorpay_key_id?: string | null;
  contact_sales_email?: string;
}

/**
 * Honest pre-checkout quote. No proration.
 *
 * Carries THREE amounts on every branch, not one, because published prices are
 * exclusive of tax: the taxable base (`amount_minor` / `amount_display`), the
 * tax (`tax_minor` at `tax_rate_bps`), and the gross the mandate actually
 * debits (`gross_minor` / `gross_display`). A surface showing the customer one
 * number before the Razorpay sheet opens must show the GROSS; quoting
 * `amount_display` as the amount payable understates it by the tax.
 */
export interface CheckoutQuoteResponse extends Record<string, unknown> {
  country?: string | null;
  /** 'INR' | 'USD' - the currency all four amounts below are denominated in. */
  currency?: string;
  /** BASE price, minor units, exclusive of tax. NOT the amount payable. */
  amount_minor?: number;
  /** BASE price, preformatted. NOT the amount payable. */
  amount_display?: string;
  /** Tax on the base, minor units. 0 on the export rail. */
  tax_minor?: number;
  /** Rate applied to the base, basis points (1800 = 18%). 0 on the export rail. */
  tax_rate_bps?: number;
  /** Base + tax, minor units: what the mandate debits. */
  gross_minor?: number;
  /** Base + tax, preformatted: what the mandate debits. */
  gross_display?: string;
  billing_cycle?: string;
  provider?: string | null;
  methods?: string[];
  /** False → render Contact Sales instead of a pay button. */
  checkout_supported?: boolean;
  reason?: string;
  contact_sales?: string | null;
}

/**
 * Add (delta > 0) or remove (delta < 0) operator seats; may return
 * `{ requires_authorization, checkout }` on the first extra seat.
 *
 * `extra_seat_price_cents` is the BASE per-seat price. The add-on mandate
 * collects base + tax, so `gross_extra_seat_price_cents` is the figure that
 * matches the Razorpay sheet opened from this same response.
 */
export interface SeatChangeResponse extends Record<string, unknown> {
  message?: string;
  requires_authorization?: boolean;
  checkout?: Record<string, unknown>;
  pending_seats?: number;
  total_seats?: number;
  extra_seats?: number;
  operator_quantity?: number;
  included_operator_seats?: number;
  /** BASE per-seat price, minor units, exclusive of tax. */
  extra_seat_price_cents?: number;
  /** Base + tax per seat, minor units: what the seat mandate debits. */
  gross_extra_seat_price_cents?: number;
  /** Rate applied to the base, basis points. 0 on the export rail. */
  tax_rate_bps?: number;
  /** ISO-4217 code the seat prices are denominated in. */
  currency?: string;
}

/**
 * Buy the branding-removal add-on → `{ message, active, pending,
 * requires_authorization, checkout, price_cents, gross_price_cents,
 * tax_rate_bps, currency }`. The entitlement is granted by the activation
 * webhook, never by this response, so `active` stays false until the mandate is
 * authorized.
 *
 * `price_cents` is the BASE. `gross_price_cents` is base + tax, the figure the
 * add-on mandate actually debits, and the one any label beside a buy button
 * should quote.
 */
export interface BrandingAddonResponse extends Record<string, unknown> {
  message?: string;
  active?: boolean;
  pending?: boolean;
  requires_authorization?: boolean;
  checkout?: Record<string, unknown>;
  /** BASE add-on price, minor units, exclusive of tax. */
  price_cents?: number;
  /** Base + tax, minor units: what the add-on mandate debits. */
  gross_price_cents?: number;
  /** Rate applied to the base, basis points. 0 on the export rail. */
  tax_rate_bps?: number;
  /** ISO-4217 code both prices are denominated in. */
  currency?: string;
}

/**
 * One-off credit pack.
 *
 * `inr` is the BASE rupee price and stays the amount posted to
 * {@link initiateTopup}; the server adds tax when it mints the order. `gross_inr`
 * is base + tax, the figure the Razorpay sheet shows, and the one a tile should
 * display. `usd` needs no gross twin: an export carries no Indian GST, so the
 * listed dollar figure is already the full charge.
 */
export interface TopupPackResponse extends Record<string, unknown> {
  /** BASE rupee price (major units). What {@link initiateTopup} is called with. */
  inr?: number;
  /** Base + tax in rupees (major units): what Razorpay debits. */
  gross_inr?: number;
  /** Legacy alias for `inr`. */
  amount?: number;
  /** USD display price. Export rail, so no Indian GST is added on top. */
  usd?: number;
  credits?: number;
  bonus_pct?: number;
  badge?: string;
}

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


const API_BASE_URL: string = import.meta.env.VITE_API_URL || 'https://api.oyechats.com';

/** Returns the backend endpoint configured for this dashboard build. */
export const getApiBaseUrl = (): string => API_BASE_URL;

// Public / auth routes where a background 401 (e.g. a stale token left in
// storage) must NOT force-redirect the visitor to /login. Otherwise landing
// on /register from the marketing "Start free" CTA with a lapsed token would
// bounce straight to /login. On these pages we still clear the bad token, we
// just leave the user where they intended to be.
const PUBLIC_AUTH_PATHS: readonly string[] = [
    '/login',
    '/register',
    '/forgot-password',
    '/verify-email',
    '/auth/callback',
    '/affiliate-invite',
    '/affiliate-accept',
    '/invite',
];

function isOnPublicAuthPath(): boolean {
    if (typeof window === 'undefined') return false;
    const path = window.location.pathname;
    return PUBLIC_AUTH_PATHS.some((p) => path === p || path.startsWith(`${p}/`));
}

const api = axios.create({
    baseURL: API_BASE_URL,
    headers: {
        'Content-Type': 'application/json',
    },
    timeout: 30000,
});

/**
 * The configured axios instance.
 *
 * Exported so the platform console can reuse the auth header, impersonation
 * suppression, 401 handling and error shaping that live on this client's
 * interceptors. Roughly a hundred super-admin endpoints have no wrapper here,
 * and a second `axios.create` would silently lose every one of those.
 *
 * It must stay BELOW the `axios.create` call. `const` bindings are hoisted into
 * a temporal dead zone, so an `export const httpClient = api` placed earlier in
 * the file throws `ReferenceError: Cannot access 'api' before initialization`
 * the moment this module is evaluated — which takes down every screen in the
 * app, not just the console. That is exactly what it did.
 */
export const httpClient: AxiosInstance = api;

const buildApiError = (
    error: unknown,
    fallbackMessage: string = translateNow('app.requestFailed') || 'Request failed',
): ApiError => {
    // Every caller passes an axios rejection, but `catch` binds `unknown` and a
    // non-axios throw (a bug in a then-handler) must not crash the builder.
    const axiosError = error as ApiAxiosError;
    const status = axiosError.response?.status;
    const data = axiosError.response?.data;
    let detail: unknown = data?.detail;

    // Handle Pydantic 422 validation errors (detail is an array of error objects)
    if (status === 422 && Array.isArray(detail) && detail.length > 0) {
        const first = detail[0] as { msg?: string; message?: string } | undefined;
        const msg = first?.msg || first?.message || translateNow('app.validationError') || 'Validation error';
        // @i18n-exempt: this strips a prefix the SERVER emits (FastAPI's
        // pydantic message). Translating it would stop the replace matching
        // and leak "Value error, " into the message shown to the user.
        detail = msg.replace('Value error, ', '');
    }

    // Structured FastAPI errors (e.g. 402 insufficient_credits) put a
    // human-readable string under detail.message - surface that instead of
    // letting axios's "Request failed with status code 402" leak through.
    let message: string;
    if (typeof detail === 'string') {
        message = detail;
    } else if (
        detail
        && typeof detail === 'object'
        && typeof (detail as { message?: unknown }).message === 'string'
    ) {
        message = (detail as { message: string }).message;
    } else if (status === 429) {
        // SlowAPI uses {"error": "Rate limit exceeded: ..."} - not FastAPI's {"detail": "..."}
        message = (typeof data?.error === 'string' && data.error)
            ? data.error
            : translateNow('app.tooManyRequestsPleaseWait') || 'Too many requests - please wait a moment and try again.';
    } else {
        message = axiosError.message || fallbackMessage;
    }

    return new ApiError(message, { status, detail: data?.detail ?? null, data });
};

// The active AbortController for the current workspace context. Every API
// request opts in to being cancelled on workspace switch via ``config.signal``
// unless the caller supplied their own signal. The controller is rotated by
// ``WorkspaceContext.switchWorkspace`` so all in-flight requests scoped to
// the previous workspace abort atomically - this prevents cross-tenant data
// leaks where a slow response for workspace A lands after the UI switched
// to workspace B.
let currentWorkspaceAbortController: AbortController | null = null;

/**
 * Return the AbortSignal that new requests should use, minting a fresh
 * controller lazily. Exported so ``WorkspaceContext`` can call
 * ``rotateWorkspaceAbort`` on switch.
 */
export function rotateWorkspaceAbort(): AbortSignal {
    if (currentWorkspaceAbortController) {
        try { currentWorkspaceAbortController.abort(); } catch { /* noop */ }
    }
    currentWorkspaceAbortController = new AbortController();
    return currentWorkspaceAbortController.signal;
}

function getWorkspaceAbortSignal(): AbortSignal {
    if (!currentWorkspaceAbortController) {
        currentWorkspaceAbortController = new AbortController();
    }
    return currentWorkspaceAbortController.signal;
}

/**
 * Marker set on the axios request config for every request issued under an
 * impersonation credential. The response interceptor reads it back off
 * ``error.config`` so it can classify a failure by the credential the request
 * ACTUALLY carried, instead of re-reading storage that a concurrent failure may
 * already have cleared. A Symbol so it can never collide with an axios option.
 */
const IMPERSONATED_REQUEST = Symbol('oyechats.impersonatedRequest');

declare module 'axios' {
    interface InternalAxiosRequestConfig {
        /** Set on every request issued under an impersonation credential, so the
         *  response interceptor can classify a failure by the credential the
         *  request ACTUALLY carried rather than by re-reading storage. */
        [IMPERSONATED_REQUEST]?: boolean;
    }
}

/**
 * Drop a header regardless of whether ``headers`` is a plain object or an
 * ``AxiosHeaders`` instance (the latter matches case-insensitively).
 */
function dropHeader(headers: AxiosRequestHeaders | undefined, name: string): void {
    if (!headers) return;
    if (typeof headers.delete === 'function') headers.delete(name);
    else delete (headers as Record<string, unknown>)[name];
}

// Request interceptor: inject API key (supports both Client and Operator auth).
// Reads via authStorage so session-only logins ("Remember me" off) land in
// sessionStorage and still attach correctly here. Also attaches
// ``X-Workspace-Id`` for Client-authed requests so the backend can resolve
// which workspace the caller is acting in (their own vs. a linked-operator
// workspace they joined via an invite).
api.interceptors.request.use(
    (config: InternalAxiosRequestConfig) => {
        // ── Impersonation: the token IS the session ──────────────────────
        // A super-admin support session authenticates with a short-lived,
        // revocable ``X-Impersonation-Token`` and NOTHING else. The permanent
        // credentials (``X-API-Key``/``X-Operator-Key``) and the workspace hints
        // derived from them are suppressed outright: the backend re-resolves the
        // target Account from the token on every request, and sending the
        // super-admin's own key alongside would make the effective identity
        // ambiguous. This branch returns before the normal path so
        // non-impersonated behaviour below is byte-for-byte unchanged.
        const impersonationToken = getImpersonationToken();
        if (impersonationToken) {
            config.headers['X-Impersonation-Token'] = impersonationToken;
            dropHeader(config.headers, 'X-API-Key');
            dropHeader(config.headers, 'X-Operator-Key');
            dropHeader(config.headers, 'X-Workspace-Id');
            dropHeader(config.headers, 'X-Acting-Role');
            config[IMPERSONATED_REQUEST] = true;
            if (!config.signal) {
                config.signal = getWorkspaceAbortSignal();
            }
            return config;
        }

        // The session ended (expired, revoked, or the operator hit Exit) but
        // components are still mounted and pollers still tick. Cancel locally
        // rather than letting the request fall through to the branch below,
        // where it would silently re-authenticate as whatever real session this
        // browser has in localStorage - a support tab must never quietly become
        // the super-admin's own account. Cancellations are swallowed by the
        // response interceptor's ``isCancel`` guard.
        if (isImpersonationSessionEnded()) {
            return Promise.reject(new axios.CanceledError(translateNow('app.impersonationEnded') || 'Impersonation session ended'));
        }

        const token = getAuthItem('admin_token');
        const authType = getAuthItem('auth_type'); // 'client' or 'operator'
        if (token) {
            if (authType === 'operator') {
                config.headers['X-Operator-Key'] = token;
            } else {
                config.headers['X-API-Key'] = token;
                // Only client auth benefits from X-Workspace-Id - legacy operator
                // keys are implicitly scoped to their one workspace and the
                // backend ignores the header on that auth path.
                const workspaceId = getAuthItem('current_workspace_id');
                if (workspaceId) {
                    config.headers['X-Workspace-Id'] = workspaceId;
                }
                // ``X-Acting-Role`` communicates which persona the switcher
                // pill is currently in. Backend uses it to scope endpoints
                // like ``GET /bots`` and ``GET /offline-messages`` to the
                // caller's self-operator bot when they've added themselves
                // as an operator in their OWN workspace (auth resolves as
                // ``client`` there - no X-Workspace-Id is sent because it's
                // their own workspace - so without this hint we can't tell
                // "owner viewing their workspace as owner" from "owner
                // viewing their workspace as operator").
                const workspaceRole = getAuthItem('current_workspace_role');
                if (workspaceRole) {
                    config.headers['X-Acting-Role'] = workspaceRole;
                }
            }
        }
        // Opt every request into the workspace-scoped abort controller unless
        // the caller explicitly provided their own signal (e.g. long-running
        // stream downloads that manage their own cancellation).
        if (!config.signal) {
            config.signal = getWorkspaceAbortSignal();
        }
        return config;
    },
    (error: unknown) => Promise.reject(error)
);

/** Structured error code the backend's impersonation write guard returns on 403. */
const IMPERSONATION_READ_ONLY_CODE = 'impersonation_read_only';

/** Methods the impersonation write guard always permits (read-only verbs). */
const IMPERSONATION_SAFE_METHODS: readonly string[] = ['get', 'head', 'options'];

/**
 * True when a 403 under impersonation is the backend's write guard refusing a
 * non-allowlisted mutation.
 *
 * Primary signal is the structured ``detail.error`` code. The method check is
 * the fallback for a denial that arrives without it (an intermediary, or a
 * backend older than the guard): the guard only ever refuses mutations, so a
 * 403 on a safe method came from somewhere else (plan gating, ownership) and
 * must keep its own message.
 */
function isImpersonationBlockedWrite(error: ApiAxiosError): boolean {
    const detail = error.response?.data?.detail;
    if (detail && typeof detail === 'object' && !Array.isArray(detail)) {
        return detail.error === IMPERSONATION_READ_ONLY_CODE;
    }
    const method = (error.config?.method || '').toString().toLowerCase();
    return !IMPERSONATION_SAFE_METHODS.includes(method);
}

/**
 * Give a write-guard 403 a human sentence on ``error.message``.
 *
 * The structured ``detail`` is left intact - that is how every other structured
 * error in this app behaves (``workspace_access_denied``, ``must_subscribe``,
 * ``insufficient_credits``), and ``buildApiError`` already lifts
 * ``detail.message`` out of it. What it does NOT cover is the call sites that
 * use the axios error directly, which would otherwise show the raw "Request
 * failed with status code 403". The backend's own copy wins when present; the
 * constant is the fallback when the denial carries no message at all.
 */
function applyImpersonationForbiddenCopy(error: ApiAxiosError): void {
    const detail = error.response?.data?.detail;
    let message = '';
    if (typeof detail === 'string') message = detail;
    else if (
        detail
        && typeof (detail as { message?: unknown }).message === 'string'
    ) message = (detail as { message: string }).message;
    error.message = message || IMPERSONATION_FORBIDDEN_MESSAGE;
}

// Response interceptor: handle auth errors globally
api.interceptors.response.use(
    (response) => response,
    (error) => {
        // Requests aborted by a workspace switch (via ``rotateWorkspaceAbort``)
        // arrive here as ``ERR_CANCELED`` from axios. Suppress the auto-logout
        // path and don't rethrow noisily - callers should filter these via
        // ``axios.isCancel(err)`` and simply not update state.
        if (axios.isCancel?.(error) || error.code === 'ERR_CANCELED') {
            return Promise.reject(error);
        }

        const status = error.response?.status;

        // ── Impersonation short-circuit - MUST stay above everything below ──
        // A support session has its own lifecycle. The backend re-validates the
        // token on every request, so a revoke or an expiry surfaces as a 401 on
        // the very next call, and the write guard refuses non-allowlisted
        // mutations with a 403.
        //
        // Neither may reach the auto-logout block further down. That block calls
        // ``clearAuthStorage()``, which wipes the SHARED localStorage auth bundle
        // - i.e. the super-admin's genuine credentials in every other tab of this
        // browser. Returning early here is what guarantees it is unreachable
        // while impersonating; nothing between this point and that block may be
        // allowed to run either, so this check is the first thing after
        // ``status`` is known.
        //
        // Three independent ways to recognise the context, so none of them
        // failing can let a 401 through to the auto-logout: the per-request
        // marker (survives a concurrent 401 that already cleared the session),
        // live session state, and the "this tab WAS an impersonation tab" latch.
        if (
            error.config?.[IMPERSONATED_REQUEST] === true
            || isImpersonating()
            || isImpersonationSessionEnded()
        ) {
            if (status === 401) {
                endImpersonationSession(translateNow('app.thisImpersonationSessionExpiredOr') || 'This impersonation session expired or was revoked.');
            } else if (status === 403 && isImpersonationBlockedWrite(error)) {
                applyImpersonationForbiddenCopy(error);
            }
            return Promise.reject(error);
        }

        const authType = getAuthItem('auth_type');
        const detailRaw = error.response?.data?.detail;
        const detail = (detailRaw || '').toString().toLowerCase();
        const detailErrorCode = (typeof detailRaw === 'object' && detailRaw?.error) || null;
        const requestUrl = (error.config?.url || '').toString();

        const isLoginAttempt = requestUrl.includes('/auth/login') || requestUrl.includes('/auth/operator-login');
        const isOperatorOnClientOnlyEndpoint = authType === 'operator' && detail.includes('api key');

        // A 403 with error code ``workspace_access_denied`` means the caller
        // still holds a valid Client identity but has lost access to the
        // workspace they had cached in ``current_workspace_id`` (revoked,
        // deleted, or otherwise). Don't nuke the whole session - surface the
        // signal so the frontend can drop the workspace, refresh the list,
        // and land the user on a workspace they still belong to.
        if (status === 403 && detailErrorCode === 'workspace_access_denied') {
            window.dispatchEvent(new CustomEvent('oyechats:workspace-access-denied', {
                detail: { workspaceId: getAuthItem('current_workspace_id') },
            }));
            return Promise.reject(error);
        }

        // Public routes must NOT trigger the auto-logout redirect. A stray
        // 401 from a speculative call (entitlements fired at app root, an
        // authed hook that happens to be mounted) would bounce an
        // unauthenticated visitor OFF the invite airlock, register form,
        // or verify-email page - turning legitimate public-page visits
        // into infinite login redirects. The 401 still propagates as a
        // rejected promise so callers can handle it; we just skip the
        // catastrophic side-effect.
        const publicPath = window.location.pathname;
        const isOnPublicRoute = (
            publicPath === '/login'
            || publicPath === '/register'
            || publicPath === '/verify-email'
            || publicPath === '/forgot-password'
            || publicPath === '/auth/callback'
            || publicPath === '/affiliate-invite'
            || publicPath === '/affiliate-accept'
            || publicPath.startsWith('/invite/')
        );

        if (status === 401 && !isLoginAttempt && !isOperatorOnClientOnlyEndpoint && !isOnPublicRoute) {
            // Clear from BOTH stores so a session-only login that auto-
            // logs-out doesn't leave a stale localStorage shadow (or
            // vice versa).
            clearAuthStorage();
            // Only force the user to /login from a PROTECTED page. On public
            // auth pages (notably /register from the "Start free" CTA) a stale
            // token's 401 must not hijack the page - clear it and stay put.
            if (!isOnPublicAuthPath()) {
                window.location.href = '/login';
            }
        }
        return Promise.reject(error);
    }
);

/**
 * Redeem the raw token from a super-admin impersonation link.
 *
 * Deliberately bypasses the shared ``api`` instance: this call must carry NO
 * credential at all (the token in the body IS the authentication), and at the
 * moment it runs there is no impersonation session yet for the request
 * interceptor to key off - so going through it would attach whatever real
 * session this browser happens to have in localStorage.
 *
 * @param {string} token - the raw token lifted from ``?impersonation=``.
 * @returns {Promise<Object>} ``{ client_id, name, email, expires_at, actor_email, is_impersonation }``
 * @throws {Error} decorated with ``.status`` - 401 means expired, revoked or unknown.
 */
export const redeemImpersonation = async (
    token: string,
): Promise<{
  client_id: number;
  name: string;
  email: string;
  /** ISO-8601 instant at which the token stops being accepted. */
  expires_at: string;
  actor_email: string;
  is_impersonation: boolean;
}> => {
    try {
        const response = await axios.post(
            `${API_BASE_URL}/auth/impersonation/redeem`,
            { token },
            { headers: { 'Content-Type': 'application/json' }, timeout: 30000 },
        );
        return response.data;
    } catch (error) {
        throw buildApiError(error, 'This impersonation link could not be redeemed');
    }
};

/**
 * Authenticate admin and receive API Key
 * @param {string} email
 * @param {string} password
 * @returns {Promise<Object>} The API response with access_token and name
 */
/**
 * Resolved plan entitlements for the authenticated workspace. Returns the
 * dataclass payload from /auth/me/entitlements with derived helper booleans.
 * Used by useEntitlements() - components should NOT call this directly.
 */
export const getEntitlements = async (): Promise<Entitlements> => {
    try {
        const response = await api.get('/auth/me/entitlements');
        return response.data;
    } catch (error) {
        // Fail open on the client - caller falls back to "Free" defaults
        // baked into the hook so the UI never crashes if the endpoint is down.
        console.warn('[OyeChats] getEntitlements failed:', (error as Error | null)?.message);
        throw error;
    }
};

export const loginAdmin = async (email: string, password: string): Promise<ClientLoginResult> => {
    try {
        const response = await api.post('/auth/login', { email, password });
        return response.data;
    } catch (error) {
        console.error('API Error during login:', error);
        throw buildApiError(error, 'Login failed');
    }
};

/**
 * Self-service client registration.
 * @param {string} name - Full name
 * @param {string} email - Email address
 * @param {string} password - Password (min 8 chars, letter + number)
 * @param {string|null} companyName - Optional company name
 * @param {string|null} website - Optional website URL
 * @returns {Promise<Object>} The API response with access_token, client_id, name
 */
export const registerClient = async (
    name: string,
    email: string,
    password: string,
    companyName: string | null = null,
    website: string | null = null,
    billingCountry: string | null = null,
    promoCode: string | null = null,
): Promise<RegisterResult> => {
    try {
        const payload: Record<string, unknown> = { name, email, password, company_name: companyName, website };
        if (billingCountry) payload.billing_country = billingCountry;
        // Launch-promo code from the campaign link (?code=). Makes the offer
        // link-exclusive. Silently ignored server-side when unknown.
        if (promoCode) payload.promo_code = promoCode;
        const response = await api.post('/auth/register', payload);
        return response.data;
    } catch (error) {
        console.error('API Error during registration:', error);
        throw buildApiError(error, 'Registration failed');
    }
};

/**
 * Resolve the visitor's country (ISO 3166-1 alpha-2) from the request edge
 * headers, so the signup form can preselect it. Public endpoint, no auth.
 * Returns `null` when no edge signal is present (e.g. local dev) - never throws.
 * @returns {Promise<string|null>} 2-letter country code, or null.
 */
/**
 * Best-guess country for prefilling the signup form.
 *
 * `override` forwards a `?country=XX` from the page URL. The backend's
 * `resolve_country` has always honoured that parameter; it exists so a surface
 * can offer a manual toggle without every header-aware caller changing. Here it
 * is what makes the prefill exercisable off the edge network -- on localhost
 * there is no Cloudflare to inject `CF-IPCountry`, so detection correctly
 * returns null and the field can never be seen doing its job.
 *
 * It grants nothing a person could not do with the picker: the value lands in a
 * visible, editable field that still has to be submitted. Sanitised to two
 * letters before it is sent so a junk parameter is dropped here rather than
 * round-tripped.
 */
export const detectCountry = async (override?: string | null): Promise<string | null> => {
    try {
        const code = (override || '').trim().toUpperCase();
        const path = /^[A-Z]{2}$/.test(code)
            ? `/auth/detect-country?country=${code}`
            : '/auth/detect-country';
        const response = await api.get(path);
        const country = response.data?.country;
        return typeof country === 'string' && country.length === 2 ? country.toUpperCase() : null;
    } catch (error) {
        console.error('API Error during country detection:', error);
        return null;
    }
};

/**
 * Verify a client's email address with the 6-digit OTP.
 * @param {string} email
 * @param {string} otp
 */
export const verifyEmail = async (email: string, otp: string): Promise<AuthMessageResult> => {
    try {
        const response = await api.post('/auth/verify-email', { email, otp });
        return response.data;
    } catch (error) {
        throw buildApiError(error, 'Verification failed');
    }
};

/**
 * Re-send the email verification OTP.
 * @param {string} email
 */
export const resendVerification = async (email: string): Promise<AuthMessageResult> => {
    try {
        const response = await api.post('/auth/resend-verification', { email });
        return response.data;
    } catch (error) {
        throw buildApiError(error, 'Failed to resend code');
    }
};

/**
 * Apply a referral code for the currently-authenticated customer.
 * Called from the checkout modal before the user pays. Returns
 * { attributed: bool, message: string } - always resolves (never throws
 * for invalid codes; only throws on network error).
 * @param {string} code
 */
/**
 * Standing referral attribution for the authenticated account. Drives the
 * permanent-discount badge in the checkout modal - attribution is first-touch
 * and cannot be removed, so the UI must never render it as an editable field.
 */
export const getReferralStatus = async (
): Promise<{ attributed?: boolean; code?: string | null; discount_pct?: number | null } | null> => {
    try {
        const response = await api.get('/affiliate/referral-status');
        return response.data;
    } catch {
        // Non-fatal - the modal just falls back to the empty input; the
        // server still applies any standing discount at checkout.
        return { attributed: false, code: null, discount_pct: null };
    }
};

export const applyReferralCode = async (
    code: string,
): Promise<{ code: string | null; message: string; discount_pct?: number }> => {
    try {
        const response = await api.post('/affiliate/apply-referral', { code });
        return response.data;
    } catch (error) {
        throw buildApiError(error, 'Failed to apply referral code');
    }
};

/**
 * Request a password reset OTP
 * @param {string} email
 * @returns {Promise<Object>} API response
 */
export const requestPasswordReset = async (email: string): Promise<AuthMessageResult> => {
    try {
        const response = await api.post('/auth/request-password-reset', { email });
        return response.data;
    } catch (error) {
        console.error('API Error requesting password reset:', error);
        throw buildApiError(error, 'Failed to request reset');
    }
};

/**
 * Verify OTP and reset password
 * @param {string} email
 * @param {string} otp
 * @param {string} new_password
 * @returns {Promise<Object>} API response
 */
export const resetPassword = async (
    email: string,
    otp: string,
    new_password: string,
): Promise<AuthMessageResult> => {
    try {
        const response = await api.post('/auth/reset-password', { email, otp, new_password });
        return response.data;
    } catch (error) {
        console.error('API Error resetting password:', error);
        throw buildApiError(error, 'Failed to reset password');
    }
};

/**
 * Uploads multiple PDF documents to the ingestion endpoint.
 * @param {File[]} files - An array of File objects (must be PDFs)
 * @returns {Promise<Object>} The API response with upload results
 */
/**
 * Preview the credit cost of uploading files WITHOUT saving or charging.
 * Extracts each file server-side, counts words, and returns the tiered
 * credit charge per file plus the grand total and the caller's current
 * credit balance. The Knowledge panel calls this after the user drops
 * files so we can render "Upload for N credits" with an explicit
 * confirmation step, no surprise deductions.
 *
 * On failure, returns null so the caller can fall through to a plain
 * upload (best-effort: preview is UX sugar, not a correctness gate, the
 * real deduct happens on POST /ingest).
 *
 * @param {File[]} files - files the user is about to upload
 * @param {number|undefined} botId - optional bot scope
 * @returns {Promise<null | {
 *   per_file: {filename: string, words: number, credits: number, reason?: string, detail?: string, size_bytes?: number}[],
 *   total_credits: number,
 *   current_balance: number,
 *   sufficient: boolean,
 * }>}
 */
export const previewUploadCost = async (files: File[], botId?: number): Promise<UploadCostPreview | null> => {
    if (!files || files.length === 0) return null;
    const formData = new FormData();
    files.forEach((file) => {
        formData.append('files', file);
    });
    try {
        const url = botId ? `/ingest/preview-cost?bot_id=${botId}` : '/ingest/preview-cost';
        const response = await api.post(url, formData, {
            headers: { 'Content-Type': 'multipart/form-data' },
        });
        return response.data;
    } catch (error) {
        console.warn('Cost preview failed. Proceeding without preview:', error);
        return null;
    }
};

export const uploadDocuments = async (files: File[], botId?: number): Promise<unknown> => {
    const formData = new FormData();

    files.forEach((file) => {
        formData.append('files', file);
    });

    try {
        const url = botId ? `/ingest?bot_id=${botId}` : '/ingest';
        const response = await api.post(url, formData, {
            headers: {
                'Content-Type': 'multipart/form-data',
            },
        });
        return response.data;
    } catch (error) {
        console.error('API Error during document upload:', error);
        throw buildApiError(error, 'Document upload failed');
    }
};

/**
 * Poll a background ingestion job started by POST /ingest.
 *
 * `POST /ingest` returns 202 with a `job_id` whenever the ARQ worker is
 * enabled; this reads `GET /ingest/status/{job_id}` so an upload can report
 * honest progress instead of a spinner that stops the moment the HTTP request
 * settles (which is long before the document is readable by the chatbot).
 *
 * Statuses mirror ARQ: `queued` | `in_progress` | `complete` | `failed` |
 * `not_found`. The endpoint answers 501 when the worker is disabled, in which
 * case ingestion runs inline as a FastAPI BackgroundTask and there is no job
 * to poll - callers should treat that as "no progress available", not an error.
 *
 * @param {string} jobId - the `job_id` returned by uploadDocuments
 * @returns {Promise<{job_id: string, status: string, function?: string, enqueue_time?: string|null, start_time?: string, finish_time?: string, result?: unknown}>}
 */
export const getIngestStatus = async (jobId: string): Promise<IngestJobStatus> => {
    try {
        const response = await api.get(`/ingest/status/${encodeURIComponent(jobId)}`);
        return response.data;
    } catch (error) {
        console.error('API Error fetching ingest status:', error);
        throw buildApiError(error, 'Failed to load ingestion status');
    }
};

/**
 * Poll the current crawl progress (URLs discovered so far).
 * Lightweight - Redis read on the server, no DB.
 * Returns the full progress payload: status, urls, pages_crawled,
 * max_pages, current_url, started_at, cancellable, result (when done) or
 * error (when failed). Falls back to `{status: 'idle', urls: []}` on any
 * network error so callers can render safely.
 * @returns {Promise<Object>}
 */
export const getCrawlProgress = async (): Promise<CrawlProgress> => {
    try {
        const response = await api.get('/crawl/progress');
        return response.data;
    } catch {
        return { status: 'idle', urls: [] };
    }
};

/**
 * Request cancellation of the caller's in-flight crawl.
 * Returns 202 immediately; the actual cancel lands within a few seconds.
 * Idempotent. Safe to call when no crawl is running (returns a status hint).
 * @param {number|undefined} botId - Optional bot ID for ownership check
 * @returns {Promise<{status: string, message: string}>}
 */
export const cancelCrawl = async (botId?: number): Promise<Record<string, unknown>> => {
    try {
        const endpoint = botId ? `/crawl/cancel?bot_id=${botId}` : '/crawl/cancel';
        const response = await api.post(endpoint);
        return response.data;
    } catch (error) {
        console.error('API Error cancelling crawl:', error);
        throw buildApiError(error, 'Failed to cancel crawl');
    }
};

/**
 * Discover how many pages a website has without ingesting content.
 * Used for the pre-crawl confirmation step.
 * @param {string} url - The root URL to probe
 * @param {number|undefined} botId - Optional bot ID scope
 * @returns {Promise<{url: string, total_found: number, capped: boolean, plan_max: number}>}
 */
export const discoverCrawlUrls = async (url: string, botId?: number): Promise<CrawlDiscovery> => {
    try {
        const endpoint = botId ? `/crawl/discover?bot_id=${botId}` : '/crawl/discover';
        const response = await api.post(endpoint, { url }, { timeout: 30000 });
        return response.data;
    } catch (error) {
        console.error('API Error during URL discovery:', error);
        throw buildApiError(error, 'Failed to discover pages');
    }
};

/**
 * Diff a recrawl against existing stored pages for the same source.
 * Returns exact counts of unchanged, new, and removed URLs without ingesting.
 * @param {string} url - The root URL being recrawled
 * @param {string} replaceSource - The bare domain whose existing pages to diff against
 * @param {number|undefined} botId - Optional bot ID scope
 * @param {'full'|'delta'} mode - 'delta' (default) is Standard+ only and returns 403 for
 *   Free/Starter with detail.error === 'feature_not_available'. 'full' works for any tier
 *   and previews the total pages a full re-crawl would fetch.
 * @returns {Promise<{url: string, replace_source: string, mode: string, sitemap_total: number, existing_total: number, unchanged: number, new_pages: number, removed_pages: number, capped: boolean, plan_max: number}>}
 */
export const diffRecrawl = async (
    url: string,
    replaceSource?: string | null,
    botId?: number,
    mode: string = 'delta',
): Promise<Record<string, unknown>> => {
    try {
        const endpoint = botId ? `/crawl/diff?bot_id=${botId}` : '/crawl/diff';
        // The backend caps HEAD-liveness + sitemap discovery at ~22s each and
        // runs them concurrently, so ~45s gives headroom for TLS + auth +
        // serialization without the client tripping on its own timeout.
        const response = await api.post(
            endpoint,
            { url, replace_source: replaceSource, mode },
            { timeout: 60000 },
        );
        return response.data;
    } catch (error) {
        console.error('API Error during recrawl diff:', error);
        throw buildApiError(error, 'Failed to diff recrawl');
    }
};

/**
 * Submits a URL to be crawled and ingested.
 * @param {string} url - The root URL to start crawling
 * @param {number|undefined} botId - Optional bot ID to scope the crawl
 * @param {boolean} useJs - Enable JavaScript mode for Next.js / React / SPA sites
 * @returns {Promise<Object>} The API response with crawling results
 */
export const crawlWebsite = async (
    url: string,
    botId?: number,
    useJs: boolean = false,
    replaceSource: string | null = null,
    expectedNewPages: number | null = null,
    orderedUrls: string[] | null = null,
    maxPages: number | null = null,
    mode: 'full' | 'delta' = 'delta',
    discoveredPages: number | null = null,
): Promise<Record<string, unknown>> => {
    try {
        const endpoint = botId ? `/crawl?bot_id=${botId}` : '/crawl';
        const body: Record<string, unknown> = { url, use_js: useJs, mode };
        if (replaceSource) body.replace_source = replaceSource;
        // Recrawls send the diff's new-page count so the backend pre-flight
        // sizes the credit reservation to (new_pages + buffer) instead of the
        // plan's full max-pages ceiling. Per-page atomic deduction inside the
        // pipeline still enforces the real spend.
        if (replaceSource && expectedNewPages != null && Number.isFinite(expectedNewPages) && expectedNewPages >= 0) {
            body.expected_new_pages = expectedNewPages;
        }
        // Initial crawls send the discovered sitemap page count so the backend
        // pre-flight reserves credits for the ACTUAL page count instead of the
        // plan's full max-pages ceiling (fixes small sites being gated at
        // plan_max × cost_per_page). Only for first-time crawls (no
        // replaceSource); per-page atomic deduction stays the real safety net.
        if (!replaceSource && discoveredPages != null && Number.isFinite(discoveredPages) && discoveredPages > 0) {
            body.discovered_pages = discoveredPages;
        }
        // Credit-aware partial crawl: an explicit, pre-ordered slice of the
        // discovered URLs plus the chosen page count. The backend validates
        // same-origin and caps to what the credit pre-flight reserved.
        if (Array.isArray(orderedUrls) && orderedUrls.length > 0) {
            body.ordered_urls = orderedUrls;
        }
        if (maxPages != null && Number.isFinite(maxPages) && maxPages >= 1) {
            body.max_pages = maxPages;
        }
        const response = await api.post(endpoint, body, { timeout: 300000 });
        return response.data;
    } catch (error) {
        console.error('API Error during website crawl:', error);
        throw buildApiError(error, 'Website crawl failed');
    }
};

/**
 * Fetches the list of ingested documents and their chunk counts.
 * @returns {Promise<Array>} List of document objects
 */
export const getDocuments = async (botId?: number): Promise<KnowledgeSource[]> => {
    try {
        const url = botId ? `/documents?bot_id=${botId}` : '/documents';
        const response = await api.get(url);
        return response.data;
    } catch (error) {
        console.error('API Error fetching documents:', error);
        throw buildApiError(error, 'Failed to load documents');
    }
};

/**
 * Whether this bot's knowledge was deactivated by a plan lapse to Free.
 * `deactivated` is true when the bot has any inactive chunk. Drives the
 * "re-crawl / re-upload to reactivate" banner on the Knowledge page.
 * @param {number} botId
 * @returns {Promise<{active_count:number, inactive_count:number, deactivated:boolean}>}
 */
export const getKnowledgeState = async (botId?: number): Promise<KnowledgeState> => {
    try {
        const url = botId ? `/documents/knowledge-state?bot_id=${botId}` : '/documents/knowledge-state';
        const response = await api.get(url);
        return response.data;
    } catch (error) {
        console.error('API Error fetching knowledge state:', error);
        throw buildApiError(error, 'Failed to load knowledge state');
    }
};

/**
 * Deletes a document and all its vector chunks by name.
 * @param {string} documentName - The document name (filename or URL)
 * @returns {Promise<Object>} Deletion result
 */
export const deleteDocument = async (
    documentName: string,
    botId?: number,
): Promise<Record<string, unknown>> => {
    try {
        const url = botId
            ? `/documents/${encodeURIComponent(documentName)}?bot_id=${botId}`
            : `/documents/${encodeURIComponent(documentName)}`;
        const response = await api.delete(url);
        return response.data;
    } catch (error) {
        console.error('API Error deleting document:', error);
        throw buildApiError(error, 'Failed to delete document');
    }
};

// ── Auto-recrawl ─────────────────────────────────────────────────────────────
// Weekly automatic refresh of a bot's previously-crawled URLs. Only
// available on Standard + Professional plans; Free / Starter clients get a
// 403 on PATCH with { error: 'feature_locked', current_plan, upgrade_url }
// that the admin UI surfaces via the existing FeatureGate / UpgradeModal
// flow. The ARQ sweep fires on schedule - there is no manual trigger.

/** Get the current auto-recrawl state and last-run summary for a bot. */
export const getRecrawlStatus = async (botId: number): Promise<Record<string, unknown>> => {
    try {
        const response = await api.get(`/bots/${botId}/recrawl`);
        return response.data;
    } catch (error) {
        console.error('API Error fetching recrawl status:', error);
        throw buildApiError(error, 'Failed to load auto-recrawl status');
    }
};

/** Toggle auto-recrawl on or off for a bot. */
export const updateRecrawl = async (botId: number, enabled: boolean): Promise<Record<string, unknown>> => {
    try {
        const response = await api.patch(`/bots/${botId}/recrawl`, { enabled });
        return response.data;
    } catch (error) {
        console.error('API Error updating recrawl:', error);
        throw buildApiError(error, 'Failed to update auto-recrawl setting');
    }
};


/**
 * Fetches all crawled page URLs for a website source.
 * @param {string} source - Normalized root domain (e.g. "fynix.digital")
 * @param {number|null} botId - Optional bot ID
 * @returns {Promise<Object>} { domain, total_pages, total_chunks, pages: [...] }
 */
export const getDocumentPages = async (source: string, botId?: number): Promise<SourcePagesResult> => {
    try {
        const params = new URLSearchParams({ source });
        if (botId) params.set('bot_id', String(botId));
        const response = await api.get(`/documents/pages?${params.toString()}`);
        return response.data;
    } catch (error) {
        console.error('API Error fetching document pages:', error);
        throw buildApiError(error, 'Failed to load source pages');
    }
};

/**
 * Fetches aggregate statistics for the admin dashboard.
 * @returns {Promise<Object>} Object containing total counts
 */
export const getDashboardStats = async (
    botId?: number,
    days: number | null = null,
): Promise<Record<string, unknown>> => {
    try {
        const params = new URLSearchParams();
        if (botId) params.set('bot_id', String(botId));
        if (days) params.set('days', String(days));
        const query = params.toString();
        const url = query ? `/analytics/dashboard?${query}` : '/analytics/dashboard';
        const response = await api.get(url);
        return response.data;
    } catch (error) {
        console.error('API Error fetching dashboard stats:', error);
        throw buildApiError(error, 'Failed to load dashboard stats');
    }
};

/**
 * The reader's own IANA zone, or `UTC` where the runtime cannot name one.
 *
 * `/analytics/activity` cuts its day buckets in the zone it is given and the
 * client reads every `date` key as a LOCAL date, so a viewer east of UTC who
 * sends nothing has every message before their local dawn filed under the
 * previous day — the month-edge off-by-one an IST customer sees for everything
 * sent between 00:00 and 05:30.
 */
export const readerTimeZone = (): string => {
    try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    } catch {
        return 'UTC';
    }
};

/**
 * Fetches message activity grouped by date for charts.
 *
 * @param botId Scope to one chatbot. Omitted, the whole workspace.
 * @param options.days Trailing whole days in `tz`, today included. Omitted, the
 *   endpoint returns the workspace's entire history — an unbounded aggregate
 *   and a real timeout on a busy account, so a caller that windows the series
 *   afterwards should ask for exactly the days it will use.
 * @param options.tz IANA zone the day buckets are cut in. Defaults to the
 *   reader's own, which is the zone their `date` keys are read back in.
 * @returns Array of { date, messages }
 */
export const getActivityStats = async (
    botId?: number,
    options: { days?: number | null; tz?: string } = {},
): Promise<ActivityPoint[]> => {
    try {
        const params = new URLSearchParams();
        if (botId) params.set('bot_id', String(botId));
        if (options.days) params.set('days', String(options.days));
        params.set('tz', options.tz || readerTimeZone());
        const response = await api.get(`/analytics/activity?${params.toString()}`);
        return response.data;
    } catch (error) {
        console.error('API Error fetching activity stats:', error);
        throw buildApiError(error, 'Failed to load activity data');
    }
};

export const getRatingsSummary = async (botId?: number): Promise<Record<string, unknown>> => {
    try {
        const url = botId ? `/analytics/ratings-summary?bot_id=${botId}` : '/analytics/ratings-summary';
        const response = await api.get(url);
        return response.data;
    } catch (error) {
        console.error('API Error fetching ratings summary:', error);
        throw buildApiError(error, 'Failed to load ratings summary');
    }
};

export const getResolutionSummary = async (botId?: number): Promise<Record<string, unknown>> => {
    try {
        const url = botId ? `/analytics/resolution-summary?bot_id=${botId}` : '/analytics/resolution-summary';
        const response = await api.get(url);
        return response.data;
    } catch (error) {
        console.error('API Error fetching resolution summary:', error);
        throw buildApiError(error, 'Failed to load resolution summary');
    }
};

export const getSessionAuditTrail = async (sessionId: string): Promise<{ entries: SessionAuditEntry[] }> => {
    try {
        const response = await api.get(`/chat/sessions/${sessionId}/audit`);
        return response.data;
    } catch (error) {
        console.error('API Error fetching session audit trail:', error);
        throw buildApiError(error, 'Failed to load session audit trail');
    }
};

export const getQueueSummary = async (botId?: number, days: number = 30): Promise<QueueSummary> => {
    try {
        const params = new URLSearchParams();
        if (botId) params.set('bot_id', String(botId));
        if (days) params.set('days', String(days));
        const qs = params.toString();
        const url = qs ? `/analytics/queue-summary?${qs}` : '/analytics/queue-summary';
        const response = await api.get(url);
        return response.data;
    } catch (error) {
        console.error('API Error fetching queue summary:', error);
        throw buildApiError(error, 'Failed to load queue summary');
    }
};

/**
 * Conversations broken down by the language they were held in (Phase 5C).
 *
 * Two different kinds of number come back and must not be conflated:
 * `conversations` and `cost` are durable Postgres reads over `period`, while
 * `translation` is a rolling 24-hour window from expiring Redis counters.
 *
 * @param {number} botId
 * @param {'7d'|'30d'|'90d'|'all'} [period]
 */
export const getLanguageBreakdown = async (
    botId: number,
    period: '7d' | '30d' | '90d' | 'all' = '30d',
): Promise<Record<string, unknown>> => {
    try {
        const response = await api.get('/analytics/language-breakdown', {
            params: { bot_id: botId, period },
        });
        return response.data;
    } catch (error) {
        console.error('API Error fetching language breakdown:', error);
        throw buildApiError(error, 'Failed to load language breakdown');
    }
};

// ── Per-agent report (Workspace ▸ Reports) ──────────────────────────────────
// Account-wide, never scoped to the shell's agent switcher: the whole point is
// one row per agent side by side, so an agency can show each of its own clients
// that client's numbers.

/**
 * Per-agent activity rollup for the account over a trailing window.
 * @param {number} days - Trailing window, 1-365. Backend 422s outside that.
 * @returns {Promise<Object>} `{ since, until, rows[], totals }`
 */
export const getPerAgentReport = async (days: number = 30): Promise<PerAgentReport> => {
    try {
        const response = await api.get(`/analytics/by-bot?days=${days}`);
        return response.data;
    } catch (error) {
        console.error('API Error fetching per-agent report:', error);
        throw buildApiError(error, 'Failed to load the per-agent report');
    }
};

/**
 * Pull the `filename` out of a Content-Disposition header.
 *
 * The server names the file after the window it covers, so the download keeps
 * that name rather than a generic one - an agency archives one file per client
 * per period. Reduced to a bare basename: this header is ours, but a filename
 * is written straight into the user's Downloads folder, so path separators
 * never survive the trip.
 *
 * @param {unknown} header - Raw `content-disposition` value, if any.
 * @returns {string|null} The filename, or null when the header is absent
 *   (cross-origin responses hide it unless the API exposes it) or unparseable.
 */
const parseContentDispositionFilename = (header: unknown): string | null => {
    if (typeof header !== 'string') return null;
    const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(header);
    if (!match) return null;
    const name = decodeURIComponent(match[1].trim()).split(/[\\/]/).pop();
    return name || null;
};

/**
 * Download the per-agent report as a CSV file.
 *
 * Mirrors `exportLeadsCsv`, with one difference: the filename comes from the
 * server so it carries the reporting window. `fallbackFilename` covers an API
 * build that predates the exposed header.
 *
 * @param {number} days - Trailing window, 1-365.
 * @param {string} fallbackFilename - Used only when the server sends no name.
 * @returns {Promise<void>} Resolves once the download has been triggered.
 */
export const downloadPerAgentReportCsv = async (
    days: number = 30,
    fallbackFilename: string = 'oyechats-report.csv',
): Promise<void> => {
    try {
        const response = await api.get(`/analytics/by-bot.csv?days=${days}`, { responseType: 'blob' });
        const filename = parseContentDispositionFilename(response.headers?.['content-disposition']) ?? fallbackFilename;
        const url = window.URL.createObjectURL(new Blob([response.data], { type: 'text/csv' }));
        const link = document.createElement('a');
        link.href = url;
        link.setAttribute('download', filename);
        document.body.appendChild(link);
        link.click();
        link.remove();
        window.URL.revokeObjectURL(url);
    } catch (error) {
        console.error('API Error exporting the per-agent report:', error);
        throw buildApiError(error, 'Failed to export the per-agent report');
    }
};

// ── Journey analytics (paid-tier: Standard / Professional) ──────────────────
// Backend gates the read side on the `journey_analytics` plan flag and
// returns HTTP 402 for Free / Starter. The hook layer catches that and
// switches the UI into an upgrade teaser.

const _journeyQuery = (botId: number, extras: Record<string, unknown> = {}): string => {
    const params = new URLSearchParams();
    params.set('bot_id', String(botId));
    for (const [key, value] of Object.entries(extras)) {
        if (value === undefined || value === null || value === '') continue;
        params.set(key, String(value));
    }
    return params.toString();
};

export const getJourneySummary = async (
    botId: number,
    period: JourneyPeriod = '30d',
): Promise<JourneySummary> => {
    try {
        const response = await api.get(`/analytics/journey/summary?${_journeyQuery(botId, { period })}`);
        return response.data;
    } catch (error) {
        console.error('API Error fetching journey summary:', error);
        throw buildApiError(error, 'Failed to load journey summary');
    }
};

export const getJourneyTopPages = async (
    botId: number,
    { period = '30d', phase = null, limit = 20 }: { period?: JourneyPeriod; phase?: JourneyPhase | null; limit?: number } = {},
): Promise<JourneyTopPagesResponse> => {
    try {
        const response = await api.get(
            `/analytics/journey/top-pages?${_journeyQuery(botId, { period, phase, limit })}`,
        );
        return response.data;
    } catch (error) {
        console.error('API Error fetching journey top pages:', error);
        throw buildApiError(error, 'Failed to load top pages');
    }
};

export const getJourneyConversionPaths = async (
    botId: number,
    conversionType: JourneyConversionType,
    { period = '30d', limit = 5 }: { period?: JourneyPeriod; limit?: number } = {},
): Promise<JourneyConversionPathsResponse> => {
    try {
        const response = await api.get(
            `/analytics/journey/conversion-paths?${_journeyQuery(botId, {
                conversion_type: conversionType,
                period,
                limit,
            })}`,
        );
        return response.data;
    } catch (error) {
        console.error('API Error fetching journey conversion paths:', error);
        throw buildApiError(error, 'Failed to load conversion paths');
    }
};

export const getJourneyPreChatSequences = async (
    botId: number,
    { period, limit = 5 }: { period: JourneyPeriod; limit?: number },
): Promise<JourneyPreChatSequencesResponse> => {
    try {
        const response = await api.get(
            `/analytics/journey/pre-chat-sequences?${_journeyQuery(botId, { period, limit })}`,
        );
        return response.data;
    } catch (error) {
        console.error('API Error fetching journey pre-chat sequences:', error);
        throw buildApiError(error, 'Failed to load pre-chat sequences');
    }
};

export const getJourneyPostChat = async (
    botId: number,
    { period = '30d', limit = 10 }: { period?: JourneyPeriod; limit?: number } = {},
): Promise<JourneyPostChatResponse> => {
    try {
        const response = await api.get(
            `/analytics/journey/post-chat?${_journeyQuery(botId, { period, limit })}`,
        );
        return response.data;
    } catch (error) {
        console.error('API Error fetching journey post-chat:', error);
        throw buildApiError(error, 'Failed to load post-chat destinations');
    }
};


/**
 * Fetches the list of visitors/sessions for the admin dashboard.
 * @returns {Promise<Array>} List of visitor session objects
 */
export const getVisitorsData = async (botId?: number): Promise<Array<Record<string, unknown>>> => {
    try {
        const url = botId ? `/analytics/visitors?bot_id=${botId}` : '/analytics/visitors';
        const response = await api.get(url);
        return response.data;
    } catch (error) {
        console.error('API Error fetching visitors data:', error);
        throw buildApiError(error, 'Failed to load visitor data');
    }
};

/**
 * Fetches the knowledge gaps for a bot: the questions visitors asked that the
 * AI could not answer from its knowledge base, grouped by question with a count
 * and last-asked timestamp.
 * @param {number} botId
 * @param {{ limit?: number, days?: number }} [options]
 * @returns {Promise<Array<{ question: string, count: number, last_asked: string | null }>>}
 */
export const getUnansweredQuestions = async (
    botId?: number,
    { limit, days }: { limit?: number; days?: number } = {},
): Promise<UnansweredQuestion[]> => {
    try {
        const params = new URLSearchParams();
        if (botId) params.set('bot_id', String(botId));
        if (limit != null) params.set('limit', String(limit));
        if (days != null) params.set('days', String(days));
        const query = params.toString();
        const url = query ? `/analytics/unanswered-questions?${query}` : '/analytics/unanswered-questions';
        const response = await api.get(url);
        return response.data;
    } catch (error) {
        console.error('API Error fetching unanswered questions:', error);
        throw buildApiError(error, 'Failed to load unanswered questions');
    }
};

/**
 * Fetches the raw chat history for a specific session ID.
 * @param {string} sessionId
 * @param {{ beforeId?: number, limit?: number }} options - Pagination options
 * @returns {Promise<Array>} Array of chat message objects
 */
export const getChatHistory = async (
    sessionId: string,
    { beforeId, limit = 50 }: { beforeId?: number; limit?: number } = {},
): Promise<ChatMessage[]> => {
    try {
        const params: Record<string, unknown> = { limit };
        if (beforeId != null) params.before = beforeId;
        const response = await api.get(`/chat/history/${sessionId}`, { params });
        return response.data;
    } catch (error) {
        console.error('API Error fetching chat history:', error);
        throw buildApiError(error, 'Failed to load chat history');
    }
};

/**
 * Reads the platform's locale catalogue: every locale a bot can be configured
 * with, plus the base-language names a conversation is labelled by.
 *
 * Deploy-static, so callers fetch it once per session (see
 * `hooks/useLocaleCatalog`) rather than per screen.
 *
 * @returns {Promise<{locales: Array<{code: string, locale: string, name: string, native_name: string, direction: 'ltr'|'rtl'}>, languages: Record<string, string>}>}
 */
export const getLocales = async (
): Promise<{
  locales: Array<{
    code: string;
    locale: string;
    name: string;
    native_name: string;
    direction: 'ltr' | 'rtl';
  }>;
  languages: Record<string, string>;
}> => {
    const response = await api.get('/locales');
    return response.data;
};

/**
 * Reads the caller's own live-chat working language.
 * @returns {Promise<{preferred_locale: string|null, supported_languages: string[]}>}
 */
export const getMyLanguage = async (
): Promise<{
  preferred_locale: string | null;
  supported_languages: string[];
  /** Locales the caller's bot supports - what the translation picker offers. */
  available_locales: string[];
}> => {
    const response = await api.get('/operators/me/language');
    return response.data;
};

/**
 * Sets the caller's OWN live-chat working language. Pass null/'' to clear it,
 * which turns translation off for this operator.
 * @param {string|null} preferredLocale - BCP-47 tag, e.g. 'en-IN'
 * @returns {Promise<{preferred_locale: string|null}>}
 */
export const setMyLanguage = async (
    preferredLocale: string | null,
): Promise<{ preferred_locale: string | null }> => {
    try {
        const response = await api.put('/operators/me/language', { preferred_locale: preferredLocale ?? '' });
        return response.data;
    } catch (error) {
        throw buildApiError(error, 'Failed to save your language preference');
    }
};

/**
 * Translates text in the context of a conversation the caller owns.
 *
 * The target language is derived server-side: passing `messageId` backfills an
 * existing message into the reader's language, omitting it previews an
 * outgoing reply in the visitor's. There is deliberately no way to ask for an
 * arbitrary target.
 *
 * @param {string} sessionId - must belong to the caller's workspace
 * @param {string} text
 * @param {number} [messageId] - persist the result onto this message
 * @returns {Promise<{translated: string, target_locale: string, cached: boolean, status: string}>}
 */
export const translateForSession = async (
    sessionId: string,
    text: string,
    messageId?: number,
): Promise<{ translated: string; target_locale: string; cached: boolean; status: string }> => {
    try {
        const body: Record<string, unknown> = { session_id: sessionId, text };
        if (messageId != null) body.message_id = messageId;
        const response = await api.post('/operators/translate', body);
        return response.data;
    } catch (error) {
        throw buildApiError(error, 'Translation is unavailable right now');
    }
};

/**
 * Fetches all feedback data for the admin dashboard.
 * @returns {Promise<Array>} Array of feedback objects
 */
export const getFeedbackData = async (botId?: number): Promise<FeedbackItem[]> => {
    try {
        const url = botId ? `/analytics/feedback?bot_id=${botId}` : '/analytics/feedback';
        const response = await api.get(url);
        return response.data;
    } catch (error) {
        console.error('API Error fetching feedback data:', error);
        throw buildApiError(error, 'Failed to load feedback');
    }
};

/**
 * Fetches the most common user queries.
 * @returns {Promise<Array>} Array of { question, count }
 */
export const getTopQuestions = async (botId?: number): Promise<TopQuestion[]> => {
    try {
        const url = botId ? `/analytics/top-questions?bot_id=${botId}` : '/analytics/top-questions';
        const response = await api.get(url);
        return response.data;
    } catch (error) {
        console.error('API Error fetching top questions:', error);
        throw buildApiError(error, 'Failed to load top questions');
    }
};

/**
 * Fetches chatbot customization settings.
 * Uses bot-scoped endpoint if botId provided, otherwise legacy /client/settings.
 * @param {number} [botId] - Optional bot ID
 * @returns {Promise<Object>} Settings object
 */
/**
 * Fetches the authenticated client's profile (name, email, joined date,
 * bot count). Used by the TopBar profile dropdown. Cached per session by
 * the caller - re-fetched on menu open so bot_count stays fresh.
 *
 * @returns {Promise<Object>} { id, name, email, company_name, website,
 *   created_at, bot_count, is_superadmin }
 */
export const getCurrentUser = async (): Promise<CurrentUser> => {
    try {
        const response = await api.get('/auth/me');
        return response.data;
    } catch (error) {
        console.error('API Error fetching current user:', error);
        throw buildApiError(error, 'Failed to load profile');
    }
};

export const getClientSettings = async (botId?: number): Promise<Record<string, unknown>> => {
    try {
        if (botId) {
            const response = await api.get(`/bots/${botId}`);
            const bot = response.data;
            // Pass the full bot payload through, then layer the legacy-name
            // mapping (``name`` → ``bot_name``) and service normalization on
            // top. Spreading first keeps fields like ``widget_messages`` and
            // ``widget_config`` intact - listing them explicitly previously
            // dropped customizations (e.g. welcome suggestions) on reload.
            return {
                ...bot,
                bot_name: bot.name,
                services: Array.isArray(bot.services)
                    ? bot.services
                          .map((s: unknown) => (typeof s === 'string'
                              ? { name: s, url: '' }
                              : { name: (s as { name?: string })?.name || '', url: (s as { url?: string })?.url || '' }))
                          .filter((s: { name: string; url: string }) => s.name.trim() !== '' || s.url.trim() !== '')
                    : [],
                services_url: bot.services_url || '',
            };
        }
        const response = await api.get('/client/settings');
        return response.data;
    } catch (error) {
        console.error('API Error fetching settings:', error);
        throw buildApiError(error, 'Failed to load settings');
    }
};

/**
 * Updates chatbot customization settings.
 * Uses bot-scoped endpoint if botId provided.
 * @param {Object} settings - Object containing settings to update
 * @param {number} [botId] - Optional bot ID
 * @returns {Promise<Object>} Result message
 */
export const updateClientSettings = async (
    settings: Record<string, unknown>,
    botId?: number,
): Promise<Record<string, unknown>> => {
    try {
        if (botId) {
            // Map legacy field names to bot model fields
            const botSettings = { ...settings };
            if ('bot_name' in botSettings) {
                botSettings.name = botSettings.bot_name;
                delete botSettings.bot_name;
            }
            const response = await api.patch(`/bots/${botId}`, botSettings);
            return response.data;
        }
        const response = await api.patch('/client/settings', settings);
        return response.data;
    } catch (error) {
        console.error('API Error updating settings:', error);
        throw buildApiError(error, 'Failed to update settings');
    }
};

/**
 * Fetch the curated brand-tone preset catalog (chips + prefill text).
 * @returns {Promise<Array<{key: string, label: string, text: string}>>}
 */
export const getBrandTonePresets = async (): Promise<Array<Record<string, unknown>>> => {
    try {
        const response = await api.get('/bots/brand-tone-presets');
        return Array.isArray(response.data?.presets) ? response.data.presets : [];
    } catch (error) {
        console.error('API Error fetching brand tone presets:', error);
        throw buildApiError(error, 'Failed to load brand tone presets');
    }
};

/**
 * Re-classify a bot's brand tone from its already-crawled content (no re-crawl).
 * Writes the detected preset + text on the server and unlocks the field.
 * @param {number} botId
 * @returns {Promise<{brand_tone: string, brand_tone_preset: string}>}
 */
export const detectBrandTone = async (botId: number): Promise<Record<string, unknown>> => {
    try {
        const response = await api.post(`/bots/${botId}/brand-tone/detect`);
        return response.data;
    } catch (error) {
        console.error('API Error detecting brand tone:', error);
        throw buildApiError(error, 'Failed to detect brand tone');
    }
};

/**
 * Generate a 1-2 sentence sample bot reply in the given (unsaved) tone.
 * @param {number} botId
 * @param {string} brandTone - the current draft tone text
 * @returns {Promise<{sample: string}>}
 */
export const previewBrandTone = async (botId: number, brandTone: string): Promise<{ sample?: string }> => {
    try {
        const response = await api.post(`/bots/${botId}/brand-tone/preview`, { brand_tone: brandTone });
        return response.data;
    } catch (error) {
        console.error('API Error previewing brand tone:', error);
        throw buildApiError(error, 'Failed to preview brand tone');
    }
};

/**
 * Uploads a logo file to Backblaze B2 via the backend.
 * @param {File} file - The image file to upload
 * @returns {Promise<Object>} The API response with the public URL
 */
export const uploadLogo = async (file: File): Promise<{ url: string }> => {
    const formData = new FormData();
    formData.append('file', file);
    try {
        const response = await api.post('/client/upload-logo', formData, {
            headers: {
                'Content-Type': 'multipart/form-data',
            },
        });
        return response.data;
    } catch (error) {
        console.error('API Error uploading logo:', error);
        throw buildApiError(error, 'Failed to upload logo');
    }
};

/**
 * Re-derives the bot's website favicon on demand and returns it as an image
 * Blob, so the caller can crop it into an avatar. Nothing is persisted server
 * side — the crop is uploaded through {@link uploadLogo} like any other image.
 */
export const fetchSiteIcon = async (botId: number): Promise<Blob> => {
    try {
        const response = await api.post(`/bots/${botId}/site-icon`, null, { responseType: 'blob' });
        return response.data as Blob;
    } catch (error) {
        throw buildApiError(error, 'Failed to fetch the website icon');
    }
};

/**
 * Uploads (or replaces) the current operator's own profile picture. Purely
 * optional - an operator who never calls this just shows initials.
 * @param {File} file - The image file to upload
 * @returns {Promise<{avatar_url: string}>}
 */
export const uploadOperatorAvatar = async (file: File): Promise<{ avatar_url: string }> => {
    const formData = new FormData();
    formData.append('file', file);
    try {
        const response = await api.post('/operators/me/avatar', formData, {
            headers: {
                'Content-Type': 'multipart/form-data',
            },
        });
        return response.data;
    } catch (error) {
        console.error('API Error uploading operator avatar:', error);
        throw buildApiError(error, 'Failed to upload profile picture');
    }
};

/**
 * Removes the current operator's own profile picture, reverting to initials.
 * @returns {Promise<{success: boolean}>}
 */
export const removeOperatorAvatar = async (): Promise<{ success: boolean }> => {
    try {
        const response = await api.delete('/operators/me/avatar');
        return response.data;
    } catch (error) {
        console.error('API Error removing operator avatar:', error);
        throw buildApiError(error, 'Failed to remove profile picture');
    }
};

// --- SUPERADMIN ENDPOINTS ---

/**
 * Client: Submit classified feedback from the admin dashboard Feedback tab.
 * @param {object} payload
 * @param {string} payload.message - The feedback text (required)
 * @param {string} [payload.type] - bug | feature_request | question | other
 * @param {string|null} [payload.area] - billing | bots | knowledge | live_chat | dashboard | widget | other
 * @param {string|null} [payload.severity] - low | medium | high | critical (bug-only)
 * @param {object|null} [payload.context] - { page_url, app_version, plan_tier, user_agent }
 * @param {Array|null} [payload.attachments] - [{ url, name?, content_type? }]
 */
export const submitPlatformFeedback = async (
    {
    message,
    type = 'other',
    area = null,
    severity = null,
    context = null,
    attachments = null,
}: {
  message: string;
  type?: string;
  area?: string | null;
  severity?: string | null;
  context?: Record<string, unknown> | null;
  attachments?: PlatformFeedbackAttachment[] | null;
},
): Promise<{ ok: true }> => {
    try {
        const response = await api.post('/client/feedback', {
            message,
            type,
            area,
            severity,
            context,
            attachments,
        });
        return response.data;
    } catch (error) {
        console.error('API Error submitting platform feedback:', error);
        throw buildApiError(error, 'Failed to submit feedback');
    }
};

export const uploadFeedbackAttachment = async (file: File): Promise<{ url: string }> => {
    const formData = new FormData();
    formData.append('file', file);
    try {
        const response = await api.post('/client/feedback/upload', formData, {
            headers: {
                'Content-Type': 'multipart/form-data',
            },
        });
        return response.data;
    } catch (error) {
        console.error('API Error uploading feedback attachment:', error);
        throw buildApiError(error, 'Failed to upload attachment');
    }
};

/**
 * Client: Fetch the logged-in user's own platform feedback, newest first.
 * Each item includes the resolution status and the admin's written response
 * so the customer can see that their issue was handled.
 * @returns {Promise<Array>} List of the caller's feedback objects
 */
export const getMyFeedback = async (): Promise<PlatformFeedbackItem[]> => {
    try {
        const response = await api.get('/client/feedback');
        return response.data;
    } catch (error) {
        console.error('API Error fetching my feedback:', error);
        throw buildApiError(error, 'Failed to load your feedback');
    }
};

// --- BOT CRUD ENDPOINTS ---

/**
 * Fetches all bots for the authenticated client.
 * @returns {Promise<Array>} List of bot objects
 */
export const getBots = async (): Promise<Bot[]> => {
    try {
        const response = await api.get('/bots');
        return response.data;
    } catch (error) {
        console.error('API Error fetching bots:', error);
        throw buildApiError(error, 'Failed to load bots');
    }
};

/**
 * Creates a new bot.
 * @param {Object} data - { name, website?, system_prompt? }
 * @returns {Promise<Object>} Created bot info
 */
export const createBot = async (
    data: { name: string; website?: string; system_prompt?: string },
): Promise<Bot> => {
    try {
        const response = await api.post('/bots', data);
        return response.data;
    } catch (error) {
        console.error('API Error creating bot:', error);
        throw buildApiError(error, 'Failed to create bot');
    }
};

/**
 * Fetch the onboarding "seed questions" for a bot - LLM-proposed and
 * retrieval-verified as answerable from the bot's content (see the backend
 * seed_questions_service). Returns an array of 0 to 3 question strings; an empty
 * array is normal ("show only the open input"), so this resolves to `[]` on any
 * error rather than throwing - the Prove step must never be blocked by it.
 * @param {number} botId
 * @returns {Promise<string[]>}
 */
export const getSeedQuestions = async (botId: number): Promise<string[]> => {
    try {
        const response = await api.post(`/bots/${botId}/seed-questions`);
        const questions = response.data?.questions;
        return Array.isArray(questions) ? questions : [];
    } catch (error) {
        console.error('API Error fetching seed questions:', error);
        return [];
    }
};

/**
 * Recompute a bot's seed questions, ignoring the cached set.
 *
 * ``POST /bots/{id}/seed-questions`` caches its result on the bot the first
 * time it is computed and returns that same list forever after; ``force=true``
 * is the only way to ask for a fresh one. Unlike ``getSeedQuestions`` this
 * throws, because it is only ever called from an explicit "suggest again"
 * control that has somewhere to show the failure.
 * @param {number} botId
 * @returns {Promise<string[]>} 0 to 3 freshly-generated questions
 */
export const refreshSeedQuestions = async (botId: number): Promise<string[]> => {
    try {
        const response = await api.post(`/bots/${botId}/seed-questions`, null, {
            params: { force: true },
        });
        const questions = response.data?.questions;
        return Array.isArray(questions) ? questions : [];
    } catch (error) {
        console.error('API Error regenerating seed questions:', error);
        throw buildApiError(error, 'Failed to regenerate suggested questions');
    }
};

/**
 * Records an onboarding/activation milestone event. Best-effort: it must NEVER
 * throw, so instrumentation can't break the flow it measures.
 * @param {string} eventType - e.g. 'studio_opened', 'bot_created', 'crawl_completed'
 * @param {{ botId?: number|null, eventData?: Object|null }} [opts]
 */
export const recordActivationEvent = async (
    eventType: string,
    { botId = null, eventData = null }: { botId?: number | null; eventData?: unknown } = {},
): Promise<void> => {
    try {
        await api.post('/activation/events', {
            event_type: eventType,
            bot_id: botId,
            event_data: eventData,
        });
    } catch (error) {
        // Instrumentation is fire-and-forget - swallow failures.
        console.warn('Activation event failed (non-fatal):', eventType, (error as Error | null)?.message);
    }
};

/**
 * Email the install snippet to the developer who will actually paste it.
 *
 * `POST /bots/{botId}/install-invite`. The server builds the snippet from the
 * bot's own entitlement and sends the mail itself, so unlike the `mailto:` link
 * this replaces, "sent" is a fact the product can store and show later.
 *
 * Not fire-and-forget, unlike `recordActivationEvent`: the customer is waiting
 * on this one and a silent failure would look like a delivered email.
 */
export const sendInstallInvite = async (botId: number, email: string): Promise<InstallInviteResult> => {
    try {
        const response = await api.post(`/bots/${botId}/install-invite`, { email });
        return response.data;
    } catch (error) {
        console.error('API Error sending install invite:', error);
        throw buildApiError(error, 'We could not send that email. Please try again.');
    }
};

/** Auth headers for the raw-fetch streaming preview (mirrors the axios interceptor). */
function previewStreamHeaders() {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };

    // Impersonation MUST be handled here as well as in the axios interceptor:
    // this path uses raw fetch(), so the interceptor never runs. Sending the
    // shared localStorage `admin_token` from an impersonated tab would
    // authenticate the preview as the SUPER-ADMIN'S OWN Account. 404-ing on
    // the impersonated bot_id, or leaking the admin's identity into a session
    // whose banner says otherwise. Send only the impersonation credential and
    // suppress the other four headers, exactly as the interceptor does.
    const impersonationToken = getImpersonationToken();
    if (impersonationToken) {
        headers['X-Impersonation-Token'] = impersonationToken;
        return headers;
    }

    const token = getAuthItem('admin_token');
    const authType = getAuthItem('auth_type');
    if (token) {
        if (authType === 'operator') headers['X-Operator-Key'] = token;
        else headers['X-API-Key'] = token;
    }
    if (authType === 'client') {
        const workspaceId = getAuthItem('current_workspace_id');
        if (workspaceId) headers['X-Workspace-Id'] = workspaceId;
        const workspaceRole = getAuthItem('current_workspace_role');
        if (workspaceRole) headers['X-Acting-Role'] = workspaceRole;
    }
    return headers;
}

/**
 * Streaming owner-preview chat for the Build Studio Prove step - the same SSE
 * path the real widget uses (`/chat/stream`, owner-preview mode: free, no credit
 * deduction). Streaming makes the aha feel instant and faithful, and - unlike
 * the old blocking POST - a slow-but-OK model streams tokens instead of tripping
 * a timeout that read as a false "couldn't answer".
 *
 * Protocol: `METADATA:{json}` → text chunks → `FINAL_METADATA:{json}`.
 * `onChunk(text)` fires per visible token; `onFinal(meta)` once at the end with
 * `{ sources, ... }`; `onError(err)` on a hard failure. Resolves when done.
 */
export const previewChatStream = async (
    botId: number,
    question: string,
    sessionId?: string | null,
    { onChunk, onFinal, onError }: {
    onChunk?: (text: string) => void;
    onFinal?: (meta: unknown) => void;
    onError?: (err: unknown) => void;
  } = {},
): Promise<void> => {
    const controller = new AbortController();
    // Overall guard so a hung stream can't spin forever (tokens normally arrive
    // well within this; a healthy stream clears the timer on completion).
    const timer = setTimeout(() => controller.abort(), 90000);
    let finalMeta = null;
    // Strip widget-only inline-card sentinels (e.g. [LEAVE_MESSAGE_CARD]) so they
    // never leak into the preview text.
    const clean = (t: string): string => t.replace(/\[[A-Z0-9_]+_CARD\]/g, '');
    const emit = (t: string): void => {
        const c = clean(t);
        if (c) onChunk?.(c);
    };
    try {
        const res = await fetch(`${API_BASE_URL}/chat/stream?preview=true&bot_id=${botId}`, {
            method: 'POST',
            headers: previewStreamHeaders(),
            body: JSON.stringify({ question, session_id: sessionId }),
            signal: controller.signal,
        });
        if (!res.ok || !res.body) throw new Error('The chatbot could not answer that just now.');

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let metadataReceived = false;
        const takeFinal = (line: string, sliceAt: number): void => {
            try {
                finalMeta = JSON.parse(line.slice(sliceAt));
            } catch {
                /* ignore malformed terminal frame */
            }
        };

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';
            for (const line of lines) {
                if (!line.trim()) continue;
                if (line.startsWith('METADATA:')) {
                    metadataReceived = true;
                } else if (line.startsWith('FINAL_METADATA:')) {
                    if (buffer && !buffer.startsWith('METADATA:') && !buffer.startsWith('FINAL_METADATA:')) {
                        emit(buffer);
                        buffer = '';
                    }
                    takeFinal(line, 15);
                } else {
                    emit(line + '\n');
                }
            }
            if (metadataReceived && buffer && !buffer.startsWith('METADATA:') && !buffer.startsWith('FINAL_METADATA:')) {
                emit(buffer);
                buffer = '';
            }
        }
        if (buffer.trim()) {
            if (buffer.startsWith('FINAL_METADATA:')) takeFinal(buffer, 15);
            else if (!buffer.startsWith('METADATA:')) emit(buffer);
        }
        onFinal?.(finalMeta || {});
    } catch (error) {
        onError?.(error);
    } finally {
        clearTimeout(timer);
    }
};

/**
 * Marks the account's guided onboarding (Build Studio) as complete. Best-effort -
 * never throws, so finishing the flow can't be blocked by a transient failure.
 */
export const completeOnboarding = async (): Promise<Record<string, unknown> | null> => {
    try {
        const { data } = await api.post('/auth/onboarding/complete');
        return data;
    } catch (error) {
        console.warn('completeOnboarding failed (non-fatal):', (error as Error | null)?.message);
        return null;
    }
};

/**
 * Gets details of a specific bot.
 * @param {number} botId
 * @returns {Promise<Object>} Bot details
 */
export const getBot = async (botId: number): Promise<Bot> => {
    try {
        const response = await api.get(`/bots/${botId}`);
        return response.data;
    } catch (error) {
        console.error('API Error fetching bot:', error);
        throw buildApiError(error, 'Failed to load bot');
    }
};

/**
 * Every domain this chatbot has been seen on, checked against, or is allowed on.
 *
 * Replaces reading `widget_last_origin` off the bot row, which held one
 * hostname and overwrote it, so a chatbot on several sites reported whichever
 * called most recently.
 */
export const getInstallDomains = async (botId: number): Promise<InstallDomains> => {
    try {
        const response = await api.get(`/bots/${botId}/install-domains`);
        return response.data;
    } catch (error) {
        console.error('API Error fetching install domains:', error);
        throw buildApiError(error, 'Failed to load install status');
    }
};

/**
 * Ask the backend to go and fetch each domain now.
 *
 * Returns as soon as the check is dispatched, not when it finishes: it makes up
 * to 25 third-party requests and runs on the worker. The caller polls
 * `getInstallDomains` for the result.
 */
export const startInstallCheck = async (
    botId: number,
): Promise<{ success: boolean; checking: boolean; already_running: boolean }> => {
    try {
        const response = await api.post(`/bots/${botId}/install-domains/check`);
        return response.data;
    } catch (error) {
        console.error('API Error starting install check:', error);
        throw buildApiError(error, 'Failed to start the check');
    }
};

export const getFrameworkPresets = async (botId: number): Promise<Record<string, unknown>> => {
    try {
        const response = await api.get(`/bots/${botId}/framework-presets`);
        return response.data;
    } catch (error) {
        console.error('API Error fetching framework presets:', error);
        throw buildApiError(error, 'Failed to load framework presets');
    }
};

/**
 * Updates a bot's settings.
 * @param {number} botId
 * @param {Object} data - Settings to update
 * @returns {Promise<Object>} Result message
 */
export const updateBot = async (
    botId: number,
    data: Record<string, unknown>,
): Promise<{ message: string }> => {
    try {
        const response = await api.patch(`/bots/${botId}`, data);
        return response.data;
    } catch (error) {
        console.error('API Error updating bot:', error);
        throw buildApiError(error, 'Failed to update bot');
    }
};

/**
 * Deletes a bot and all its data.
 * @param {number} botId
 * @returns {Promise<Object>} Result message
 */
export const deleteBot = async (botId: number): Promise<Record<string, unknown>> => {
    try {
        const response = await api.delete(`/bots/${botId}`);
        return response.data;
    } catch (error) {
        console.error('API Error deleting bot:', error);
        throw buildApiError(error, 'Failed to delete bot');
    }
};

export const getBotDemoUrl = (botKey: string): string => `${API_BASE_URL}/demo/${botKey}`;

export const getBotPreviewUrl = (
    botKey: string,
    websiteUrl?: string,
    { edit = false }: { edit?: boolean } = {},
): string => {
    const base = `${API_BASE_URL}/demo/${botKey}`;
    const params = new URLSearchParams();
    if (websiteUrl) {
        const normalized = /^https?:\/\//i.test(websiteUrl) ? websiteUrl : `https://${websiteUrl}`;
        params.set('url', String(normalized));
    }
    if (edit) params.set('edit', '1');
    const qs = params.toString();
    return qs ? `${base}?${qs}` : base;
};

export const trackDemoShareClick = async (botId: number): Promise<Record<string, unknown>> => {
    try {
        const response = await api.post(`/bots/${botId}/demo-share-click`);
        return response.data;
    } catch (error) {
        console.error('API Error tracking demo share click:', error);
        throw buildApiError(error, 'Failed to track demo share');
    }
};

/**
 * Queue a fresh capture of the chatbot's website for its hosted demo page.
 *
 * The capture normally rides along with training. This is the explicit path,
 * for a customer who redesigned their site or whose first capture failed and
 * wants the demo link right before they send it.
 *
 * The fallback message deliberately does not repeat "we could not start the
 * preview": the caller already renders that as the alert's title, so a
 * matching body would say the same thing twice and tell the reader nothing
 * about what to do next.
 */
export const recaptureDemoScreenshot = async (
    botId: number,
): Promise<{ success: boolean; status: string; website: string }> => {
    try {
        const response = await api.post(`/bots/${botId}/demo-screenshot`);
        return response.data;
    } catch (error) {
        console.error('API Error requesting demo screenshot:', error);
        throw buildApiError(error, 'The request did not go through. Try again in a moment.');
    }
};

// ── Lead Management ──

export const getLeads = async (botId?: number, params: LeadsQuery = {}): Promise<LeadsResult> => {
    try {
        const query = new URLSearchParams();
        if (botId) query.set('bot_id', String(botId));
        if (params.status) query.set('status', params.status);
        if (params.min_score != null) query.set('min_score', String(params.min_score));
        if (params.days != null) query.set('days', String(params.days));
        if (params.from_date) query.set('from_date', params.from_date);
        if (params.to_date) query.set('to_date', params.to_date);
        if (params.page) query.set('page', String(params.page));
        if (params.limit) query.set('limit', String(params.limit));
        const response = await api.get(`/leads?${query.toString()}`);
        return response.data;
    } catch (error) {
        console.error('API Error fetching leads:', error);
        throw buildApiError(error, 'Failed to load leads');
    }
};

export const getLeadDetail = async (sessionId: string): Promise<Lead & { messages?: ChatMessage[] }> => {
    try {
        const response = await api.get(`/leads/${sessionId}`);
        return response.data;
    } catch (error) {
        console.error('API Error fetching lead detail:', error);
        throw buildApiError(error, 'Failed to load lead detail');
    }
};

export const getLeadStats = async (
    botId?: number,
    days?: number,
    fromDate?: string,
    toDate?: string,
): Promise<Record<string, unknown>> => {
    try {
        const query = new URLSearchParams();
        if (botId) query.set('bot_id', String(botId));
        if (days != null) query.set('days', String(days));
        if (fromDate) query.set('from_date', fromDate);
        if (toDate) query.set('to_date', toDate);
        const suffix = query.toString();
        const response = await api.get(`/leads/stats${suffix ? `?${suffix}` : ''}`);
        return response.data;
    } catch (error) {
        console.error('API Error fetching lead stats:', error);
        throw buildApiError(error, 'Failed to load lead stats');
    }
};

export const getQualificationFunnel = async (
    botId: number,
    period: string = '30d',
): Promise<Record<string, unknown>> => {
    try {
        const response = await api.get(`/analytics/qualification-funnel?bot_id=${botId}&period=${period}`);
        return response.data;
    } catch (error) {
        console.error('API Error fetching qualification funnel:', error);
        throw buildApiError(error, 'Failed to load qualification funnel');
    }
};

export const exportLeadsCsv = async (botId?: number): Promise<void> => {
    try {
        const query = botId ? `?bot_id=${botId}` : '';
        const response = await api.get(`/leads/export${query}`, { responseType: 'blob' });
        const url = window.URL.createObjectURL(new Blob([response.data]));
        const link = document.createElement('a');
        link.href = url;
        link.setAttribute('download', 'oyechats-leads.csv');
        document.body.appendChild(link);
        link.click();
        link.remove();
        window.URL.revokeObjectURL(url);
    } catch (error) {
        console.error('API Error exporting leads:', error);
        throw buildApiError(error, 'Failed to export leads');
    }
};

// Mark a single lead as viewed (idempotent, 204 no body). Fire-and-forget on drawer open.
export const markLeadViewed = async (sessionId: string): Promise<void> => {
    try {
        await api.post(`/leads/${sessionId}/view`);
    } catch (error) {
        console.error('API Error marking lead viewed:', error);
        throw buildApiError(error, 'Failed to mark lead as read');
    }
};

// Bulk-clear unread leads for a bot (or all of the caller's bots).
export const markAllLeadsViewed = async (botId?: number): Promise<void> => {
    try {
        const query = botId ? `?bot_id=${botId}` : '';
        await api.post(`/leads/mark-all-viewed${query}`);
    } catch (error) {
        console.error('API Error marking all leads viewed:', error);
        throw buildApiError(error, 'Failed to mark all leads as read');
    }
};

// Manually trigger a follow-up email for a captured lead. Every gate (valid
// email, cooldown, unsubscribe, bot pause) is enforced server-side. This
// call can come back 400/403/409/423 with a human-readable `detail`, which
// callers should surface rather than treat as a generic failure.
export const sendLeadFollowUp = async (
    sessionId: string,
    confirmOverride: boolean = false,
): Promise<SendFollowUpResult> => {
    try {
        const response = await api.post(`/leads/${sessionId}/follow-up`, {
            confirm_override: confirmOverride,
        });
        return response.data;
    } catch (error) {
        console.error('API Error sending lead follow-up:', error);
        throw buildApiError(error, 'Failed to send follow-up email');
    }
};

// ── Email suppressions ──────────────────────────────────────────────────────
// The per-bot do-not-email list: every address that unsubscribed from a
// follow-up, plus any the customer records by hand after being asked to stop
// out of band. Scoped server-side to the caller's own bots.
//
// There is deliberately no delete. The model never removes a row, and the API
// exposes no DELETE: re-enabling mail to somebody who asked for it to stop is a
// consent decision under India's DPDP Act, not a CRUD operation. Any UI over
// this has to say so rather than leave the reader hunting for a button.
export const getEmailSuppressions = async (
    params: {
  botId?: number | null;
  page?: number;
  limit?: number;
  search?: string | null;
} = {},
): Promise<EmailSuppressionsResult> => {
    try {
        const query = new URLSearchParams();
        if (params.botId != null) query.set('bot_id', String(params.botId));
        if (params.page) query.set('page', String(params.page));
        if (params.limit) query.set('limit', String(params.limit));
        if (params.search) query.set('search', params.search);
        const suffix = query.toString();
        const response = await api.get(`/leads/suppressions${suffix ? `?${suffix}` : ''}`);
        return response.data;
    } catch (error) {
        console.error('API Error fetching email suppressions:', error);
        throw buildApiError(error, 'Failed to load the unsubscribe list');
    }
};

// Suppress an address for one bot. Idempotent: suppressing an already-suppressed
// address returns the existing row rather than failing.
export const createEmailSuppression = async (
    { botId, email, reason = 'unsubscribe' }: {
  botId: number;
  email: string;
  reason?: 'unsubscribe' | 'hard_bounce' | 'spam_complaint';
},
): Promise<EmailSuppression> => {
    try {
        const response = await api.post('/leads/suppressions', {
            bot_id: botId,
            email,
            reason,
        });
        return response.data;
    } catch (error) {
        console.error('API Error creating email suppression:', error);
        throw buildApiError(error, 'Failed to add that address to the unsubscribe list');
    }
};

// Correct or reset one qualification dimension's score for a lead (BR-03).
// The automated extractor never downgrades a dimension, by design, so a single
// false-positive extraction ("we have a $50k budget approved") otherwise pins a
// lead to the wrong tier forever. Every override is written to the append-only
// BANTSignal trail tagged `operator_override`, and the server recomputes the
// composite score and tier, which it returns. `score` is bounded server-side by
// the dimension's own configured maximum, so a 400 here means the caller sent a
// score the bot's framework does not allow.
export const overrideLeadQualification = async (
    sessionId: string,
    dimension: string,
    score: number,
): Promise<QualificationOverrideResult> => {
    try {
        const response = await api.patch(`/operators/session/${sessionId}/qualification`, {
            dimension,
            score,
        });
        return response.data;
    } catch (error) {
        console.error('API Error overriding lead qualification:', error);
        throw buildApiError(error, 'Failed to update the qualification score');
    }
};

// ── Webhooks ──

export const getWebhooks = async (botId?: number): Promise<Webhook[]> => {
    try {
        const response = await api.get(`/webhooks?bot_id=${botId}`);
        return response.data;
    } catch (error) {
        console.error('API Error fetching webhooks:', error);
        throw buildApiError(error, 'Failed to load webhooks');
    }
};

export const createWebhook = async (botId: number, data: Record<string, unknown>): Promise<Webhook> => {
    try {
        const response = await api.post(`/webhooks?bot_id=${botId}`, data);
        return response.data;
    } catch (error) {
        console.error('API Error creating webhook:', error);
        throw buildApiError(error, 'Failed to create webhook');
    }
};

export const updateWebhook = async (webhookId: number, data: Record<string, unknown>): Promise<Webhook> => {
    try {
        const response = await api.patch(`/webhooks/${webhookId}`, data);
        return response.data;
    } catch (error) {
        console.error('API Error updating webhook:', error);
        throw buildApiError(error, 'Failed to update webhook');
    }
};

export const deleteWebhook = async (webhookId: number): Promise<Record<string, unknown>> => {
    try {
        const response = await api.delete(`/webhooks/${webhookId}`);
        return response.data;
    } catch (error) {
        console.error('API Error deleting webhook:', error);
        throw buildApiError(error, 'Failed to delete webhook');
    }
};

export const getWebhookDeliveries = async (
    webhookId: number,
    page: number = 1,
): Promise<WebhookDeliveriesResult> => {
    try {
        const response = await api.get(`/webhooks/${webhookId}/deliveries?page=${page}&limit=50`);
        return response.data;
    } catch (error) {
        console.error('API Error fetching webhook deliveries:', error);
        throw buildApiError(error, 'Failed to load webhook deliveries');
    }
};

export const testWebhook = async (webhookId: number): Promise<Record<string, unknown>> => {
    try {
        const response = await api.post(`/webhooks/${webhookId}/test`);
        return response.data;
    } catch (error) {
        console.error('API Error sending test webhook:', error);
        throw buildApiError(error, 'Failed to send test event');
    }
};

// ── Live Chat / Operator ──

export const getOperatorQueue = async (): Promise<Record<string, unknown>> => {
    try {
        const response = await api.get('/operators/queue');
        return response.data;
    } catch (error) {
        console.error('API Error fetching queue:', error);
        throw buildApiError(error, 'Failed to load queue');
    }
};

export const getQualifiedBotSessions = async (limit: number = 50): Promise<Record<string, unknown>> => {
    try {
        const response = await api.get(`/operators/qualified-bot-sessions?limit=${limit}`);
        return response.data;
    } catch (error) {
        console.error('API Error fetching qualified bot sessions:', error);
        throw buildApiError(error, 'Failed to load qualified bot sessions');
    }
};

export const sendConnectRequest = async (
    sessionId: string,
    operatorId: number | null = null,
): Promise<Record<string, unknown>> => {
    try {
        const body = operatorId ? { operator_id: operatorId } : {};
        const response = await api.post(`/operators/connect-request/${sessionId}`, body);
        return response.data;
    } catch (error) {
        console.error('API Error sending connect request:', error);
        throw buildApiError(error, 'Failed to send connect request');
    }
};

export const cancelConnectRequest = async (sessionId: string): Promise<Record<string, unknown>> => {
    try {
        const response = await api.post(`/operators/connect-request/${sessionId}/cancel`);
        return response.data;
    } catch (error) {
        console.error('API Error cancelling connect request:', error);
        throw buildApiError(error, 'Failed to cancel connect request');
    }
};

export const acceptChat = async (
    sessionId: string,
    operatorId: number | null = null,
): Promise<Record<string, unknown>> => {
    try {
        // Pass operatorId in the body so the backend uses the exact operator record
        // rather than the fragile `.limit(1)` fallback (critical for owner accounts).
        const body = operatorId ? { operator_id: operatorId } : {};
        const response = await api.post(`/operators/accept/${sessionId}`, body);
        return response.data;
    } catch (error) {
        console.error('API Error accepting chat:', error);
        throw buildApiError(error, 'Failed to accept chat');
    }
};

export const closeOperatorChat = async (sessionId: string): Promise<Record<string, unknown>> => {
    try {
        const response = await api.post(`/operators/close/${sessionId}`);
        return response.data;
    } catch (error) {
        console.error('API Error closing chat:', error);
        throw buildApiError(error, 'Failed to close chat');
    }
};

/**
 * Resolve and hard-close a live chat (marks the conversation `closed` for
 * reporting), as opposed to `closeOperatorChat` which returns the visitor to
 * the bot (`status='bot'`). Visitor-facing teardown is identical.
 * @param {string} sessionId
 */
export const resolveOperatorChat = async (sessionId: string): Promise<Record<string, unknown>> => {
    try {
        const response = await api.post(`/operators/resolve/${sessionId}`);
        return response.data;
    } catch (error) {
        console.error('API Error resolving chat:', error);
        throw buildApiError(error, 'Failed to resolve chat');
    }
};

export const transferChat = async (
    sessionId: string,
    data: Record<string, unknown>,
): Promise<Record<string, unknown>> => {
    try {
        const response = await api.post(`/operators/transfer/${sessionId}`, data);
        return response.data;
    } catch (error) {
        console.error('API Error transferring chat:', error);
        throw buildApiError(error, 'Failed to transfer chat');
    }
};

export const toggleOperatorStatus = async (
    { isOnline, botId }: { isOnline?: boolean; botId?: number } = {},
): Promise<Record<string, unknown>> => {
    try {
        const body: Record<string, unknown> = {};
        if (typeof isOnline === 'boolean') body.is_online = isOnline;
        if (botId) body.bot_id = botId;
        // Only send a body when the caller actually populated a field -
        // preserves the legacy no-body toggle semantics the backend still
        // supports for older callers.
        const response = Object.keys(body).length > 0
            ? await api.post('/operators/status', body)
            : await api.post('/operators/status');
        return response.data;
    } catch (error) {
        console.error('API Error toggling status:', error);
        throw buildApiError(error, 'Failed to toggle status');
    }
};

/**
 * How many visitors are waiting for a person, for the signed-in caller.
 *
 * The rail's Inbox badge. It used to be derived in the shell from the
 * notifications feed - every unread `handoff_request` - which counted visitors
 * who had asked weeks ago and long since left, so the rail claimed six people
 * were waiting on the same screen where the inbox said none were.
 *
 * Returns 0 rather than throwing on failure: a badge is not worth an error
 * boundary, and an absent count reads as "nothing waiting", which is the safe
 * direction to be wrong in for a number whose only job is to make someone look.
 */
export const getMyWaitingCount = async (
    { botId }: { botId?: number } = {},
): Promise<number> => {
    try {
        const params = botId ? { bot_id: botId } : {};
        const response = await api.get('/operators/me/waiting-count', { params });
        const count = (response.data as { count?: unknown })?.count;
        return typeof count === 'number' && Number.isFinite(count) ? count : 0;
    } catch {
        return 0;
    }
};

export const getMyOperatorStatus = async (
    { botId }: { botId?: number } = {},
): Promise<OperatorStatus | null> => {
    try {
        const params = botId ? { bot_id: botId } : {};
        const response = await api.get('/operators/me/status', { params });
        return response.data;
    } catch (error) {
        console.error('API Error getting operator status:', error);
        return null;
    }
};

// ── Notification preferences (self-service) ──
//
// app/api/operator_routes.py:
//   GET /operators/me/notification-preferences
//   PUT /operators/me/notification-preferences
//
// Works for BOTH auth types: an operator token writes the Operator row, a
// client token writes the Client row - the backend picks the row whose prefs
// its own push dispatch actually consults (``_prefs_target``). The response is
// always fully defaulted, so the caller never has to infer a missing field.

/** Read the signed-in user's own push preferences (events + quiet hours). */
export const getNotificationPreferences = async (): Promise<NotificationPreferences> => {
    try {
        const response = await api.get('/operators/me/notification-preferences');
        return response.data;
    } catch (error) {
        throw buildApiError(error, 'Failed to load your notification preferences');
    }
};

/**
 * Replace the signed-in user's own push preferences. The backend stores the
 * whole ``push`` object, so callers must send the complete state - a partial
 * body silently resets the fields it omits to their defaults.
 */
export const updateNotificationPreferences = async (
    preferences: NotificationPreferences,
): Promise<NotificationPreferences> => {
    try {
        const response = await api.put('/operators/me/notification-preferences', preferences);
        return response.data;
    } catch (error) {
        throw buildApiError(error, 'Failed to save your notification preferences');
    }
};

export const getSessionDetails = async (sessionId: string): Promise<Record<string, unknown>> => {
    try {
        const response = await api.get(`/operators/session/${sessionId}/details`);
        return response.data;
    } catch (error) {
        console.error('API Error fetching session details:', error);
        throw buildApiError(error, 'Failed to load session details');
    }
};

// ── Operator Login ──

export const loginOperator = async (email: string, password: string): Promise<OperatorLoginResult> => {
    try {
        const response = await api.post('/auth/operator-login', { email, password });
        return response.data;
    } catch (error) {
        console.error('API Error operator login:', error);
        throw buildApiError(error, 'Login failed');
    }
};

/**
 * Change the authenticated operator's password.
 *
 * As with ``changeClientPassword``, the backend rotates the operator's API key
 * so other sessions are revoked, and returns the replacement as
 * ``access_token``. Swap it into storage so this tab survives the rotation.
 */
export const operatorChangePassword = async (
    currentPassword: string,
    newPassword: string,
): Promise<{ message: string; access_token?: string }> => {
    try {
        const response = await api.post('/auth/operator-change-password', {
            current_password: currentPassword,
            new_password: newPassword,
        });
        if (response.data?.access_token) {
            setAuthItem('admin_token', response.data.access_token);
        }
        return response.data;
    } catch (error) {
        console.error('API Error operator change password:', error);
        throw buildApiError(error, 'Failed to change password');
    }
};

// ── Operator Management ──

export const getOperators = async (): Promise<Operator[]> => {
    try {
        const response = await api.get('/operators');
        return response.data;
    } catch (error) {
        console.error('API Error fetching operators:', error);
        throw buildApiError(error, 'Failed to load operators');
    }
};

export const createOperator = async (data: Record<string, unknown>): Promise<Operator> => {
    try {
        const response = await api.post('/operators/create', data);
        return response.data;
    } catch (error) {
        console.error('API Error creating operator:', error);
        throw buildApiError(error, 'Failed to create operator');
    }
};

export const updateOperator = async (
    operatorId: number,
    data: Record<string, unknown>,
): Promise<Operator> => {
    try {
        const response = await api.patch(`/operators/${operatorId}`, data);
        return response.data;
    } catch (error) {
        console.error('API Error updating operator:', error);
        throw buildApiError(error, 'Failed to update operator');
    }
};

export const deleteOperator = async (operatorId: number): Promise<Record<string, unknown>> => {
    try {
        const response = await api.delete(`/operators/${operatorId}`);
        return response.data;
    } catch (error) {
        console.error('API Error deleting operator:', error);
        throw buildApiError(error, 'Failed to delete operator');
    }
};

// ── Department Management ──

export const getDepartments = async (): Promise<Department[]> => {
    try {
        const response = await api.get('/operators/departments');
        return response.data;
    } catch (error) {
        console.error('API Error fetching departments:', error);
        throw buildApiError(error, 'Failed to load departments');
    }
};

export const createDepartment = async (data: Record<string, unknown>): Promise<Department> => {
    try {
        const response = await api.post('/operators/departments', data);
        return response.data;
    } catch (error) {
        console.error('API Error creating department:', error);
        throw buildApiError(error, 'Failed to create department');
    }
};

export const updateDepartment = async (
    departmentId: number,
    data: Record<string, unknown>,
): Promise<Department> => {
    try {
        const response = await api.patch(`/operators/departments/${departmentId}`, data);
        return response.data;
    } catch (error) {
        console.error('API Error updating department:', error);
        throw buildApiError(error, 'Failed to update department');
    }
};

export const deleteDepartment = async (departmentId: number): Promise<Record<string, unknown>> => {
    try {
        const response = await api.delete(`/operators/departments/${departmentId}`);
        return response.data;
    } catch (error) {
        console.error('API Error deleting department:', error);
        throw buildApiError(error, 'Failed to delete department');
    }
};

// ── Offline Messages ──

export const getOfflineMessages = async (
    params: Record<string, unknown> = {},
): Promise<OfflineMessagesResult> => {
    try {
        const response = await api.get('/offline-messages', { params });
        return response.data;
    } catch (error) {
        console.error('API Error fetching offline messages:', error);
        throw buildApiError(error, 'Failed to load messages');
    }
};

export const updateOfflineMessage = async (
    messageId: number,
    data: Record<string, unknown>,
): Promise<{ success: boolean; status?: string }> => {
    try {
        const response = await api.patch(`/offline-messages/${messageId}`, data);
        return response.data;
    } catch (error) {
        console.error('API Error updating offline message:', error);
        throw buildApiError(error, 'Failed to update message');
    }
};

export const deleteOfflineMessage = async (messageId: number): Promise<{ success: boolean }> => {
    try {
        const response = await api.delete(`/offline-messages/${messageId}`);
        return response.data;
    } catch (error) {
        console.error('API Error deleting offline message:', error);
        throw buildApiError(error, 'Failed to delete message');
    }
};

// ── Canned Responses ──

export const getCannedResponses = async (category: string | null = null): Promise<CannedResponsesResult> => {
    try {
        const params = category ? { category } : {};
        const response = await api.get('/canned-responses', { params });
        return response.data;
    } catch (error) {
        console.error('API Error fetching canned responses:', error);
        throw buildApiError(error, 'Failed to load responses');
    }
};

export const createCannedResponse = async (
    data: {
  title: string;
  content: string;
  shortcut?: string;
  category?: string | null;
},
): Promise<CannedResponse> => {
    try {
        const response = await api.post('/canned-responses', data);
        return response.data;
    } catch (error) {
        console.error('API Error creating canned response:', error);
        throw buildApiError(error, 'Failed to create response');
    }
};

export const updateCannedResponse = async (
    responseId: number,
    data: Record<string, unknown>,
): Promise<Record<string, unknown>> => {
    try {
        const response = await api.patch(`/canned-responses/${responseId}`, data);
        return response.data;
    } catch (error) {
        console.error('API Error updating canned response:', error);
        throw buildApiError(error, 'Failed to update response');
    }
};

export const deleteCannedResponse = async (responseId: number): Promise<{ success: boolean }> => {
    try {
        const response = await api.delete(`/canned-responses/${responseId}`);
        return response.data;
    } catch (error) {
        console.error('API Error deleting canned response:', error);
        throw buildApiError(error, 'Failed to delete response');
    }
};

/**
 * Uploads a file during a live chat session (operator side).
 * Uses multipart/form-data. Returns { file_url, filename, content_type }.
 * @param {File} file
 * @param {string} sessionId
 * @returns {Promise<{ file_url: string, filename: string, content_type: string }>}
 */
export const uploadOperatorChatFile = async (
    file: File,
    sessionId: string,
): Promise<{ file_url: string; filename: string; content_type: string; size: number }> => {
    try {
        const formData = new FormData();
        formData.append('file', file);
        const response = await api.post(
            `/operators/upload-chat-file?session_id=${sessionId}`,
            formData,
            { headers: { 'Content-Type': 'multipart/form-data' } }
        );
        return response.data;
    } catch (error) {
        console.error('API Error uploading operator chat file:', error);
        throw buildApiError(error, 'Failed to upload file');
    }
};

// --- SUBSCRIPTION & BILLING ENDPOINTS ---

export const getSubscriptionPlans = async (): Promise<Array<Record<string, unknown>>> => {
    try {
        const response = await api.get('/subscriptions/plans');
        return response.data;
    } catch (error) {
        throw buildApiError(error, 'Failed to load plans');
    }
};

// Launch-promo eligibility for the CURRENT client (billing display only).
// Returns `{ active: false }` or the promo projection
// `{ active: true, id, name, free_cycles, ends_at, eligible_plan_ids }`.
// Checkout re-validates server-side, so this is never the gate.
export const getActivePromotion = async (): Promise<Record<string, unknown>> => {
    try {
        const response = await api.get('/subscriptions/promo');
        return response.data;
    } catch (error) {
        throw buildApiError(error, 'Failed to load promotion');
    }
};

// ─── Per-bot checkout ────────────────────────────────────────────────────────
// Mints a Razorpay subscription that funds exactly one new bot. The bot row
// is created server-side only after payment captures (via the activation
// webhook, or synchronously via verifyBotCheckout when the webhook can't
// reach localhost).

export const createBotCheckout = async (
    {
    name,
    website,
    plan_slug,
    billing_cycle = 'monthly',
    allowed_domains,
    domain_check_enabled,
}: {
  name: string;
  website?: string;
  plan_slug: string;
  billing_cycle?: string;
  allowed_domains?: string[] | null;
  domain_check_enabled?: boolean | null;
},
): Promise<Record<string, unknown>> => {
    try {
        const response = await api.post('/bots/checkout', {
            name,
            website: website || null,
            plan_slug,
            billing_cycle,
            allowed_domains,
            domain_check_enabled,
        });
        return response.data;
    } catch (error) {
        throw buildApiError(error, 'Failed to start bot checkout');
    }
};

export const verifyBotCheckout = async (
    {
    razorpay_payment_id,
    razorpay_subscription_id,
    razorpay_signature,
}: {
  razorpay_payment_id: string;
  razorpay_subscription_id: string;
  razorpay_signature: string;
},
): Promise<Record<string, unknown>> => {
    try {
        const response = await api.post('/bots/checkout/verify', {
            razorpay_payment_id,
            razorpay_subscription_id,
            razorpay_signature,
        });
        return response.data;
    } catch (error) {
        throw buildApiError(error, 'Failed to verify bot checkout');
    }
};

export const getCurrentSubscription = async (botId?: number | null): Promise<Record<string, unknown>> => {
    try {
        const params: Record<string, unknown> = {};
        if (botId != null) params.bot_id = botId;
        const response = await api.get('/subscriptions/current', { params });
        return response.data;
    } catch (error) {
        throw buildApiError(error, 'Failed to load subscription');
    }
};

export const getSubscriptionUsage = async (): Promise<Record<string, unknown>> => {
    try {
        const response = await api.get('/subscriptions/usage');
        return response.data;
    } catch (error) {
        throw buildApiError(error, 'Failed to load usage data');
    }
};

export const getInvoices = async (botId?: number | null): Promise<Array<Record<string, unknown>>> => {
    try {
        const params: Record<string, unknown> = {};
        if (botId != null) params.bot_id = botId;
        const response = await api.get('/subscriptions/invoices', { params });
        return response.data;
    } catch (error) {
        throw buildApiError(error, 'Failed to load invoices');
    }
};

/**
 * Fetch the buyer tax identity printed on invoices (invoicing v2).
 * @returns {Promise<{legal_name, company_name, gstin, billing_address, billing_country, billing_state_code, billing_email}>}
 */
/**
 * Recovery state for a failing subscription. Drives the app-wide past-due
 * banner. Read-only and safe to poll: the backend resolves Razorpay's EXISTING
 * hosted page and never mints a second mandate.
 *
 * `recoverable` is tri-state: true (link usable), false (settled. Terminal
 * mandate or no hosted page), null (the gateway couldn't be reached, so we
 * don't know). Never render a button on null or false.
 */
/**
 * Saved payment instruments for ONE-OFF payments (credit top-ups).
 *
 * Not the subscription mandate: Razorpay cannot swap the instrument on a live
 * subscription, so changing THAT runs the re-mandate flow via /resume.
 * Conflating the two would promise a swap the gateway cannot perform.
 */
export const getPaymentMethods = async (
    { refresh = false }: { refresh?: boolean } = {},
): Promise<Record<string, unknown>[]> => {
    try {
        const params = refresh ? { refresh: 'true' } : {};
        const response = await api.get('/payment-methods', { params });
        return response.data;
    } catch (error) {
        throw buildApiError(error, 'Failed to load saved payment methods');
    }
};

/** Revoke a saved instrument at Razorpay, then drop our mirror row. */
export const deletePaymentMethod = async (tokenId: string): Promise<Record<string, unknown>> => {
    try {
        const response = await api.delete(`/payment-methods/${encodeURIComponent(tokenId)}`);
        return response.data;
    } catch (error) {
        throw buildApiError(error, 'Failed to remove the payment method');
    }
};

export const getPaymentRecovery = async (botId?: number | null): Promise<Record<string, unknown>> => {
    try {
        const params: Record<string, unknown> = {};
        if (botId != null) params.bot_id = botId;
        const response = await api.get('/subscriptions/payment-recovery', { params });
        return response.data;
    } catch (error) {
        throw buildApiError(error, 'Failed to load payment status');
    }
};

export const getBillingDetails = async (): Promise<Record<string, unknown>> => {
    try {
        const response = await api.get('/subscriptions/billing-details');
        return response.data;
    } catch (error) {
        throw buildApiError(error, 'Failed to load billing details');
    }
};

/**
 * Update billing details with PATCH semantics: send only the fields that
 * changed; an explicit ``null`` clears a field. The backend derives
 * ``billing_state_code`` from the GSTIN's first two digits when one is set
 * and returns 422 with a human-readable ``detail`` on invalid combinations.
 * @param {object} patch - Subset of billing-details fields to change.
 */
export const updateBillingDetails = async (
    patch: Record<string, unknown>,
): Promise<Record<string, unknown>> => {
    try {
        const response = await api.put('/subscriptions/billing-details', patch);
        return response.data;
    } catch (error) {
        throw buildApiError(error, 'Failed to update billing details');
    }
};

/**
 * Honest pre-checkout quote - the single source of truth for what the pay
 * button will charge, before any payment surface opens. Returns the resolved
 * currency, amount (minor units + display string), payment methods, and
 * whether checkout is supported at all (`checkout_supported: false` with a
 * `reason` of `free_plan` / `intl_usd_pending` → render Contact Sales instead
 * of a pay button). Proration is applied server-side at activation and is
 * intentionally NOT part of this quote.
 */
export const getCheckoutQuote = async (
    planId: number,
    billingCycle: 'monthly' | 'annual' = 'monthly',
    billingCountry: string | null = null,
): Promise<CheckoutQuoteResponse> => {
    try {
        const response = await api.get('/subscriptions/checkout/quote', {
            params: {
                plan_id: planId,
                billing_cycle: billingCycle,
                ...(billingCountry ? { billing_country: billingCountry } : {}),
            },
        });
        return response.data;
    } catch (error) {
        throw buildApiError(error, 'Failed to fetch checkout quote');
    }
};

/**
 * Fire-and-forget payment-funnel telemetry: the customer closed the Razorpay
 * sheet ('checkout_abandoned') or the gateway declined ('payment_failed').
 * Never throws. Losing a telemetry event must not affect the checkout UX.
 */
export const recordBillingEvent = (
    event: 'checkout_abandoned' | 'payment_failed',
    surface: 'plan' | 'topup' | 'seat' | 'resume' | 'branding',
    meta?: Record<string, unknown> | null,
): Promise<unknown> => {
    try {
        return api
            .post('/subscriptions/billing-events', { event, surface, meta: meta ?? null })
            .catch(() => undefined);
    } catch {
        return Promise.resolve(undefined);
    }
};

export const createCheckoutSession = async (
    planId: number,
    billingCycle: 'monthly' | 'annual' = 'monthly',
    billingCountry: string | null = null,
): Promise<Record<string, unknown>> => {
    try {
        const response = await api.post('/subscriptions/checkout', {
            plan_id: planId,
            billing_cycle: billingCycle,
            // Confirmed billing country routes currency/plan/invoice. Omitted
            // (null) → the backend falls back to the client's stored country,
            // else domestic (IN).
            ...(billingCountry ? { billing_country: billingCountry } : {}),
        });
        return response.data;
    } catch (error) {
        throw buildApiError(error, 'Failed to create checkout session');
    }
};
export const changePlan = async (
    planId: number,
    billingCycle: string | null = null,
    botId: number | null = null,
): Promise<Record<string, unknown>> => {
    try {
        const response = await api.post('/subscriptions/change-plan', {
            plan_id: planId,
            billing_cycle: billingCycle,
            ...(botId != null ? { bot_id: botId } : {}),
        });
        return response.data;
    } catch (error) {
        throw buildApiError(error, 'Failed to change plan');
    }
};

export const cancelScheduledChange = async (): Promise<Record<string, unknown>> => {
    try {
        const response = await api.post('/subscriptions/cancel-scheduled-change');
        return response.data;
    } catch (error) {
        throw buildApiError(error, 'Failed to cancel the scheduled plan change');
    }
};

export const cancelSubscription = async (
    reason: string | null = null,
    botId: number | null = null,
): Promise<Record<string, unknown>> => {
    try {
        const body: Record<string, unknown> = { reason };
        if (botId != null) body.bot_id = botId;
        const response = await api.post('/subscriptions/cancel', body);
        return response.data;
    } catch (error) {
        throw buildApiError(error, 'Failed to cancel subscription');
    }
};

/**
 * Reactivate a subscription that was scheduled to cancel.
 *
 * MUST carry the same `botId` scope `cancelSubscription` used. Without it the
 * backend resolves the account subscription, which for a customer with
 * per-agent plans is a DIFFERENT row than the one Cancel just acted on, so
 * Reactivate either 400s ("not scheduled for cancellation") or mints a fresh
 * Razorpay mandate against the wrong subscription.
 */
export const resumeSubscription = async (botId: number | null = null): Promise<Record<string, unknown>> => {
    try {
        const body: Record<string, unknown> = {};
        if (botId != null) body.bot_id = botId;
        const response = await api.post('/subscriptions/resume', body);
        return response.data;
    } catch (error) {
        throw buildApiError(error, 'Failed to resume subscription');
    }
};

// --- CREDITS & TOP-UPS ---

export const getCreditBalance = async (): Promise<Record<string, unknown>> => {
    try {
        const response = await api.get('/credits/balance');
        return response.data;
    } catch (error) {
        throw buildApiError(error, 'Failed to load credit balance');
    }
};

export const getCreditHistory = async (
    { page = 1, limit = 50, botId }: { page?: number; limit?: number; botId?: number | null } = {},
): Promise<Record<string, unknown>> => {
    try {
        const params: Record<string, unknown> = { page, limit };
        if (botId != null) params.bot_id = botId;
        const response = await api.get('/credits/history', { params });
        return response.data;
    } catch (error) {
        throw buildApiError(error, 'Failed to load credit history');
    }
};

/**
 * Daily credit consumption for the Usage-page trend → `{ days, series: [{ date,
 * credits_used }] }`. The series is zero-filled and ascending (one entry per
 * day in the window), summing only metered consumption debits.
 */
export const getCreditDaily = async (
    { days = 30, botId }: { days?: number; botId?: number | null } = {},
): Promise<Record<string, unknown>> => {
    try {
        const params: Record<string, unknown> = { days };
        if (botId != null) params.bot_id = botId;
        const response = await api.get('/credits/daily', { params });
        return response.data;
    } catch (error) {
        throw buildApiError(error, 'Failed to load consumption trend');
    }
};

export const getTopupPacks = async (): Promise<TopupPackResponse[]> => {
    try {
        const response = await api.get('/credits/packs');
        return response.data;
    } catch (error) {
        throw buildApiError(error, 'Failed to load top-up packs');
    }
};

/**
 * Initiate a top-up purchase.
 *
 * Returns a Razorpay order payload:
 *   { provider:'razorpay', order_id, amount, currency, key_id, name,
 *     description, prefill, theme, credits, bonus_pct, receipt }
 *
 * The caller passes `amount` matching one of the configured packs.
 * `pack_usd` is accepted as a legacy alias.
 */
export const initiateTopup = async (
    amount: number,
    { botId }: { botId?: number | null } = {},
): Promise<Record<string, unknown>> => {
    try {
        const response = await api.post('/credits/topup', { amount, bot_id: botId ?? null });
        return response.data;
    } catch (error) {
        throw buildApiError(error, 'Failed to start top-up checkout');
    }
};

/**
 * Server-verify the Razorpay Checkout success callback.
 * Required for defence-in-depth - never trust the modal-only success path.
 */
export const verifyTopupPayment = async (
    { razorpay_order_id, razorpay_payment_id, razorpay_signature }: {
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
},
): Promise<Record<string, unknown>> => {
    try {
        const response = await api.post('/credits/topup/verify', {
            razorpay_order_id,
            razorpay_payment_id,
            razorpay_signature,
        });
        return response.data;
    } catch (error) {
        throw buildApiError(error, 'Could not verify payment');
    }
};


/**
 * Subscription billing geo / currency profile. Returns the country and
 * ``display_currency``, which follows the currency the charge path would
 * actually use: "INR" for India AND for an unresolved country (an unconfirmed
 * buyer is treated as domestic), "USD" only for a stored or IP-detected non-IN
 * country. Also returns ``checkout_available`` - whether checkout is wired
 * (Razorpay enabled). Cached at call sites - geo doesn't change mid-session.
 */
export const getBillingGeo = async (overrideCountry?: string): Promise<BillingGeoResponse> => {
    try {
        const params = overrideCountry ? { country: overrideCountry.toUpperCase() } : undefined;
        const response = await api.get('/subscriptions/geo', { params });
        return response.data;
    } catch (error) {
        throw buildApiError(error, 'Could not load billing region');
    }
};

/**
 * Server-verify the Razorpay subscription Checkout success callback.
 * Mirrors verifyTopupPayment's responsibility but for the subscription
 * signature (``payment_id|subscription_id`` HMAC variant). The webhook is
 * still the authoritative reconciler - this endpoint exists so the modal
 * can flip to a success state instantly instead of polling.
 */
export const verifyRazorpaySubscription = async (
    {
    razorpay_payment_id,
    razorpay_subscription_id,
    razorpay_signature,
}: {
  razorpay_payment_id: string;
  razorpay_subscription_id: string;
  razorpay_signature: string;
},
): Promise<Record<string, unknown>> => {
    try {
        const response = await api.post('/subscriptions/verify-razorpay-subscription', {
            razorpay_payment_id,
            razorpay_subscription_id,
            razorpay_signature,
        });
        return response.data;
    } catch (error) {
        throw buildApiError(error, 'Could not verify Razorpay subscription');
    }
};


export const changeOperatorSeats = async (
    delta: number,
    botId: number | null = null,
): Promise<SeatChangeResponse> => {
    try {
        const body: Record<string, unknown> = { delta };
        if (botId != null) body.bot_id = botId;
        const response = await api.post('/subscriptions/seats', body);
        return response.data;
    } catch (error) {
        throw buildApiError(error, 'Failed to update operator seats');
    }
};

/**
 * Buy the branding-removal add-on for a subscription.
 *
 * Branding removal is not bundled into any plan tier - it rides on its own
 * Razorpay mandate, exactly like an extra operator seat. The entitlement is NOT
 * granted by this call: the mandate is minted in `created` state and
 * `branding_removable` only flips once the customer authorizes the returned
 * `checkout` payload and the `activated` webhook lands. Callers must re-read
 * entitlements rather than assume success.
 *
 * 400 when the subscription is on the Free plan.
 * @param {number|null} botId - Target that agent's subscription; null = account.
 */
export const purchaseBrandingAddon = async (botId: number | null = null): Promise<BrandingAddonResponse> => {
    try {
        const response = await api.post('/subscriptions/branding-addon', { bot_id: botId ?? null });
        return response.data;
    } catch (error) {
        throw buildApiError(error, 'Failed to start the branding removal add-on');
    }
};

/**
 * Cancel the branding-removal add-on. Cancels immediately (not at cycle end),
 * so billing stops the moment the customer asks; the badge reappears on their
 * widget within the entitlements cache TTL.
 * @param {number|null} botId - Target that agent's subscription; null = account.
 */
export const cancelBrandingAddon = async (botId: number | null = null): Promise<BrandingAddonResponse> => {
    try {
        const response = await api.delete('/subscriptions/branding-addon', {
            data: { bot_id: botId ?? null },
        });
        return response.data;
    } catch (error) {
        throw buildApiError(error, 'Failed to cancel the branding removal add-on');
    }
};



// ─── Affiliate Program v1 ────────────────────────────────────────────────
// Money-free referral codes + attribution. Endpoints mirror
// app/api/affiliate_routes.py:
//   GET    /affiliate/me           - affiliate's own meta
//   GET    /affiliate/codes        - codes + per-row stats
//   POST   /affiliate/codes        - create a code
//   PATCH  /affiliate/codes/{id}   - update label / toggle active
//   GET    /affiliate/stats        - aggregate metrics for the header card
// All require X-API-Key + an active affiliates row (backend enforces 403).

/** Return the logged-in affiliate's profile + cap. */
export const getAffiliateMe = async (): Promise<Record<string, unknown>> => {
    try {
        const response = await api.get('/affiliate/me');
        return response.data;
    } catch (error) {
        throw buildApiError(error, 'Failed to load affiliate profile');
    }
};

/** List the current affiliate's codes with per-code click + signup counts. */
export const getAffiliateCodes = async (): Promise<Array<Record<string, unknown>>> => {
    try {
        const response = await api.get('/affiliate/codes');
        return response.data;
    } catch (error) {
        throw buildApiError(error, 'Failed to load referral codes');
    }
};

/**
 * List the customers who signed up via one of the affiliate's codes.
 * Emails are masked server-side on this route (affiliate scope) so the
 * raw PII never reaches the browser.
 */
export const getAffiliateCodeReferrals = async (codeId: number): Promise<Record<string, unknown>> => {
    try {
        const response = await api.get(`/affiliate/codes/${codeId}/referrals`);
        return response.data;
    } catch (error) {
        throw buildApiError(error, 'Failed to load referrals for this code');
    }
};

/**
 * Create a new referral code for the current affiliate.
 * @param {string} code
 * @param {string|null} label
 * @param {{ affiliateCommissionPct?: number, customerDiscountPct?: number }} split
 *   - per-code commission split. Each is 0 to 100 (whole percent). Their sum
 *     must not exceed the affiliate's pool (set by super-admin).
 */
export const createAffiliateCode = async (
    code: string,
    label: string | null = null,
    { affiliateCommissionPct, customerDiscountPct }: { affiliateCommissionPct?: number; customerDiscountPct?: number } = {},
): Promise<Record<string, unknown>> => {
    try {
        const payload: Record<string, unknown> = { code, label };
        if (affiliateCommissionPct != null) payload.affiliate_commission_pct = affiliateCommissionPct;
        if (customerDiscountPct != null) payload.customer_discount_pct = customerDiscountPct;
        const response = await api.post('/affiliate/codes', payload);
        return response.data;
    } catch (error) {
        throw buildApiError(error, 'Failed to create referral code');
    }
};

/**
 * Update an existing code. Every field is an optional patch:
 *   - ``code``                       - rename (breaks old ?ref= URL)
 *   - ``label``                      - internal label (empty string clears)
 *   - ``active``                     - toggle deactivation/reactivation
 *   - ``affiliateCommissionPct``     - what the affiliate keeps (0 to 100)
 *   - ``customerDiscountPct``        - what the referred customer gets
 *
 * The split pair is validated together: their sum must not exceed the
 * affiliate's commission pool.
 */
export const updateAffiliateCode = async (
    codeId: number,
    { code, label, active, affiliateCommissionPct, customerDiscountPct }: {
    code?: string;
    label?: string;
    active?: boolean;
    affiliateCommissionPct?: number;
    customerDiscountPct?: number;
  } = {},
): Promise<Record<string, unknown>> => {
    try {
        const payload: Record<string, unknown> = {};
        if (code !== undefined) payload.code = code;
        if (label !== undefined) payload.label = label;
        if (active !== undefined) payload.active = active;
        if (affiliateCommissionPct !== undefined) payload.affiliate_commission_pct = affiliateCommissionPct;
        if (customerDiscountPct !== undefined) payload.customer_discount_pct = customerDiscountPct;
        const response = await api.patch(`/affiliate/codes/${codeId}`, payload);
        return response.data;
    } catch (error) {
        throw buildApiError(error, 'Failed to update referral code');
    }
};

/** Aggregate stats for the affiliate dashboard header card. */
export const getAffiliateStats = async (): Promise<Record<string, unknown>> => {
    try {
        const response = await api.get('/affiliate/stats');
        return response.data;
    } catch (error) {
        throw buildApiError(error, 'Failed to load affiliate stats');
    }
};

// ─── Super-admin: affiliate management ──────────────────────────────────
// Endpoints in app/api/affiliate_routes.py under /superadmin/affiliates.
// All require X-API-Key from a client with is_superadmin = true.

// ─── Affiliate invites (magic-link onboarding) ──────────────────────────

/**
 * Look up a magic-link invite by raw token. Returns the email + expiry so
 * the AffiliateInvite landing page can show the recipient who the invite
 * is for + the expiry deadline before they pick sign-in or sign-up.
 *
 * Throws on invalid (404) / expired or revoked (410). The caller inspects
 * `error.status` to render the right empty state.
 */
export const lookupAffiliateInvite = async (
    token: string,
): Promise<{ email: string; expires_at: string }> => {
    try {
        const response = await api.get('/affiliate-invites/lookup', { params: { token } });
        return response.data;
    } catch (error) {
        throw buildApiError(error, 'Invite link is invalid or expired');
    }
};

/**
 * Accept a magic-link invite: atomically creates Client + Affiliate, returns
 * an access_token with the same shape as /auth/register so the admin app
 * can log the user in immediately.
 */
export const acceptAffiliateInvite = async (
    { token, name, password, companyName = null, website = null }: {
  token: string;
  name: string;
  password: string;
  companyName?: string | null;
  website?: string | null;
},
): Promise<{
  access_token: string;
  client_id: number;
  name: string;
  is_affiliate: boolean;
}> => {
    try {
        const payload: Record<string, unknown> = { token, name, password };
        if (companyName) payload.company_name = companyName;
        if (website) payload.website = website;
        const response = await api.post('/affiliate-invites/accept', payload);
        return response.data;
    } catch (error) {
        throw buildApiError(error, 'Failed to accept invite');
    }
};

/**
 * Accept an invite while ALREADY signed in. Backend wires the Affiliate
 * row to the currently-authenticated client (no Client row created).
 * Returns 403 if the token's email doesn't match the logged-in client.
 */
export const acceptAffiliateInviteExisting = async (
    token: string,
): Promise<{ is_affiliate: boolean; message: string }> => {
    try {
        const response = await api.post('/affiliate-invites/accept-existing', { token });
        return response.data;
    } catch (error) {
        throw buildApiError(error, 'Failed to accept invite');
    }
};

// ─────────────────────────────────────────────────────────────────────────
// Web Push (operator notifications)
//
// Only operators ever subscribe. The dashboard's usePushNotifications hook
// gates these calls behind `authType === 'operator'`; calling them as a
// client login will receive a 400 from the backend, which we handle as a
// no-op since clients don't need push.
// ─────────────────────────────────────────────────────────────────────────

/** Fetch the server's VAPID public key for pushManager.subscribe(). */
export const getVapidPublicKey = async (): Promise<{ public_key: string; enabled: boolean }> => {
    try {
        const response = await api.get('/operators/push/vapid-public-key');
        return response.data; // { public_key: string, enabled: boolean }
    } catch (error) {
        throw buildApiError(error, 'Failed to load push public key');
    }
};

/** Register a PushSubscription with the backend. */
export const subscribePush = async (subscription: PushSubscription): Promise<boolean> => {
    // PushSubscription.toJSON() returns { endpoint, expirationTime, keys: { p256dh, auth } }
    // - exactly the shape the backend expects, minus expirationTime which we drop.
    const json = subscription.toJSON();
    // The browser always populates `keys` for a real subscription; the type
    // marks them optional because PushSubscriptionJSON also describes a bare
    // endpoint. One without them cannot be encrypted to, so this fails loudly
    // rather than posting a record the push sender can never use. Previously
    // it threw a bare TypeError on the same input.
    const { p256dh, auth } = json.keys ?? {};
    if (!p256dh || !auth) {
        throw new ApiError('This push subscription is missing its encryption keys.');
    }
    try {
        await api.post('/operators/push/subscribe', {
            endpoint: json.endpoint,
            keys: { p256dh, auth },
        });
        return true;
    } catch (error) {
        throw buildApiError(error, 'Failed to register push subscription');
    }
};

// ── In-app notifications (bell + dropdown) ─────────────────────────────────

/** Fetch the most recent notifications + the unread count. */
export const listNotifications = async (
    { limit = 30, beforeId, unreadOnly = false }: {
  /** Page size. Defaults to 30. */
  limit?: number;
  /** Cursor: return notifications older than this id. */
  beforeId?: number;
  /** Restrict to unread only. Defaults to false. */
  unreadOnly?: boolean;
} = {},
): Promise<{ items: NotificationItem[]; unread_count: number }> => {
    try {
        const params: Record<string, unknown> = { limit };
        if (beforeId) params.before_id = beforeId;
        if (unreadOnly) params.unread_only = true;
        const response = await api.get('/notifications', { params });
        return response.data; // { items, unread_count }
    } catch (error) {
        throw buildApiError(error, 'Failed to load notifications');
    }
};

/** Cheap polling endpoint - returns ``{unread_count}``. */
export const getUnreadNotificationCount = async (): Promise<number> => {
    try {
        const response = await api.get('/notifications/unread-count');
        return response.data.unread_count;
    } catch (error) {
        throw buildApiError(error, 'Failed to load unread count');
    }
};

/** Mark every unread notification as read. */
export const markAllNotificationsRead = async (): Promise<{ updated: number; unread_count: number }> => {
    try {
        const response = await api.post('/notifications/mark-all-read');
        return response.data;
    } catch (error) {
        throw buildApiError(error, 'Failed to mark notifications read');
    }
};

/** Mark a single notification as read. Safe to call on already-read rows. */
export const markNotificationRead = async (
    notificationId: number,
): Promise<{ updated: boolean; unread_count: number }> => {
    try {
        const response = await api.patch(`/notifications/${notificationId}/read`);
        return response.data;
    } catch (error) {
        throw buildApiError(error, 'Failed to update notification');
    }
};

/** Delete one notification from the feed. */
export const deleteNotification = async (
    notificationId: number,
): Promise<{ deleted: boolean; unread_count: number }> => {
    try {
        const response = await api.delete(`/notifications/${notificationId}`);
        return response.data;
    } catch (error) {
        throw buildApiError(error, 'Failed to delete notification');
    }
};

/** Clear the entire feed for this workspace. */
export const clearAllNotifications = async (): Promise<{ deleted: number; unread_count: number }> => {
    try {
        const response = await api.delete('/notifications');
        return response.data;
    } catch (error) {
        throw buildApiError(error, 'Failed to clear notifications');
    }
};

/** Unregister a PushSubscription from the backend. */
export const unsubscribePush = async (endpoint: string, keys?: unknown): Promise<boolean> => {
    try {
        await api.delete('/operators/push/subscribe', {
            data: { endpoint, keys },
        });
        return true;
    } catch (error) {
        // Treat 4xx as best-effort cleanup - the subscription may already be
        // gone server-side (different device or 410 prune), and we still want
        // the local unsubscribe to proceed.
        const status = (error as { status?: number } | null)?.status;
        if (status !== undefined && status >= 400 && status < 500) {
            return false;
        }
        throw buildApiError(error, 'Failed to remove push subscription');
    }
};

// --- CLIENT ACCOUNT (Settings → Profile / Security / Workspace) ---

/**
 * Update the authenticated client's display name. Email changes go through
 * requestClientEmailChange / confirmClientEmailChange instead.
 * @param {{ name?: string }} patch
 * @returns {Promise<{ id: number, name: string, email: string, pending_email: string|null }>}
 */
export const updateClientProfile = async (
    patch: {
  name?: string;
  company_name?: string;
  website?: string;
},
): Promise<{
  id: number;
  name: string;
  email: string;
  company_name?: string | null;
  website?: string | null;
  pending_email: string | null;
}> => {
    try {
        const response = await api.patch('/client/profile', patch);
        return response.data;
    } catch (error) {
        console.error('API Error updating client profile:', error);
        throw buildApiError(error, 'Failed to update profile');
    }
};

/**
 * Start an email change: verifies the current password, stores the new
 * address as pending, and emails it a confirmation code. The login email
 * does not change until confirmClientEmailChange succeeds.
 * @param {string} newEmail
 * @param {string} currentPassword
 * @returns {Promise<{ message: string, pending_email: string }>}
 */
export const requestClientEmailChange = async (
    newEmail: string,
    currentPassword: string,
): Promise<{ message: string; pending_email: string }> => {
    try {
        const response = await api.post('/client/change-email/request', {
            new_email: newEmail,
            current_password: currentPassword,
        });
        return response.data;
    } catch (error) {
        console.error('API Error requesting email change:', error);
        throw buildApiError(error, 'Failed to start email change');
    }
};

/**
 * Confirm a pending email change with the OTP sent to the new address.
 * @param {string} otp
 * @returns {Promise<{ id: number, name: string, email: string, pending_email: null }>}
 */
export const confirmClientEmailChange = async (
    otp: string,
): Promise<{ id: number; name: string; email: string; pending_email: null }> => {
    try {
        const response = await api.post('/client/change-email/confirm', { otp });
        return response.data;
    } catch (error) {
        console.error('API Error confirming email change:', error);
        throw buildApiError(error, 'Failed to confirm email change');
    }
};

/**
 * Cancel a pending email change before it's confirmed.
 * @returns {Promise<{ ok: boolean }>}
 */
export const cancelClientEmailChange = async (): Promise<{ ok: boolean }> => {
    try {
        const response = await api.post('/client/change-email/cancel');
        return response.data;
    } catch (error) {
        console.error('API Error cancelling email change:', error);
        throw buildApiError(error, 'Failed to cancel email change');
    }
};

/**
 * Change the authenticated client's password. The backend verifies the current
 * password and enforces strength (≥8 chars, a letter and a number).
 *
 * The backend also ROTATES the account's API key as part of the change, so
 * every other session holding the old key is revoked. It returns the new key
 * in ``api_key``; we swap it into storage immediately so THIS tab keeps
 * working. Without that swap the very next request 401s and the interceptor
 * bounces the user to /login mid-flow.
 *
 * @param {string} currentPassword
 * @param {string} newPassword
 * @returns {Promise<{ ok: boolean, api_key?: string }>}
 */
export const changeClientPassword = async (
    currentPassword: string,
    newPassword: string,
): Promise<{ ok: boolean; api_key?: string }> => {
    try {
        const response = await api.post('/client/change-password', {
            current_password: currentPassword,
            new_password: newPassword,
        });
        if (response.data?.api_key) {
            setAuthItem('admin_token', response.data.api_key);
        }
        return response.data;
    } catch (error) {
        console.error('API Error changing client password:', error);
        throw buildApiError(error, 'Failed to change password');
    }
};

/**
 * Fetch the authenticated client's API key in masked form.
 * @returns {Promise<{ api_key_masked: string }>}
 */
export const getClientApiKey = async (): Promise<{ api_key_masked: string }> => {
    try {
        const response = await api.get('/client/api-key');
        return response.data;
    } catch (error) {
        console.error('API Error fetching client API key:', error);
        throw buildApiError(error, 'Failed to load API key');
    }
};

/**
 * Rotate the client's API key. The response contains the full new key exactly
 * once so the UI can offer a copy-to-clipboard reveal; later reads are masked.
 * @returns {Promise<{ ok: boolean, api_key: string, api_key_masked: string }>}
 */
export const regenerateClientApiKey = async (
): Promise<{ ok: boolean; api_key: string; api_key_masked: string }> => {
    try {
        const response = await api.post('/client/api-key/regenerate');
        return response.data;
    } catch (error) {
        console.error('API Error regenerating client API key:', error);
        throw buildApiError(error, 'Failed to regenerate API key');
    }
};

// ─────────────────────────────────────────────────────────────────────────
// Operator invites + workspace membership
//
// Owner-facing invite CRUD + the public airlock endpoints + workspace
// listing for the switcher. All scoped by the current X-Workspace-Id header
// so calling ``createInvite`` while in workspace X invites into workspace X.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Send an operator invite to the given email. Called from Team → Invite modal.
 * ``role`` is one of ``operator | admin`` (v1). ``departmentId`` is optional.
 * Returns ``{ invite, accept_url }`` - the URL is included so a copy-to-clipboard
 * affordance is possible; the email is fired backend-side.
 */
export const createOperatorInvite = async (
    { email, botId, role = 'operator', departmentId = null }: {
  email: string;
  botId: number;
  role?: 'operator' | 'admin' | string;
  departmentId?: number | null;
},
): Promise<OperatorInviteCreated> => {
    try {
        const response = await api.post('/invites', {
            email,
            bot_id: botId,
            role,
            department_id: departmentId,
        });
        return response.data;
    } catch (error) {
        throw buildApiError(error, 'Failed to send invite');
    }
};

/**
 * List invites for the current workspace. ``statusFilter`` narrows to
 * pending / accepted / revoked / expired / all (default = all).
 */
export const listOperatorInvites = async (statusFilter: string | null = null): Promise<OperatorInvite[]> => {
    try {
        const params = statusFilter ? { status_filter: statusFilter } : {};
        const response = await api.get('/invites', { params });
        return response.data;
    } catch (error) {
        throw buildApiError(error, 'Failed to load invites');
    }
};

/** Regenerate the token and resend the invite email. */
export const resendOperatorInvite = async (inviteId: number): Promise<OperatorInviteCreated> => {
    try {
        const response = await api.post(`/invites/${inviteId}/resend`);
        return response.data;
    } catch (error) {
        throw buildApiError(error, 'Failed to resend invite');
    }
};

/** Revoke a pending invite. Idempotent - resolved invites are no-ops. */
export const revokeOperatorInvite = async (inviteId: number): Promise<boolean> => {
    try {
        await api.delete(`/invites/${inviteId}`);
        return true;
    } catch (error) {
        throw buildApiError(error, 'Failed to revoke invite');
    }
};

/**
 * Unauthenticated - used by the ``/invite/{token}`` airlock page BEFORE login
 * to render workspace name + inviter + status so the invitee can decide
 * whether to sign up or log in.
 */
export const getInvitePublic = async (token: string): Promise<Record<string, unknown>> => {
    try {
        const response = await api.get(`/invites/by-token/${encodeURIComponent(token)}`);
        return response.data;
    } catch (error) {
        throw buildApiError(error, 'This invite link is invalid or expired');
    }
};

/**
 * Accept the invite as the currently-logged-in Client. Requires X-API-Key.
 * Backend validates email match (case-insensitive) and creates the linked
 * Operator row atomically.
 */
export const acceptInvitePublic = async (token: string): Promise<Record<string, unknown>> => {
    try {
        const response = await api.post(`/invites/by-token/${encodeURIComponent(token)}/accept`);
        return response.data;
    } catch (error) {
        throw buildApiError(error, 'Failed to accept invite');
    }
};

/**
 * List every workspace the current caller can act in (owned + linked-operator
 * memberships). Called by ``WorkspaceContext`` on mount and after a switch.
 * Bypasses the workspace abort controller so it isn't cancelled during
 * a switch (workspace list is orthogonal to the workspace being switched).
 */
export const getMyWorkspaces = async (): Promise<{ workspaces: Workspace[] }> => {
    try {
        // Ignore the workspace-scoped AbortController for THIS call - otherwise
        // a switch mid-flight would cancel the list refresh we just triggered.
        const response = await api.get('/me/workspaces', { signal: undefined });
        return response.data;
    } catch (error) {
        throw buildApiError(error, 'Failed to load workspaces');
    }
};

/**
 * Add the calling Client (workspace owner) as an operator in their own
 * workspace. Idempotent - reactivates a previously-left row if one exists.
 * The self-operator does NOT consume a paid seat.
 *
 * Returns ``{ operator_id, role, is_active, was_existing }``. UI can toast
 * "Welcome back to live chat" when ``was_existing`` is true.
 */
export const addSelfAsOperator = async (botId?: number): Promise<SelfOperatorResult> => {
    try {
        const response = await api.post('/me/self-operator', { bot_id: botId });
        return response.data;
    } catch (error) {
        throw buildApiError(error, 'Failed to add yourself as an operator');
    }
};

/**
 * Read the quotation catalog for a bot.
 * Returns { enabled, currency, services[] }.
 */
export const getQuotationCatalog = async (botId: number): Promise<unknown> => {
    try {
        const response = await api.get(`/bots/${botId}/quotation-catalog`);
        return response.data;
    } catch (error) {
        throw buildApiError(error, 'Failed to load quotation catalog');
    }
};

/** Replace the quotation catalog for a bot. */
export const putQuotationCatalog = async (botId: number, catalog: unknown): Promise<unknown> => {
    try {
        const response = await api.put(`/bots/${botId}/quotation-catalog`, catalog);
        return response.data;
    } catch (error) {
        throw buildApiError(error, 'Failed to save quotation catalog');
    }
};

/**
 * Deactivate the caller's self-operator row (owner leaves live chat).
 * Sets ``is_active=False`` - historical chats stay linked, in-flight chats
 * complete naturally. Idempotent.
 */
export const removeSelfAsOperator = async (): Promise<boolean> => {
    try {
        await api.delete('/me/self-operator');
        return true;
    } catch (error) {
        throw buildApiError(error, 'Failed to leave live chat');
    }
};

/** Re-exported so consumers can narrow a rejection without a second import. */
export { ApiError, isApiError } from './apiTypes';
