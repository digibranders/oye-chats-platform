import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { JourneyPage } from './JourneyPage';

/**
 * Journey's own guard clauses and header.
 *
 * The data-rendering path (the diagram, the list, the outcomes donut, the
 * pages panel) is exercised by each of those components' own tests — this
 * file only covers what's new to `JourneyPage` itself: the standalone page
 * header and the loading/error/empty states it now owns directly rather than
 * inheriting from `AnalyticsPage`.
 */

const botContext = vi.hoisted(() => ({
  bots: [{ id: 7, name: 'Acme Support' }],
  selectedBot: { id: 7, name: 'Acme Support' },
  loading: false,
  error: null as Error | null,
  refreshBots: vi.fn(),
}));

vi.mock('../../context/BotContext', () => ({
  useBotContext: () => botContext,
}));

vi.mock('../../services/api', () => ({
  getJourneySummary: vi.fn(
    async () =>
      ({
        sessions_with_journey: 5,
        meeting_booked: 1,
        handoff_requested: 2,
        offline_message_sent: 0,
        leads_captured: 3,
        sessions_no_activity: 0,
        sessions_browsed_no_conversion: 2,
      }) as const,
  ),
  getJourneyTopPages: vi.fn(async () => ({ rows: [] })),
  getJourneyPostChat: vi.fn(async () => ({
    sessions_with_post_chat_activity: 0,
    first_hops: [],
    all_hops: [],
    full_sequences: [],
  })),
  getJourneyPreChatSequences: vi.fn(async () => ({
    total_sessions: 5,
    sessions_with_pre_chat: 4,
    sequences: [],
  })),
  getJourneyConversionPaths: vi.fn(async () => ({ paths: [] })),
}));

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/journey']}>
        <JourneyPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  botContext.bots = [{ id: 7, name: 'Acme Support' }];
  botContext.selectedBot = { id: 7, name: 'Acme Support' };
  botContext.loading = false;
  botContext.error = null;
});

describe('JourneyPage', () => {
  it('is its own page, not a tab, with its own title', async () => {
    renderPage();
    expect(screen.getByRole('heading', { name: 'Journey' })).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByText('Tracked journeys')).toBeInTheDocument(),
    );
  });

  it('shows a month picker and a refresh control in the header, not a range control', () => {
    renderPage();
    expect(screen.getByRole('combobox', { name: 'Month' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeInTheDocument();
  });

  it('shows the empty state when the workspace has no chatbots yet', () => {
    botContext.bots = [];
    botContext.selectedBot = null as never;
    renderPage();
    expect(screen.getByText('Nothing measured yet')).toBeInTheDocument();
  });

  it('shows an error state when the chatbot list fails to load', () => {
    botContext.error = new Error('network down');
    renderPage();
    expect(screen.getByText('Your chatbots could not be loaded')).toBeInTheDocument();
  });
});
