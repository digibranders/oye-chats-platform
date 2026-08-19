/**
 * Shapes returned by the platform's money endpoints.
 *
 * Written from the handlers, not from guesswork. Three routers answer these
 * paths and they do not agree on an envelope, a cap or a filter set, so each
 * type below records the handler it came from and every field name is the one
 * that router actually serialises.
 */

/* ------------------------------------------------------- /superadmin/revenue */

export type SubscriptionStatus =
  | 'active'
  | 'trialing'
  | 'past_due'
  | 'canceled'
  | 'paused'
  | 'expired';

/**
 * `superadmin_plan_routes.get_revenue_metrics`.
 *
 * Every figure is **USD cents**, normalised server-side by `_to_usd_cents`:
 * amounts stored in INR are divided by a fixed internal display rate, not by a
 * market rate on the day. `currency` is the server saying so, and it is echoed
 * on screen rather than assumed.
 */
export interface RevenueMetrics {
  currency: string;
  mrr_cents: number;
  arr_cents: number;
  total_revenue_cents: number;
  subscription_counts: Record<SubscriptionStatus, number>;
  total_paying_customers: number;
}

/** `superadmin_ops_routes.revenue_cohorts` — a bare array, one row per signup month. */
export interface RevenueCohort {
  cohort: string;
  signups: number;
  retained: number;
  /** USD cents, normalised the same way as `RevenueMetrics`. */
  ltv_cents: number;
}

/* ------------------------------------------------- /superadmin/subscriptions */

/**
 * `superadmin_plan_routes.list_subscriptions` — a bare array, **capped at 200**,
 * newest first. It accepts `status` and `plan_id` and nothing else: there is no
 * `page`, no `search` and no total, so the console must not offer them.
 */
export interface SubscriptionRow {
  id: number;
  client_id: number;
  client_name: string;
  client_email: string | null;
  plan_id: number;
  plan_name: string;
  status: SubscriptionStatus | string;
  billing_cycle: string | null;
  operator_quantity: number | null;
  payment_provider: string | null;
  current_period_start: string | null;
  current_period_end: string | null;
  trial_end: string | null;
  canceled_at: string | null;
  created_at: string | null;
}

/** The body `PUT /superadmin/subscriptions/{id}` accepts. Every field optional. */
export interface SubscriptionOverride {
  plan_id?: number;
  status?: string;
  operator_quantity?: number;
  billing_cycle?: 'monthly' | 'annual';
  extend_trial_days?: number;
}

/* ------------------------------------------------------ /superadmin/invoices */

/**
 * `superadmin_routes_v2.list_all_invoices` — the only genuinely paginated list
 * in this section: `{total, page, limit, items}`, with `page`, `limit`,
 * `invoice_type`, `client_id`, `search` and `include_legacy`.
 *
 * `amount_cents` is in **the document's own currency**, untouched. Nothing
 * normalises it, so it must never be rendered beside a USD figure without its
 * `currency` alongside.
 */
export interface InvoiceRow {
  id: number;
  client_id: number;
  client_name: string | null;
  invoice_number: string | null;
  invoice_type: string | null;
  status: string | null;
  amount_cents: number | null;
  currency: string | null;
  taxable_value_minor: number | null;
  total_tax_minor: number | null;
  supply_kind: string | null;
  is_export: boolean | null;
  pdf_url: string | null;
  credit_note_of_id: number | null;
  issued_at: string | null;
  created_at: string | null;
}

/** `superadmin_routes_v2.invoice_detail` — the row plus its statutory fields. */
export interface InvoiceDetail extends InvoiceRow {
  razorpay_payment_id: string | null;
  razorpay_invoice_id: string | null;
  tax_rate_bps: number | null;
  cgst_minor: number | null;
  sgst_minor: number | null;
  igst_minor: number | null;
  hsn_sac: string | null;
  place_of_supply: string | null;
  seller_snapshot: Record<string, unknown> | null;
  buyer_snapshot: Record<string, unknown> | null;
  line_items: unknown;
  description: string | null;
  period_start: string | null;
  period_end: string | null;
  invoice_url: string | null;
}

