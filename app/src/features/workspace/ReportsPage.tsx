import { type ReactElement, useState } from 'react';
import { Link } from 'react-router-dom';
import { BarChart3, Bot as BotIcon, CalendarRange, Download, TriangleAlert } from 'lucide-react';
import {
  Button,
  EmptyState,
  FeedbackBanner,
  PageContainer,
  SegmentedControl,
  type SegmentedOption,
  Skeleton,
  cn,
  useFeedback,
} from '../../design-system';
import { downloadPerAgentReportCsv, type PerAgentReport } from '../../services/api';
import { useBotContext } from '../../context/BotContext';
import { formatDate } from './usage-model';
import {
  DEFAULT_REPORT_RANGE,
  REPORT_RANGES,
  buildReportFilename,
  reportEmptyReason,
  type ReportRange,
} from './reportsModel';
import { useAgentReport } from './useAgentReport';

/** Format a metric for display. Grouped digits, never a bare `NaN`. */
function metric(value: number): string {
  return Number.isFinite(value) ? value.toLocaleString() : '0';
}

/** The reporting windows as `SegmentedControl` options. */
const REPORT_RANGE_OPTIONS: ReadonlyArray<SegmentedOption<ReportRange>> = REPORT_RANGES.map(
  (range) => ({ value: range.days, label: range.label }),
);

// ── Table ────────────────────────────────────────────────────────────────────

const HEAD_CELL =
  'px-4 py-3 text-[11px] font-semibold uppercase tracking-wide text-[var(--ds-text-subtle)]';
const NUMERIC_CELL = 'px-4 py-3 text-right tabular-nums text-[var(--ds-text)]';

/**
 * AgentReportTable - one row per agent, with the account totals in a real
 * `<tfoot>`.
 *
 * Hand-written rather than built on the shared `DataTable`, which models a
 * generic grid: it has no footer row, and every cell is a `<td>`. This is a
 * report, so the agent name is the row's *header* (`<th scope="row">`) and the
 * totals belong in a `<tfoot>` - a screen reader then announces "Acme Support,
 * Conversations, 412" instead of four unlabelled numbers, and the totals are
 * structurally distinct from the data instead of being a 'Total' row hiding in
 * the body (where an agent genuinely named "Total" would be indistinguishable
 * from it). Same tokens and the same visual language as `DataTable`; the
 * markup follows `PlanMatrix`, the other semantic table in this feature.
 */
