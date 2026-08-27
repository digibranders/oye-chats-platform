import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { GRADED_BULLET_BUDGET, PlanCards } from './PlanCards';
import { buildPlan, type PlanView } from '../billingModel';

/**
 * The cards sell one plan at a time, so - unlike the comparison matrix - they
 * carry an agent bullet ONLY for the unlimited tier. These tests pin both
 * halves of that asymmetry: the unlimited tier leads with it, and a `bots: 1`
 * tier spends none of its four bullets restating the platform default.
 *
 * They also pin the two rules the bullet list is built on:
 *
 * - The graded budget is capped at {@link GRADED_BULLET_BUDGET}, and the
 *   unlimited-agents headline is PREPENDED above that cap rather than competing
 *   inside it. Asserting only a length would pass just as happily with a real
 *   entitlement silently truncated off the end, which is the regression this
 *   exists for: a fifth candidate competing inside a fixed four once dropped
 *   BANT from Enterprise, leaving the top tier advertising strictly less than
 *   Standard, which sells BANT at a fifth of the price.
 * - Branding removal is never a bullet. It is a paid add-on bought on top of
 *   any paid plan, so no plan may advertise it - including a hand-provisioned
 *   plan row still carrying a stale `branding_removable` flag.
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
  credits_per_month: 10000,
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

describe('PlanCards. Agent entitlement bullet', () => {
  it('leads the unlimited tier with its unlimited-agents entitlement', () => {
    renderCards([CAPPED, UNLIMITED]);
    expect(bulletsFor('Enterprise')[0]).toBe('Unlimited AI chatbots');
  });

  it('spends no bullet on the single included agent of a capped tier', () => {
    renderCards([CAPPED, UNLIMITED]);
    const bullets = bulletsFor('Standard');
    expect(bullets.some((bullet) => /agent/i.test(bullet))).toBe(false);
    // The four-bullet budget still goes to what differentiates the tier.
    expect(bullets[0]).toBe('2,500 credits / month');
  });

  /**
   * The entitlement is PREPENDED above the graded budget, not pushed into it:
   * every graded bullet the tier earned still renders, with the headline on
   * top, so the list is exactly one longer than the budget it may spend.
   */
  it('adds the entitlement above the budget without displacing a graded bullet', () => {
    renderCards([CAPPED, UNLIMITED]);
    const bullets = bulletsFor('Enterprise');
    expect(bullets).toEqual([
      'Unlimited AI chatbots',
      '10,000 credits / month',
      'Unlimited operator seats',
      'Live chat & handoff',
      'BANT lead qualification',
    ]);
    expect(bullets.slice(1).length).toBeLessThanOrEqual(GRADED_BULLET_BUDGET);
  });

  /* A capped tier gets the budget and nothing above it, so its whole list is
     bounded by the cap. This is the guard that keeps a future graded
     entitlement from quietly widening what one card claims. */
  it('never spends more than the graded budget on a capped tier', () => {
    renderCards([CAPPED]);
    const bullets = bulletsFor('Standard');
    expect(bullets).toEqual([
      '2,500 credits / month',
      '2 operator seats',
      'Live chat & handoff',
      'BANT lead qualification',
    ]);
    expect(bullets.length).toBeLessThanOrEqual(GRADED_BULLET_BUDGET);
  });
});

describe('PlanCards. Branding removal', () => {
  /**
   * Branding removal is sold as a per-subscription add-on, on top of any paid
   * plan. No plan grants it, so no card may advertise it - and a stale
   * `branding_removable` flag left on a hand-provisioned plan row must not be
   * read as if it did. That flag is the only input that could resurrect the
   * bullet, so it is the one this renders.
   */
  it('advertises no branding bullet, even on a plan row still carrying the flag', () => {
    renderCards([{ ...CAPPED, features: { ...CAPPED.features, branding_removable: true } }]);
    const bullets = bulletsFor('Standard');
    expect(bullets.some((bullet) => /branding/i.test(bullet))).toBe(false);
    // The budget it does spend is unchanged by the stale flag.
    expect(bullets).toEqual([
      '2,500 credits / month',
      '2 operator seats',
      'Live chat & handoff',
      'BANT lead qualification',
    ]);
  });

  it('advertises no branding bullet on the unlimited tier either', () => {
    renderCards([CAPPED, UNLIMITED]);
    expect(bulletsFor('Enterprise').some((bullet) => /branding/i.test(bullet))).toBe(false);
  });
});
