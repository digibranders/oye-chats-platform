/**
 * Shapes returned by the catalogue endpoints.
 *
 * Written against the handlers, not against hope: every field below is one this
 * console has seen a route actually serialise. `GET /superadmin/plans`
 * (superadmin_plan_routes.py) returns a bare array of exactly these keys — note
 * that it omits both USD gateway ids, which is why the editor can show the INR
 * pair and not the other two.
 */

/** JSONB blobs are open-ended by design; the plan editor types what it knows. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface Plan {
  id: number;
  name: string;
  slug: string;
  description: string | null;
  pricing_model: string;
  currency: string;
  /** INR paise. */
  monthly_price_cents: number;
  annual_price_cents: number;
  /** US cents. Null on legacy rows created before the dual rail. */
  monthly_price_usd_cents: number | null;
  annual_price_usd_cents: number | null;
  /** Derived server-side from the two INR prices. Never stored from a write. */
  annual_discount_percent: number;
  trial_days: number;
  limits: Record<string, JsonValue> | null;
  features: Record<string, JsonValue> | null;
  marketing: Record<string, JsonValue> | null;
  overage_rate_cents: number;
  credits_per_month: number;
  /** `-1` means unlimited. Never render it as a number. */
  included_operator_seats: number;
  extra_seat_price_cents: number;
  extra_seat_price_usd_cents: number | null;
  is_active: boolean;
  is_default: boolean;
  sort_order: number;
  razorpay_plan_id_monthly: string | null;
  razorpay_plan_id_annual: string | null;
  /** Active, trialing or past_due subscriptions sitting on this plan right now. */
  active_subscriptions: number;
  created_at: string | null;
  updated_at: string | null;
}

/** What a plan write answers with. `warnings` is advisory, never a failure. */
export interface PlanWriteResult {
  message?: string;
  plan_id?: number;
  warnings?: string[];
}

export interface PricingConfigRow {
  key: string;
  value: JsonValue;
  updated_at: string | null;
}

export interface PricingContent {
  faq: JsonValue[];
  feature_matrix: JsonValue[];
  topup_packs: JsonValue[];
  credit_costs: JsonValue[];
}

export interface Coupon {
  id: number;
  code: string;
  percent_off: number | null;
  amount_off_cents: number | null;
  max_redemptions: number | null;
  redemptions: number;
  expires_at: string | null;
  applies_to_plan_ids: number[] | null;
  is_active: boolean;
  created_at: string;
}

export interface PromotionStats {
  subscriptions_created: number;
  by_status: Record<string, number>;
  converted: number;
  in_free_period: number;
}

export interface Promotion {
  id: number;
  code: string | null;
  name: string;
  is_active: boolean;
  starts_at: string | null;
  ends_at: string | null;
  free_cycles: number;
  eligible_plan_ids: number[] | null;
  max_redemptions: number | null;
  /** The atomic checkout counter; leads `stats.subscriptions_created`. */
  slots_claimed: number;
  created_at: string | null;
  updated_at: string | null;
  stats?: PromotionStats;
}

export interface PromotionRedemption {
  subscription_id: number;
  status: string;
  client_id: number;
  client_name: string | null;
  client_email: string | null;
  bot_id: number | null;
  bot_name: string | null;
  plan_name: string | null;
  promo_free_until: string | null;
  in_free_period: boolean;
  redeemed_at: string | null;
}

export interface PromotionRedemptionsResponse {
  promotion: Promotion;
  redemptions: PromotionRedemption[];
}
