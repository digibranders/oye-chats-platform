import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AnalyticsPage } from './AnalyticsPage';

/**
 * The URL contract, end to end.
 *
 * Tab state was component-local, so refresh and Back always landed on the first
 * tab, and the range control only ever moved a chart. Both live in the query
 * string now, which is only true if the page actually writes them there — a
 * fact no amount of unit testing the helpers can establish on its own.
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
  getJourneySummary: vi.fn(async () => ({})),
  getJourneyTopPages: vi.fn(async () => ({ rows: [] })),
  getJourneyPostChat: vi.fn(async () => ({ first_hops: [] })),
  getJourneyPreChatSequences: vi.fn(async () => ({ sequences: [] })),
  getJourneyConversionPaths: vi.fn(async () => ({ paths: [] })),
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
        <AnalyticsPage />
        <Probe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('AnalyticsPage', () => {
  it('opens on the tab named in the URL rather than always the first one', () => {
    renderPage('/analytics?tab=visitors');
    expect(screen.getByRole('tab', { name: 'Visitors' })).toHaveAttribute('aria-selected', 'true');
  });

  it('treats the legacy journey path as the journey tab', () => {
    renderPage('/analytics/journey');
    expect(screen.getByRole('tab', { name: 'Journey' })).toHaveAttribute('aria-selected', 'true');
  });

  it('writes the chosen tab into the URL, and journey to its own path', async () => {
    const user = userEvent.setup();
    renderPage('/analytics');
    await user.click(screen.getByRole('tab', { name: 'Visitors' }));
    expect(screen.getByTestId('url')).toHaveTextContent('/analytics?tab=visitors');
    await user.click(screen.getByRole('tab', { name: 'Journey' }));
    expect(screen.getByTestId('url')).toHaveTextContent('/analytics/journey');
  });

  it('carries the reporting period across a tab change', async () => {
    const user = userEvent.setup();
    renderPage('/analytics?range=90d');
    await user.click(screen.getByRole('tab', { name: 'Conversations' }));
    expect(screen.getByTestId('url')).toHaveTextContent('range=90d');
  });

  it('puts the reporting period in the URL', async () => {
    const user = userEvent.setup();
    renderPage('/analytics');
    await user.click(screen.getByRole('radio', { name: '7 days' }));
    expect(screen.getByTestId('url')).toHaveTextContent('range=7d');
  });

  it('offers the refresh control before anything has loaded', () => {
    renderPage('/analytics');
    expect(screen.getByRole('button', { name: /refresh/i })).toBeInTheDocument();
  });
});
