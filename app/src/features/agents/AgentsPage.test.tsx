import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AgentsPage,
  DEFAULT_SORT,
  agentSortParam,
  matchesQuery,
  matchesStatus,
  parseAgentSort,
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
  return {
    bot: full,
    health: agentHealth(full),
    conversations,
    messages: conversations === null ? null : conversations * 3,
    conversationsLoading: false,
  };
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
    const order = sortAgents([live, training, broken], DEFAULT_SORT).map((entry) => entry.bot.id);
    expect(order).toEqual([2, 3, 1]);
  });

  it('sorts by name case-insensitively', () => {
    const a = item({ id: 1, name: 'apple' });
    const b = item({ id: 2, name: 'Banana' });
    expect(
      sortAgents([b, a], { key: 'name', direction: 'asc' }).map((entry) => entry.bot.id),
    ).toEqual([1, 2]);
  });

  it('sorts newest first and pushes an unreadable creation date to the end', () => {
    const undated = item({ id: 4, name: 'Zeta', created_at: 'not-a-date' });
    const order = sortAgents([live, broken, undated], {
      key: 'created',
      direction: 'desc',
    }).map((entry) => entry.bot.id);
    expect(order).toEqual([2, 1, 4]);
  });

  it('sorts busiest first, ranking a chatbot that did not report below a quiet one', () => {
    const busy = item({ id: 5, name: 'Busy' }, 90);
    const quiet = item({ id: 6, name: 'Quiet' }, 0);
    const silent = item({ id: 7, name: 'Silent' }, null);
    const order = sortAgents([silent, quiet, busy], {
      key: 'conversations',
      direction: 'desc',
    }).map((entry) => entry.bot.id);
    expect(order).toEqual([5, 6, 7]);
  });

  it('orders the columns the card grid could not offer at all', () => {
    const rich = item({ id: 11, name: 'Rich', indexed_chunk_count: 900 });
    const thin = item({ id: 12, name: 'Thin', indexed_chunk_count: 4 });
    expect(
      sortAgents([thin, rich], { key: 'passages', direction: 'desc' }).map((e) => e.bot.id),
    ).toEqual([11, 12]);

    const fresh = item({ id: 13, name: 'Fresh', crawl_completed_at: '2026-08-01T00:00:00Z' });
    const stale = item({ id: 14, name: 'Stale', crawl_completed_at: '2026-01-01T00:00:00Z' });
    const never = item({ id: 15, name: 'Never' });
    expect(
      sortAgents([never, stale, fresh], { key: 'trained', direction: 'desc' }).map((e) => e.bot.id),
    ).toEqual([13, 14, 15]);
  });

  it('is stable: equal rows keep one order rather than reshuffling on refetch', () => {
    const first = item({ id: 8, name: 'Alpha' }, 5);
    const second = item({ id: 9, name: 'Bravo' }, 5);
    const busiest = { key: 'conversations', direction: 'desc' } as const;
    expect(sortAgents([second, first], busiest).map((entry) => entry.bot.id)).toEqual([8, 9]);
    expect(sortAgents([first, second], busiest).map((entry) => entry.bot.id)).toEqual([8, 9]);
  });

  it('does not mutate the list it was given', () => {
    const input = [live, broken];
    sortAgents(input, { key: 'name', direction: 'asc' });
    expect(input.map((entry) => entry.bot.id)).toEqual([1, 2]);
  });
});

/**
 * The sort moved from a `Select` to the column heads, but the URL parameter is
 * the same one — a link pasted into a support thread last week still has to open
 * the order it promised.
 */
