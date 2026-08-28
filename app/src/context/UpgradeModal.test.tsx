import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UpgradeModal } from './UpgradeModal';
import { UPGRADE_INTENTS } from './upgradeIntents';

/**
 * The upsell, rebuilt on the console's own `Dialog`.
 *
 * What is worth pinning is the seam: the registry's copy has to survive the
 * move, and the call to action has to land on the billing route that actually
 * exists — the surface it replaces navigated to `/workspace/billing`, a path
 * the rebuilt router no longer serves.
 */

vi.mock('../hooks/useEntitlements', () => ({
  useEntitlements: () => ({ planName: 'Free' }),
}));

vi.mock('../services/api', () => ({
  getSubscriptionPlans: vi.fn(async () => []),
}));

function Probe() {
  return <output data-testid="url">{useLocation().pathname}</output>;
}

function renderModal(onClose = vi.fn()) {
  return render(
    <MemoryRouter initialEntries={['/leads']}>
      <UpgradeModal open content={UPGRADE_INTENTS.view_leads()} onClose={onClose} />
      <Routes>
        <Route path="*" element={<Probe />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('UpgradeModal', () => {
  it('renders nothing at all when there is no intent to show', () => {
    const { container } = render(
      <MemoryRouter>
        <UpgradeModal open={false} content={null} onClose={vi.fn()} />
      </MemoryRouter>,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('carries the registry’s copy for the gate that opened it', () => {
    renderModal();
    const intent = UPGRADE_INTENTS.view_leads();

    expect(screen.getByRole('heading', { name: intent.title })).toBeInTheDocument();
    for (const line of intent.highlights) {
      expect(screen.getByText(line)).toBeInTheDocument();
    }
  });

  it('sends the customer to the billing route this router actually serves', async () => {
    const onClose = vi.fn();
    renderModal(onClose);

    await userEvent.click(screen.getByRole('button', { name: /see plans/i }));
    expect(onClose).toHaveBeenCalled();
    expect(screen.getByTestId('url')).toHaveTextContent('/billing');
  });
});
