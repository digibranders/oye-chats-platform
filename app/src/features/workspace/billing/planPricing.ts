/**
 * planPricing - the raw plan-row shape plus display-price rendering.
 *
 * This is deliberately NOT part of `billingModel.ts`. That module owns the
 * opposite boundary: it coerces loose API records into strict `PlanView`
 * view-models so the Billing page never touches a raw record, and it reads only
 * the canonical INR `*_price_cents` columns. This module works on the raw
 * `PlanRow` straight off `getSubscriptionPlans` and *does* read the
 * `*_usd_cents` columns for geo-routed display, so the two must stay apart.
 *
 * Prices are stored in minor units (paise for INR, cents for USD).
 */
import { FALLBACK_USD_TO_INR } from '../../../lib/currency';

/** A subscription plan row as returned by `getSubscriptionPlans`. */
export interface PlanRow {
  id: number;
  slug: string;
  name: string;
  description?: string | null;
  sort_order?: number;
  currency?: string | null;
  monthly_price_cents?: number | null;
  annual_price_cents?: number | null;
  monthly_price_usd_cents?: number | null;
  annual_price_usd_cents?: number | null;
  credits_per_month?: number | null;
  included_operator_seats?: number | null;
  extra_seat_price_cents?: number | null;
  extra_seat_price_usd_cents?: number | null;
  trial_days?: number | null;
  limits?: {
    max_crawl_pages?: number | null;
    max_crawl_depth?: number | null;
    /** `-1` = unlimited AI agents (the Enterprise/agency entitlement). */
    bots?: number | null;
    /** `-1` = unlimited knowledge documents. */
    documents?: number | null;
  } | null;
  features?: { live_chat?: boolean; bant?: boolean; webhooks?: boolean } | null;
}

/** Geo/currency profile from `getBillingGeo`. */
export interface Geo {
  country?: string | null;
  display_currency?: string | null;
  display_rate?: number | null;
}

export type BillingCycle = 'monthly' | 'annual';

interface DisplayPrice {
  cents: number;
  currency: string;
  symbol: string;
}

/**
 * Convert a plan-native amount (paise/INR or cents/USD) into the geo's display
 * currency. One-way INR→USD (plan rows are INR-priced today); a USD-priced plan
 * passes through unchanged.
 */
function toDisplayPrice(
  planCents: number | null | undefined,
  planCurrency: string | null | undefined,
  geo: Geo | null,
): DisplayPrice {
  const safeCents = Number(planCents) || 0;
  const native = (planCurrency || 'INR').toUpperCase();
  const display = (geo?.display_currency || native).toUpperCase();
  if (!geo || display === native) {
    return {
      cents: safeCents,
      currency: native,
      symbol: native === 'USD' ? '$' : native === 'INR' ? '₹' : `${native} `,
    };
  }
  if (native === 'INR' && display === 'USD') {
    const rate = Number(geo.display_rate) || FALLBACK_USD_TO_INR;
    const usdCents = Math.round((safeCents / 100 / rate) * 100);
    return { cents: usdCents, currency: 'USD', symbol: '$' };
  }
  return {
    cents: safeCents,
    currency: native,
    symbol: native === 'USD' ? '$' : '₹',
  };
}

/** Compact/full price label for a plan at a billing cycle in the display currency. */
export function renderPriceLabel(
  plan: PlanRow,
  billingCycle: BillingCycle,
  geo: Geo | null,
  compact = false,
): string {
  const displayCurrency = (geo?.display_currency || plan.currency || 'INR').toUpperCase();
  const usdAvailable = displayCurrency === 'USD' && plan.monthly_price_usd_cents != null;
  let cents: number;
  let sym: string;
  if (usdAvailable) {
    cents = Number(
      billingCycle === 'annual' ? plan.annual_price_usd_cents ?? 0 : plan.monthly_price_usd_cents ?? 0,
    );
    sym = '$';
  } else {
    const planCents = billingCycle === 'annual' ? plan.annual_price_cents : plan.monthly_price_cents;
    ({ cents, symbol: sym } = toDisplayPrice(planCents, plan.currency || 'INR', geo));
  }
  if (!cents) return compact ? 'Free' : `${sym}0`;
  const major = cents / 100;
  const value = `${sym}${Number.isInteger(major) ? major.toLocaleString() : major.toFixed(2)}`;
  return compact ? value : `${value} / ${billingCycle === 'annual' ? 'yr' : 'mo'}`;
}
