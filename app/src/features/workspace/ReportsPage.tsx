import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Bot as BotIcon, CalendarRange, Download } from 'lucide-react';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  DataTable,
  EmptyState,
  ErrorState,
  LoadingRows,
  NavTabs,
  Page,
  PageHeader,
  SegmentedControl,
  Stack,
  Tooltip,
  buttonClass,
  formatDate,
  formatNumber,
} from '../../ui';
import { downloadPerAgentReportCsv } from '../../services/api';
import { useBotContext } from '../../context/BotContext';
import { BILLING_SECTIONS } from './billing/sections';
import { errorMessage } from './billingModel';
import {
  DEFAULT_REPORT_RANGE,
  REPORT_RANGES,
  buildReportFilename,
  reportEmptyReason,
  type ReportRange,
} from './reportsModel';
import { useAgentReport } from './useAgentReport';

/**
 * `/billing/reports` - what each chatbot did, and what it cost.
 *
 * Built for the agency case: many client sites on one account and one shared
 * credit pool. It is deliberately account-wide and never scoped to the shell's
 * chatbot switcher, because the point of the surface is the comparison, and
 * every row is exportable as a CSV the owner can forward to the client it
 * covers.
 *
 * It sits under Billing rather than Analytics because it answers a commercial
 * question rather than a performance one: it is the per-chatbot breakdown of
 * the same credit consumption the Usage page totals up.
 */
