/**
 * Response shapes for the customer-support endpoints.
 *
 * Written against the handlers, not against a guess: `superadmin_routes.py`
 * (`/clients` list, create, delete), `superadmin_routes_v2.py` (`/clients/{id}`
 * and every client mutation) and `superadmin_ops_routes.py` (`/api-keys`,
 * `/oauth-accounts`, `/push-subscriptions`, `/notifications`,
 * `/clients/{id}/rotate-api-key`). Where a field is documented as always-null
 * or always-constant it says so here, so no screen renders it as data.
 */

/** A row of `GET /superadmin/clients`. A bare array, newest account first, uncapped and unfiltered. */
export interface ClientRow {
  id: number;
  name: string;
  email: string;
  is_superadmin: boolean;
  superadmin_role: string | null;
  website: string | null;
  /** `clients.billing_country`, ISO 3166-1 alpha-2. Absent on the detail endpoint. */
  country: string | null;
  suspended_at: string | null;
  plan_name: string | null;
  plan_slug: string | null;
  /** The primary subscription's status: active | trialing | past_due | canceled | paused | expired. */
  subscription_status: string | null;
  active_subscriptions: number;
  /** Normalised to USD cents by `_plan_monthly_usd_cents`. */
  mrr_cents: number;
  bots_count: number;
  /** `SUM(credit_ledger.delta)` — the ledger is the source of truth. */
  credits_balance: number;
  created_at: string | null;
}

export interface ClientBot {
  id: number;
  bot_key: string;
  name: string | null;
  client_id: number;
  client_name: string | null;
  is_active: boolean;
  primary_color: string | null;
  created_at: string | null;
}

export interface SubscriptionSummary {
  id: number;
  client_id: number;
  plan_id: number | null;
  plan_name: string;
  status: string;
  billing_cycle: string | null;
  operator_quantity: number | null;
  payment_provider: string | null;
  current_period_start: string | null;
  current_period_end: string | null;
  trial_end: string | null;
  canceled_at: string | null;
  created_at: string | null;
}

/** `GET /superadmin/clients/{id}`. Note: it does **not** return `billing_country`. */
export interface ClientDetail {
  id: number;
  name: string;
  email: string;
  is_superadmin: boolean;
  superadmin_role: string | null;
  suspended_at: string | null;
  website: string | null;
  created_at: string | null;
  bots: ClientBot[];
  subscription: SubscriptionSummary | null;
  mrr_cents: number;
  total_sessions: number;
  total_messages: number;
  credits_balance: number;
}

export interface OperatorRow {
  id: number;
  client_id: number | null;
  client_name: string | null;
  name: string;
  email: string;
  /** owner | admin | operator */
  role: string;
  department_id: number | null;
  is_active: boolean;
  max_concurrent_chats: number | null;
  created_at: string | null;
}

export interface OAuthAccountRow {
  id: number;
  client_id: number;
  client_name: string | null;
  provider: string;
  provider_user_id: string;
  email: string | null;
  picture_url: string | null;
  created_at: string | null;
  last_login_at: string | null;
}

/** `GET /superadmin/api-keys` — an object of two arrays, never a list. Keys arrive already masked. */
export interface ApiKeyRegistry {
  clients: {
    id: number;
    name: string;
    email: string;
    /** `••••••1a2b`. The server never returns more than the last four characters. */
    api_key_masked: string;
    created_at: string | null;
  }[];
  operators: {
    id: number;
    name: string;
    client_name: string | null;
    api_key_masked: string;
    is_active: boolean;
  }[];
}

export interface PushSubscriptionRow {
  id: number;
  operator_id: number | null;
  client_id: number | null;
  /** Host plus the last twelve characters. The path carries a per-device secret. */
  endpoint_masked: string;
  user_agent: string | null;
  created_at: string | null;
  last_used_at: string | null;
}

export interface NotificationRow {
  id: number;
  client_id: number | null;
  operator_id: number | null;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  is_read: boolean;
  read_at: string | null;
  created_at: string | null;
}

/** `POST /superadmin/clients/{id}/impersonate`. `token` is a live credential — never render it. */
export interface ImpersonationGrant {
  token: string;
  token_id: number;
  expires_at: string;
  /** `${APP_URL}/?impersonation=<raw>`. Carries the credential; open it, never display it. */
  redirect_url: string;
}

export interface CreditGrantResult {
  balance: number;
  entry_id: number;
}

export interface RotateKeyResult {
  ok: boolean;
  api_key_masked: string;
}

/** The status vocabulary `superadmin_routes.py` accepts and `Subscription.status` uses. */
export const SUBSCRIPTION_TONES: Record<string, 'success' | 'warning' | 'danger' | 'neutral'> = {
  active: 'success',
  trialing: 'success',
  past_due: 'danger',
  canceled: 'neutral',
  paused: 'warning',
  expired: 'neutral',
};
