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
  getCurrentUser: vi.fn(),
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

/**
 * The page's `h1`, which is the greeting and therefore moves with the clock
 * and with whether `/auth/me` has landed. Tests that only need "the page has
 * rendered" match on this rather than pinning one time of day.
 */
const GREETING = /^Good (morning|afternoon|evening)(, \w+)?$/;

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
  // Lowercase on purpose: it is what the account actually stores, and the
  // greeting is expected to capitalise it rather than print it mid-sentence.
  api.getCurrentUser.mockResolvedValue({ name: 'gaurav', email: 'gaurav@fynix.digital' });
});

describe('HomePage', () => {
  it('greets the person by name, and keeps the emoji out of the accessible name', async () => {
    renderHome();
    // This reverses an earlier decision on purpose. The greeting was moved to
    // the eyebrow when it was a bare "Good afternoon" — a heading that named
    // no page — but with the person's name in it, it names a personal
    // dashboard, which is what this page is. "Home" still reaches assistive
    // tech, from the shell's breadcrumb.
    //
    // The accessible name must be the greeting ALONE: the emoji is `aria-hidden`,
    // so matching it here would fail, and that is the point of the assertion.
    const heading = await screen.findByRole('heading', {
      level: 1,
      name: /^Good (morning|afternoon|evening), Gaurav$/,
    });
    expect(heading).toBeInTheDocument();
    // Printed, not hidden — the earlier version rendered the `h1` `sr-only`.
    expect(heading).not.toHaveClass('sr-only');
  });

  it('greets without a name rather than greeting an email address', async () => {
    // `/auth/me` carries no name for accounts that never set one, and the
    // account menu falls back to the email. A greeting must not: "Good
    // afternoon, gaurav@fynix.digital" is worse than no name at all.
    api.getCurrentUser.mockResolvedValue({ email: 'gaurav@fynix.digital' });
    renderHome();
    expect(
      await screen.findByRole('heading', {
        level: 1,
        name: /^Good (morning|afternoon|evening)$/,
      }),
    ).toBeInTheDocument();
  });

  it('anchors the headline figure to a window and compares it to the last one', async () => {
    renderHome();

    const strip = await screen.findByRole('group', { name: 'Workspace at a glance' });
    expect(await within(strip).findByText('100')).toBeInTheDocument();
    // Stated once, by the strip's own caption — not four times down a row of
    // tiles, and not again as a `CardHeader` action beside it.
    expect(screen.getAllByText('Last 30 days')).toHaveLength(1);
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

  it('says the chatbot\u2019s state once, and its consequence on the other track', async () => {
    renderHome();

    // The badge in the table is the state. It appears exactly once per chatbot:
    // the attention row above it used to print the same words, beside its own
    // copy of the same button.
    const table = (await screen.findByRole('columnheader', { name: 'Status' })).closest('table');
    expect(within(table as HTMLElement).getByText('Nothing to answer from')).toBeInTheDocument();
    // Once on screen. The remaining occurrence is the attention row's status
    // dot naming itself for assistive tech, which is the alternative text for a
    // 6px circle and not a second copy of the sentence.
    const visible = screen
      .getAllByText('Nothing to answer from')
      .filter((node) => !node.classList.contains('sr-only'));
    expect(visible).toHaveLength(1);

    // What the attention row carries instead: why it matters, which no status
    // badge can say.
    expect(screen.getByText('It will tell visitors it does not know.')).toBeInTheDocument();
    // And one call to action for it, not two forty pixels apart.
    expect(screen.getAllByRole('link', { name: 'Add knowledge' })).toHaveLength(1);
  });

  it('bounds the activity rail and points at the page that is not bounded', async () => {
    // Twenty-four rows came back for a `limit: 6` request and the card drew all
    // of them, running the aside 785px past the bottom of the work column at
    // 1440. `Columns` requires `main` to be the taller track.
    api.getLeads.mockResolvedValue({
      leads: Array.from({ length: 24 }, (_, index) => ({
        session_id: `s${index}`,
        name: `Visitor ${index}`,
        last_active_at: '2026-08-20T09:00:00Z',
      })),
      total: 24,
    });
    renderHome();

    const heading = await screen.findByRole('heading', { level: 2, name: 'Recent leads' });
    const card = heading.closest('[data-card]') as HTMLElement;
    expect(await within(card).findAllByRole('listitem')).toHaveLength(6);
    expect(within(card).getByRole('link', { name: 'See all' })).toHaveAttribute('href', '/leads');
  });

  it('does not restate the rail at the bottom of its own aside', async () => {
    renderHome();
    await screen.findByRole('heading', { level: 1, name: GREETING });

    // Two 76px tiles linking to Inbox and Leads — rows two and three of the
    // navigation rail, repeated below the fold of the page they are already on.
    expect(screen.queryByText('Live conversations and offline messages')).toBeNull();
    expect(screen.queryByText('Captured contacts, scored')).toBeNull();
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
    expect(await screen.findByRole('heading', { level: 1, name: GREETING })).toBeInTheDocument();
    expect(screen.getByText('No chatbots yet')).toBeInTheDocument();
  });
});
