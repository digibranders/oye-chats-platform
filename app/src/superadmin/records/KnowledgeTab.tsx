import { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import {
  Alert,
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  SearchField,
  SegmentedControl,
  Select,
  Stack,
  Toolbar,
  formatDateTime,
  formatNumber,
  toast,
  type Column,
} from '../../ui';
import { platform } from '../client';
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
  const [pending, setPending] = useState<DocumentRow | null>(null);
  const [error, setError] = useState<string | null>(null);

  const paged = usePagedRows(list.items, {
    url,
    filter: (row) =>
      (!source || row.source === source) && includesText([row.bot_name, row.source, row.id], query),
    comparators: {
      id: byNumber((row) => row.id),
      bot_name: byText((row) => row.bot_name),
      source: byText((row) => row.source),
      created_at: byDate((row) => row.created_at),
    },
  });

  const columns: Column<DocumentRow>[] = [
    {
      key: 'id',
      header: 'Chunk',
      pinned: true,
      sortable: true,
      render: (row) => <span className="figure font-medium">#{row.id}</span>,
    },
    {
      key: 'bot_name',
      header: 'Chatbot',
      sortable: true,
      render: (row) => row.bot_name ?? (row.bot_id ? `#${row.bot_id}` : '—'),
    },
    { key: 'source', header: 'Source', sortable: true, render: (row) => <Badge>{row.source}</Badge> },
    {
      key: 'created_at',
      header: 'Ingested',
      sortable: true,
      secondary: true,
      render: (row) => formatDateTime(row.created_at),
    },
    {
      key: 'actions',
      header: 'Re-embed',
      align: 'right',
      render: (row) => (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setError(null);
            setPending(row);
          }}
        >
          <RefreshCw aria-hidden className="h-3.5 w-3.5" />
          Reindex
        </Button>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      {error ? (
        <Alert tone="danger" live title="The reindex was not queued">
          {error}
        </Alert>
      ) : null}
      <Toolbar>
        <div className="w-full max-w-xs">
          <SearchField
            label="Search documents"
            value={query}
            onValueChange={(next) => url.set({ q: next })}
            placeholder="Chatbot, source or chunk id"
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
        caption="Embedded knowledge-base chunks"
        columns={columns}
        paged={paged}
        rowKey={(row) => String(row.id)}
        loading={list.loading}
        error={list.error}
        forbidden={list.forbidden}
        onRetry={list.reload}
        loaded={list.items.length}
        cap={500}
        note={
          <>
            One row is one embedded <strong>chunk</strong>, not one file. The endpoint returns no
            document name, size or chunk count — its handler reads fields the model does not have, so
            those three values are always empty, zero and one. Nothing is shown for them here rather
            than showing a zero that looks like data.
          </>
        }
        empty={
          <EmptyState
            compact
            title={query || source ? 'Nothing matched' : 'Nothing ingested'}
            description={
              query || source
                ? 'No chunk matches this filter.'
                : 'No account has uploaded a document or crawled a site.'
            }
          />
        }
      />

      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(next) => {
          if (!next) setPending(null);
        }}
        title={pending ? `Re-embed chunk #${pending.id}?` : 'Reindex'}
        description={
          <>
            The chunk&apos;s vector is recomputed with the current embedding provider and overwritten.
            That spends embedding quota, and while it runs the chunk keeps answering with its old
            vector. If the background worker is down it runs inline instead, which can take several
            seconds before this returns.
          </>
        }
        confirmLabel="Reindex chunk"
        onConfirm={async () => {
          if (!pending) return;
          try {
            await platform.post(`/documents/${pending.id}/reindex`);
            setPending(null);
            toast.success('Reindex queued.');
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'The reindex was not queued.');
            setPending(null);
          }
        }}
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
