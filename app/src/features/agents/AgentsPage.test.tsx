import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AgentsPage,
  matchesQuery,
  matchesStatus,
  sortAgents,
  summarizeAgents,
  type AgentListItem,
} from './AgentsPage';
import { agentHealth } from '../home/agentHealth';
import { useBotContext } from '../../context/BotContext';
import { useEntitlements } from '../../hooks/useEntitlements';
import type { Bot } from '../../types/domain';

vi.mock('../../context/BotContext', () => ({ useBotContext: vi.fn() }));
vi.mock('../../hooks/useEntitlements', () => ({ useEntitlements: vi.fn() }));
vi.mock('../../services/api', () => ({
  getDashboardStats: vi.fn().mockResolvedValue({}),
  createBot: vi.fn(),
  createBotCheckout: vi.fn(),
  getSubscriptionPlans: vi.fn().mockResolvedValue([]),
  verifyBotCheckout: vi.fn(),
  updateBot: vi.fn(),
  deleteBot: vi.fn(),
  trackDemoShareClick: vi.fn(),
  getBotDemoUrl: (key: string) => `https://demo.test/${key}`,
}));
vi.mock('../../lib/razorpay', () => ({ openRazorpayCheckout: vi.fn() }));

/**
 * The list's derivations, which are the whole reason a twenty-chatbot workspace
 * is usable. The page they belong to renders them; these pin the rules.
 */

function item(bot: Partial<Bot>, conversations: number | null = 0): AgentListItem {
  const full: Bot = { id: 1, name: 'Chatbot', ...bot };
  return { bot: full, health: agentHealth(full), conversations, conversationsLoading: false };
}

const live = item({
  id: 1,
  name: 'Acme Support',
  website: 'https://acme.test',
  bot_key: 'bot-aaaa1111',
  indexed_chunk_count: 500,
  widget_installed_at: '2026-01-01T00:00:00Z',
  created_at: '2026-01-01T00:00:00Z',
});
const broken = item({
  id: 2,
  name: 'Beta Concierge',
  indexed_chunk_count: 0,
  last_crawl_status: 'failed',
  created_at: '2026-03-01T00:00:00Z',
});
const training = item({
  id: 3,
  name: 'Gamma Helper',
  indexed_chunk_count: 0,
  last_crawl_status: 'running',
  created_at: '2026-02-01T00:00:00Z',
});

describe('search', () => {
  it('matches on name, website and key, because those are what people remember', () => {
    expect(matchesQuery(live, 'acme')).toBe(true);
    expect(matchesQuery(live, 'ACME.TEST')).toBe(true);
    expect(matchesQuery(live, 'aaaa1111')).toBe(true);
    expect(matchesQuery(live, 'nothing')).toBe(false);
  });

  it('treats an empty or whitespace query as no filter at all', () => {
    expect(matchesQuery(broken, '')).toBe(true);
    expect(matchesQuery(broken, '   ')).toBe(true);
  });

  it('does not crash on a chatbot with no website or key', () => {
    expect(matchesQuery(broken, 'beta')).toBe(true);
    expect(matchesQuery(broken, 'https')).toBe(false);
  });
});

describe('status filter', () => {
  it('reads "needs attention" from the shared health definition, not from a local rule', () => {
    expect(matchesStatus(broken, 'attention')).toBe(true);
    expect(matchesStatus(live, 'attention')).toBe(false);
    expect(matchesStatus(training, 'training')).toBe(true);
    expect(matchesStatus(live, 'live')).toBe(true);
  });

  it('passes everything through on "all"', () => {
    for (const candidate of [live, broken, training]) {
      expect(matchesStatus(candidate, 'all')).toBe(true);
    }
  });
});

describe('summary', () => {
  it('counts the states the tiles claim to show', () => {
    const summary = summarizeAgents([live, broken, training]);
    expect(summary).toMatchObject({ total: 3, live: 1, attention: 1, training: 1 });
  });

  it('reports absent conversations as absent rather than as zero', () => {
    expect(summarizeAgents([item({ id: 9 }, null)]).conversations).toBeNull();
    expect(summarizeAgents([item({ id: 9 }, null), item({ id: 10 }, 4)]).conversations).toBe(4);
  });
});

