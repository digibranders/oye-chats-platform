import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OverviewTab } from './OverviewTab';
import { resolveRange } from './range';

/**
 * The headline strip, and what each figure claims to cover.
 *
 * Both assertions here are about a period, not a number, because both defects
 * they cover were figures wearing the wrong window: one tile labelled itself
 * "All time" over a windowed figure, and the series behind another was fetched
 * for all of history and bucketed in the database's zone.
 */

const api = vi.hoisted(() => ({
  getDashboardStats: vi.fn(),
  getActivityStats: vi.fn(),
  getLeadStats: vi.fn(),
  getUnansweredQuestions: vi.fn(),
  getQualificationFunnel: vi.fn(),
  getRatingsSummary: vi.fn(),
  getTopQuestions: vi.fn(),
  getVisitorsData: vi.fn(),
  getLanguageBreakdown: vi.fn(),
  getFeedbackData: vi.fn(),
}));

vi.mock('../../services/api', () => api);

vi.mock('../../hooks/useEntitlements', () => ({
  useEntitlements: () => ({ hasFeature: () => true }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  api.getDashboardStats.mockResolvedValue({
    total_conversations: 40,
    total_messages: 300,
    success_rate: 82,
  });
  api.getActivityStats.mockResolvedValue([]);
  api.getLeadStats.mockResolvedValue({ total: 4, sql: 1 });
  api.getUnansweredQuestions.mockResolvedValue([]);
  api.getQualificationFunnel.mockResolvedValue({ funnel: [] });
  api.getRatingsSummary.mockResolvedValue({ total: 0, avg: 0, distribution: {} });
});

function renderTab(rangeKey: '7d' | '30d' = '7d') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <OverviewTab botId={7} range={resolveRange(rangeKey)} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('OverviewTab — every tile over the window it actually covers', () => {
  it('does not stamp the helpfulness rate "All time" when a range is selected', async () => {
    // `/analytics/dashboard` used to ignore `?days=` for `success_rate` and
    // always answer all-time, so the tile said so. It is windowed now — cut on
    // the rated message's own date — and the label was the only thing still
    // claiming otherwise. The tile carries no period of its own, so it inherits
    // the strip's, which is the range control's own words.
    renderTab('7d');

    const tile = (await screen.findByText('Answers rated helpful')).parentElement;
    expect(tile).not.toBeNull();
    expect(within(tile as HTMLElement).queryByText('All time')).toBeNull();

    // The strip states the window once, for every tile that inherits it.
    expect(screen.getByText('Last 7 days')).toBeInTheDocument();

    // Qualified leads genuinely has no date filter on its endpoint, so it keeps
    // its own label. Exactly one "All time" on the strip, not two.
    expect(screen.getAllByText('All time')).toHaveLength(1);
  });

  it('asks the activity endpoint for the two windows it plots, not for all history', async () => {
    // `splitWindows` cuts the selected window AND the one before it out of this
    // one series, so a 7-day range needs 14 days fetched. Asking for nothing
    // made every load an unbounded aggregate over the workspace's whole chat
    // history — a real timeout on a busy account.
    renderTab('7d');

    await screen.findByText('Answers rated helpful');
    expect(api.getActivityStats).toHaveBeenCalledWith(7, { days: 14 });
  });
});
