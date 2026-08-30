import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TrialCard } from './TrialCard';
import type { TrialState } from '../types/domain';

/**
 * The rail's standing statement about the account.
 *
 * Three states, and the reason each exists: days when days are what will stop
 * you, credits when credits are, and neither when you have already paid, in
 * which case an Upgrade button is an insult rather than a call to action.
 */

let trial: TrialState | null = null;
let balance: number | null = null;

vi.mock('./useTrialState', async () => {
  const actual = await vi.importActual<typeof import('./useTrialState')>('./useTrialState');
  return {
    ...actual,
    useTrialState: () => trial,
    useTrialCreditBalance: () => balance,
  };
});

function renderCard(collapsed = false) {
  return render(
    <MemoryRouter>
      <TrialCard collapsed={collapsed} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  trial = null;
  balance = null;
});

describe('TrialCard', () => {
  it('renders nothing when the account is not on a trial', () => {
    const { container } = renderCard();
    expect(container).toBeEmptyDOMElement();
  });

  it('counts days, and offers the one action', () => {
    trial = { status: 'trialing', days_remaining: 9, credits_granted: 500 };
    balance = 480;
    renderCard();
    expect(screen.getByText(/9 days left in your trial/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /upgrade/i })).toHaveAttribute('href', '/billing');
  });

  it('counts credits instead when credits are the binding constraint', () => {
    // 40 of 500 credits with 9 of 14 days left: the credits run out first, so
    // telling this customer they have nine days is true and useless.
    trial = { status: 'trialing', days_remaining: 9, credits_granted: 500 };
    balance = 40;
    renderCard();
    expect(screen.getByText(/40 credits left in your trial/i)).toBeInTheDocument();
    expect(screen.queryByText(/9 days left/i)).toBeNull();
  });

  it('confirms a purchase instead of asking for one, and drops the CTA', () => {
    trial = {
      status: 'active',
      days_remaining: 6,
      paid_plan_starts_at: '2026-09-11T00:00:00+00:00',
      paid_plan_name: 'Standard',
    };
    renderCard();
    expect(screen.getByText(/Standard starts in 6 days/i)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /upgrade/i })).toBeNull();
  });

  it('never renders a close button, in any state', () => {
    trial = { status: 'trialing', days_remaining: 9, credits_granted: 500 };
    balance = 480;
    renderCard();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('says "day" rather than "days" on the last one', () => {
    trial = { status: 'trialing', days_remaining: 1, credits_granted: 500 };
    balance = 480;
    renderCard();
    expect(screen.getByText(/1 day left in your trial/i)).toBeInTheDocument();
  });
});

describe('TrialCard, collapsed', () => {
  it('names the plan and pluralises, like the expanded card', () => {
    // This branch said "null starts in 6 days" and "1 days left".
    trial = { status: 'active', days_remaining: 1, paid_plan_starts_at: '2026-09-11T00:00:00+00:00' };
    renderCard(true);
    const link = screen.getByTestId('trial-card');
    expect(link).toHaveAttribute('title', 'Your plan starts in 1 day');
    expect(link.getAttribute('title')).not.toContain('null');
  });

  it('counts days on the trial, in one glyph', () => {
    trial = { status: 'trialing', days_remaining: 9, credits_granted: 500 };
    balance = 480;
    renderCard(true);
    expect(screen.getByTestId('trial-card')).toHaveTextContent('9');
  });
});
