import { useState } from 'react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Column } from '../../ui';
import { platform } from '../client';
import { useUrlState } from '../usePlatform';
import { RecordList } from '../RecordList';
import { usePagedRows } from '../recordList';
import { KnowledgeTab } from './KnowledgeTab';
import { SessionDetailPage } from './ConversationsTab';

vi.mock('../client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../client')>();
  return {
    ...actual,
    platform: {
      get: vi.fn(),
      post: vi.fn(),
      patch: vi.fn(),
      put: vi.fn(),
      remove: vi.fn(),
    },
  };
});

const mocked = vi.mocked(platform);

interface Row {
  id: number;
  name: string;
}

const COLUMNS: Column<Row>[] = [
  { key: 'name', header: 'Name', sortable: true, render: (row) => row.name },
];

function emptyPage(overrides: Partial<Parameters<typeof RecordList<Row>>[0]['paged']> = {}) {
  return {
    rows: [],
    page: 1,
    total: 0,
    onPageChange: vi.fn(),
    sort: null,
    onSortChange: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('RecordList — the four states', () => {
  it('reports busy while loading rather than showing an empty table', () => {
    render(
      <RecordList caption="Rows" columns={COLUMNS} paged={emptyPage()} rowKey={String} loading />,
    );
    expect(screen.getByRole('table')).toHaveAttribute('aria-busy', 'true');
    expect(screen.queryByText('Nothing here')).not.toBeInTheDocument();
  });

  it('renders the caller’s empty state, which says why it is empty', () => {
    render(
      <RecordList
        caption="Rows"
        columns={COLUMNS}
        paged={emptyPage()}
        rowKey={String}
        empty={<p>No chatbot matches this filter.</p>}
      />,
    );
    expect(screen.getByText('No chatbot matches this filter.')).toBeInTheDocument();
  });

  it('offers a way back from an error instead of a dead card', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    render(
      <RecordList
        caption="Rows"
        columns={COLUMNS}
        paged={emptyPage()}
        rowKey={String}
        error="The server did not answer."
        onRetry={onRetry}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('The server did not answer.');
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalled();
  });

  it('distinguishes forbidden from failed, and renders no table at all', () => {
    // "We could not load this" would send an operator hunting an outage that is
    // not there. A 403 is a different answer and gets a different screen.
    render(
      <RecordList
        caption="Rows"
        columns={COLUMNS}
        paged={emptyPage()}
        rowKey={String}
        forbidden
        error="Forbidden"
      />,
    );
    expect(screen.getByText('You do not have access to these records')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByText('Forbidden')).not.toBeInTheDocument();
  });
});

describe('RecordList — the endpoint cap', () => {
  it('says so when the response is exactly the server cap', () => {
    render(
      <RecordList
        caption="Rows"
        columns={COLUMNS}
        paged={emptyPage({ rows: [{ id: 1, name: 'a' }], total: 500 })}
        rowKey={(row) => String(row.id)}
        loaded={500}
        cap={500}
      />,
    );
    expect(screen.getByText('This is not the whole set')).toBeInTheDocument();
  });

  it('stays quiet when the endpoint returned everything it had', () => {
    render(
      <RecordList
        caption="Rows"
        columns={COLUMNS}
        paged={emptyPage({ rows: [{ id: 1, name: 'a' }], total: 12 })}
        rowKey={(row) => String(row.id)}
        loaded={12}
        cap={500}
      />,
    );
    expect(screen.queryByText('This is not the whole set')).not.toBeInTheDocument();
  });
});

describe('RecordList — server-style paging', () => {
  const rows = Array.from({ length: 10 }, (_, index) => ({ id: index, name: `Row ${index}` }));

  it('reports the whole total, not the size of the page it was handed', async () => {
    const user = userEvent.setup();
    const onPageChange = vi.fn();
    render(
      <RecordList
        caption="Rows"
        columns={COLUMNS}
        paged={emptyPage({ rows, total: 137, page: 2, onPageChange })}
        rowKey={(row) => String(row.id)}
        pageSize={10}
      />,
    );
    const pager = screen.getByRole('navigation', { name: 'Rows pages' });
    expect(pager).toHaveTextContent('11');
    expect(pager).toHaveTextContent('137');

    await user.click(within(pager).getByRole('button', { name: 'Next page' }));
    expect(onPageChange).toHaveBeenCalledWith(3);
  });

  it('is reachable by keyboard, from the sort control through to the pager', async () => {
    const user = userEvent.setup();
    const onSortChange = vi.fn();
    const onPageChange = vi.fn();
    render(
      <RecordList
        caption="Rows"
        columns={COLUMNS}
        paged={emptyPage({ rows, total: 137, page: 2, onPageChange, onSortChange })}
        rowKey={(row) => String(row.id)}
        pageSize={10}
      />,
    );
    const sort = screen.getByRole('button', { name: /Name/ });
    sort.focus();
    await user.keyboard('{Enter}');
    expect(onSortChange).toHaveBeenCalledWith({ key: 'name', direction: 'asc' });

    const previous = screen.getByRole('button', { name: 'Previous page' });
    previous.focus();
    await user.keyboard('{Enter}');
    expect(onPageChange).toHaveBeenCalledWith(1);
  });
});

/** Renders the URL so a test can assert what a colleague would receive if they were sent the link. */
function UrlProbe() {
  const location = useLocation();
  return <span data-testid="url">{`${location.pathname}${location.search}`}</span>;
}

function PagedProbe({ rows }: { rows: Row[] }) {
  const url = useUrlState();
  const [query, setQuery] = useState('');
  const paged = usePagedRows(rows, {
    url,
    pageSize: 2,
    filter: (row) => row.name.includes(query),
  });
  return (
    <>
      <UrlProbe />
      <button type="button" onClick={() => setQuery('9')}>
        Filter
      </button>
      <RecordList
        caption="Rows"
        columns={COLUMNS}
        paged={paged}
        rowKey={(row) => String(row.id)}
        pageSize={2}
      />
    </>
  );
}

describe('usePagedRows', () => {
  const rows = Array.from({ length: 10 }, (_, index) => ({ id: index, name: `Row ${index}` }));

  it('keeps the page and the sort in the URL, so a filtered list is a link', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/platform/records']}>
        <PagedProbe rows={rows} />
      </MemoryRouter>,
    );

    expect(screen.getByText('Row 0')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Next page' }));
    await waitFor(() => expect(screen.getByTestId('url')).toHaveTextContent('page=2'));
    expect(screen.getByText('Row 2')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Name/ }));
    await waitFor(() => expect(screen.getByTestId('url')).toHaveTextContent('sort=name%3Aasc'));
    // A new order makes the old page number meaningless, so it is dropped.
    expect(screen.getByTestId('url')).not.toHaveTextContent('page=2');
  });

  it('pages the whole filtered set, not the slice it last rendered', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/platform/records?page=3']}>
        <PagedProbe rows={rows} />
      </MemoryRouter>,
    );
    // Page 3 of ten rows at two per page.
    expect(screen.getByText('Row 4')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Filter' }));
    // One row matches, so the stale page 3 is clamped rather than blanking.
    expect(screen.getByText('Row 9')).toBeInTheDocument();
  });
});

