import {
  Badge,
  EmptyState,
  SearchField,
  SegmentedControl,
  Select,
  Stack,
  Toolbar,
  formatDateTime,
  formatNumber,
  type Column,
} from '../../ui';
import { usePlatformList, useUrlState } from '../usePlatform';
import { RecordList } from '../RecordList';
import { byDate, byNumber, byText, includesText, usePagedRows } from '../recordList';
import type { CrawlRow, DocumentRow } from './types';

const VIEWS = [
  { value: 'documents', label: 'Documents' },
  { value: 'crawls', label: 'Crawls' },
];

/** The ingested corpus: what was embedded, and where it came from. */
export function KnowledgeTab() {
  const url = useUrlState();
  const view = url.get('view', 'documents');

  return (
    <Stack>
      <SegmentedControl
        label="Knowledge view"
        value={view}
        onChange={(next) => url.set({ view: next, q: null, source: null })}
        items={VIEWS}
      />
      {view === 'crawls' ? <CrawlsList /> : <DocumentsList />}
    </Stack>
  );
}

function DocumentsList() {
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
    <div className="flex flex-col gap-4">
      <Toolbar>
        <div className="w-full max-w-xs">
          <SearchField
            label="Search documents"
            value={query}
            onValueChange={(next) => url.set({ q: next })}
            placeholder="Document, chatbot or source"
          />
        </div>
        <div className="w-44">
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
        columns={columns}
        paged={paged}
        rowKey={(row) => row.id}
        loading={list.loading}
        error={list.error}
        forbidden={list.forbidden}
        onRetry={list.reload}
        loaded={list.items.length}
        cap={500}
        note={
          <>
            One row is one <strong>document</strong>, grouped from its chunks — the endpoint used to
            return one row per chunk with a literal chunk count of one, no name and a size of zero.
            Characters are counted after chunking, so they run a little ahead of the original file by
            the chunk overlap.
            <br />
            There is no re-embed control here any more. The reindex route acts on a single chunk
            (<code>POST /superadmin/documents/{'{'}chunk_id{'}'}/reindex</code>), and re-embedding one
            arbitrary chunk of a document that may have hundreds is not a thing worth offering. A
            source-level reindex needs a route that does not exist yet.
          </>
        }
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
    </div>
  );
}

function CrawlsList() {
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
    <div className="flex flex-col gap-4">
      <Toolbar>
        <div className="w-full max-w-xs">
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
    </div>
  );
}