describe('the sort parameter', () => {
  it('still reads the four words the Select used to write', () => {
    expect(parseAgentSort('newest')).toEqual({ key: 'created', direction: 'desc' });
    expect(parseAgentSort('busiest')).toEqual({ key: 'conversations', direction: 'desc' });
    expect(parseAgentSort('name')).toEqual({ key: 'name', direction: 'asc' });
    expect(parseAgentSort('status')).toEqual(DEFAULT_SORT);
  });

  it('reads a descending column and falls back rather than throwing', () => {
    expect(parseAgentSort('-passages')).toEqual({ key: 'passages', direction: 'desc' });
    expect(parseAgentSort('nonsense')).toEqual(DEFAULT_SORT);
    expect(parseAgentSort(null)).toEqual(DEFAULT_SORT);
  });

  it('writes no parameter at all for the default order', () => {
    expect(agentSortParam(DEFAULT_SORT)).toBeNull();
    expect(agentSortParam({ key: 'trained', direction: 'desc' })).toBe('-trained');
    expect(agentSortParam({ key: 'name', direction: 'asc' })).toBe('name');
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

/**
 * The rows themselves.
 *
 * These contracts used to live on `AgentCard`, which the table replaces. They
 * are the same assertions against the DOM that now carries them: the name is a
 * real link, the actions menu is its sibling rather than nested inside it, an
 * unreported figure is an em dash and never a zero, and the health verdict is
 * on the row.
 */
describe('the table', () => {
  const rows: Bot[] = [
    {
      id: 17,
      name: 'Support Concierge',
      bot_key: 'bot-6a427d4529b9',
      website: 'https://acme.test',
      indexed_chunk_count: 480,
      crawl_completed_at: '2026-07-01T00:00:00Z',
      widget_installed_at: '2026-07-02T00:00:00Z',
      created_at: '2026-01-01T00:00:00Z',
    },
    {
      id: 18,
      name: 'Beta Concierge',
      indexed_chunk_count: 0,
      last_crawl_status: 'failed',
      created_at: '2026-03-01T00:00:00Z',
    },
  ];

  function renderTable(url = '/chatbots') {
    vi.mocked(useBotContext).mockReturnValue({
      bots: rows,
      selectedBot: null,
      selectBot: vi.fn(),
      isAllAgents: false,
      loading: false,
      error: null,
      refreshBots: vi.fn().mockResolvedValue([]),
    });
    vi.mocked(useEntitlements).mockReturnValue({
      limitFor: () => 5,
      planName: 'Standard',
    } as unknown as ReturnType<typeof useEntitlements>);
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter initialEntries={[url]}>
          <AgentsPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  it('names each row with a real link, so a chatbot can be opened in a new tab', () => {
    renderTable();

    expect(screen.getByRole('link', { name: 'Support Concierge' })).toHaveAttribute(
      'href',
      '/chatbots/17/overview',
    );
  });

  it('keeps the actions menu outside the navigational link', () => {
    renderTable();

    const link = screen.getByRole('link', { name: 'Support Concierge' });
    const menu = screen.getByRole('button', { name: 'Actions for Support Concierge' });

    expect(link).not.toContainElement(menu);
    expect(menu).not.toContainElement(link);
  });

  it('carries the health verdict as a word on the row, never as colour alone', () => {
    renderTable();

    expect(screen.getByText('Training failed')).toBeInTheDocument();
    expect(screen.getAllByText('Not installed').length).toBeGreaterThan(0);
  });

  it('never renders an unknown or absent figure as zero', () => {
    renderTable();

    // Beta has no passages, no training date and no reported conversations.
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
    expect(screen.getByText('480')).toBeInTheDocument();
  });

  it('offers every column the card grid could not sort by', () => {
    renderTable();

    for (const header of ['Chatbot', 'Status', 'Conversations', 'Passages', 'Last trained']) {
      expect(screen.getByRole('button', { name: new RegExp(`^${header}$`) })).toBeInTheDocument();
    }
  });

  it('fits its columns inside a 1280 laptop rather than clipping the last badge', () => {
    // Eight columns declaring 58.5rem of width plus the name column measured
    // 1114px against a 966px page: `Column.secondary` only hides below `md`, so
    // between 768 and ~1400 the install state — the column people come here to
    // scan — was the half sliced off at the card's edge, with the scroll
    // affordance a 6px bar under 44px rows. Messages went (it is conversations
    // at a finer grain, and this page ranks chatbots, it does not analyse one),
    // and the actions header is `sr-only` because the word was 15px wider than
    // the menu button under it.
    renderTable();

    expect(screen.queryByRole('button', { name: /^Messages$/ })).toBeNull();
    expect(screen.queryByRole('columnheader', { name: 'Actions' })?.textContent).toBe('Actions');
  });

  it('states the result of a filter once, in the toolbar, and not again as a card of tiles', () => {
    renderTable();

    expect(screen.getByRole('status')).toHaveTextContent('2 chatbots');
    // The summary card restated three of the four filter segments as 28px tiles.
    expect(screen.queryByText('Needs attention', { selector: 'p' })).not.toBeInTheDocument();
  });
});