export function ReportsPage() {
  const { bots, loading: botsLoading } = useBotContext();
  const [range, setRange] = useState<ReportRange>(DEFAULT_REPORT_RANGE);
  const { query, retry } = useAgentReport(range);
  const [downloading, setDownloading] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const report = query.data ?? null;
  // `?.rows?.length`, not `?.rows.length`: a 200 whose body is missing the
  // array threw `Cannot read properties of undefined` and took the route to
  // the error boundary, where a report that failed to arrive looked like a
  // broken console.
  const rowCount = report?.rows?.length ?? 0;
  const windowLabel = report ? `${formatDate(report.since)} to ${formatDate(report.until)}` : '';
  const emptyReason = report ? reportEmptyReason(bots.length, rowCount) : null;

  async function download() {
    if (!report) return;
    setDownloading(true);
    setExportError(null);
    try {
      await downloadPerAgentReportCsv(range, buildReportFilename(report.since, report.until));
    } catch (cause) {
      setExportError(errorMessage(cause, 'We could not export the report. Please try again.'));
    } finally {
      setDownloading(false);
    }
  }

  return (
    <Page width="wide">
      <PageHeader
        title="Reports"
        toolbar={<NavTabs label="Billing sections" items={BILLING_SECTIONS} />}
        actions={
          <>
            <SegmentedControl
              label="Reporting window"
              size="sm"
              value={String(range)}
              onChange={(next) => setRange(Number(next) as ReportRange)}
              items={REPORT_RANGES.map((option) => ({
                value: String(option.days),
                label: option.label,
                // Locked while an export is in flight: the file being built
                // covers the window that was selected when the customer
                // clicked, so let it finish rather than let the two disagree.
                disabled: downloading,
              }))}
            />
            <Button
              variant="secondary"
              onClick={() => void download()}
              // Nothing to export is a real state, not an error: a header-only
              // CSV looks like a broken download rather than a quiet month.
              disabled={downloading || rowCount === 0}
            >
              <Download aria-hidden />
              {downloading ? 'Preparing…' : 'Download CSV'}
            </Button>
          </>
        }
      />

      <Stack>
        {exportError ? (
          <Alert tone="danger" live title="The export did not finish">
            {exportError}
          </Alert>
        ) : null}

        {query.isPending || botsLoading ? (
          <Card>
            <CardBody>
              <LoadingRows rows={4} />
            </CardBody>
          </Card>
        ) : query.isError ? (
          <Card>
            <ErrorState
              title="We could not load your report"
              description={errorMessage(
                query.error,
                'The reporting service did not answer. Nothing about your account has changed.',
              )}
              onRetry={retry}
            />
          </Card>
        ) : emptyReason === 'no-agents' ? (
          <Card>
            <EmptyState
              icon={BotIcon}
              title="No chatbots to report on yet"
              description="Once visitors start talking to one, its conversations, leads and credit usage appear here."
              action={
                <Link to="/chatbots?new=1" className={buttonClass('primary', 'sm')}>
                  Create a chatbot
                </Link>
              }
            />
          </Card>
        ) : emptyReason === 'no-activity-in-window' ? (
          <Card>
            <EmptyState
              icon={CalendarRange}
              title={`No activity in the last ${range} days`}
              description="Nothing held a conversation, captured a lead or spent a credit in this window."
              action={
                range === 90 ? undefined : (
                  <Button variant="secondary" size="sm" onClick={() => setRange(90)}>
                    Show the last 90 days
                  </Button>
                )
              }
            />
          </Card>
        ) : report ? (
          // The stat card is gone. It printed the same three figures as the
          // table's `tfoot`, from the same `report.totals`, 130px above it —
          // and the `tfoot` is the better artefact, because it is structurally
          // a total and it is aligned with the columns it totals.
          <Card>
            <CardHeader
              eyebrow="Per chatbot"
              title="Activity"
              titleAs="h2"
              description={windowLabel}
              actions={
                <Badge tone="neutral">
                  {`${rowCount} active ${rowCount === 1 ? 'chatbot' : 'chatbots'}`}
                </Badge>
              }
            />
            <CardBody flush>
              {/* This was a hand-built `<table>` — the second under `/billing`,
                  at a third cell geometry — because a report needs the
                  chatbot's name to be the row's HEADER and the account totals
                  to live in a real `tfoot`. `DataTable` owns both now
                  (`Column.rowHeader`, `footer`), so the markup goes. */}
              <DataTable
                seated
                caption={`Activity per chatbot for ${windowLabel}: conversations, leads and credits used`}
                rows={report.rows}
                rowKey={(row) => String(row.bot_id)}
                rowNoun="chatbot"
                defaultSort={{ key: 'credits', direction: 'desc' }}
                columns={[
                  {
                    key: 'name',
                    header: 'Chatbot',
                    pinned: true,
                    width: '16rem',
                    rowHeader: true,
                    sortable: (a, b) => a.bot_name.localeCompare(b.bot_name),
                    render: (row) => (
                      <span className="font-medium text-text-primary">{row.bot_name}</span>
                    ),
                  },
                  {
                    key: 'conversations',
                    header: 'Conversations',
                    type: 'number',
                    sortable: (a, b) => a.conversations - b.conversations,
                    render: (row) => formatNumber(row.conversations),
                  },
                  {
                    key: 'leads',
                    header: 'Leads',
                    type: 'number',
                    sortable: (a, b) => a.leads - b.leads,
                    render: (row) => formatNumber(row.leads),
                  },
                  {
                    key: 'credits',
                    header: (
                      <Tooltip content="Consumption only. Grants, top-ups and refunds are ledger movements, not spend.">
                        <span>Credits used</span>
                      </Tooltip>
                    ),
                    type: 'number',
                    sortable: (a, b) => a.credits_spent - b.credits_spent,
                    render: (row) => formatNumber(row.credits_spent),
                  },
                ]}
                footer={
                  <tr>
                    <th scope="row" className="font-semibold">
                      All chatbots
                    </th>
                    <td className="figure text-right font-semibold">
                      {formatNumber(report.totals.conversations)}
                    </td>
                    <td className="figure text-right font-semibold">
                      {formatNumber(report.totals.leads)}
                    </td>
                    <td className="figure text-right font-semibold">
                      {formatNumber(report.totals.credits_spent)}
                    </td>
                  </tr>
                }
              />
            </CardBody>
          </Card>
        ) : null}
      </Stack>
    </Page>
  );
}
