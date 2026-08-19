import { useQuery } from '@tanstack/react-query';
import { ExternalLink, FileSearch } from 'lucide-react';
import {
  DataTable,
  Drawer,
  EmptyState,
  formatNumber,
  type Column,
} from '../../../ui';
import { getDocumentPages } from '../../../services/api';
import type { SourcePage } from '../../../types/domain';
import { errorMessage, isForbidden } from './knowledge-api';
import { rootDomainOf } from './knowledge-model';

export interface PagesDrawerProps {
  /** The website source whose pages to list, or null when closed. */
  sourceName: string | null;
  agentId: number;
  onClose: () => void;
}

/**
 * Every page a website source actually contributed.
 *
 * A drawer rather than an expander in the table: the list runs to hundreds of
 * rows on a real site, and pushing the table down by that much costs the reader
 * the row they were looking at. Closing it puts them back exactly where they
 * were.
 */
export function PagesDrawer({ sourceName, agentId, onClose }: PagesDrawerProps) {
  const domain = sourceName === null ? null : rootDomainOf(sourceName);

  const pages = useQuery({
    // Scoped by chatbot and source. `getDocumentPages` takes the bare domain —
    // the endpoint validates it against a hostname pattern and rejects a full
    // URL, which is why this is never the raw source name.
    queryKey: ['agents', 'knowledge', agentId, 'pages', domain],
    queryFn: () => getDocumentPages(domain as string, agentId),
    enabled: domain !== null,
  });

  const rows: SourcePage[] = pages.data?.pages ?? [];
  const forbidden = pages.isError && isForbidden(pages.error);

  const columns: Column<SourcePage>[] = [
    {
      key: 'title',
      header: 'Page',
      sortable: (a, b) => (a.title ?? a.url).localeCompare(b.title ?? b.url),
      render: (row) => (
        <span className="block min-w-0">
          <span className="block truncate font-medium text-text-primary">
            {row.title || row.url}
          </span>
          {row.title ? (
            <span className="mt-0.5 block truncate text-xs text-text-tertiary">{row.url}</span>
          ) : null}
        </span>
      ),
    },
    {
      key: 'open',
      header: 'Open',
      align: 'right',
      width: '5rem',
      render: (row) => (
        <a
          href={row.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex h-6 min-w-6 items-center justify-center rounded-xs text-accent-600 hover:text-accent-700"
          aria-label={`Open ${row.title || row.url} in a new tab`}
        >
          <ExternalLink aria-hidden className="h-3.5 w-3.5" />
        </a>
      ),
    },
  ];

  return (
    <Drawer
      open={sourceName !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      width="lg"
      title={domain ?? 'Pages'}
      description={
        pages.data?.total_pages
          ? `${formatNumber(pages.data.total_pages)} pages · ${formatNumber(pages.data.total_chunks ?? 0)} passages this chatbot can answer from.`
          : 'The pages this chatbot read from this website.'
      }
    >
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(row) => row.url}
        caption={`Pages read from ${domain ?? 'this website'}`}
        loading={pages.isPending && domain !== null}
        error={
          forbidden
            ? 'You do not have permission to see this chatbot’s pages.'
            : pages.isError
              ? errorMessage(pages.error, 'We could not load this source’s pages.')
              : null
        }
        onRetry={forbidden ? undefined : () => void pages.refetch()}
        pageSize={50}
        empty={
          <EmptyState
            icon={FileSearch}
            title="No pages recorded"
            description="This source is stored, but we have no per-page record for it. Re-training the website rebuilds the list."
          />
        }
      />
    </Drawer>
  );
}
