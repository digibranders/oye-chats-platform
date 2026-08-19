import { describe, expect, it } from 'vitest';
import {
  LIMIT_FIELDS,
  UNLIMITED,
  annualSavingPercent,
  canonicalSeatPrices,
  describePlanChanges,
  draftFromPlan,
  formatLimit,
  formatSeats,
  isUnlimited,
  parseIntegerField,
  planCreatePayload,
  planUpdatePayload,
  planWarnings,
  unknownKeys,
  validatePlanDraft,
  type PlanDraft,
} from './plan-model';
import type { Plan } from './types';

function plan(overrides: Partial<Plan> = {}): Plan {
  return {
    id: 3,
    name: 'Standard',
    slug: 'standard',
    description: 'The lead machine.',
    pricing_model: 'per_operator',
    currency: 'INR',
    monthly_price_cents: 119900,
    annual_price_cents: 1150800,
    monthly_price_usd_cents: 1599,
    annual_price_usd_cents: 15588,
    annual_discount_percent: 20,
    trial_days: 7,
    limits: { credits: 2500, documents: UNLIMITED, operators: 2, bots: 1 },
    features: { live_chat: true, bant: true, integrations: 'all' },
    marketing: { tagline: 'The lead machine.' },
    overage_rate_cents: 0,
    credits_per_month: 2500,
    included_operator_seats: 2,
    extra_seat_price_cents: 44900,
    extra_seat_price_usd_cents: 500,
    is_active: true,
    is_default: false,
    sort_order: 3,
    razorpay_plan_id_monthly: 'plan_month',
    razorpay_plan_id_annual: 'plan_year',
    active_subscriptions: 412,
    created_at: null,
    updated_at: null,
    ...overrides,
  };
}

describe('the unlimited sentinel', () => {
  it('never renders -1 as a number', () => {
    expect(formatLimit(UNLIMITED)).toBe('Unlimited');
    expect(formatSeats(UNLIMITED)).toBe('Unlimited');
    expect(formatLimit(-1)).not.toContain('-1');
    expect(formatSeats(-1)).not.toContain('-1');
  });

  it('distinguishes unlimited from absent and from zero', () => {
    expect(formatLimit(null)).toBe('—');
    expect(formatLimit(undefined)).toBe('—');
    expect(formatLimit(0)).toBe('0');
    expect(isUnlimited(0)).toBe(false);
    expect(isUnlimited(UNLIMITED)).toBe(true);
  });

  it('loads an unlimited limit as a switch, not as a value of -1', () => {
    const draft = draftFromPlan(plan());
    expect(draft.limits.documents).toEqual({ unlimited: true, value: '' });
    expect(draft.limits.credits).toEqual({ unlimited: false, value: '2500' });
  });

  it('loads unlimited seats as a switch too', () => {
    const draft = draftFromPlan(plan({ included_operator_seats: UNLIMITED }));
    expect(draft.seats).toEqual({ unlimited: true, value: '' });
  });

  it('writes the sentinel back out when the switch is on', () => {
    const draft = draftFromPlan(plan({ included_operator_seats: UNLIMITED }));
    const payload = planCreatePayload(draft);
    expect(payload.included_operator_seats).toBe(UNLIMITED);
    expect((payload.limits as Record<string, number>).documents).toBe(UNLIMITED);
  });

  it('describes an unlimited change in words, in the confirm', () => {
    const current = plan();
    const draft = draftFromPlan(current);
    draft.limits.credits = { unlimited: false, value: '5000' };
    draft.seats = { unlimited: true, value: '' };
    const changes = describePlanChanges(planUpdatePayload(draft, current), current);
    const seats = changes.find((change) => change.key === 'included_operator_seats');
    expect(seats?.after).toBe('Unlimited');
    expect(seats?.before).toBe('2 seats');
  });
});

describe('the derived annual saving', () => {
  it('floors rather than rounds, so a saving is never overstated', () => {
    // Professional: 12 × ₹2,999 against ₹28,188 is 21.674%.
    expect(annualSavingPercent(299900, 2818800)).toBe(21);
  });

  it('is zero for every plan with no real annual saving to quote', () => {
    expect(annualSavingPercent(0, 0)).toBe(0);
    expect(annualSavingPercent(1000, 0)).toBe(0);
    expect(annualSavingPercent(1000, 12000)).toBe(0);
    expect(annualSavingPercent(1000, 20000)).toBe(0);
    expect(annualSavingPercent(null, null)).toBe(0);
  });

  it('is never sent — the API refuses a supplied value that disagrees', () => {
    const draft = draftFromPlan(plan());
    expect(planCreatePayload(draft)).not.toHaveProperty('annual_discount_percent');
    expect(planUpdatePayload(draft, plan())).not.toHaveProperty('annual_discount_percent');
  });
});

