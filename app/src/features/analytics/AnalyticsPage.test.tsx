import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AnalyticsPage } from './AnalyticsPage';

/**
 * The URL contract, end to end.
 *
 * Tab state was component-local, so refresh and Back always landed on the first
 * tab, and the range control only ever moved a chart. The views are real routes
 * now and the period is a query parameter — which is only true if the page
 * actually renders links to those routes and writes that parameter, a fact no
 * amount of unit testing the helpers can establish on its own.
 *
 * Rendered under the same `analytics/*` splat `src/app/routes.tsx` mounts, so
 * the page's own `<Routes>` resolves against the address the test names rather
 * than against `/`.
 */

vi.mock('../../context/BotContext', () => ({
  useBotContext: () => ({
    bots: [{ id: 7, name: 'Acme Support' }],
    selectedBot: { id: 7, name: 'Acme Support' },
    loading: false,
    error: null,
    refreshBots: vi.fn(),
  }),
}));

vi.mock('../../hooks/useEntitlements', () => ({
  useEntitlements: () => ({ hasFeature: () => true }),
}));

vi.mock('../../services/api', () => ({
  getDashboardStats: vi.fn(async () => ({ total_conversations: 0, total_messages: 0 })),
  getActivityStats: vi.fn(async () => []),
  getTopQuestions: vi.fn(async () => []),
  getUnansweredQuestions: vi.fn(async () => []),
  getRatingsSummary: vi.fn(async () => ({})),
  getLeadStats: vi.fn(async () => ({})),
  getQualificationFunnel: vi.fn(async () => ({})),
  getVisitorsData: vi.fn(async () => []),
  getFeedbackData: vi.fn(async () => []),
}));

function Probe() {
  const location = useLocation();
  return <output data-testid="url">{`${location.pathname}${location.search}`}</output>;
}

function renderPage(entry: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/analytics/*" element={<AnalyticsPage />} />
        </Routes>
        <Probe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('AnalyticsPage', () => {
  it('opens on the view named in the path rather than always the first one', () => {
    renderPage('/analytics/visitors');
    expect(screen.getByRole('link', { name: 'Visitors' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('names its views with links, not tabs', () => {
    // A `tablist` promises every tab controls a panel in the document. These
    // are addresses, so they are links — which is also what gives them
    // middle-click, cmd-click and open-in-new-tab.
    renderPage('/analytics');
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Feedback' })).toHaveAttribute(
      'href',
      '/analytics/feedback',
    );
  });

  it('redirects the legacy ?tab= link to the view it names', async () => {
    // It shipped, so it is in bookmarks and pasted messages. Rendering Overview
    // under an address that asked for Visitors would be the quiet failure.
    renderPage('/analytics?tab=visitors');
    await waitFor(() =>
      expect(screen.getByTestId('url')).toHaveTextContent('/analytics/visitors'),
    );
    expect(screen.getByTestId('url')).not.toHaveTextContent('tab=');
  });

  it('keeps the reporting period while redirecting a legacy link', async () => {
    renderPage('/analytics?tab=feedback&range=90d');
    await waitFor(() =>
      expect(screen.getByTestId('url')).toHaveTextContent('/analytics/feedback?range=90d'),
    );
  });

  it('sends each view to its own path', async () => {
    const user = userEvent.setup();
    renderPage('/analytics');
    await user.click(screen.getByRole('link', { name: 'Visitors' }));
    expect(screen.getByTestId('url')).toHaveTextContent('/analytics/visitors');
    await user.click(screen.getByRole('link', { name: 'Feedback' }));
    expect(screen.getByTestId('url')).toHaveTextContent('/analytics/feedback');
  });

  it('carries the reporting period across a change of view', async () => {
    const user = userEvent.setup();
    renderPage('/analytics?range=90d');
    await user.click(screen.getByRole('link', { name: 'Conversations' }));
    expect(screen.getByTestId('url')).toHaveTextContent('range=90d');
  });

  it('puts the reporting period in the URL', async () => {
    const user = userEvent.setup();
    renderPage('/analytics');
    await user.click(screen.getByRole('radio', { name: '7 days' }));
    expect(screen.getByTestId('url')).toHaveTextContent('range=7d');
  });

  it('sends an address under the section that names nothing back to the index', async () => {
    renderPage('/analytics/nonsense');
    await waitFor(() => expect(screen.getByTestId('url')).toHaveTextContent('/analytics'));
    expect(screen.getByRole('link', { name: 'Overview' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('offers the refresh control before anything has loaded', () => {
    renderPage('/analytics');
    expect(screen.getByRole('button', { name: /refresh/i })).toBeInTheDocument();
  });
});