describe('Documents', () => {
  it('offers no re-embed control, because the row is a document and the route takes a chunk', async () => {
    // The list is grouped per source now, so `id` is a file hash. The reindex
    // route addresses a single chunk by integer id, and re-embedding one
    // arbitrary chunk of a document that may have hundreds is not a thing
    // worth offering. The button is gone until a per-source route exists.
    mocked.get.mockResolvedValue([
      {
        id: 'a3f19c02',
        bot_id: 1,
        bot_name: 'Support',
        client_id: 1,
        source: 'upload',
        title: 'Handbook.pdf',
        chunk_count: 42,
        content_chars: 91_204,
        is_active: true,
        created_at: '2026-08-01T10:00:00Z',
      },
    ]);
    render(
      <MemoryRouter initialEntries={['/platform/records?tab=knowledge']}>
        <KnowledgeTab />
      </MemoryRouter>,
    );

    expect(await screen.findByText('Handbook.pdf')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reindex' })).not.toBeInTheDocument();
    expect(mocked.post).not.toHaveBeenCalled();
  });

  it('shows the real chunk count and size the endpoint used to hard-code', async () => {
    mocked.get.mockResolvedValue([
      {
        id: 'a3f19c02',
        bot_id: 1,
        bot_name: 'Support',
        client_id: 1,
        source: 'upload',
        title: 'Handbook.pdf',
        chunk_count: 42,
        content_chars: 91_204,
        is_active: false,
        created_at: '2026-08-01T10:00:00Z',
      },
    ]);
    render(
      <MemoryRouter initialEntries={['/platform/records?tab=knowledge']}>
        <KnowledgeTab />
      </MemoryRouter>,
    );

    expect(await screen.findByText('42')).toBeInTheDocument();
    expect(screen.getByText('91,204')).toBeInTheDocument();
    // A plan lapse deactivates knowledge without deleting it; a super-admin
    // answering "my chatbot forgot everything" needs to see that here.
    expect(screen.getByText('Deactivated')).toBeInTheDocument();
  });
});

/**
 * One conversation as `GET /superadmin/sessions/{id}` returns it.
 *
 * Tests that need a different shape override a field rather than restating the
 * payload, so a field added to the wire is added in exactly one place here.
 */
function detail(
  overrides: Record<string, unknown> = {},
): { session: Record<string, unknown>; messages: Record<string, unknown>[] } {
  const { messages, ...session } = overrides;
  return {
    session: {
      id: '9f2c7a1e-4d5b-4c8a-9c11-2f3a4b5c6d7e',
      bot_id: 1,
      bot_name: 'Support',
      client_id: 3,
      client_name: 'Acme',
      status: 'closed',
      visitor_name: null,
      visitor_email: null,
      rating: 4,
      created_at: '2026-08-01T10:00:00Z',
      last_activity_at: null,
      ...session,
    },
    messages: (messages as Record<string, unknown>[] | undefined) ?? [],
  };
}

describe('Conversation detail', () => {
  it('fetches a UUID id, now that the endpoint accepts one', async () => {
    // This route declared its path parameter as `int` against a String primary
    // key, so it 422'd every real conversation and the console refused to call
    // it at all. Both halves are fixed; the guard now only mirrors the server's
    // length and shape bounds.
    mocked.get.mockResolvedValue(detail());
    render(
      <MemoryRouter initialEntries={['/platform/records/sessions/9f2c7a1e-4d5b-4c8a-9c11-2f3a4b5c6d7e']}>
        <Routes>
          <Route path="/platform/records/sessions/:sessionId" element={<SessionDetailPage />} />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(mocked.get).toHaveBeenCalled());
    expect(mocked.get.mock.calls[0][0]).toBe('/sessions/9f2c7a1e-4d5b-4c8a-9c11-2f3a4b5c6d7e');
  });

  it('says there is no such conversation rather than crashing on a payload without one', async () => {
    // The handler 404s a missing id, so this shape should never arrive. If it
    // ever does, the page reading `detail.session.status` straight through
    // would throw during render and leave a blank screen behind — the four
    // states exist so a surprise from the server is still legible.
    mocked.get.mockResolvedValue({ session: null, messages: [] });
    render(
      <MemoryRouter initialEntries={['/platform/records/sessions/9f2c7a1e-4d5b-4c8a-9c11-2f3a4b5c6d7e']}>
        <Routes>
          <Route path="/platform/records/sessions/:sessionId" element={<SessionDetailPage />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText('No such conversation')).toBeInTheDocument();
  });

  it('shows the visitor and last activity the endpoint now returns', async () => {
    // These three fields were permanently null because the handler read
    // attributes the model does not have. They carry data now, so the console
    // shows them instead of describing them as missing.
    mocked.get.mockResolvedValue(
      detail({
        visitor_name: 'Priya Raman',
        visitor_email: 'priya@northwind.test',
        last_activity_at: '2026-08-19T09:41:00Z',
      }),
    );
    render(
      <MemoryRouter initialEntries={['/platform/records/sessions/9f2c7a1e-4d5b-4c8a-9c11-2f3a4b5c6d7e']}>
        <Routes>
          <Route path="/platform/records/sessions/:sessionId" element={<SessionDetailPage />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText('Priya Raman')).toBeInTheDocument();
    expect(screen.getByText('priya@northwind.test')).toBeInTheDocument();
    expect(screen.getByText('Last active')).toBeInTheDocument();
  });

  it('still refuses an id the server would reject on shape, without firing a request', async () => {
    render(
      <MemoryRouter initialEntries={['/platform/records/sessions/not%20a%20valid%20id']}>
        <Routes>
          <Route path="/platform/records/sessions/:sessionId" element={<SessionDetailPage />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText('That is not a conversation id')).toBeInTheDocument();
    expect(mocked.get).not.toHaveBeenCalled();
  });

  it('fetches a conversation whose id the endpoint can address', async () => {
    mocked.get.mockResolvedValue(
      detail({
        id: '42',
        messages: [
          {
            id: 1,
            session_id: '42',
            role: 'user',
            content: 'Hello',
            created_at: '2026-08-01T10:00:00Z',
            trace_id: null,
          },
        ],
      }),
    );

    render(
      <MemoryRouter initialEntries={['/platform/records/sessions/42']}>
        <Routes>
          <Route path="/platform/records/sessions/:sessionId" element={<SessionDetailPage />} />
        </Routes>
      </MemoryRouter>,
    );
    // Asserted on the path alone: the hook is free to pass query params alongside it.
    await waitFor(() => expect(mocked.get.mock.calls[0]?.[0]).toBe('/sessions/42'));
    expect(await screen.findByText('Hello')).toBeInTheDocument();
  });
});