describe('sorting', () => {
  it('puts the chatbot that is failing customers first by default', () => {
    const order = sortAgents([live, training, broken], 'status').map((entry) => entry.bot.id);
    expect(order).toEqual([2, 3, 1]);
  });

  it('sorts by name case-insensitively', () => {
    const a = item({ id: 1, name: 'apple' });
    const b = item({ id: 2, name: 'Banana' });
    expect(sortAgents([b, a], 'name').map((entry) => entry.bot.id)).toEqual([1, 2]);
  });

  it('sorts newest first and pushes an unreadable creation date to the end', () => {
    const undated = item({ id: 4, name: 'Zeta', created_at: 'not-a-date' });
    const order = sortAgents([live, broken, undated], 'newest').map((entry) => entry.bot.id);
    expect(order).toEqual([2, 1, 4]);
  });

  it('sorts busiest first, ranking a chatbot that did not report below a quiet one', () => {
    const busy = item({ id: 5, name: 'Busy' }, 90);
    const quiet = item({ id: 6, name: 'Quiet' }, 0);
    const silent = item({ id: 7, name: 'Silent' }, null);
    const order = sortAgents([silent, quiet, busy], 'busiest').map((entry) => entry.bot.id);
    expect(order).toEqual([5, 6, 7]);
  });

  it('is stable: equal rows keep one order rather than reshuffling on refetch', () => {
    const first = item({ id: 8, name: 'Alpha' }, 5);
    const second = item({ id: 9, name: 'Bravo' }, 5);
    expect(sortAgents([second, first], 'busiest').map((entry) => entry.bot.id)).toEqual([8, 9]);
    expect(sortAgents([first, second], 'busiest').map((entry) => entry.bot.id)).toEqual([8, 9]);
  });

  it('does not mutate the list it was given', () => {
    const input = [live, broken];
    sortAgents(input, 'name');
    expect(input.map((entry) => entry.bot.id)).toEqual([1, 2]);
  });
});

/**
 * The one create path, and its door.
 *
 * The rail and Home both link to `/chatbots?new=1`, so the param has to open the
 * dialog and closing it has to clear the param — otherwise Back reopens a dialog
 * the user has just dismissed, and a copied link opens a form nobody asked for.
 */
describe('creating a chatbot', () => {
  const bots: Bot[] = [];
  const refreshBots = vi.fn().mockResolvedValue([]);

  function renderPage(url: string) {
    function Probe() {
      return <output data-testid="search">{useLocation().search}</output>;
    }
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter initialEntries={[url]}>
          <AgentsPage />
          <Probe />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  beforeEach(() => {
    vi.mocked(useBotContext).mockReturnValue({
      bots,
      selectedBot: null,
      selectBot: vi.fn(),
      isAllAgents: false,
      loading: false,
      error: null,
      refreshBots,
    });
    vi.mocked(useEntitlements).mockReturnValue({
      limitFor: () => 1,
      planName: 'Free',
    } as unknown as ReturnType<typeof useEntitlements>);
  });

  it('opens the create dialog when the URL asks for it', () => {
    renderPage('/chatbots?new=1');
    expect(screen.getByRole('heading', { name: 'New chatbot' })).toBeInTheDocument();
  });

  it('stays closed without the param', () => {
    renderPage('/chatbots');
    expect(screen.queryByRole('heading', { name: 'New chatbot' })).not.toBeInTheDocument();
  });

  it('clears the param when the dialog closes, so Back does not reopen it', async () => {
    const user = userEvent.setup();
    renderPage('/chatbots?new=1');

    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'New chatbot' })).not.toBeInTheDocument(),
    );
    expect(screen.getByTestId('search')).toHaveTextContent('');
  });
});
