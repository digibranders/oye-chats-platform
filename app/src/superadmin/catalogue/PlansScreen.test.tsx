import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PlansScreen } from './PlansScreen';
import { UNLIMITED } from './plan-model';
import type { Plan } from './types';

// `vi.hoisted` because `vi.mock` is lifted above every other statement in the
// file, so a plain const declared here would not exist when the factory runs.
const httpClient = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
}));

vi.mock('../../services/api', () => ({ httpClient }));

function plan(overrides: Partial<Plan> = {}): Plan {
  return {
    id: 1,
    name: 'Enterprise',
    slug: 'enterprise',
    description: null,
    pricing_model: 'per_operator',
    currency: 'INR',
    monthly_price_cents: 599900,
    annual_price_cents: 5758800,
    monthly_price_usd_cents: 8999,
    annual_price_usd_cents: 86388,
    annual_discount_percent: 20,
    trial_days: 0,
    limits: { bots: UNLIMITED, credits: 10000 },
    features: { live_chat: true },
    marketing: {},
    overage_rate_cents: 0,
    credits_per_month: 10000,
    included_operator_seats: UNLIMITED,
    extra_seat_price_cents: 0,
    extra_seat_price_usd_cents: 0,
    is_active: true,
    is_default: false,
    sort_order: 5,
    razorpay_plan_id_monthly: 'plan_m',
    razorpay_plan_id_annual: 'plan_a',
    active_subscriptions: 0,
    created_at: null,
    updated_at: null,
    ...overrides,
  };
}

function renderScreen() {
  return render(
    <MemoryRouter initialEntries={['/platform/catalogue']}>
      <PlansScreen />
    </MemoryRouter>,
  );
}

function rejection(status: number, detail: string) {
  return { response: { status, data: { detail } } };
}

beforeEach(() => {
  vi.clearAllMocks();
});

/**
 * The four states, and the one rendering rule the whole section turns on.
 *
 * `-1` is `plan_entitlements_service.UNLIMITED`. A table that prints it is not a
 * cosmetic bug: "-1 seats" is read as a broken row, and the operator's next move
 * is to "fix" it by typing a number, which caps a tier that was meant to be
 * uncapped.
 */
describe('PlansScreen', () => {
  it('shows a busy table while the catalogue loads', () => {
    httpClient.get.mockReturnValue(new Promise(() => {}));
    renderScreen();
    expect(screen.getByRole('table')).toHaveAttribute('aria-busy', 'true');
  });

  it('says the section is empty rather than showing a blank table', async () => {
    httpClient.get.mockResolvedValue({ data: [] });
    renderScreen();
    expect(await screen.findByText('No plans exist')).toBeInTheDocument();
  });

  it('offers a way back when the catalogue fails to load', async () => {
    httpClient.get.mockRejectedValue(rejection(500, 'Database unreachable.'));
    renderScreen();
    expect(await screen.findByText('Database unreachable.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('says the account is not permitted, rather than showing an empty catalogue', async () => {
    httpClient.get.mockRejectedValue(rejection(403, 'Read-only super-admin.'));
    renderScreen();
    expect(await screen.findByText('You do not have access to this')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('renders the unlimited sentinel as a word, never as -1', async () => {
    httpClient.get.mockResolvedValue({ data: [plan()] });
    renderScreen();
    const row = await screen.findByRole('row', { name: /Enterprise/ });
    expect(within(row).getAllByText('Unlimited').length).toBeGreaterThan(0);
    expect(row.textContent).not.toContain('-1');
  });

  it('refuses to offer delisting for a plan somebody is paying for', async () => {
    httpClient.get.mockResolvedValue({ data: [plan({ active_subscriptions: 412 })] });
    renderScreen();
    expect(await screen.findByRole('button', { name: 'Delist' })).toBeDisabled();
  });

  it('does not offer to delist a plan that is already delisted', async () => {
    // The action's confirm described an effect the row already has, and the API
    // would have accepted it — a no-op behind a destructive dialog.
    httpClient.get.mockResolvedValue({
      data: [plan({ is_active: false, active_subscriptions: 0 })],
    });
    renderScreen();
    expect(await screen.findByText('Delisted')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delist' })).not.toBeInTheDocument();
  });

  it('counts its rows as plans, not as rows', async () => {
    httpClient.get.mockResolvedValue({ data: [plan(), plan({ id: 2, name: 'Scale', slug: 'scale' })] });
    renderScreen();
    expect(
      await screen.findByText((_, node) => node?.textContent?.trim() === '2 plans' && node.tagName === 'P'),
    ).toBeInTheDocument();
  });

  it('does not delist until the confirmation is accepted', async () => {
    const user = userEvent.setup();
    httpClient.get.mockResolvedValue({ data: [plan()] });
    httpClient.delete.mockResolvedValue({ data: { message: 'ok' } });
    renderScreen();

    await user.click(await screen.findByRole('button', { name: 'Delist' }));
    expect(await screen.findByRole('alertdialog')).toBeInTheDocument();
    expect(httpClient.delete).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Delist plan' }));
    await waitFor(() => expect(httpClient.delete).toHaveBeenCalledWith('/superadmin/plans/1'));
  });

  it('abandons the delist when the confirmation is cancelled', async () => {
    const user = userEvent.setup();
    httpClient.get.mockResolvedValue({ data: [plan()] });
    renderScreen();

    await user.click(await screen.findByRole('button', { name: 'Delist' }));
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(httpClient.delete).not.toHaveBeenCalled();
  });

  it('names the plan every new account lands on, or says there is not one', async () => {
    httpClient.get.mockResolvedValue({ data: [plan({ is_default: false })] });
    renderScreen();
    expect(
      await screen.findByText(/none — new accounts fall back to Free limits/),
    ).toBeInTheDocument();
  });
});
