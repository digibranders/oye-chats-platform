import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PlanMatrix } from './PlanMatrix';
import { buildPlan, type PlanView } from '../billingModel';

/**
 * The "AI agents included" row is the only row on which the top tier differs
 * from every other, so it is the row a buyer comparing tiers is reading the
 * table for. These tests pin BOTH of its states against the seeded catalogue:
 * the four `bots: 1` plans and the `bots: -1` (UNLIMITED) one.
 */

const SEEDED: readonly Record<string, unknown>[] = [
  { id: 1, slug: 'free', name: 'Free', sort_order: 1, credits_per_month: 200, limits: { bots: 1 } },
  {
    id: 2,
    slug: 'starter',
    name: 'Starter',
    sort_order: 2,
    monthly_price_cents: 59900,
    credits_per_month: 1000,
    limits: { bots: 1 },
  },
  {
    id: 3,
    slug: 'standard',
    name: 'Standard',
    sort_order: 3,
    monthly_price_cents: 119900,
    credits_per_month: 2500,
    limits: { bots: 1 },
  },
  {
    id: 4,
    slug: 'professional',
    name: 'Professional',
    sort_order: 4,
    monthly_price_cents: 299900,
    credits_per_month: 10000,
    limits: { bots: 1 },
  },
  {
    id: 5,
    slug: 'enterprise',
    name: 'Enterprise',
    sort_order: 5,
    monthly_price_cents: 599900,
    credits_per_month: 10000,
    limits: { bots: -1 },
  },
];

function renderMatrix(raw: readonly Record<string, unknown>[] = SEEDED): void {
  const plans = raw.map((row) => buildPlan(row) as PlanView);
  render(
    <PlanMatrix
      plans={plans}
      currentSlug="free"
      cycle="monthly"
      onCycleChange={vi.fn()}
      onSelect={vi.fn()}
    />,
  );
}

/** The rendered cell values of one labelled row, in column (plan) order. */
function rowValues(label: string): string[] {
  const header = screen.getByRole('rowheader', { name: label });
  const row = header.closest('tr');
  expect(row).not.toBeNull();
  return Array.from((row as HTMLTableRowElement).querySelectorAll('td')).map(
    (cell) => cell.textContent?.trim() ?? '',
  );
}

describe('PlanMatrix — AI agents included row', () => {
  it('renders the unlimited sentinel as "Unlimited", never as a count of -1', () => {
    renderMatrix();
    expect(rowValues('AI agents included (add more anytime)').at(-1)).toBe('Unlimited');
  });

  it('renders a single included agent as "1" on every capped tier', () => {
    renderMatrix();
    // Four capped tiers then the unlimited one - the whole point of the row is
    // that "1" is only informative next to "Unlimited".
    expect(rowValues('AI agents included (add more anytime)')).toEqual(['1', '1', '1', '1', 'Unlimited']);
  });

  it('reads the same string quota the backend does ("-1" from JSONB counts)', () => {
    // `Plan.limits` is schema-less JSONB, so a hand-provisioned tier can store
    // the quota as a string; the server reads it through `int(...)`.
    renderMatrix([{ id: 9, slug: 'agency', name: 'Agency', sort_order: 1, limits: { bots: '-1' } }]);
    expect(rowValues('AI agents included (add more anytime)')).toEqual(['Unlimited']);
  });

  it('claims nothing for a plan row that declares no agent quota', () => {
    // `_plan_bots_limit_allows` logs and refuses to widen for such a row, so the
    // matrix must not print a number the backend would not honour.
    renderMatrix([{ id: 9, slug: 'bespoke', name: 'Bespoke', sort_order: 1, limits: { credits: 5000 } }]);
    expect(rowValues('AI agents included (add more anytime)')).toEqual(['-']);
  });

  /**
   * The row reads `1 / 1 / 1 / 1 / Unlimited`, which on its own says that more
   * than one agent requires the top tier. It does not: extra agents are sold
   * their own subscription via `POST /bots/checkout` on any plan. The label is
   * the only place that can say so - the cells stay bare values by convention -
   * so it is pinned, not left to a reader who already knows the caveat.
   */
  it('labels the row so it admits extra agents are purchasable', () => {
    renderMatrix();
    const label = screen
      .getAllByRole('rowheader')
      .map((header) => header.textContent?.trim() ?? '')
      .find((text) => /AI agents/i.test(text));
    expect(label).toBe('AI agents included (add more anytime)');
  });

  it('leads the Usage group, above credits', () => {
    renderMatrix();
    const labels = screen
      .getAllByRole('rowheader')
      .map((header) => header.textContent?.trim() ?? '');
    expect(labels.indexOf('AI agents included (add more anytime)')).toBe(0);
    expect(labels.indexOf('AI agents included (add more anytime)')).toBeLessThan(labels.indexOf('Credits / month'));
  });
});