/* ------------------------------------------------- /superadmin/usage-records */

/**
 * `superadmin_ops_routes.list_usage_records` — bare array, **capped at 500**,
 * newest period first, filterable by `client_id` only.
 *
 * Limits are the client's *live* plan limits, not the frozen ones on the record;
 * `-1` is the UNLIMITED sentinel and is never a number on screen.
 * `overage_amount_cents` goes through `_to_usd_cents(x, None)`, which is a
 * pass-through — it is already USD cents and no conversion happened.
 */
export interface UsageRecordRow {
  id: number;
  client_id: number;
  client_name: string | null;
  plan_id: number | null;
  plan_name: string | null;
  period_start: string | null;
  period_end: string | null;
  ai_messages_used: number;
  ai_messages_limit: number;
  live_chat_messages_used: number;
  live_chat_messages_limit: number;
  url_scans_used: number;
  url_scans_limit: number;
  storage_used_mb: number;
  storage_limit_mb: number;
  bots_count: number;
  operators_count: number;
  overage_messages: number;
  overage_amount_cents: number;
}

/* ------------------------------------------------ /superadmin/credits/ledger */

/**
 * `superadmin_routes_v2.credits_ledger` — bare array, **capped at 500**,
 * newest first, filterable by `client_id`.
 *
 * `balance_after` is computed by walking the returned window forward from zero,
 * so it is a running total *within this page of history*, not the account's
 * balance. Rendering it as "balance" would be wrong on every account with more
 * than 500 ledger rows, so the column says what it is.
 */
export interface CreditLedgerRow {
  id: number;
  client_id: number;
  delta: number;
  balance_after: number;
  reason: string | null;
  grant_id: number | null;
  expires_at: string | null;
  created_at: string;
}

/* ----------------------------------------------- /superadmin/payment-methods */

/** `superadmin_ops_routes.list_payment_methods` — bare array, capped at 500. */
export interface PaymentMethodRow {
  id: number;
  client_id: number;
  client_name: string | null;
  provider: string | null;
  type: string | null;
  last4: string | null;
  network: string | null;
  issuer: string | null;
  /** Masked server-side: a VPA is routinely a phone number or a person's name. */
  upi_handle: string | null;
  is_default: boolean;
  synced_at: string | null;
  created_at: string | null;
}

/* --------------------------------------------------------- funnels & growth */

/** `superadmin_ops_routes.conversion_funnel` — `{days, stages}`. */
export interface FunnelStage {
  label: string;
  value: number;
  /** Already a percentage of stage one, not a 0–1 fraction. */
  pct: number;
}

export interface FunnelResponse {
  days: number;
  stages: FunnelStage[];
}

/** `superadmin_routes_v2.billing_funnel` — `{days, counts, recent}`. */
export interface BillingFunnelCount {
  surface: string;
  event: string;
  count: number;
}

export interface BillingFunnelEvent {
  id: number;
  client_id: number;
  client_email: string | null;
  event: string;
  surface: string;
  meta: Record<string, unknown> | null;
  created_at: string | null;
}

export interface BillingFunnelResponse {
  days: number;
  counts: BillingFunnelCount[];
  recent: BillingFunnelEvent[];
}

/** `superadmin_ops_routes.list_referral_conversions` — bare array, capped 500. */
export interface ReferralConversionRow {
  id: number;
  client_id: number;
  client_name: string | null;
  referral_code_id: number | null;
  referral_code: string | null;
  affiliate_id: number | null;
  affiliate_name: string | null;
  commission_bps: number;
  commission_pct: number;
  customer_discount_bps: number;
  customer_discount_pct: number;
  created_at: string | null;
}

/** `superadmin_ops_routes.list_bot_growth_events` — bare array, capped 500. */
export interface BotGrowthEventRow {
  id: number;
  bot_id: number;
  bot_name: string | null;
  event_type: string;
  created_at: string | null;
}
