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

  it('keeps the card to its four-bullet budget when the entitlement is added', () => {
    renderCards([UNLIMITED]);
    expect(bulletsFor('Enterprise')).toHaveLength(4);
  });
});
