import { describe, expect, it } from 'vitest';
import {
  buildPlan,
  buildPromotion,
  buildSubscription,
  formatSeatAllowance,
  getRenewalDisplay,
  planGrantsUnlimitedAgents,
  promotionAppliesToPlan,
  type PlanView,
} from './billingModel';

/** The seeded Enterprise row, verbatim from `api/scripts/seed_plans.py`. */
const SEEDED_ENTERPRISE = {
  id: 5,
  slug: 'enterprise',
  name: 'Enterprise',
  credits_per_month: 13000,
  monthly_price_cents: 479900,
  annual_price_cents: 4606800,
  included_operator_seats: -1,
  sort_order: 5,
  features: {
    live_chat: true,
    bant: true,
    branding_removable: true,
    webhooks: true,
    api_access: true,
    online_support: true,
    topup_allowed: true,
    auto_recrawl: true,
    integrations: 'all',
  },
  limits: { bots: -1, operators: -1 },
};

describe('formatSeatAllowance', () => {
  /* `included_operator_seats` is serialized raw, and `-1` is the UNLIMITED
     sentinel. Every seat surface routes through this so the unlimited tier
     can never print "-1 operator seats", nor be filed under "None" by a bare
     `> 0` test. */
  it('renders the unlimited sentinel as Unlimited, never as -1', () => {
    expect(formatSeatAllowance(-1)).toBe('Unlimited operator seats');
  });

  it('keeps finite counts and their pluralisation unchanged', () => {
    expect(formatSeatAllowance(1)).toBe('1 operator seat');
    expect(formatSeatAllowance(3)).toBe('3 operator seats');
    expect(formatSeatAllowance(0)).toBe('No operator seats');
  });
});

describe('planGrantsUnlimitedAgents', () => {
  /* The per-agent pickers (Create agent, and Billing while an agent is scoped)
     filter on this predicate because both per-agent money paths refuse such a
     plan server-side. It keys off the `-1` sentinel, never a slug. */
  it('is true for a plan whose bots quota is the unlimited sentinel', () => {
    const plan = buildPlan(SEEDED_ENTERPRISE);
    expect(plan && planGrantsUnlimitedAgents(plan)).toBe(true);
  });

  it('is false for a finite agent quota', () => {
    const plan = buildPlan({ id: 3, slug: 'professional', name: 'Professional', limits: { bots: 1 } });
    expect(plan && planGrantsUnlimitedAgents(plan)).toBe(false);
  });

  /* Conservative on bad data, exactly like the server: a bespoke plan row with
     no (or a non-numeric) `bots` quota is NOT unlimited and stays selectable. */
  it('is false for a plan row with no bots quota at all', () => {
    const plan = buildPlan({ id: 9, slug: 'bespoke-acme', name: 'Acme', limits: { credits: 5000 } });
    expect(plan && planGrantsUnlimitedAgents(plan)).toBe(false);
  });

  it('is false for a non-numeric bots quota', () => {
    const plan = buildPlan({ id: 9, slug: 'bespoke-acme', name: 'Acme', limits: { bots: 'unlimited' } });
    expect(plan && planGrantsUnlimitedAgents(plan)).toBe(false);
  });

  /* `limits` is JSONB with nothing enforcing its value types, and the server
     reads the quota through `int(...)` — which accepts `"-1"`. Dropping the
     string here made the picker offer a plan `POST /bots/checkout` then
     refused, so the customer chose it and hit a dead end. */
  it('is true for the unlimited sentinel stored as a string', () => {
    const plan = buildPlan({ id: 5, slug: 'enterprise', name: 'Enterprise', limits: { bots: '-1' } });
    expect(plan && planGrantsUnlimitedAgents(plan)).toBe(true);
  });

  it('is false for a finite agent quota stored as a string', () => {
    const plan = buildPlan({ id: 3, slug: 'professional', name: 'Professional', limits: { bots: '1' } });
    expect(plan && planGrantsUnlimitedAgents(plan)).toBe(false);
  });
});

describe('buildPlan limits coercion', () => {
  it('keeps a numeric-string quota as a number, so consumers never compare a string', () => {
    const plan = buildPlan({ slug: 'x', name: 'X', limits: { bots: '-1', max_crawl_pages: ' 250 ' } });
    expect(plan?.limits.bots).toBe(-1);
    expect(plan?.limits.max_crawl_pages).toBe(250);
  });

  /* Unreadable values are dropped, not defaulted to 0: an absent key reads as
     "this plan declares no such quota", which consumers already treat
     conservatively, while a 0 would read as a real quota of zero. */
  it('drops values that cannot be read as a finite number', () => {
    const plan = buildPlan({
      slug: 'x',
      name: 'X',
      limits: { bots: 'unlimited', operators: '', credits: null, seats: true, docs: [1] },
    });
    expect(plan?.limits).toEqual({});
  });
});

