import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SubscriptionsTab } from './SubscriptionsTab';
import type { SubscriptionRow } from './types';

const get = vi.fn();
const put = vi.fn();

vi.mock('../../services/api', () => ({
  httpClient: {
    get: (...args: unknown[]) => get(...args),
    put: (...args: unknown[]) => put(...args),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  getApiBaseUrl: () => '',
}));

function subscription(overrides: Partial<SubscriptionRow> = {}): SubscriptionRow {
  return {
    id: 77,
    client_id: 42,
    client_name: 'Northwind Security',
    client_email: 'ops@northwind.test',
    plan_id: 3,
    plan_name: 'Standard',
    status: 'active',
    billing_cycle: 'monthly',
    operator_quantity: 3,
    payment_provider: 'razorpay',
    current_period_start: '2026-08-01T00:00:00Z',
    current_period_end: '2026-09-01T00:00:00Z',
    trial_end: null,
    canceled_at: null,
    created_at: '2026-01-04T00:00:00Z',
    ...overrides,
  };
}

function UrlProbe() {
  const location = useLocation();
  return <span data-testid="url">{`${location.pathname}${location.search}`}</span>;
}

function mount(url = '/platform/revenue/subscriptions') {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <UrlProbe />
      <Routes>
        <Route path="/platform/revenue/subscriptions" element={<SubscriptionsTab />} />
      </Routes>
    </MemoryRouter>,
  );
}

async function openOverride(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByText('Northwind Security');
  await user.click(screen.getByRole('button', { name: /Northwind Security/ }));
  return screen.findByRole('dialog');
}

