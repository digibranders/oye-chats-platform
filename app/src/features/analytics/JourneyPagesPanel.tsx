import { Download, Compass } from 'lucide-react';
import {
  ABSENT,
  Button,
  Card,
  CardBody,
  CardHeader,
  DataTable,
  EmptyState,
  formatNumber,
  formatPercent,
  type Column,
} from '../../ui';
import type { JourneyTopPageRow } from '../../services/api';
import { csvFilename, exportRows } from './exportCsv';

/**
 * Which pages send people to the chatbot.
 *
 * The panel this replaces asked the API for twenty rows and rendered six, with
 * no way to see the rest — so a site with a long tail of entry pages showed a
 * top six and quietly binned the evidence. Every row it fetches is rendered,
 * sortable, paged and exportable.
 */
export function JourneyPagesPanel({
  rows,
  journeys,
  monthLabel,
}: {
  rows: readonly JourneyTopPageRow[];
  /** Tracked journeys in the month, the denominator for each page's share. */
  journeys: number;
  monthLabel: string;
}) {
  const columns: readonly Column<JourneyTopPageRow>[] = [
    {
      key: 'path',
      header: 'Page',
      pinned: true,
      render: (row) => <span className="figure text-text-primary">{row.path}</span>,
      sortable: (a, b) => a.path.localeCompare(b.path),
    },
    {
      key: 'sessions',
      header: 'Conversations',
      align: 'right',
      width: '9rem',
      render: (row) => <span className="figure">{formatNumber(row.sessions)}</span>,
      sortable: (a, b) => a.sessions - b.sessions,
    },
    {
      key: 'share',
      header: 'Share of journeys',
      align: 'right',
      width: '11rem',
      render: (row) => (
        <span className="figure text-text-secondary">
          {journeys > 0 ? formatPercent(row.sessions / journeys) : ABSENT}
        </span>
      ),
      sortable: (a, b) => a.sessions - b.sessions,
    },
    {
      key: 'visits',
      header: 'Page views',
      align: 'right',
      width: '9rem',
      secondary: true,
      render: (row) => <span className="figure text-text-secondary">{formatNumber(row.visits)}</span>,
      sortable: (a, b) => a.visits - b.visits,
    },
  ];

  function onExport() {
    exportRows(
      csvFilename('journey-pages', monthLabel),
      ['Page', 'Conversations', 'Share of journeys (%)', 'Page views'],
      rows.map((row) => [
        row.path,
        row.sessions,
        journeys > 0 ? ((row.sessions / journeys) * 100).toFixed(1) : '',
        row.visits,
      ]),
    );
  }

  return (
    <Card>
      <CardHeader
        eyebrow="Influence"
        title="Pages that lead to a chat"
        titleAs="h2"
        description={`Where visitors were before they opened the chatbot · ${monthLabel}`}
        actions={
          rows.length > 0 ? (
            <Button size="sm" variant="ghost" onClick={onExport} iconLeft={<Download aria-hidden />}>
              Export
            </Button>
          ) : undefined
        }
      />
      <CardBody flush>
        <DataTable
          seated
          caption="Pages visitors were on before opening the chatbot"
          columns={columns}
          rows={rows}
          rowKey={(row) => row.path}
          defaultSort={{ key: 'sessions', direction: 'desc' }}
          pageSize={10}
          rowNoun="page"
          empty={
            <EmptyState
              size="inline"
              icon={Compass}
              title="No pages tracked this month"
              description="This needs visitors who browsed at least one page before opening the chat. Nobody did in this month."
            />
          }
        />
      </CardBody>
    </Card>
  );
}