describe('buildPlan', () => {
  it('passes the unlimited seat sentinel through instead of zeroing it', () => {
    const plan = buildPlan({ slug: 'enterprise', name: 'Enterprise', included_operator_seats: -1 });
    expect(plan?.includedSeats).toBe(-1);
  });

  /* `isContactSales` means "bespoke tier, priced on request" - NOT "the slug
     says enterprise". The seeded Enterprise row is a real, priced, self-serve
     rung of the ladder (₹4,799/mo), so keying off the slug rendered it as
     "Custom" and dead-ended its checkout at a mailto. Only the feature flags
     decide. */
  it('does not mark the seeded Enterprise tier as contact-sales - it is priced and self-serve', () => {
    const plan = buildPlan(SEEDED_ENTERPRISE);
    expect(plan?.isContactSales).toBe(false);
    expect(plan?.isPaid).toBe(true);
    expect(plan?.monthlyPriceMinor).toBe(479900);
    expect(plan?.annualPriceMinor).toBe(4606800);
  });

  it('marks any plan carrying contact_sales as contact-sales, whatever its slug', () => {
    const plan = buildPlan({
      id: 91,
      slug: 'enterprise-acme',
      name: 'Acme',
      monthly_price_cents: 2500000,
      features: { contact_sales: true },
    });
    expect(plan?.isContactSales).toBe(true);
  });

  it('marks any plan carrying the enterprise feature flag as contact-sales, whatever its slug', () => {
    const plan = buildPlan({
      id: 92,
      slug: 'globex-custom',
      name: 'Globex',
      monthly_price_cents: 0,
      features: { enterprise: true },
    });
    expect(plan?.isContactSales).toBe(true);
  });

  /* Truthy-but-not-true must not flip the gate: these flags route money, and
     a stray string would silently dead-end a self-serve tier at a mailto. */
  it('ignores non-boolean-true flag values', () => {
    const plan = buildPlan({
      slug: 'starter',
      name: 'Starter',
      monthly_price_cents: 44900,
      features: { contact_sales: 'no', enterprise: 0 },
    });
    expect(plan?.isContactSales).toBe(false);
  });
});

describe('promotionAppliesToPlan', () => {
  const promo = buildPromotion({ active: true, id: 1, name: 'Launch', free_cycles: 3, eligible_plan_ids: null });

  /* The frontend is display-only: the authority is
     `promotion_service.resolve_active_promotion`, whose `_plan_eligible`
     covers EVERY paid plan when `eligible_plan_ids` is unset - Enterprise
     included. Excluding it here would show the full price for an offer the
     server would actually grant, and route the purchase through change-plan
     instead of the checkout path that realises the deferred free period. To
     scope an offer away from Enterprise, use `eligible_plan_ids`. */
  it('applies an unscoped promotion to the seeded Enterprise tier', () => {
    const plan = buildPlan(SEEDED_ENTERPRISE) as PlanView;
    expect(promotionAppliesToPlan(promo, plan)).toBe(true);
  });

  it('never applies to a bespoke contact-sales tier, which has no self-serve checkout', () => {
    const plan = buildPlan({
      id: 91,
      slug: 'enterprise-acme',
      name: 'Acme',
      monthly_price_cents: 2500000,
      features: { contact_sales: true },
    }) as PlanView;
    expect(promotionAppliesToPlan(promo, plan)).toBe(false);
  });

  it('honours an explicitly scoped plan list', () => {
    const scoped = buildPromotion({ active: true, id: 2, free_cycles: 3, eligible_plan_ids: [2, 3] });
    const plan = buildPlan(SEEDED_ENTERPRISE) as PlanView;
    expect(promotionAppliesToPlan(scoped, plan)).toBe(false);
  });
});

describe('buildSubscription', () => {
  it('maps promo_free_until from the API envelope', () => {
    const subscription = buildSubscription({
      status: 'active',
      billing_cycle: 'monthly',
      promo_free_until: '2026-09-06T00:00:00Z',
      current_period_end: null,
    });
    expect(subscription.promoFreeUntil).toBe('2026-09-06T00:00:00Z');
    expect(subscription.currentPeriodEnd).toBeNull();
  });

  it('defaults promoFreeUntil to null when the field is absent', () => {
    expect(buildSubscription({ status: 'active' }).promoFreeUntil).toBeNull();
  });
});

describe('getRenewalDisplay', () => {
  it('shows "Free until" the deferred first-charge date for a promo subscription with no cycle yet', () => {
    const result = getRenewalDisplay(
      { trialEnd: null, currentPeriodEnd: null, promoFreeUntil: '2026-09-06T00:00:00Z' },
      false
    );
    expect(result.caption).toBe('Free until');
    expect(result.label).toBe('6 Sept 2026');
  });

  it('prefers a real currentPeriodEnd once billing has actually started, even if promoFreeUntil lingers', () => {
    const result = getRenewalDisplay(
      { trialEnd: null, currentPeriodEnd: '2026-10-06T00:00:00Z', promoFreeUntil: '2026-09-06T00:00:00Z' },
      false
    );
    expect(result.caption).toBe('Renews');
    expect(result.label).toBe('6 Oct 2026');
  });

  it('shows "Trial ends" ahead of any promo state', () => {
    const result = getRenewalDisplay(
      { trialEnd: '2026-08-20T00:00:00Z', currentPeriodEnd: null, promoFreeUntil: '2026-09-06T00:00:00Z' },
      false
    );
    expect(result.caption).toBe('Trial ends');
    expect(result.label).toBe('20 Aug 2026');
  });

  it('falls back to "Renews -" for a plain non-promo subscription with no period end (e.g. Free plan)', () => {
    const result = getRenewalDisplay({ trialEnd: null, currentPeriodEnd: null, promoFreeUntil: null }, false);
    expect(result.caption).toBe('Renews');
    expect(result.label).toBe('-');
  });

  it('shows "Plan ends" when cancellation is pending and there is no promo in play', () => {
    const result = getRenewalDisplay(
      { trialEnd: null, currentPeriodEnd: '2026-10-06T00:00:00Z', promoFreeUntil: null },
      true
    );
    expect(result.caption).toBe('Plan ends');
    expect(result.label).toBe('6 Oct 2026');
  });

  it('handles a null subscription (not yet loaded)', () => {
    const result = getRenewalDisplay(null, false);
    expect(result.caption).toBe('Renews');
    expect(result.label).toBe('-');
  });
});
