import { useMemo } from 'react';
import { Download, Users } from 'lucide-react';
import { Link } from 'react-router-dom';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  DataTable,
  EmptyState,
  LockedState,
  buttonClass,
  formatDateTime,
  formatNumber,
  type Column,
} from '../../ui';
import { csvFilename, exportRows } from './exportCsv';
import { errorMessage, useVisitors } from './useAnalyticsData';
import { filterVisitorsToWindow, type VisitorRow } from './visitors';
import type { ResolvedRange } from './range';
import { useTranslation } from '../../i18n/useTranslation';

/**
 * Visitors — who actually turned up.
 *
 * `GET /analytics/visitors` and its client function have existed all along with
 * nothing calling either, so a workspace could see how many conversations it
 * had and never who had them. One row is one visitor, not one chat: the server
 * groups sessions by device and address, so somebody who came back three times
 * is one line with three conversations against it.
 *
 * The endpoint has no date filter of its own, so the page's range is applied to
 * "last active". That keeps this count comparable with every other figure on
 * the surface instead of being the one panel that is always all-time.
 */
export function VisitorsTab({ botId, range }: { botId: number | null; range: ResolvedRange }) {
  const { t } = useTranslation();
  const { visitors, loading, locked, error, refetch } = useVisitors(botId);

  const rows = useMemo(
    () => filterVisitorsToWindow(visitors, range.since),
    [visitors, range.since],
  );

  const columns: readonly Column<VisitorRow>[] = [
    {
      key: 'visitor',
      header: t('analytics.visitor') || 'Visitor',
      pinned: true,
      render: (row) => <span className="figure text-text-primary">{row.visitor}</span>,
      sortable: (a, b) => a.visitor.localeCompare(b.visitor, undefined, { numeric: true }),
    },
    {
      key: 'location',
      header: t('analytics.location') || 'Location',
      render: (row) => <span className="text-text-secondary">{row.location}</span>,
      sortable: (a, b) => a.location.localeCompare(b.location),
    },
    {
      key: 'device',
      header: t('analytics.device') || 'Device',
      secondary: true,
      render: (row) => <span className="text-text-secondary">{row.device}</span>,
      sortable: (a, b) => a.device.localeCompare(b.device),
    },
    {
      key: 'conversations',
      header: t('analytics.conversations') || 'Conversations',
      align: 'right',
      width: '9rem',
      render: (row) => <span className="figure">{formatNumber(row.conversations)}</span>,
      sortable: (a, b) => a.conversations - b.conversations,
    },
    {
      key: 'messages',
      header: t('analytics.messages') || 'Messages',
      align: 'right',
      width: '8rem',
      secondary: true,
      render: (row) => <span className="figure">{formatNumber(row.messages)}</span>,
      sortable: (a, b) => a.messages - b.messages,
    },
    {
      key: 'lastActiveAt',
      header: t('analytics.lastActive') || 'Last active',
      align: 'right',
      width: '13rem',
      render: (row) => (
        <span className="figure text-text-secondary">{formatDateTime(row.lastActiveAt)}</span>
      ),
      sortable: (a, b) =>
        new Date(a.lastActiveAt ?? 0).getTime() - new Date(b.lastActiveAt ?? 0).getTime(),
    },
  ];

  function onExport() {
    exportRows(
      csvFilename('visitors', range.label),
      [t('analytics.visitor') || 'Visitor', t('analytics.location') || 'Location', t('analytics.device') || 'Device', t('analytics.conversations') || 'Conversations', t('analytics.messages') || 'Messages', t('analytics.lastActive') || 'Last active'],
      rows.map((row) => [
        row.visitor,
        row.location,
        row.device,
        row.conversations,
        row.messages,
        row.lastActiveAt ?? '',
      ]),
    );
  }

  if (locked) {
    return (
      <LockedState
        size="page"
        title={t('analytics.visitorHistoryIsLimitedOn') || 'Visitor history is limited on your plan'}
        description={t('analytics.yourPlanKeepsAShort') || 'Your plan keeps a short window of conversation history, and this list is built from it. A longer retention window comes with Standard and above.'}
        action={
          <Link to="/billing" className={buttonClass('primary', 'sm')}>
            {t('analytics.seePlans') || 'See plans'}
          </Link>
        }
      />
    );
  }

  return (
    <Card>
      <CardHeader
        eyebrow="Audience"
        title={t('analytics.whoVisited') || 'Who visited'}
        titleAs="h2"
        description={`One row per visitor, last seen in ${range.label.toLowerCase()}`}
        actions={
          rows.length > 0 ? (
            <Button size="sm" variant="ghost" onClick={onExport} iconLeft={<Download aria-hidden />}>
              {t('analytics.export') || 'Export'}
            </Button>
          ) : undefined
        }
      />
      <CardBody flush>
        <DataTable
          seated
          caption={t('analytics.visitorsWhoSpokeToThe') || 'Visitors who spoke to the chatbot in the selected period'}
          columns={columns}
          rows={rows}
          rowKey={(row) => row.id}
          loading={loading}
          error={error ? errorMessage(error, t('analytics.theRequestForVisitorsFailed') || 'The request for visitors failed.') : null}
          onRetry={() => void refetch()}
          defaultSort={{ key: 'lastActiveAt', direction: 'desc' }}
          pageSize={25}
          rowNoun="visitor"
          empty={
            <EmptyState
              size="inline"
              icon={Users}
              title={visitors.length > 0 ? t('analytics.nobodyInThisPeriod') || 'Nobody in this period' : t('analytics.noVisitorsYet') || 'No visitors yet'}
              description={
                visitors.length > 0
                  ? t('analytics.visitorsHaveUsedTheChatbot') || 'Visitors have used the chatbot, but none of them in this window. Try a wider period.'
                  : t('analytics.nobodyHasOpenedTheChatbot') || 'Nobody has opened the chatbot yet. Once someone does, they will appear here with where they were and how much they asked.'
              }
            />
          }
        />
      </CardBody>
    </Card>
  );
}
