import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The three behaviours this page got wrong that no unit test would have caught,
 * because each one is a wiring decision rather than a calculation:
 *
 * 1. `GET /leads/stats` was fetched on every load and rendered nowhere. It was
 *    used as a truthiness gate and thrown away, so the summary the page's own
 *    documentation promised did not exist.
 * 2. A 403 from `GET /leads` landed on "we could not load your leads" — a
 *    failure message for a plan boundary, with no way forward.
 * 3. Row click was a trapdoor: on a gated plan the row kept its pointer cursor
 *    and its chevron and opened an upgrade modal instead of the lead.
 */

const api = vi.hoisted(() => ({
  getLeads: vi.fn(),
  getLeadStats: vi.fn(),
  getLeadDetail: vi.fn(),
  getChatHistory: vi.fn(),
  getSessionDetails: vi.fn(),
  markLeadViewed: vi.fn(),
  markAllLeadsViewed: vi.fn(),
  exportLeadsCsv: vi.fn(),
  overrideLeadQualification: vi.fn(),
  sendLeadFollowUp: vi.fn(),
}));

vi.mock('../../services/api', () => api);

vi.mock('../../context/BotContext', () => ({
  useBotContext: () => ({
    bots: [{ id: 1, name: 'Acme Support' }],
    selectedBot: { id: 1, name: 'Acme Support' },
    selectBot: vi.fn(),
    refreshBots: vi.fn(),
    loading: false,
    error: null,
    isAllAgents: false,
  }),
}));

const entitlements = vi.hoisted(() => ({ isFree: false }));
vi.mock('../../hooks/useEntitlements', () => ({
  useEntitlements: () => entitlements,
}));
vi.mock('../../hooks/useSelectedBotPlanSlug', () => ({
  useSelectedBotPlanSlug: () => 'professional',
}));

const { LeadsPage } = await import('./LeadsPage');

function scoredLead(overrides: Record<string, unknown> = {}) {
  return {
    session_id: 's1',
    score: 82,
    tier: 'sql',
    status: 'sql',
    bant: { budget: { value: 'Approved', score: 22 }, need: { value: null, score: 0 } },
    contact: { name: 'Priya Raman', email: 'priya@infosys.com', company: 'infosys.com' },
    chats: 7,
    last_active_at: '2026-08-13T10:00:00Z',
    unread: true,
    ...overrides,
  };
}

function forbidden(): Error {
  const error = new Error('The leads dashboard is included on Starter and above.');
  (error as Error & { status: number }).status = 403;
  return error;
}

/** Reports the query string, so a URL-driven page can be asserted on directly. */
function Search() {
  const location = useLocation();
  return <output data-testid="search">{location.search}</output>;
}

function renderPage(initialEntry = '/leads') {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route
            path="/leads"
            element={
              <>
                <LeadsPage />
                <Search />
              </>
            }
          />
          <Route path="/billing" element={<p>Billing</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  entitlements.isFree = false;
  api.getLeads.mockResolvedValue({ leads: [scoredLead()], total: 1, page: 1, limit: 50 });
  api.getLeadStats.mockResolvedValue({
    total: 128,
    unqualified: 87,
    mql: 24,
    sal: 8,
    sql: 9,
    avg_score: 43,
    unread: 4,
  });
  api.getLeadDetail.mockResolvedValue(scoredLead());
  api.getChatHistory.mockResolvedValue([]);
  api.getSessionDetails.mockResolvedValue({ visitor_rating: 5 });
  api.markLeadViewed.mockResolvedValue(undefined);
  api.markAllLeadsViewed.mockResolvedValue(undefined);
});

describe('LeadsPage', () => {
  it('renders the pipeline summary the stats call was already paying for', async () => {
    renderPage();

    // Every figure the endpoint returns, on screen. It used to return all of
    // this and have it thrown away.
    expect(await screen.findByText('128')).toBeInTheDocument();
    expect(screen.getByText('41')).toBeInTheDocument(); // mql + sal + sql
    // The denominator is in the figure now, not overloaded into the tile's
    // `period` slot, which is documented as the window a figure covers.
    expect(screen.getByText('43/100')).toBeInTheDocument(); // average score
    expect(screen.getByText('4')).toBeInTheDocument(); // not opened
  });

  it('sends the tier and score filters to the server rather than filtering a slice', async () => {
    renderPage('/leads?tier=sql&score=75&page=2');

    await waitFor(() =>
      expect(api.getLeads).toHaveBeenCalledWith(1, {
        status: 'sql',
        min_score: 75,
        page: 2,
        limit: 50,
      }),
    );
  });

  it('answers a 403 with the upgrade path, not with a failure message', async () => {
    api.getLeads.mockRejectedValue(forbidden());

    renderPage();

    expect(await screen.findByText(/not included on your plan/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /see plans/i })).toHaveAttribute('href', '/billing');
    expect(screen.queryByText(/could not/i)).not.toBeInTheDocument();
  });

  it('opens the lead when a row is clicked, and marks it read', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: /Priya Raman/ }));

    await waitFor(() => expect(screen.getByTestId('search')).toHaveTextContent('lead=s1'));
    expect(api.markLeadViewed).toHaveBeenCalledWith('s1');
  });

  it('keeps both faces of the drawer reachable from either', async () => {
    const user = userEvent.setup();
    renderPage('/leads?lead=s1');

    // The panel used to fix its face at open time, so reading a profile and
    // then wanting the transcript meant closing it and finding the row again.
    await user.click(await screen.findByRole('tab', { name: /conversation/i }));
    await waitFor(() => expect(screen.getByTestId('search')).toHaveTextContent('tab=conversation'));

    await user.click(screen.getByRole('tab', { name: /profile/i }));
    await waitFor(() =>
      expect(screen.getByTestId('search')).not.toHaveTextContent('tab=conversation'),
    );
  });

  it('confirms before clearing every unread mark', async () => {
    const user = userEvent.setup();
    renderPage();

    // The page's secondary verbs live in one overflow menu. The header used to
    // carry three unbounded buttons, two of them ghost, none of them primary.
    await user.click(await screen.findByRole('button', { name: /lead actions/i }));
    await user.click(await screen.findByRole('menuitem', { name: /mark all read/i }));

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent(/every page/i);
    expect(api.markAllLeadsViewed).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: /^mark all read$/i }));
    await waitFor(() => expect(api.markAllLeadsViewed).toHaveBeenCalledWith(1));
  });

  it('drops the paid columns on a plan that has none of their data', async () => {
    // The server deletes score, tier and location for Free rather than nulling
    // them, so the honest table is a narrower one plus a single statement of
    // what is missing — not sixty identical "Locked" cells.
    entitlements.isFree = true;
    api.getLeads.mockResolvedValue({
      leads: [{ session_id: 's1', contact: { name: 'Priya Raman' }, chats: 3, unread: false }],
      total: 1,
      page: 1,
      limit: 50,
    });
    api.getLeadStats.mockResolvedValue({ total: 12, unread: 1 });

    renderPage();

    expect(await screen.findByRole('columnheader', { name: /lead/i })).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: /quality/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: /location/i })).not.toBeInTheDocument();
    expect(screen.getAllByText(/included on Starter and above/i).length).toBeGreaterThan(0);
  });
});