describe('SubscriptionsTab', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reads the book with no filters until one is set', async () => {
    get.mockResolvedValue({ data: [subscription()] });
    mount();
    await screen.findByText('Northwind Security');
    expect(get).toHaveBeenCalledWith('/superadmin/subscriptions', { params: {} });
  });

  it('puts a status filter in the URL and sends it', async () => {
    const user = userEvent.setup();
    get.mockResolvedValue({ data: [subscription()] });
    mount();

    await screen.findByText('Northwind Security');
    await user.selectOptions(screen.getByLabelText(/filter by status/i), 'past_due');

    await waitFor(() => expect(screen.getByTestId('url').textContent).toContain('status=past_due'));
    await waitFor(() =>
      expect(get).toHaveBeenLastCalledWith('/superadmin/subscriptions', {
        params: { status: 'past_due' },
      }),
    );
  });

  /**
   * The endpoint caps at 200 rows and offers no page parameter, so the console
   * must not imply the list is complete.
   */
  it('says so when the endpoint has truncated the list', async () => {
    get.mockResolvedValue({ data: Array.from({ length: 200 }, (_, index) => subscription({ id: index })) });
    mount();
    expect(await screen.findByText(/Most recent/)).toBeInTheDocument();
  });

  it('does not claim truncation on a short list', async () => {
    get.mockResolvedValue({ data: [subscription()] });
    mount();
    await screen.findByText('Northwind Security');
    expect(screen.queryByText('This is a truncated list')).not.toBeInTheDocument();
  });

  /* ------------------------------------------------------------- override */

  it('sends only the fields that were actually changed', async () => {
    const user = userEvent.setup();
    get.mockResolvedValue({ data: [subscription()] });
    put.mockResolvedValue({ data: { message: 'ok' } });
    mount();

    const dialog = await openOverride(user);
    await user.selectOptions(within(dialog).getByLabelText(/^status$/i), 'paused');
    await user.click(within(dialog).getByRole('button', { name: /apply override/i }));

    await waitFor(() =>
      expect(put).toHaveBeenCalledWith('/superadmin/subscriptions/77', { status: 'paused' }),
    );
  });

  it('will not send anything until something has changed', async () => {
    const user = userEvent.setup();
    get.mockResolvedValue({ data: [subscription()] });
    mount();

    const dialog = await openOverride(user);
    expect(within(dialog).getByRole('button', { name: /apply override/i })).toBeDisabled();
    expect(within(dialog).getByText(/Nothing yet/)).toBeInTheDocument();
  });

  it('shows what will be sent before it is sent', async () => {
    const user = userEvent.setup();
    get.mockResolvedValue({ data: [subscription()] });
    mount();

    const dialog = await openOverride(user);
    await user.selectOptions(within(dialog).getByLabelText(/^status$/i), 'paused');
    expect(within(dialog).getByText('status Active → Paused')).toBeInTheDocument();
  });

  /**
   * The handler's condition is `extend_trial_days is not None and
   * sub.trial_end`, so days sent for a subscription with no trial are silently
   * ignored — and a console that accepted them would report a success that
   * never happened.
   */
  it('disables the trial extension when there is no trial to extend', async () => {
    const user = userEvent.setup();
    get.mockResolvedValue({ data: [subscription({ trial_end: null })] });
    mount();

    const dialog = await openOverride(user);
    expect(within(dialog).getByLabelText(/extend trial/i)).toBeDisabled();
    expect(within(dialog).getByText(/No trial end date/i)).toBeInTheDocument();
  });

  it('allows the trial extension when there is a trial end date', async () => {
    const user = userEvent.setup();
    get.mockResolvedValue({ data: [subscription({ status: 'trialing', trial_end: '2026-09-01T00:00:00Z' })] });
    put.mockResolvedValue({ data: { message: 'ok' } });
    mount();

    const dialog = await openOverride(user);
    const field = within(dialog).getByLabelText(/extend trial/i);
    expect(field).toBeEnabled();
    await user.type(field, '14');
    await user.click(within(dialog).getByRole('button', { name: /apply override/i }));

    await waitFor(() =>
      expect(put).toHaveBeenCalledWith('/superadmin/subscriptions/77', { extend_trial_days: 14 }),
    );
  });

  it('warns that an override does not touch the gateway', async () => {
    const user = userEvent.setup();
    get.mockResolvedValue({ data: [subscription()] });
    mount();
    const dialog = await openOverride(user);
    expect(
      within(dialog).getByText(/writes to the customer's account and not to the gateway/i),
    ).toBeInTheDocument();
  });

  it('shows the server’s refusal instead of closing as though it worked', async () => {
    const user = userEvent.setup();
    get.mockResolvedValue({ data: [subscription()] });
    put.mockRejectedValue(
      Object.assign(new Error('failed'), {
        response: {
          status: 400,
          data: { detail: 'Subscription 77 is scoped to agent 9, and the Enterprise plan includes unlimited AI agents.' },
        },
      }),
    );
    mount();

    const dialog = await openOverride(user);
    await user.selectOptions(within(dialog).getByLabelText(/^status$/i), 'paused');
    await user.click(within(dialog).getByRole('button', { name: /apply override/i }));

    expect(await within(dialog).findByText(/includes unlimited AI agents/)).toBeInTheDocument();
  });

  /* --------------------------------------------------------- four states */

  it('is busy while the book loads', async () => {
    get.mockReturnValue(new Promise(() => {}));
    mount();
    expect(await screen.findByRole('table')).toHaveAttribute('aria-busy', 'true');
  });

  it('separates an empty book from an empty filter result', async () => {
    get.mockResolvedValue({ data: [] });
    const { unmount } = mount();
    expect(await screen.findByText('No subscriptions yet')).toBeInTheDocument();
    unmount();

    mount('/platform/revenue/subscriptions?status=paused');
    expect(await screen.findByText('Nothing matched those filters')).toBeInTheDocument();
  });

  it('explains a failure and offers the way back', async () => {
    get.mockRejectedValue(new Error('Database unreachable'));
    mount();
    expect(await screen.findByRole('alert')).toHaveTextContent('Database unreachable');
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });

  it('says the account is not permitted rather than showing an empty book', async () => {
    get.mockRejectedValue(
      Object.assign(new Error('failed'), {
        response: { status: 403, data: { detail: 'No privileges.' } },
      }),
    );
    mount();
    expect(await screen.findByText('You do not have access to this')).toBeInTheDocument();
    // The column heads stay so the reader can see what they are locked out of;
    // no subscription row is rendered.
    expect(screen.queryAllByRole('cell')).toHaveLength(1);
  });
});
