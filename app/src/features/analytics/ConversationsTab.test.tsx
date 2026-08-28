import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { ConversationsTab } from './ConversationsTab';

const api = vi.hoisted(() => ({
  getRatingsSummary: vi.fn(),
  getResolutionSummary: vi.fn(),
  getFeedbackData: vi.fn(),
  getQueueSummary: vi.fn(),
  getMessageActivity: vi.fn(),
  getTopQuestions: vi.fn(),
  getUnansweredQuestions: vi.fn(),
}));

vi.mock('../../services/api', () => api);

function renderTab(botId = 1, days = 30) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <ConversationsTab botId={botId} days={days} />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('ConversationsTab', () => {
  it('renders the queue stat band with depth and wait time', async () => {
    api.getRatingsSummary.mockResolvedValue({ total: 10, avg: 4.5, distribution: { 1: 0, 2: 0, 3: 0, 4: 5, 5: 5 } });
    api.getResolutionSummary.mockResolvedValue({ total: 10, resolved: 8, unresolved: 2, rate: 80 });
    api.getFeedbackData.mockResolvedValue([]);
    api.getMessageActivity.mockResolvedValue([]);
    api.getTopQuestions.mockResolvedValue([]);
    api.getUnansweredQuestions.mockResolvedValue([]);
    api.getQueueSummary.mockResolvedValue({
      current_depth: 3,
      avg_wait_seconds: 45,
      resolved_count: 12,
      abandoned_count: 2,
    });

    renderTab();

    expect(await screen.findByText('Waiting now')).toBeInTheDocument();
    expect(await screen.findByText('3')).toBeInTheDocument();
    expect(screen.getByText('Average wait')).toBeInTheDocument();
    expect(screen.getByText('45s')).toBeInTheDocument();
  });
});
