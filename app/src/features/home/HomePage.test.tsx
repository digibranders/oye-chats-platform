import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Home's shape, which is the whole point of the page.
 *
 * The version this replaces was five stacked full-width bands: a setup card,
 * one warning `Alert` per unhealthy chatbot, a strip of four all-time counters,
 * a flex row faking a table with magic-width spacers, and two hand-rolled copies
 * of `Card interactive`. Nothing was beside anything, and the first product
 * figure sat about a thousand pixels down the page. These are the four claims
 * that fall out of fixing that, each of which a refactor could quietly undo.
 */

const api = vi.hoisted(() => ({
  getDashboardStats: vi.fn(),
  getLeadStats: vi.fn(),
  getLeads: vi.fn(),
  getOfflineMessages: vi.fn(),
}));

vi.mock('../../services/api', () => api);

const bots = vi.hoisted(() => ({
  list: [] as unknown[],
}));

vi.mock('../../context/BotContext', () => ({
  useBotContext: () => ({
    bots: bots.list,
    selectedBot: bots.list[0] ?? null,
    selectBot: vi.fn(),
    refreshBots: vi.fn(),
    loading: false,
    error: null,
    isAllAgents: false,
  }),
}));

vi.mock('../../context/WorkspaceContext', () => ({
  useWorkspace: () => ({ currentWorkspaceId: 7, currentWorkspaceName: 'Northwind' }),
}));

const { HomePage } = await import('./HomePage');

function bot(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    name: 'Acme Support',
    website: 'acme.com',
    indexed_chunk_count: 900,
    widget_installed_at: '2026-08-01T00:00:00Z',
    ...overrides,
  };
}

function renderHome() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/welcome" element={<p>First run</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  bots.list = [bot(), bot({ id: 2, name: 'Northwind Sales', indexed_chunk_count: 0 })];
  // Trailing 30 days, then trailing 60 — the delta is the difference between
  // the two windows, so both are asked for at the workspace level.
  api.getDashboardStats.mockImplementation((_botId?: number, days?: number | null) =>
    Promise.resolve({ total_conversations: days === 60 ? 150 : 100 }),
  );
  api.getLeadStats.mockResolvedValue({ total: 12, qualified: 5 });
  api.getLeads.mockResolvedValue({ leads: [], total: 0, page: 1, limit: 8 });
  api.getOfflineMessages.mockResolvedValue({ total: 3 });
});

describe('HomePage', () => {
  it('titles itself, and puts the greeting in the eyebrow', async () => {
    renderHome();
    // The document's only `h1` used to be "Good afternoon" — a heading that
    // changes three times a day and names no page.
    expect(await screen.findByRole('heading', { level: 1, name: 'Home' })).toBeInTheDocument();
    expect(screen.getByText(/^Good (morning|afternoon|evening)$/)).toBeInTheDocument();
  });

  it('anchors the headline figure to a window and compares it to the last one', async () => {
    renderHome();

    const strip = await screen.findByRole('group', { name: 'Workspace at a glance' });
    expect(await within(strip).findByText('100')).toBeInTheDocument();
    // Stated once, in the card's header — not four times down a row of tiles.
    expect(screen.getByText('Last 30 days')).toBeInTheDocument();
    // 100 this window against 50 in the one before it. No figure in the app
    // carried a delta before this.
    expect(within(strip).getByText('+100%')).toBeInTheDocument();
    expect(within(strip).getByText('vs previous 30 days')).toBeInTheDocument();
  });

  it('lists what needs attention once, as rows, not as one Alert per chatbot', async () => {
    renderHome();

    const section = await screen.findByRole('heading', { level: 2, name: 'Needs attention' });
    const card = section.closest('[data-card]');
    expect(card).not.toBeNull();
    // The untrained chatbot, with its way out — and only it.
    expect(within(card as HTMLElement).getByRole('link', { name: 'Northwind Sales' })).toBeInTheDocument();
    expect(within(card as HTMLElement).getByRole('link', { name: 'Add knowledge' })).toBeInTheDocument();
    expect(within(card as HTMLElement).queryByRole('link', { name: 'Acme Support' })).toBeNull();
  });

  it('renders the chatbots as a real table with a row count', async () => {
    renderHome();

    expect(await screen.findByRole('columnheader', { name: 'Chatbot' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Status' })).toBeInTheDocument();
    // The count `DataTable` draws for every table: "2 chatbots", with the
    // figure in its own `.figure` span.
    expect(
      screen.getByText((_, node) => node?.textContent?.trim() === '2 chatbots'),
    ).toBeTruthy();
  });

  it('lets the setup card be dismissed, and remembers it per workspace', async () => {
    const user = userEvent.setup();
    renderHome();

    const dismiss = await screen.findByRole('button', { name: 'Hide setup' });
    await user.click(dismiss);

    expect(screen.queryByRole('button', { name: 'Hide setup' })).toBeNull();
    // "Capture your first lead" completes on its own or never, so without this
    // the card is permanent furniture for a workspace with no traffic.
    expect(localStorage.getItem('oyechats_home_setup_dismissed_7')).toBe('true');
  });

  it('sends a workspace with no chatbot to the first run, unless it asked not to be', async () => {
    bots.list = [];
    const { unmount } = renderHome();
    expect(await screen.findByText('First run')).toBeInTheDocument();
    unmount();

    // "Skip for now" sets this, and it is what makes Home's empty state
    // reachable at all — it used to be unreachable code behind an
    // unconditional redirect.
    sessionStorage.setItem('oyechats_skip_first_run', 'true');
    renderHome();
    expect(await screen.findByRole('heading', { level: 1, name: 'Home' })).toBeInTheDocument();
    expect(screen.getByText('No chatbots yet')).toBeInTheDocument();
  });
});
