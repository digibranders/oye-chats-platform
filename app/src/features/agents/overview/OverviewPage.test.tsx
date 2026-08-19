import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OverviewPage } from './OverviewPage';
import { useAgent } from '../../../context/AgentContext';
import { useOverviewData, type OverviewData, type Section } from './overview-data';
import type { Bot } from '../../../types/domain';

vi.mock('../../../context/AgentContext', () => ({ useAgent: vi.fn() }));
vi.mock('./overview-data', async () => {
  const actual = await vi.importActual<typeof import('./overview-data')>('./overview-data');
  return { ...actual, useOverviewData: vi.fn() };
});

const trained: Bot = {
  id: 17,
  name: 'Support Concierge',
  bot_key: 'bot-6a427d4529b9',
  website: 'https://example.test',
  widget_installed_at: '2026-07-01T00:00:00Z',
  crawl_completed_at: '2026-07-01T00:00:00Z',
  last_crawl_status: 'completed',
  indexed_chunk_count: 42,
  created_at: '2026-07-12T00:00:00.000Z',
};

function section<T>(data: T, overrides: Partial<Section<T>> = {}): Section<T> {
  return { data, loading: false, error: null, retry: vi.fn(), ...overrides };
}

function overviewData(overrides: Partial<OverviewData> = {}): OverviewData {
  return {
    figures: section({
      conversations: 40,
      messages: 210,
      activeVisitors: 2,
      demoShares: 8,
      demoOpens: 6,
      demoOpenRate: 75,
    }),
    activity: section([]),
    questions: section([]),
    ratings: section({ average: 4.6, total: 11 }),
    resolution: section({ rate: 82, total: 20 }),
    refreshing: false,
    refreshAll: vi.fn(),
    ...overrides,
  };
}

function mountAgent(agent: Bot | null, rest: Partial<ReturnType<typeof useAgent>> = {}) {
  vi.mocked(useAgent).mockReturnValue({
    agent,
    agentId: agent ? String(agent.id) : null,
    loading: false,
    error: null,
    refresh: vi.fn(),
    ...rest,
  });
}

function renderPage(url = '/chatbots/17/overview') {
  render(
    <MemoryRouter initialEntries={[url]}>
      <OverviewPage />
    </MemoryRouter>,
  );
}

describe('OverviewPage', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(useOverviewData).mockReturnValue(overviewData());
  });

  /**
   * The layout that rendered the chatbot's name as a second `h1` is gone. The
   * rail names the chatbot and the top bar breadcrumbs it, so this page owns
   * exactly one heading.
   */
  it('renders exactly one h1', () => {
    mountAgent(trained);
    renderPage();

    const headings = screen.getAllByRole('heading', { level: 1 });
    expect(headings).toHaveLength(1);
    expect(headings[0]).toHaveTextContent('Overview');
  });

  /** Resolution rate and average rating each used to appear twice on one screen. */
  it('states each quality figure once', () => {
    mountAgent(trained);
    renderPage();

    expect(screen.getAllByText('Resolution rate')).toHaveLength(1);
    expect(screen.getAllByText('Average rating')).toHaveLength(1);
  });

  /**
   * The card labelled "7-day performance" read all-time values because no period
   * was ever passed. The range is in the URL now and every figure is anchored.
   */
  it('reads the range out of the URL and anchors the figures to it', () => {
    mountAgent(trained);
    renderPage('/chatbots/17/overview?days=7');

    expect(vi.mocked(useOverviewData)).toHaveBeenCalledWith(17, 7);
    expect(screen.getAllByText('Last 7 days').length).toBeGreaterThan(0);
    expect(screen.getByRole('radio', { name: '7 days' })).toBeChecked();
  });

  it('puts a chosen range into the URL so a refresh and a shared link both work', async () => {
    const user = userEvent.setup();
    mountAgent(trained);
    renderPage();

    expect(screen.getByRole('radio', { name: '30 days' })).toBeChecked();
    await user.click(screen.getByRole('radio', { name: '90 days' }));

    expect(vi.mocked(useOverviewData)).toHaveBeenLastCalledWith(17, 90);
  });

  /** The demo funnel had zero references anywhere in the app. */
  it('surfaces the demo-share funnel', () => {
    mountAgent(trained);
    renderPage();

    expect(screen.getByText('Links shared')).toBeInTheDocument();
    expect(screen.getByText('Demos opened')).toBeInTheDocument();
    expect(screen.getByText('Open rate')).toBeInTheDocument();
  });

  /** The old CTA pointed at a per-agent route that redirected back to this page. */
  it('links the deep dive to the analytics destination that exists', () => {
    mountAgent(trained);
    renderPage();

    expect(screen.getByRole('link', { name: 'Full analytics' })).toHaveAttribute(
      'href',
      '/analytics',
    );
  });

  /** A failed section used to be a dead card with no way to reload it. */
  it('gives a failed section its own retry', async () => {
    const user = userEvent.setup();
    const retry = vi.fn();
    mountAgent(trained);
    vi.mocked(useOverviewData).mockReturnValue(
      overviewData({
        figures: section(
          {
            conversations: 0,
            messages: 0,
            activeVisitors: 0,
            demoShares: 0,
            demoOpens: 0,
            demoOpenRate: null,
          },
          { error: 'The analytics service is unavailable.', retry },
        ),
      }),
    );
    renderPage();

    expect(screen.getByText('We could not load these figures')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(retry).toHaveBeenCalled();
  });

  /** Refreshing has to reload the chatbot record, not only the metrics. */
  it('reloads the chatbot record as well as the metrics', async () => {
    const user = userEvent.setup();
    const refresh = vi.fn().mockResolvedValue([]);
    const refreshAll = vi.fn();
    mountAgent(trained, { refresh });
    vi.mocked(useOverviewData).mockReturnValue(overviewData({ refreshAll }));
    renderPage();

    await user.click(screen.getByRole('button', { name: 'Refresh' }));

    expect(refresh).toHaveBeenCalled();
    expect(refreshAll).toHaveBeenCalled();
  });

  it('offers the fix the health verdict asks for', () => {
    mountAgent({ ...trained, indexed_chunk_count: 0, last_crawl_status: 'failed' });
    renderPage();

    expect(screen.getByRole('link', { name: 'Fix training' })).toHaveAttribute(
      'href',
      '/chatbots/17/knowledge',
    );
  });

  it('offers a retry when the chatbot itself could not be loaded', () => {
    mountAgent(null, { error: { message: 'Network is down', status: null } });
    renderPage();

    expect(screen.getByText('We could not load this chatbot')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});
