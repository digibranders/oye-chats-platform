import { describe, expect, it } from 'vitest';
import { buildSubscription, getRenewalDisplay } from './billingModel';

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