function AgentReportTable({
  report,
  windowLabel,
}: {
  report: PerAgentReport;
  windowLabel: string;
}): ReactElement {
  return (
    <div className="overflow-x-auto rounded-xl border border-[var(--ds-border)] bg-[var(--ds-bg-surface)]">
      <table className="w-full min-w-[560px] border-collapse text-[13px]">
        <caption className="sr-only">
          Activity per AI chatbot for {windowLabel}: conversations, leads and credits used.
        </caption>
        <thead>
          <tr className="border-b border-[var(--ds-border)]">
            <th scope="col" className={cn(HEAD_CELL, 'text-left')}>
              Agent
            </th>
            <th scope="col" className={cn(HEAD_CELL, 'text-right')}>
              Conversations
            </th>
            <th scope="col" className={cn(HEAD_CELL, 'text-right')}>
              Leads
            </th>
            <th scope="col" className={cn(HEAD_CELL, 'text-right')}>
              Credits used
            </th>
          </tr>
        </thead>
        <tbody>
          {report.rows.map((row) => (
            <tr
              key={row.bot_id}
              className="border-b border-[var(--ds-border)] transition-colors last:border-b-0 hover:bg-[var(--ds-bg-hover)]"
            >
              <th
                scope="row"
                className="px-4 py-3 text-left font-medium text-[var(--ds-text)]"
              >
                {row.bot_name}
              </th>
              <td className={NUMERIC_CELL}>{metric(row.conversations)}</td>
              <td className={NUMERIC_CELL}>{metric(row.leads)}</td>
              <td className={NUMERIC_CELL}>{metric(row.credits_spent)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t border-[var(--ds-border)] bg-[var(--ds-bg-subtle)]">
            <th scope="row" className="px-4 py-3 text-left font-semibold text-[var(--ds-text)]">
              All agents
            </th>
            <td className={cn(NUMERIC_CELL, 'font-semibold')}>
              {metric(report.totals.conversations)}
            </td>
            <td className={cn(NUMERIC_CELL, 'font-semibold')}>{metric(report.totals.leads)}</td>
            <td className={cn(NUMERIC_CELL, 'font-semibold')}>
              {metric(report.totals.credits_spent)}
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function LoadingState(): ReactElement {
  return (
    <div className="space-y-3" aria-busy="true">
      <Skeleton className="h-5 w-56" />
      <Skeleton className="h-64 w-full rounded-xl" />
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

/**
 * ReportsPage - Workspace ▸ Reports (`/workspace/reports`).
 *
 * One job: answer "what did each of my chatbots do, and what did it cost?".
 * Built for the agency case - many client sites on one account and one shared
 * credit pool - so it is deliberately account-wide (never scoped to the
 * shell's agent switcher) and every row is exportable as a CSV the owner can
 * forward to the client it covers.
 *
 * It sits in Workspace rather than under Analytics because it answers a
 * commercial question, not a performance one: it is the per-agent breakdown of
 * the same credit consumption the neighbouring Usage page totals up.
 */
export function ReportsPage(): ReactElement {
  const { bots, loading: botsLoading } = useBotContext();
  const [range, setRange] = useState<ReportRange>(DEFAULT_REPORT_RANGE);
  const { phase, retry } = useAgentReport(range);
  const [downloading, setDownloading] = useState(false);
  // Scoped to the window: a "couldn't export" message must not linger over a
  // different range's numbers after the user switches.
  const { feedback, notify, dismiss } = useFeedback({ resetKey: range });

  const report = phase.status === 'ready' ? phase.report : null;
  const rowCount = report?.rows.length ?? 0;
  const windowLabel = report ? `${formatDate(report.since)} – ${formatDate(report.until)}` : '';
  const emptyReason = report ? reportEmptyReason(bots.length, rowCount) : null;

  async function handleDownload(): Promise<void> {
    if (!report) return;
    setDownloading(true);
    dismiss();
    try {
      await downloadPerAgentReportCsv(range, buildReportFilename(report.since, report.until));
    } catch (cause) {
      notify({
        tone: 'error',
        message:
          cause instanceof Error && cause.message
            ? cause.message
            : 'We couldn’t export the report. Please try again.',
      });
    } finally {
      setDownloading(false);
    }
  }

  return (
    <PageContainer
      title="Reports"
      description="What each of your AI chatbots did in the selected window - conversations held, leads captured, and credits used."
      actions={
        <>
          <SegmentedControl
            options={REPORT_RANGE_OPTIONS}
            value={range}
            onChange={setRange}
            ariaLabel="Reporting window"
            // Locked while a download is in flight: the file being built covers
            // the window that was selected when the user clicked, so let it
            // finish rather than let the two disagree.
            disabled={downloading}
          />
          <Button
            variant="outline"
            onClick={() => void handleDownload()}
            // Nothing to export is a real state, not an error: a header-only
            // CSV would look like a broken download rather than a quiet month.
            disabled={downloading || rowCount === 0}
            title={rowCount === 0 ? 'There is no activity in this window to export' : undefined}
          >
            <Download size={16} aria-hidden="true" />
            {downloading ? 'Preparing…' : 'Download CSV'}
          </Button>
        </>
      }
    >
      <FeedbackBanner feedback={feedback} onDismiss={dismiss} />

      {phase.status === 'loading' || botsLoading ? (
        <LoadingState />
      ) : phase.status === 'error' ? (
        <EmptyState
          icon={TriangleAlert}
          title="We couldn’t load your report"
          description={phase.message}
          action={<Button onClick={retry}>Try again</Button>}
        />
      ) : emptyReason === 'no-agents' ? (
        <EmptyState
          icon={BotIcon}
          title="No chatbots to report on yet"
          description="Create your first AI chatbot and deploy it. Once visitors start talking to it, its conversations, leads and credit usage appear here."
          action={
            <Link
              to="/agents"
              className="inline-flex h-9 items-center gap-2 rounded-lg bg-[var(--ds-accent)] px-4 text-sm font-medium text-[var(--ds-accent-fg)] shadow-[var(--ds-shadow-sm)] transition-colors hover:bg-[var(--ds-accent-hover)] focus-visible:outline-none focus-visible:shadow-[0_0_0_1px_var(--ds-ring)]"
            >
              <BotIcon size={16} aria-hidden="true" />
              Create an AI chatbot
            </Link>
          }
        />
      ) : emptyReason === 'no-activity-in-window' ? (
        <EmptyState
          icon={CalendarRange}
          title={`No activity in the last ${range} days`}
          description="None of your chatbots held a conversation, captured a lead or spent a credit in this window. Try a wider range."
          action={
            range === 90 ? undefined : (
              <Button variant="outline" onClick={() => setRange(90)}>
                Show the last 90 days
              </Button>
            )
          }
        />
      ) : report ? (
        <section aria-label="Activity per chatbot" className="space-y-3">
          <p className="flex items-center gap-1.5 text-[13px] text-[var(--ds-text-muted)]">
            <BarChart3 size={14} aria-hidden="true" />
            <span>
              {windowLabel} · {rowCount} active {rowCount === 1 ? 'chatbot' : 'chatbots'}
            </span>
          </p>
          <AgentReportTable report={report} windowLabel={windowLabel} />
          <p className="text-[12px] text-[var(--ds-text-subtle)]">
            Chatbots with no conversations, leads or credit usage in this window are left out.
            Credits shown are consumption only - plan grants, top-ups and refunds are excluded.
          </p>
        </section>
      ) : null}
    </PageContainer>
  );
}
