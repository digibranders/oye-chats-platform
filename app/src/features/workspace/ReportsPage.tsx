import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Bot as BotIcon, CalendarRange, Download } from 'lucide-react';
import {
  Alert,
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  ErrorState,
  LoadingRows,
  Page,
  PageHeader,
  SegmentedControl,
  Stack,
  StatTile,
  buttonClass,
  formatDate,
  formatNumber,
} from '../../ui';
import { downloadPerAgentReportCsv } from '../../services/api';
import { useBotContext } from '../../context/BotContext';
import { BillingNav } from './billing/BillingNav';
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
  const rowCount = report?.rows.length ?? 0;
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
        description="Conversations held, leads captured and credits spent, one row per chatbot."
        toolbar={<BillingNav />}
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
              <Download aria-hidden className="h-4 w-4" />
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
              description="Create your first chatbot and deploy it. Once visitors start talking to it, its conversations, leads and credit usage appear here."
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
              description="None of your chatbots held a conversation, captured a lead or spent a credit in this window. Try a wider one."
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
          <>
            <Card>
              <CardBody className="grid gap-6 sm:grid-cols-3">
                <StatTile
                  label="Conversations"
                  value={formatNumber(report.totals.conversations)}
                  period={windowLabel}
                />
                <StatTile
                  label="Leads captured"
                  value={formatNumber(report.totals.leads)}
                  period={windowLabel}
                />
                <StatTile
                  label="Credits spent"
                  value={formatNumber(report.totals.credits_spent)}
                  period={windowLabel}
                />
              </CardBody>
            </Card>

            <Card>
              <CardHeader
                eyebrow="Per chatbot"
                title="Activity"
                titleAs="h2"
                description={`${windowLabel} · ${rowCount} active ${rowCount === 1 ? 'chatbot' : 'chatbots'}. A chatbot with no conversations, leads or spend in this window is left out.`}
              />
              <CardBody flush>
                {/* Hand-built rather than a `DataTable`, and deliberately so: a
                    report needs the chatbot's name to be the row's HEADER and
                    the account totals to live in a real `tfoot`. A screen
                    reader then announces "Acme Support, Conversations, 412"
                    instead of four unlabelled numbers, and the totals are
                    structurally distinct from the data rather than being a
                    "Total" row in the body, where a chatbot genuinely named
                    Total would be indistinguishable from it. */}
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[34rem]">
                    <caption className="sr-only">
                      Activity per chatbot for {windowLabel}: conversations, leads and credits used.
                    </caption>
                    <thead>
                      <tr className="border-b border-border bg-surface-sunken">
                        <th
                          scope="col"
                          className="px-5 py-2 text-left font-mono text-2xs uppercase tracking-eyebrow text-text-tertiary"
                        >
                          Chatbot
                        </th>
                        <th
                          scope="col"
                          className="px-5 py-2 text-right font-mono text-2xs uppercase tracking-eyebrow text-text-tertiary"
                        >
                          Conversations
                        </th>
                        <th
                          scope="col"
                          className="px-5 py-2 text-right font-mono text-2xs uppercase tracking-eyebrow text-text-tertiary"
                        >
                          Leads
                        </th>
                        <th
                          scope="col"
                          className="px-5 py-2 text-right font-mono text-2xs uppercase tracking-eyebrow text-text-tertiary"
                        >
                          Credits used
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.rows.map((row) => (
                        <tr key={row.bot_id} className="border-b border-border last:border-b-0">
                          <th
                            scope="row"
                            className="px-5 py-3 text-left text-sm font-medium text-text-primary"
                          >
                            {row.bot_name}
                          </th>
                          <td className="figure px-5 py-3 text-right text-sm text-text-secondary">
                            {formatNumber(row.conversations)}
                          </td>
                          <td className="figure px-5 py-3 text-right text-sm text-text-secondary">
                            {formatNumber(row.leads)}
                          </td>
                          <td className="figure px-5 py-3 text-right text-sm text-text-primary">
                            {formatNumber(row.credits_spent)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="border-t border-border bg-surface-sunken">
                        <th
                          scope="row"
                          className="px-5 py-3 text-left text-sm font-semibold text-text-primary"
                        >
                          All chatbots
                        </th>
                        <td className="figure px-5 py-3 text-right text-sm font-semibold text-text-primary">
                          {formatNumber(report.totals.conversations)}
                        </td>
                        <td className="figure px-5 py-3 text-right text-sm font-semibold text-text-primary">
                          {formatNumber(report.totals.leads)}
                        </td>
                        <td className="figure px-5 py-3 text-right text-sm font-semibold text-text-primary">
                          {formatNumber(report.totals.credits_spent)}
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </CardBody>
              <div className="border-t border-border px-5 py-3 text-xs leading-relaxed text-text-secondary">
                Credits shown are consumption only. Plan grants, top-ups and refunds are movements
                in your ledger but they are not spend, so they are excluded here and on the Usage
                page.
              </div>
            </Card>
          </>
        ) : null}
      </Stack>
    </Page>
  );
}
