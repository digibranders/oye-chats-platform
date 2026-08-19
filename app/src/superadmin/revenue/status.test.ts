import { describe, expect, it } from 'vitest';
import { SUBSCRIPTION_STATUSES, isPaying, subscriptionLabel, subscriptionTone } from './status';

describe('subscription status', () => {
  it('covers exactly the six statuses the server accepts', () => {
    // `update_subscription` validates against this set and answers 400 with it.
    expect([...SUBSCRIPTION_STATUSES]).toEqual([
      'active',
      'trialing',
      'past_due',
      'canceled',
      'paused',
      'expired',
    ]);
  });

  it('does not paint a trial green', () => {
    // A trial is revenue that has not happened; a board of green trials reads
    // as a board of customers.
    expect(subscriptionTone('active')).toBe('success');
    expect(subscriptionTone('trialing')).toBe('warning');
    expect(subscriptionTone('past_due')).toBe('danger');
    expect(subscriptionTone('canceled')).toBe('neutral');
  });

  it('carries a word for every tone, so colour is never the only signal', () => {
    for (const status of SUBSCRIPTION_STATUSES) {
      expect(subscriptionLabel(status)).not.toBe('');
    }
    expect(subscriptionLabel('past_due')).toBe('Past due');
  });

  it('shows an unmapped status verbatim rather than hiding it', () => {
    expect(subscriptionLabel('halted_by_gateway')).toBe('halted_by_gateway');
    expect(subscriptionTone('halted_by_gateway')).toBe('neutral');
    expect(subscriptionLabel(null)).toBe('Unknown');
    expect(subscriptionTone(undefined)).toBe('neutral');
  });

  it('counts past due as still on the books', () => {
    expect(isPaying('active')).toBe(true);
    expect(isPaying('past_due')).toBe(true);
    expect(isPaying('trialing')).toBe(false);
    expect(isPaying('canceled')).toBe(false);
    expect(isPaying(null)).toBe(false);
  });
});
