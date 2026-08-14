/**
 * Pure billing/plan math - ported verbatim from the legacy
 * the pre-2.0 plan modal so the redesigned (new design-system)
 * checkout surface charges EXACTLY what the old one did. Presentation is
 * rebuilt in the DS; this money logic is preserved unchanged and typed.
 *
 * Prices are stored in minor units (paise for INR, cents for USD). All display
 * currency routing goes through `toDisplayPrice`.
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

/** Slug → tier-card metadata (icon/accent chosen in the view; text lives here). */
export const TIER_META: Record<string, { accent: 'accent' | 'neutral'; description: string }> = {
  free: { accent: 'neutral', description: 'Start exploring AI-powered chat' },
  starter: { accent: 'accent', description: 'For growing teams with live chat needs' },
  standard: { accent: 'accent', description: 'Full AI + BANT sales intelligence' },
};

export const MOST_POPULAR_SLUG = 'standard';

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
export function toDisplayPrice(
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

/** Resolve the display price components for the focused price block. */
export function resolveDisplayCents(
  plan: PlanRow,
  billingCycle: BillingCycle,
  geo: Geo | null,
): { cents: number; symbol: string; hasMonthlyCents: boolean; hasAnnualCents: boolean } {
  const displayCurrency = (geo?.display_currency || plan.currency || 'INR').toUpperCase();
  const usdAvailable = displayCurrency === 'USD' && plan.monthly_price_usd_cents != null;
  const planCents = usdAvailable
    ? billingCycle === 'annual'
      ? plan.annual_price_usd_cents ?? 0
      : plan.monthly_price_usd_cents ?? 0
    : billingCycle === 'annual'
      ? plan.annual_price_cents
      : plan.monthly_price_cents;
  const { cents, symbol } = usdAvailable
    ? { cents: Number(planCents) || 0, symbol: '$' }
    : toDisplayPrice(planCents, plan.currency || 'INR', geo);
  return {
    cents,
    symbol,
    hasMonthlyCents: usdAvailable
      ? (plan.monthly_price_usd_cents ?? 0) > 0
      : (plan.monthly_price_cents ?? 0) > 0,
    hasAnnualCents: usdAvailable
      ? (plan.annual_price_usd_cents ?? 0) > 0
      : (plan.annual_price_cents ?? 0) > 0,
  };
}

interface TrialArgs {
  plan: PlanRow;
  isCurrent: boolean;
  currentPlanSlug: string | null;
  currentSubscriptionStatus: string | null;
}

/**
 * Trial-eligibility predicate. The only state that locks the trial path is
 * "active on a paid plan". Free-tier and trialing customers can start a trial
 * of a different paid plan; the backend enforces lifetime one-trial-per-plan.
 */
export function canStartTrial({
  plan,
  isCurrent,
  currentPlanSlug,
  currentSubscriptionStatus,
}: TrialArgs): boolean {
  if (isCurrent) return false;
  const trialDays = Number(plan.trial_days || 0);
  if (trialDays <= 0) return false;
  const onPaidPlan = Boolean(currentPlanSlug && currentPlanSlug !== 'free');
  return !(currentSubscriptionStatus === 'active' && onPaidPlan);
}

export type CtaKind =
  | 'auto'
  | 'paid'
  | 'trial'
  | 'current'
  | 'noop'
  | 'downgrade_free';

export interface Cta {
  kind: CtaKind;
  variant: 'primary' | 'secondary';
  label: string;
  note: string;
}

interface CtaArgs {
  plan: PlanRow;
  isCurrent: boolean;
  currentPlanSlug: string | null;
  currentSubscriptionStatus: string | null;
  hasActiveSubscription: boolean;
  isUpgradeFromPaid: boolean;
  isDowngradeFromPaid: boolean;
}

/** Build the CTA list for the focused plan (may return two: trial + paid). */
export function ctasFor({
  plan,
  isCurrent,
  currentPlanSlug,
  currentSubscriptionStatus,
  hasActiveSubscription,
  isUpgradeFromPaid,
  isDowngradeFromPaid,
}: CtaArgs): Cta[] {
  if (isCurrent) {
    if (currentSubscriptionStatus === 'trialing' || currentSubscriptionStatus === 'trial_expired') {
      const noteByStatus: Record<string, string> = {
        trialing:
          'Authorise your card or UPI now to keep ' +
          `${plan.name} once the trial ends. We won't charge you until the trial is over.`,
        trial_expired:
          `Restore your ${plan.name} plan and bring your AI Chatbot back live. A secure ` +
          'Razorpay checkout will open to authorise your payment method.',
      };
      return [
        {
          kind: 'paid',
          variant: 'primary',
          label: `Upgrade to ${plan.name}`,
          note: noteByStatus[currentSubscriptionStatus],
        },
      ];
    }
    return [
      {
        kind: 'current',
        variant: 'primary',
        label: 'Current plan',
        note: 'You’re on this plan. To change billing cycle or cancel, use the controls on the Billing overview.',
      },
    ];
  }
  if (plan.slug === 'free') {
    if (hasActiveSubscription) {
      return [
        {
          kind: 'downgrade_free',
          variant: 'primary',
          label: 'Downgrade to Free',
          note: 'Your current subscription will end at the close of the current billing period. Existing top-up credits stay intact.',
        },
      ];
    }
    return [
      {
        kind: 'noop',
        variant: 'primary',
        label: 'You’re on Free',
        note: 'Free tier is your default - no action required.',
      },
    ];
  }

  let paidLabel: string;
  let paidNote: string;
  if (isDowngradeFromPaid) {
    paidLabel = `Downgrade to ${plan.name}`;
    paidNote =
      'You’ll keep your current plan until the end of this billing cycle, then switch to ' +
      `${plan.name}. We’ll email you the day before the change.`;
  } else if (isUpgradeFromPaid) {
    paidLabel = `Upgrade to ${plan.name}`;
    paidNote = `A secure Razorpay checkout will open. We credit your unused ${currentPlanSlug ?? 'current plan'} time back as bonus credits the moment the new mandate activates.`;
  } else if (hasActiveSubscription) {
    paidLabel = `Upgrade to ${plan.name}`;
    paidNote =
      'A secure Razorpay checkout will open to authorise your card or UPI. The new plan kicks in the moment the first payment clears.';
  } else {
    paidLabel = `Subscribe to ${plan.name}`;
    paidNote =
      'A secure checkout will open to authorise your card or UPI. The new plan kicks in the moment the first payment clears.';
  }
  const paid: Cta = { kind: 'paid', variant: 'primary', label: paidLabel, note: paidNote };

  if (canStartTrial({ plan, isCurrent, currentPlanSlug, currentSubscriptionStatus })) {
    const isSwap = currentSubscriptionStatus === 'trialing';
    const trialDays = Number(plan.trial_days || 7);
    const trial: Cta = {
      kind: 'trial',
      variant: 'primary',
      label: `Start your ${trialDays}-day trial`,
      note: isSwap
        ? `Switches your current trial to ${plan.name}. Your trial of ${currentPlanSlug ?? 'the previous plan'} ends immediately; the new ${trialDays} days start now. No card required.`
        : `${trialDays}-day free trial, no card required. Your AI Chatbot goes live with the plan’s full credit allowance from day one.`,
    };
    return [trial, { ...paid, variant: 'secondary' }];
  }

  return [paid];
}
