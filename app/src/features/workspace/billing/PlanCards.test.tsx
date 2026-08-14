import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PlanCards } from './PlanCards';
import { buildPlan, type PlanView } from '../billingModel';

/**
 * The cards sell one plan at a time, so - unlike the comparison matrix - they
 * carry an agent bullet ONLY for the unlimited tier. These tests pin both
 * halves of that asymmetry: the unlimited tier leads with it, and a `bots: 1`
 * tier spends none of its four bullets restating the platform default.
 */

const CAPPED = {
  id: 3,
  slug: 'standard',
  name: 'Standard',
  sort_order: 3,
  monthly_price_cents: 119900,
  credits_per_month: 2500,
  included_operator_seats: 2,
  limits: { bots: 1 },
  features: { live_chat: true, bant: true },
};

const UNLIMITED = {
  id: 5,
  slug: 'enterprise',
  name: 'Enterprise',
  sort_order: 5,
  monthly_price_cents: 599900,
  credits_per_month: 13000,
  included_operator_seats: -1,
  limits: { bots: -1 },
  features: { live_chat: true, bant: true, branding_removable: true },
};

function renderCards(raw: readonly Record<string, unknown>[]): void {
  const plans = raw.map((row) => buildPlan(row) as PlanView);
  render(<PlanCards plans={plans} currentSlug="free" cycle="monthly" onSelect={vi.fn()} />);
}

/** The feature bullets of one plan's card, in rendered order. */
function bulletsFor(planName: string): string[] {
  const card = screen.getByText(planName).closest('div.rounded-2xl');
  expect(card).not.toBeNull();
  return Array.from((card as HTMLElement).querySelectorAll('li')).map(
    (item) => item.textContent?.trim() ?? '',
  );
}

describe('PlanCards — agent entitlement bullet', () => {
  it('leads the unlimited tier with its unlimited-agents entitlement', () => {
    renderCards([CAPPED, UNLIMITED]);
    expect(bulletsFor('Enterprise')[0]).toBe('Unlimited AI agents');
  });

  it('spends no bullet on the single included agent of a capped tier', () => {
    renderCards([CAPPED, UNLIMITED]);
    const bullets = bulletsFor('Standard');
    expect(bullets.some((bullet) => /agent/i.test(bullet))).toBe(false);
    // The four-bullet budget still goes to what differentiates the tier.
    expect(bullets[0]).toBe('2,500 credits / month');
  });

  /**
   * The entitlement is PREPENDED above the four-bullet budget, not pushed into
   * it. Asserting only the length would pass just as happily with "BANT lead
   * qualification" - or "credits / month" - silently truncated off the end,
   * which is exactly the regression this pins: Enterprise carries `live_chat`,
   * `bant` AND `branding_removable`, so it already fills the budget, and a
   * fifth candidate competing inside a fixed four dropped BANT - leaving the
   * top tier advertising strictly less than Standard, which sells BANT at a
   * fifth of the price.
   */
  it('adds the entitlement above the budget without displacing a graded bullet', () => {
    renderCards([CAPPED, UNLIMITED]);
    expect(bulletsFor('Enterprise')).toEqual([
      'Unlimited AI agents',
      '13,000 credits / month',
      'Unlimited operator seats',
      'Live chat & handoff',
      'BANT lead qualification',
    ]);
  });

  /* The budget itself is untouched by the entitlement: a capped tier with the
     same three feature flags renders the same four graded bullets it always
     did, still dropping "Remove OyeChats branding" off the end. */
  it('leaves the four-bullet budget of a capped tier exactly as it was', () => {
    renderCards([{ ...CAPPED, features: { ...CAPPED.features, branding_removable: true } }]);
    expect(bulletsFor('Standard')).toEqual([
      '2,500 credits / month',
      '2 operator seats',
      'Live chat & handoff',
      'BANT lead qualification',
    ]);
  });
});
