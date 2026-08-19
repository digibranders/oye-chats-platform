import { describe, expect, it } from 'vitest';
import {
  couponCreatePayload,
  couponDiscount,
  couponDraftFrom,
  couponPatchPayload,
  couponState,
  emptyCouponDraft,
  emptyPromotionDraft,
  promotionDraftFrom,
  promotionPayload,
  promotionState,
  promotionUsage,
  validateCouponDraft,
  validatePromotionDraft,
} from './offer-model';
import type { Coupon, Promotion } from './types';

const NOW = new Date('2026-08-19T12:00:00Z');

function coupon(overrides: Partial<Coupon> = {}): Coupon {
  return {
    id: 1,
    code: 'LAUNCH20',
    percent_off: 20,
    amount_off_cents: null,
    max_redemptions: 100,
    redemptions: 3,
    expires_at: '2026-12-01T00:00:00Z',
    applies_to_plan_ids: null,
    is_active: true,
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function promotion(overrides: Partial<Promotion> = {}): Promotion {
  return {
    id: 7,
    code: 'THREEFREE',
    name: 'Three months free',
    is_active: true,
    starts_at: '2026-08-01T00:00:00Z',
    ends_at: '2026-09-01T00:00:00Z',
    free_cycles: 3,
    eligible_plan_ids: null,
    max_redemptions: 50,
    slots_claimed: 12,
    created_at: null,
    updated_at: null,
    stats: { subscriptions_created: 9, by_status: { active: 9 }, converted: 2, in_free_period: 7 },
    ...overrides,
  };
}

describe('coupon state', () => {
  it('reports what would actually happen, not just the flag', () => {
    expect(couponState(coupon(), NOW)).toBe('active');
    expect(couponState(coupon({ is_active: false }), NOW)).toBe('inactive');
    expect(couponState(coupon({ expires_at: '2026-01-01T00:00:00Z' }), NOW)).toBe('expired');
    expect(couponState(coupon({ redemptions: 100 }), NOW)).toBe('exhausted');
  });

  it('treats a coupon with no cap and no expiry as valid indefinitely', () => {
    expect(couponState(coupon({ max_redemptions: null, expires_at: null }), NOW)).toBe('active');
  });
});

describe('coupon discount', () => {
  it('renders a percentage or an amount, and an em dash for neither', () => {
    expect(couponDiscount(coupon())).toBe('20%');
    expect(couponDiscount(coupon({ percent_off: null, amount_off_cents: 50000 }))).toMatch(/500/);
    expect(couponDiscount(coupon({ percent_off: null, amount_off_cents: null }))).toBe('—');
  });
});

describe('coupon validation', () => {
  it('accepts a straightforward percentage coupon', () => {
    expect(validateCouponDraft(emptyCouponDraft(), false)).toEqual({});
  });

  it('requires a code when creating', () => {
    expect(validateCouponDraft(emptyCouponDraft(), true).code).toBeTruthy();
  });

  it('bounds the percentage to the range the API accepts', () => {
    const draft = { ...emptyCouponDraft(), percent_off: '120' };
    expect(validateCouponDraft(draft, false).percent_off).toBeTruthy();
  });

  it('refuses a negative amount off, which would be a credit', () => {
    const draft = { ...emptyCouponDraft(), kind: 'amount' as const, amount_off_cents: '-500' };
    expect(validateCouponDraft(draft, false).amount_off_cents).toBeTruthy();
  });

  it('treats a blank redemption cap as uncapped rather than as an error', () => {
    const draft = { ...emptyCouponDraft(), max_redemptions: '' };
    expect(validateCouponDraft(draft, false).max_redemptions).toBeUndefined();
    expect(couponCreatePayload({ ...draft, code: 'X' }).max_redemptions).toBeNull();
  });

  it('refuses a cap of zero', () => {
    const draft = { ...emptyCouponDraft(), max_redemptions: '0' };
    expect(validateCouponDraft(draft, false).max_redemptions).toBeTruthy();
  });
});

describe('coupon payloads', () => {
  it('sends exactly one discount kind, clearing the other', () => {
    const payload = couponCreatePayload({ ...emptyCouponDraft(), code: 'X', percent_off: '25' });
    expect(payload.percent_off).toBe(25);
    expect(payload.amount_off_cents).toBeNull();
  });

  it('clears the old kind when switching, so the merged row still has exactly one', () => {
    const existing = coupon();
    const draft = { ...couponDraftFrom(existing), kind: 'amount' as const, amount_off_cents: '25000' };
    const payload = couponPatchPayload(draft, existing);
    expect(payload.amount_off_cents).toBe(25000);
    expect(payload.percent_off).toBeNull();
  });

  it('sends nothing when nothing moved', () => {
    const existing = coupon();
    expect(couponPatchPayload(couponDraftFrom(existing), existing)).toEqual({});
  });

  it('does not resend an expiry that only changed representation', () => {
    const existing = coupon({ expires_at: '2026-12-01T00:00:00.000Z' });
    const draft = couponDraftFrom(existing);
    expect(couponPatchPayload(draft, existing)).not.toHaveProperty('expires_at');
  });
});

describe('promotion state', () => {
  it('separates paused, scheduled, running, exhausted and closed', () => {
    expect(promotionState(promotion(), NOW)).toBe('active');
    expect(promotionState(promotion({ is_active: false }), NOW)).toBe('inactive');
    expect(promotionState(promotion({ starts_at: '2026-09-01T00:00:00Z' }), NOW)).toBe('scheduled');
    expect(promotionState(promotion({ ends_at: '2026-08-01T00:00:00Z' }), NOW)).toBe('expired');
    expect(promotionState(promotion({ slots_claimed: 50 }), NOW)).toBe('exhausted');
  });

  it('does not call a campaign running just because is_active is true', () => {
    // The exact state that burned two live test runs: active flag, closed window.
    const closed = promotion({ is_active: true, ends_at: '2026-08-01T00:00:00Z' });
    expect(promotionState(closed, NOW)).not.toBe('active');
  });
});

describe('promotion usage', () => {
  it('keeps the claimed count and the cap in one sentence', () => {
    expect(promotionUsage(promotion())).toBe('12 of 50 claimed');
    expect(promotionUsage(promotion({ max_redemptions: null }))).toBe('12 claimed · uncapped');
  });
});

describe('promotion validation', () => {
  const valid = {
    ...emptyPromotionDraft(),
    name: 'Autumn',
    starts_at: '2026-08-20T09:00',
    ends_at: '2026-09-20T09:00',
  };

  it('accepts a window that starts before it ends and ends in the future', () => {
    expect(validatePromotionDraft(valid, { isCreate: true, endsAtChanged: true, now: NOW })).toEqual({});
  });

  it('refuses a window that ends before it starts', () => {
    const draft = { ...valid, ends_at: '2026-08-19T09:00', starts_at: '2026-08-20T09:00' };
    expect(validatePromotionDraft(draft, { isCreate: true, endsAtChanged: true, now: NOW }).ends_at).toBeTruthy();
  });

  it('refuses setting an end that is already past', () => {
    const draft = { ...valid, starts_at: '2026-01-01T09:00', ends_at: '2026-02-01T09:00' };
    expect(
      validatePromotionDraft(draft, { isCreate: true, endsAtChanged: true, now: NOW }).ends_at,
    ).toMatch(/past/i);
  });

  it('still lets an already-expired campaign be renamed or paused', () => {
    const draft = { ...valid, starts_at: '2026-01-01T09:00', ends_at: '2026-02-01T09:00' };
    expect(
      validatePromotionDraft(draft, { isCreate: false, endsAtChanged: false, now: NOW }).ends_at,
    ).toBeUndefined();
  });

  it('bounds the free cycles to what the API accepts', () => {
    expect(
      validatePromotionDraft({ ...valid, free_cycles: '0' }, { isCreate: true, endsAtChanged: true, now: NOW })
        .free_cycles,
    ).toBeTruthy();
    expect(
      validatePromotionDraft({ ...valid, free_cycles: '40' }, { isCreate: true, endsAtChanged: true, now: NOW })
        .free_cycles,
    ).toBeTruthy();
  });

  it('requires a name', () => {
    expect(
      validatePromotionDraft({ ...valid, name: '' }, { isCreate: true, endsAtChanged: true, now: NOW }).name,
    ).toBeTruthy();
  });
});

describe('promotion payload', () => {
  it('sends the window in UTC and nulls an empty code and cap', () => {
    const payload = promotionPayload({
      ...emptyPromotionDraft(),
      name: 'Autumn',
      starts_at: '2026-08-20T09:00',
      ends_at: '2026-09-20T09:00',
    });
    expect(String(payload.starts_at)).toMatch(/Z$/);
    expect(payload.code).toBeNull();
    expect(payload.max_redemptions).toBeNull();
    expect(payload.eligible_plan_ids).toBeNull();
  });

  it('round-trips an existing campaign without inventing changes', () => {
    const draft = promotionDraftFrom(promotion());
    const payload = promotionPayload(draft);
    expect(payload.free_cycles).toBe(3);
    expect(payload.max_redemptions).toBe(50);
    expect(new Date(String(payload.ends_at)).toISOString()).toBe('2026-09-01T00:00:00.000Z');
  });

  it('sends a plan scope only when one was chosen', () => {
    const draft = { ...promotionDraftFrom(promotion()), eligible_plan_ids: [2, 3] };
    expect(promotionPayload(draft).eligible_plan_ids).toEqual([2, 3]);
  });
});
