import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveRange, type RangeKey } from './range';

/**
 * `GET /analytics/visitors` pages over SESSIONS: `limit` defaults to 500 on the
 * server, caps at 1000, and the response is a deduped visitor array with no
 * total. The client used to send no `limit` at all, so a workspace with 4,000
 * sessions read "180 visitors", exported those 180, and was advised by the
 * empty state to widen a period that cannot reach past the cap.
 */

const PAGE_SIZE = 1000;

const api = vi.hoisted(() => ({ getVisitorsData: vi.fn() }));
vi.mock('../../services/api', () => api);

vi.mock('../../context/BotContext', () => ({
  useBotContext: () => ({ bots: [{ id: 1, name: 'Acme' }], selectedBot: null, loading: false }),
}));

const { VisitorsTab, VISITORS_READ_LIMIT } = await import('./VisitorsTab');

/** One API row: a deduped visitor, carrying every session it owns. */
function visitor(index: number, sessions: number, lastActiveAt = '2026-08-19T10:00:00Z') {
  const ids = Array.from({ length: sessions }, (_, n) => `s${index}-${n}`);
  return {
    session_id: ids.join(','),
    all_session_ids: ids,
    visitor: `user${index}`,
    location: 'Pune, India',
    device: 'Desktop',
    chats: sessions * 4,
    last_active_at: lastActiveAt,
  };
}

function renderTab(range: RangeKey = '30d') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <VisitorsTab botId={1} range={resolveRange(range)} />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  api.getVisitorsData.mockResolvedValue([]);
});

describe('VisitorsTab', () => {
  it('asks for the biggest page the endpoint allows', async () => {
    // The client is what sends the ceiling, so this asserts against the real
    // module rather than the mock the rest of the file renders against. Sending
    // no `limit` at all took the server's default of 500, silently.
    const actual = await vi.importActual<typeof import('../../services/api')>(
      '../../services/api',
    );
    const get = vi
      .spyOn(actual.httpClient, 'get')
      .mockResolvedValue({ data: [] } as never);

    await actual.getVisitorsData(1);

    // The tab restates the ceiling rather than importing it (sibling suites
    // mock this module wholesale), so the two must be checked against each
    // other or the caption can quietly start naming the wrong number.
    expect(actual.VISITORS_PAGE_SIZE).toBe(PAGE_SIZE);
    expect(VISITORS_READ_LIMIT).toBe(actual.VISITORS_PAGE_SIZE);
    const [url] = get.mock.calls[0] as [string];
    expect(url).toContain('bot_id=1');
    expect(url).toContain(`limit=${PAGE_SIZE}`);
    get.mockRestore();
  });

  it('says so when the read filled its page, rather than presenting a slice as the whole', async () => {
    // 250 visitors, four sessions each: 1,000 sessions, exactly the ceiling.
    api.getVisitorsData.mockResolvedValue(
      Array.from({ length: 250 }, (_, index) => visitor(index, 4)),
    );
    renderTab();
    expect(await screen.findByText(/showing the most recent 1,000 conversations/i)).toBeInTheDocument();
    expect(screen.getByText(/export covers only these/i)).toBeInTheDocument();
  });

  it('says nothing of the sort when the whole history fits', async () => {
    api.getVisitorsData.mockResolvedValue(
      Array.from({ length: 12 }, (_, index) => visitor(index, 2)),
    );
    renderTab();
    await screen.findByText('user0');
    expect(screen.queryByText(/showing the most recent/i)).not.toBeInTheDocument();
  });

  it('stops advising a wider period when a wider period cannot reach further back', async () => {
    // Every visitor is older than the window, so the table is empty for the
    // range and the page is also truncated. "Try a wider period" is advice that
    // cannot work: the cap is on recency, not on the window.
    api.getVisitorsData.mockResolvedValue(
      Array.from({ length: 250 }, (_, index) => visitor(index, 4, '2020-01-01T10:00:00Z')),
    );
    renderTab('7d');
    expect(await screen.findByText(/whatever period you pick/i)).toBeInTheDocument();
    expect(screen.queryByText(/try a wider period/i)).not.toBeInTheDocument();
  });
});
