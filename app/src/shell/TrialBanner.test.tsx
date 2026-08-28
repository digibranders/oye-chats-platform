import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TrialBanner } from './TrialBanner';
import type { TrialState } from '../types/domain';

/**
 * The interruption, as opposed to the rail card's standing fact.
 *
 * Dismissible, because a customer who has read it once should not read it on
 * every navigation. Dismissible only up to a point, because "stop telling me"
 * is a reasonable thing to mean on day four and an unreasonable thing to be
 * held to on day thirteen.
 */

let trial: TrialState | null = null;
let clientId: number | null = 7;

vi.mock('./useTrialState', async () => {
  const actual = await vi.importActual<typeof import('./useTrialState')>('./useTrialState');
  return { ...actual, useTrialState: () => trial, useSessionClientId: () => clientId };
});

vi.mock('../i18n/useTranslation', () => ({ useTranslation: () => ({ t: () => '' }) }));

function renderBanner() {
  return render(
    <MemoryRouter>
      <TrialBanner />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  trial = null;
  clientId = 7;
  localStorage.clear();
});

describe('TrialBanner', () => {
  it('is absent when the account is not on a trial', () => {
    const { container } = renderBanner();
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the days remaining from the session payload', () => {
    trial = { status: 'trialing', days_remaining: 9 };
    renderBanner();
    expect(screen.getByText(/9 days left/i)).toBeInTheDocument();
    expect(screen.getByText(/Add a payment method to keep your chatbot running/i)).toBeInTheDocument();
  });

  it('dismisses, and stays dismissed on a later render', async () => {
    trial = { status: 'trialing', days_remaining: 9 };
    const { unmount } = renderBanner();
    await userEvent.click(screen.getByRole('button'));
    expect(screen.queryByTestId('trial-banner')).toBeNull();

    unmount();
    renderBanner();
    expect(screen.queryByTestId('trial-banner')).toBeNull();
  });

  it('keys the dismissal per account, so a shared browser leaks nothing', async () => {
    trial = { status: 'trialing', days_remaining: 9 };
    const { unmount } = renderBanner();
    await userEvent.click(screen.getByRole('button'));
    unmount();

    clientId = 8;
    renderBanner();
    expect(screen.getByTestId('trial-banner')).toBeInTheDocument();
  });

  it('comes back at three days or fewer, dismissal or not', async () => {
    trial = { status: 'trialing', days_remaining: 9 };
    const { unmount } = renderBanner();
    await userEvent.click(screen.getByRole('button'));
    unmount();

    trial = { status: 'trialing', days_remaining: 3 };
    renderBanner();
    expect(screen.getByTestId('trial-banner')).toBeInTheDocument();
  });

  it('is absent for someone who has already bought', () => {
    trial = {
      status: 'trialing',
      days_remaining: 2,
      paid_plan_starts_at: '2026-09-11T00:00:00+00:00',
      paid_plan_name: 'Standard',
    };
    const { container } = renderBanner();
    expect(container).toBeEmptyDOMElement();
  });

  it('survives a localStorage that throws on read', () => {
    trial = { status: 'trialing', days_remaining: 9 };
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    try {
      renderBanner();
      expect(screen.getByTestId('trial-banner')).toBeInTheDocument();
    } finally {
      spy.mockRestore();
    }
  });
});
