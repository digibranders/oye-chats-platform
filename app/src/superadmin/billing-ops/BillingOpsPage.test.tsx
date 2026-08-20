import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BillingOpsPage } from './BillingOpsPage';

const get = vi.fn();

vi.mock('../../services/api', () => ({
  httpClient: {
    get: (...args: unknown[]) => get(...args),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  getApiBaseUrl: () => '',
}));

function UrlProbe() {
  const location = useLocation();
  return <span data-testid="url">{location.pathname}</span>;
}

function mount(url = '/platform/billing-ops') {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <UrlProbe />
      <Routes>
        <Route path="/platform/billing-ops/*" element={<BillingOpsPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('BillingOpsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    get.mockResolvedValue({ data: { count: 0, at_risk_minor_total: 0, grace_days: 7, items: [] } });
  });

  it('owns the page heading, and only one', async () => {
    mount();
    const headings = await screen.findAllByRole('heading', { level: 1 });
    expect(headings).toHaveLength(1);
    expect(headings[0]).toHaveTextContent('Billing operations');
  });

  /** Dunning first: everything else here can wait a day, and a grace period cannot. */
  it('opens on dunning', async () => {
    mount();
    expect(await screen.findByRole('link', { name: 'Dunning', current: 'page' })).toBeInTheDocument();
    expect(await screen.findByText('Nobody is failing payment')).toBeInTheDocument();
  });

  it('renders its views as navigation, not as a tablist', async () => {
    mount();
    await screen.findByRole('navigation', { name: 'Billing operations views' });
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
  });

  it('gives every view its own address', async () => {
    const user = userEvent.setup();
    mount();

    await user.click(await screen.findByRole('link', { name: 'GSTR export' }));

    await waitFor(() =>
      expect(screen.getByTestId('url').textContent).toBe('/platform/billing-ops/gstr'),
    );
    expect(screen.getByRole('link', { name: 'GSTR export', current: 'page' })).toBeInTheDocument();
  });

  it('selects the tab named by the URL on first paint', async () => {
    mount('/platform/billing-ops/seller');
    expect(
      await screen.findByRole('link', { name: 'Seller profile', current: 'page' }),
    ).toBeInTheDocument();
  });

  it('sends a mistyped sub-path to dunning rather than a dead page', async () => {
    mount('/platform/billing-ops/nonsense');
    await waitFor(() => expect(screen.getByTestId('url').textContent).toBe('/platform/billing-ops'));
    expect(screen.getByRole('link', { name: 'Dunning', current: 'page' })).toBeInTheDocument();
  });
});
