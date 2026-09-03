import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConversationsTab } from './ConversationsTab';
import { resolveRange, type RangeKey } from './range';

const api = vi.hoisted(() => ({
  getRatingsSummary: vi.fn(),
  getResolutionSummary: vi.fn(),
  getFeedbackData: vi.fn(),
  getQueueSummary: vi.fn(),
  getActivityStats: vi.fn(),
  getMessageActivity: vi.fn(),
  getTopQuestions: vi.fn(),
  getUnansweredQuestions: vi.fn(),
}));

vi.mock('../../context/BotContext', () => ({
  // The analytics hooks ask the chatbot list one question: has it resolved?
  // `botId === null` is a legitimate scope (every chatbot) once it has, so
  // readiness cannot be inferred from the id alone.
  useBotContext: () => ({ bots: [{ id: 1, name: 'Acme' }], selectedBot: null, loading: false }),
}));
vi.mock('../../services/api', () => api);

function renderTab({ range, days = 30 }: { range?: RangeKey; days?: number } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <ConversationsTab
          botId={1}
          days={days}
          range={range ? resolveRange(range) : undefined}
        />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

/** The card a claim belongs to, so an assertion cannot be answered by its neighbour. */
async function cardFor(heading: string): Promise<HTMLElement> {
  const title = await screen.findByRole('heading', { name: heading });
  const card = title.closest('[data-card]');
  expect(card).not.toBeNull();
  return card as HTMLElement;
}

beforeEach(() => {
  vi.clearAllMocks();
  api.getRatingsSummary.mockResolvedValue({ total: 10, avg: 4.5, distribution: { 1: 0, 2: 0, 3: 0, 4: 5, 5: 5 } });
  api.getResolutionSummary.mockResolvedValue({ total: 10, resolved: 8, unresolved: 2, rate: 80 });
  api.getFeedbackData.mockResolvedValue([]);
  api.getActivityStats.mockResolvedValue([]);
  api.getMessageActivity.mockResolvedValue([]);
  api.getTopQuestions.mockResolvedValue([]);
  api.getUnansweredQuestions.mockResolvedValue([]);
  api.getQueueSummary.mockResolvedValue({
    current_depth: 3,
    avg_wait_seconds: 45,
    resolved_count: 12,
    abandoned_count: 2,
  });
});

describe('ConversationsTab', () => {
  it('renders the queue stat band with depth and wait time', async () => {
    renderTab();

    expect(await screen.findByText('Waiting now')).toBeInTheDocument();
    expect(await screen.findByText('3')).toBeInTheDocument();
    expect(screen.getByText('Average wait')).toBeInTheDocument();
    expect(screen.getByText('45s')).toBeInTheDocument();
  });
});

/**
 * The queue card, and the two things it used to say that were not true.
 *
 * A failed read fell back to the string "0" on three of its four tiles, so an
 * outage rendered a calm, empty queue. And the card wore the page's range label
 * while always asking for thirty days, so "All time" was printed over a
 * thirty-day answer.
 */
describe('ConversationsTab. The live chat queue', () => {
  it('renders an error with a retry rather than a queue of zero', async () => {
    api.getQueueSummary.mockRejectedValue(new Error('Queue summary is unavailable.'));

    renderTab();

    const card = await cardFor('Live chat queue');
    expect(await within(card).findByText('Queue summary is unavailable.')).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    // Not a single figure: the tiles are gone, so there is no "0" left to read
    // as an empty queue.
    expect(within(card).queryByText('Waiting now')).toBeNull();
    expect(within(card).queryByText('0')).toBeNull();
  });

  it('names the window it actually asked for, never "All time"', async () => {
    // `getQueueSummary` has no unbounded form: `days` defaults to 30 and the
    // endpoint clamps it to 1 to 90. Selecting "All time" therefore still buys
    // a thirty-day answer, and the card has to say thirty days.
    renderTab({ range: 'all' });

    const card = await cardFor('Live chat queue');
    expect(api.getQueueSummary).toHaveBeenCalledWith(1, 30);
    expect(within(card).getByText('Last 30 days')).toBeInTheDocument();
    expect(within(card).queryByText('All time')).toBeNull();
  });

  it('stamps the live depth "Right now" rather than the card’s window', async () => {
    // `current_depth` counts sessions still waiting within the last hour,
    // whatever `days` was asked for. It is the one tile on the strip that is
    // not historical, so it states its own period.
    renderTab({ range: '90d' });

    const card = await cardFor('Live chat queue');
    const tile = (await within(card).findByText('Waiting now')).parentElement as HTMLElement;
    expect(within(tile).getByText('Right now')).toBeInTheDocument();
  });
});

describe('ConversationsTab. Message volume', () => {
  it('reports an unknown message count as unknown, not as zero', async () => {
    // `useMessageSeries` yields an empty series on failure and `summarize([])`
    // totals zero, so a 500 used to render "Messages 0 · Daily average 0" as
    // confidently as a quiet week.
    api.getActivityStats.mockRejectedValue(new Error('Activity is unavailable.'));

    renderTab();

    const card = await cardFor('Messages per day');
    const messages = (await within(card).findByText('Messages')).parentElement as HTMLElement;
    expect(within(messages).queryByText('0')).toBeNull();
    expect(within(messages).getByText('—')).toBeInTheDocument();

    const average = (within(card).getByText('Daily average')).parentElement as HTMLElement;
    expect(within(average).getByText('—')).toBeInTheDocument();
  });
});