describe('validation', () => {
  const base = () => draftFromPlan(plan());

  it('accepts the seeded catalogue unchanged', () => {
    expect(validatePlanDraft(base(), { isCreate: false })).toEqual({});
  });

  it('refuses zero included seats, which the API rejects', () => {
    const draft = base();
    draft.seats = { unlimited: false, value: '0' };
    expect(validatePlanDraft(draft, { isCreate: false }).seats).toMatch(/at least one seat|unlimited/i);
  });

  it('refuses a negative seat count that is not the sentinel', () => {
    const draft = base();
    draft.seats = { unlimited: false, value: '-2' };
    expect(validatePlanDraft(draft, { isCreate: false }).seats).toBeTruthy();
  });

  it('refuses a limit below the sentinel', () => {
    const draft = base();
    draft.limits.documents = { unlimited: false, value: '-5' };
    expect(validatePlanDraft(draft, { isCreate: false })['limits.documents']).toBeTruthy();
  });

  it('refuses unlimited on a limit where it has no meaning', () => {
    const field = LIMIT_FIELDS.find((entry) => !entry.allowsUnlimited);
    expect(field).toBeDefined();
    const draft = base();
    draft.limits[field!.key] = { unlimited: true, value: '' };
    expect(validatePlanDraft(draft, { isCreate: false })[`limits.${field!.key}`]).toBeTruthy();
  });

  it('refuses a negative price', () => {
    const draft = base();
    draft.monthly_price_cents = '-1';
    expect(validatePlanDraft(draft, { isCreate: false }).monthly_price_cents).toBeTruthy();
  });

  it('refuses a price that is not a whole number of minor units', () => {
    const draft = base();
    draft.monthly_price_cents = '599.50';
    expect(validatePlanDraft(draft, { isCreate: false }).monthly_price_cents).toBeTruthy();
  });

  it('leaves the USD rail blank without complaint', () => {
    const draft = base();
    draft.monthly_price_usd_cents = '';
    draft.annual_price_usd_cents = '';
    expect(validatePlanDraft(draft, { isCreate: false })).toEqual({});
  });

  it('checks the slug only when creating, and catches a clash first', () => {
    const draft = base();
    draft.slug = 'Standard Plan';
    expect(validatePlanDraft(draft, { isCreate: false }).slug).toBeUndefined();
    expect(validatePlanDraft(draft, { isCreate: true }).slug).toMatch(/lowercase/i);

    draft.slug = 'standard';
    expect(validatePlanDraft(draft, { isCreate: true, takenSlugs: ['standard'] }).slug).toMatch(
      /already exists/i,
    );
    expect(validatePlanDraft(draft, { isCreate: true, takenSlugs: ['free'] }).slug).toBeUndefined();
  });

  it('refuses a delisted plan that is also the default', () => {
    const draft = base();
    draft.is_active = false;
    draft.is_default = true;
    expect(validatePlanDraft(draft, { isCreate: false }).is_default).toBeTruthy();
  });

  it('requires a name', () => {
    const draft = base();
    draft.name = '   ';
    expect(validatePlanDraft(draft, { isCreate: false }).name).toBeTruthy();
  });
});

describe('parseIntegerField', () => {
  it('rejects everything that is not a whole number', () => {
    expect(parseIntegerField('')).toBeNull();
    expect(parseIntegerField('1.5')).toBeNull();
    expect(parseIntegerField('1e3')).toBeNull();
    expect(parseIntegerField('abc')).toBeNull();
    expect(parseIntegerField('12')).toBe(12);
    expect(parseIntegerField('-1')).toBe(-1);
  });
});

