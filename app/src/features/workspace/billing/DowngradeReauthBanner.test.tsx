import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DowngradeReauthBanner } from './DowngradeReauthBanner';

// The banner reads the workspace subscription and the currently-selected bot.
// Both are mocked so the test drives only the reauth-state rendering logic.
const getCurrentSubscription = vi.fn();
vi.mock('../../../services/api', () => ({
  getCurrentSubscription: (botId?: number | null) => getCurrentSubscription(botId),
}));
vi.mock('../../../context/BotContext', () => ({
  useBotContext: () => ({ selectedBot: null }),
}));

function renderBanner() {
  return render(
    <MemoryRouter>
      <DowngradeReauthBanner />
    </MemoryRouter>,
  );
}

describe('DowngradeReauthBanner', () => {
  afterEach(() => {
    getCurrentSubscription.mockReset();
  });

  it('shows the finish-downgrade notice during the re-auth grace window', async () => {
    getCurrentSubscription.mockResolvedValue({
      subscription: { status: 'past_due' },
      reauth: {
        required: true,
        reason: 'downgrade_reauth',
        target_plan_name: 'Standard',
        grace_until: '2026-08-12T00:00:00Z',
        days_left: 6,
      },
    });

    const { container } = renderBanner();

    // Waits for the async fetch in the effect to resolve and the banner to mount.
    await screen.findByRole('alert');
    expect(container.textContent).toContain('Finish downgrading to Standard');
    expect(container.textContent).toContain('in 6 days');
    expect(screen.getByRole('button', { name: /Review billing/i })).toBeInTheDocument();
  });

  it('renders nothing for an ordinary subscription (no reauth required)', async () => {
    getCurrentSubscription.mockResolvedValue({
      subscription: { status: 'active' },
      reauth: null,
    });

    const { container } = renderBanner();

    // Let the effect's fetch resolve, then assert the banner stayed hidden.
    await Promise.resolve();
    await Promise.resolve();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(container.textContent).toBe('');
  });

  it('renders nothing when the probe fails (never surfaces our own error as a warning)', async () => {
    getCurrentSubscription.mockRejectedValue(new Error('network'));

    const { container } = renderBanner();

    await Promise.resolve();
    await Promise.resolve();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(container.textContent).toBe('');
  });
});
