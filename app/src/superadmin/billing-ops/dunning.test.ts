import { describe, expect, it } from 'vitest';
import {
  atRiskByCurrency,
  byUrgency,
  cadenceSummary,
  sortByUrgency,
  urgencyLabel,
  urgencyTone,
} from './dunning';
import type { DunningItem } from './types';

function item(overrides: Partial<DunningItem> = {}): DunningItem {
  return {
    subscription_id: 1,
    client_id: 10,
    client_email: 'ops@northwind.test',
    plan_name: 'Standard',
    billing_cycle: 'monthly',
    past_due_since: '2026-08-14T00:00:00Z',
    days_elapsed: 5,
    days_left: 2,
    emails_sent: [],
    cycle_at_risk_minor: 149_900,
    currency: 'INR',
    ...overrides,
  };
}

describe('dunning is ordered by urgency, not by id', () => {
  it('puts the least grace remaining first', () => {
    const rows = sortByUrgency([
      item({ subscription_id: 1, days_left: 6 }),
      item({ subscription_id: 2, days_left: 0 }),
      item({ subscription_id: 3, days_left: 3 }),
    ]);
    expect(rows.map((row) => row.subscription_id)).toEqual([2, 3, 1]);
  });

  it('sorts a row with no recorded grace to the end, not to the top', () => {
    // It cannot be scheduled, and an unschedulable row at the head of a
    // save-call queue costs the operator their first minute every time.
    const rows = sortByUrgency([
      item({ subscription_id: 1, days_left: null }),
      item({ subscription_id: 2, days_left: 4 }),
    ]);
    expect(rows.map((row) => row.subscription_id)).toEqual([2, 1]);
  });

  it('breaks a tie on the larger amount at risk', () => {
    const rows = sortByUrgency([
      item({ subscription_id: 1, days_left: 2, cycle_at_risk_minor: 10_000 }),
      item({ subscription_id: 2, days_left: 2, cycle_at_risk_minor: 99_000 }),
    ]);
    expect(rows.map((row) => row.subscription_id)).toEqual([2, 1]);
  });

  it('does not mutate the array it is given', () => {
    const rows = [item({ subscription_id: 1, days_left: 9 }), item({ subscription_id: 2, days_left: 1 })];
    sortByUrgency(rows);
    expect(rows.map((row) => row.subscription_id)).toEqual([1, 2]);
  });

  it('is a stable comparator for equal rows', () => {
    expect(byUrgency(item(), item())).toBe(0);
  });
});

describe('urgency tone and label', () => {
  it('treats two days or less as danger, because tomorrow is too late', () => {
    expect(urgencyTone(0)).toBe('danger');
    expect(urgencyTone(2)).toBe('danger');
    expect(urgencyTone(3)).toBe('warning');
    expect(urgencyTone(5)).toBe('warning');
    expect(urgencyTone(6)).toBe('neutral');
    expect(urgencyTone(null)).toBe('neutral');
  });

  it('always carries a word alongside the colour', () => {
    expect(urgencyLabel(0)).toBe('Grace spent');
    expect(urgencyLabel(1)).toBe('1 day left');
    expect(urgencyLabel(4)).toBe('4 days left');
    expect(urgencyLabel(null)).toBe('Grace unknown');
  });
});

describe('dunning cadence', () => {
  it('distinguishes a customer who has been warned from one who has not', () => {
    expect(cadenceSummary([])).toBe('No dunning email sent yet');
    expect(cadenceSummary(['day_1'])).toBe('1 email sent (day_1)');
    expect(cadenceSummary(['day_1', 'day_3'])).toBe('2 emails sent (day_1, day_3)');
  });
});

/**
 * The server's own `at_risk_by_currency` sums minor units across currencies, so
 * on a platform with both INR and USD plans it adds paise to cents and reports
 * a number that is not an amount of anything. The console never prints it.
 */
describe('amount at risk', () => {
  it('totals per currency rather than adding paise to cents', () => {
    const totals = atRiskByCurrency([
      item({ currency: 'INR', cycle_at_risk_minor: 100_000 }),
      item({ currency: 'INR', cycle_at_risk_minor: 49_900 }),
      item({ currency: 'USD', cycle_at_risk_minor: 2_900 }),
    ]);
    expect(totals).toEqual([
      { currency: 'INR', minor: 149_900 },
      { currency: 'USD', minor: 2_900 },
    ]);
  });

  it('defaults a missing currency to INR, as the handler does', () => {
    expect(atRiskByCurrency([item({ currency: '' })])).toEqual([{ currency: 'INR', minor: 149_900 }]);
  });

  it('returns nothing when nothing is failing', () => {
    expect(atRiskByCurrency([])).toEqual([]);
  });
});