describe('the update payload', () => {
  it('is empty when nothing moved, so an accidental save sends nothing', () => {
    const current = plan();
    expect(planUpdatePayload(draftFromPlan(current), current)).toEqual({});
  });

  it('carries only the fields that changed', () => {
    const current = plan();
    const draft = draftFromPlan(current);
    draft.trial_days = '14';
    expect(planUpdatePayload(draft, current)).toEqual({ trial_days: 14 });
  });

  it('sends only the limit keys that changed, so the merge keeps the rest', () => {
    const current = plan();
    const draft = draftFromPlan(current);
    draft.limits.credits = { unlimited: false, value: '9000' };
    const payload = planUpdatePayload(draft, current);
    expect(payload.limits).toEqual({ credits: 9000 });
  });

  it('does not resend a price that only looks different as a string', () => {
    const current = plan();
    const draft = draftFromPlan(current);
    draft.monthly_price_cents = ' 119900 ';
    expect(planUpdatePayload(draft, current)).toEqual({});
  });

  it('always sends INR as the currency on create', () => {
    expect(planCreatePayload(draftFromPlan(plan())).currency).toBe('INR');
  });

  it('never writes the extra seat price, which the API fixes to one value', () => {
    const create = planCreatePayload(draftFromPlan(plan()));
    expect(create).not.toHaveProperty('extra_seat_price_cents');
    expect(create).not.toHaveProperty('extra_seat_price_usd_cents');
  });

  it('drops an empty badge rather than publishing a blank ribbon', () => {
    const draft = draftFromPlan(plan({ marketing: { tagline: 'x', badge: 'Most Popular' } }));
    draft.badge = '';
    const payload = planCreatePayload(draft);
    expect(payload.marketing).toEqual({ tagline: 'x' });
  });
});

describe('warnings', () => {
  it('names the e-mandate ceiling when an amount crosses it', () => {
    const current = plan();
    const draft = draftFromPlan(current);
    draft.annual_price_cents = '2818800';
    const warnings = planWarnings(draft, current);
    expect(warnings.some((warning) => /e-mandate/i.test(warning))).toBe(true);
  });

  it('warns that a listed, priced tier with no gateway id cannot be bought', () => {
    const current = plan({ razorpay_plan_id_monthly: null, razorpay_plan_id_annual: null });
    const warnings = planWarnings(draftFromPlan(current), current);
    expect(warnings.some((warning) => /Contact sales/i.test(warning))).toBe(true);
  });

  it('says nothing about checkout for a free tier', () => {
    const current = plan({
      monthly_price_cents: 0,
      annual_price_cents: 0,
      razorpay_plan_id_monthly: null,
      razorpay_plan_id_annual: null,
    });
    const warnings = planWarnings(draftFromPlan(current), current);
    expect(warnings.some((warning) => /Contact sales/i.test(warning))).toBe(false);
  });

  it('warns that a price edit mints a replacement gateway plan', () => {
    const current = plan();
    const draft = draftFromPlan(current);
    draft.monthly_price_cents = '129900';
    expect(planWarnings(draft, current).some((warning) => /immutable/i.test(warning))).toBe(true);
  });
});

describe('keys the editor does not model', () => {
  it('reports them so a save that merges is honest about what it left alone', () => {
    const stored = { credits: 1, secret_key: 5 } as Record<string, number>;
    expect(unknownKeys(stored, ['credits'])).toEqual([{ key: 'secret_key', value: 5 }]);
    expect(unknownKeys(null, ['credits'])).toEqual([]);
  });
});

describe('the canonical seat price', () => {
  it('is derived from the rows that carry it, since no endpoint serves it', () => {
    expect(canonicalSeatPrices([plan(), plan({ extra_seat_price_cents: 0, extra_seat_price_usd_cents: 0 })])).toEqual(
      { inr: 44900, usd: 500 },
    );
  });

  it('is unknown when every plan sells seats at zero, rather than guessed', () => {
    expect(
      canonicalSeatPrices([plan({ extra_seat_price_cents: 0, extra_seat_price_usd_cents: 0 })]),
    ).toEqual({ inr: null, usd: null });
  });
});

describe('describePlanChanges', () => {
  it('renders money in its own currency rather than as minor units', () => {
    const current = plan();
    const draft: PlanDraft = draftFromPlan(current);
    draft.monthly_price_cents = '129900';
    const changes = describePlanChanges(planUpdatePayload(draft, current), current);
    const price = changes.find((change) => change.key === 'monthly_price_cents');
    expect(price?.after).toMatch(/₹|1,299/);
    expect(price?.after).not.toBe('129900');
  });

  it('renders a boolean as On and Off, not as true and false', () => {
    const current = plan();
    const draft = draftFromPlan(current);
    draft.features.bant = false;
    const changes = describePlanChanges(planUpdatePayload(draft, current), current);
    const bant = changes.find((change) => change.key === 'features.bant');
    expect(bant).toEqual({ key: 'features.bant', label: 'Feature · BANT / MEDDIC qualification', before: 'On', after: 'Off' });
  });
});
