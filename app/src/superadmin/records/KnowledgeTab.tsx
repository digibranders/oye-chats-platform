import {
  Badge,
  EmptyState,
  SearchField,
  Select,
  Stack,
  Toolbar,
  formatDateTime,
  formatNumber,
  type Column,
} from '../../ui';
import { usePlatformList, useUrlState } from '../usePlatform';
import { RecordList } from '../RecordList';
import { byDate, byNumber, byText, includesText, usePagedRows } from '../recordListState';
import type { CrawlRow, DocumentRow } from './types';

/** The ingested corpus: what was embedded, and where it came from. */
export function DocumentsTab() {
  const url = useUrlState();
  const query = url.get('q');
  const source = url.get('source');
  const list = usePlatformList<DocumentRow>('/documents');

  const paged = usePagedRows(list.items, {
    url,
    filter: (row) =>
      (!source || row.source === source) &&
      includesText([row.title, row.bot_name, row.source, row.id], query),
    comparators: {
      // Text, not number: the id is a file hash now that the list is grouped
      // per source. Sorting it numerically compared NaN to NaN and left the
      // rows in whatever order the server sent.
      id: byText((row) => row.id),
      title: byText((row) => row.title),
      bot_name: byText((row) => row.bot_name),
      source: byText((row) => row.source),
      chunk_count: byNumber((row) => row.chunk_count),
      content_chars: byNumber((row) => row.content_chars),
      created_at: byDate((row) => row.created_at),
    },
  });

  const columns: Column<DocumentRow>[] = [
    {
      key: 'title',
      header: 'Document',
      pinned: true,
      sortable: true,
      render: (row) => (
        <span className="block max-w-xs truncate font-medium">{row.title ?? row.id}</span>
      ),
    },
    {
      key: 'bot_name',
      header: 'Chatbot',
      sortable: true,
      render: (row) => row.bot_name ?? (row.bot_id ? `#${row.bot_id}` : '—'),
    },
    { key: 'source', header: 'Source', sortable: true, render: (row) => <Badge>{row.source}</Badge> },
    {
      key: 'chunk_count',
      header: 'Chunks',
      align: 'right',
      sortable: true,
      render: (row) => <span className="figure">{formatNumber(row.chunk_count)}</span>,
    },
    {
      key: 'content_chars',
      header: 'Characters',
      align: 'right',
      sortable: true,
      secondary: true,
      render: (row) => <span className="figure">{formatNumber(row.content_chars)}</span>,
    },
    {
      key: 'is_active',
      header: 'State',
      sortable: false,
      // A plan lapse deactivates a workspace's knowledge without deleting it,
      // and a super-admin looking at a customer who says "my chatbot forgot
      // everything" needs to see that here rather than infer it from billing.
      render: (row) =>
        row.is_active ? (
          <Badge tone="success">Answering</Badge>
        ) : (
          <Badge tone="warning">Deactivated</Badge>
        ),
    },
    {
      key: 'created_at',
      header: 'Ingested',
      sortable: true,
      secondary: true,
      render: (row) => formatDateTime(row.created_at),
    },
  ];

  return (
    <Stack>
      <Toolbar sticky>
        <div className="w-72 max-w-full">
          <SearchField
            label="Search documents"
            value={query}
            onValueChange={(next) => url.set({ q: next })}
            placeholder="Document, chatbot or source"
          />
        </div>
        <div className="w-48">
          <Select
            aria-label="Filter by source"
            value={source}
            onChange={(event) => url.set({ source: event.target.value })}
            options={[
              { value: '', label: 'Any source' },
              { value: 'upload', label: 'Upload' },
              { value: 'crawl', label: 'Crawl' },
            ]}
          />
        </div>
      </Toolbar>
      <RecordList
        caption="Ingested documents"
        rowNoun="document"
        what="ingested documents"
        columns={columns}
        paged={paged}
        rowKey={(row) => row.id}
        loading={list.loading}
        error={list.error}
        forbidden={list.forbidden}
        onRetry={list.reload}
        loaded={list.items.length}
        cap={500}
        note="One row is one document, grouped from its chunks. Characters are counted after chunking, so they run a little ahead of the original file by the chunk overlap."
        empty={
          <EmptyState
            compact
            title={query || source ? 'Nothing matched' : 'Nothing ingested'}
            description={
              query || source
                ? 'No document matches this filter.'
                : 'No account has uploaded a document or crawled a site.'
            }
          />
        }
      />
    </Stack>
  );
}

export function CrawlsTab() {
  const url = useUrlState();
  const query = url.get('q');
  const list = usePlatformList<CrawlRow>('/crawls');

  const paged = usePagedRows(list.items, {
    url,
    filter: (row) => includesText([row.url, row.bot_name, row.client_name], query),
    comparators: {
      url: byText((row) => row.url),
      bot_name: byText((row) => row.bot_name),
      client_name: byText((row) => row.client_name),
      chunk_count: byNumber((row) => row.chunk_count),
      created_at: byDate((row) => row.created_at),
    },
  });

  const columns: Column<CrawlRow>[] = [
    {
      key: 'url',
      header: 'Crawled URL',
      pinned: true,
      sortable: true,
      render: (row) => <span className="truncate font-medium">{row.url}</span>,
    },
    { key: 'bot_name', header: 'Chatbot', sortable: true, render: (row) => row.bot_name ?? '—' },
    { key: 'client_name', header: 'Account', sortable: true, render: (row) => row.client_name ?? '—' },
    {
      key: 'chunk_count',
      header: 'Chunks',
      align: 'right',
      sortable: true,
      render: (row) => formatNumber(row.chunk_count),
    },
    {
      key: 'created_at',
      header: 'First ingested',
      sortable: true,
      secondary: true,
      render: (row) => formatDateTime(row.created_at),
    },
  ];

  return (
    <Stack>
      <Toolbar sticky>
        <div className="w-72 max-w-full">
          <SearchField
            label="Search crawls"
            value={query}
            onValueChange={(next) => url.set({ q: next })}
            placeholder="URL, chatbot or account"
          />
        </div>
      </Toolbar>
      <RecordList
        caption="Crawl jobs, grouped from their chunks"
        rowNoun="crawl"
        what="crawl records"
        columns={columns}
        paged={paged}
        rowKey={(row) => row.id}
        loading={list.loading}
        error={list.error}
        forbidden={list.forbidden}
        onRetry={list.reload}
        loaded={list.items.length}
        cap={200}
        note="There is no crawl table: these rows are reconstructed by grouping crawled chunks on their file hash, so there is no status, no error and no completion time to show. A crawl that failed before writing a chunk does not appear at all."
        empty={
          <EmptyState
            compact
            title={query ? 'Nothing matched' : 'No crawls'}
            description={
              query
                ? 'No crawl matches this search.'
                : 'No account has ingested a site by URL, or none of them produced a chunk.'
            }
          />
        }
      />
    </Stack>
  );
}
