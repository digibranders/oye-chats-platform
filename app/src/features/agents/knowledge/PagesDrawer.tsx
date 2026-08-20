import { useQuery } from '@tanstack/react-query';
import { ExternalLink, FileSearch } from 'lucide-react';
import {
  DataTable,
  Drawer,
  EmptyState,
  buttonClass,
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
          // 28px, like every other icon action in the app. 24 is the SC 2.5.8
          // floor exactly, with no padding buffer, in a fifty-row list.
          className={buttonClass('ghost', 'icon-sm')}
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
      {/* Seated: the drawer body already draws the surface, and the table's own
          `rounded-lg` border put its first cell 37px from the drawer edge
          against a title at 20. */}
      <DataTable
        seated
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
        rowNoun="page"
        empty={
          <EmptyState
            icon={FileSearch}
            title="No pages recorded"
            description="No per-page record. Re-training the website rebuilds it."
          />
        }
      />
    </Drawer>
  );
}
