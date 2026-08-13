import { describe, expect, it } from 'vitest';
import { buildPlan, buildSubscription, formatSeatAllowance, getRenewalDisplay } from './billingModel';

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

describe('buildPlan', () => {
  it('passes the unlimited seat sentinel through instead of zeroing it', () => {
    const plan = buildPlan({ slug: 'enterprise', name: 'Enterprise', included_operator_seats: -1 });
    expect(plan?.includedSeats).toBe(-1);
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
