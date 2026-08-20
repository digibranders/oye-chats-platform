import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RevenuePage } from './RevenuePage';

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

function mount(url = '/platform/revenue') {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <UrlProbe />
      <Routes>
        <Route path="/platform/revenue/*" element={<RevenuePage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('RevenuePage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    get.mockResolvedValue({ data: [] });
  });

  it('owns the page heading, and only one', async () => {
    mount();
    const headings = await screen.findAllByRole('heading', { level: 1 });
    expect(headings).toHaveLength(1);
    expect(headings[0]).toHaveTextContent('Revenue');
  });

  it('opens on the overview', async () => {
    mount();
    expect(await screen.findByRole('link', { name: 'Overview', current: 'page' })).toBeInTheDocument();
  });

  /**
   * The views are links, not tabs. A `tablist` promises a panel per tab and a
   * routed section only ever has the current one, so the other five carried
   * `aria-controls` pointing at ids that were never in the document.
   */
  it('renders its views as navigation, not as a tablist', async () => {
    mount();
    await screen.findByRole('navigation', { name: 'Revenue views' });
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
  });

  /**
   * Each view is a real URL, because every list in this section is something an
   * operator will want to send to a colleague — and a tab held in component
   * state cannot be sent to anyone.
   */
  it('gives every view its own address', async () => {
    const user = userEvent.setup();
    mount();

    await user.click(await screen.findByRole('link', { name: 'Invoices' }));

    await waitFor(() =>
      expect(screen.getByTestId('url').textContent).toBe('/platform/revenue/invoices'),
    );
    expect(screen.getByRole('link', { name: 'Invoices', current: 'page' })).toBeInTheDocument();
  });

  it('selects the tab named by the URL on first paint', async () => {
    mount('/platform/revenue/growth');
    expect(await screen.findByRole('link', { name: 'Growth', current: 'page' })).toBeInTheDocument();
  });

  it('sends a mistyped sub-path to the section’s first screen rather than a dead page', async () => {
    mount('/platform/revenue/nonsense');
    await waitFor(() => expect(screen.getByTestId('url').textContent).toBe('/platform/revenue'));
    expect(screen.getByRole('link', { name: 'Overview', current: 'page' })).toBeInTheDocument();
  });

  it('states once, prominently, that its aggregates are converted', async () => {
    mount();
    expect(await screen.findByText(/Every figure on this tab is normalised/)).toBeInTheDocument();
  });
});
