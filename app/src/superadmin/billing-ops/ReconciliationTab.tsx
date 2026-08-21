import { useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CodeBlock,
  Combobox,
  DataTable,
  Dialog,
  EmptyState,
  LockedState,
  Section,
  Stack,
  Toolbar,
  Tooltip,
  formatDateTime,
  formatNumber,
  type Column,
  type Tone,
} from '../../ui';
import { RecordList } from '../RecordList';
import { usePlatformList, usePlatformResource, useUrlState } from '../usePlatform';
import { FORBIDDEN_TITLE, forbiddenDescription } from '../forbidden';
import { PAGE_SIZE, byDate, byText, usePagedRows } from '../recordListState';
import { InvoiceDrawer } from './InvoiceDrawer';
import { invoiceStatusLabel, invoiceStatusTone, invoiceTypeLabel } from './invoice';
import type { AnomalyBrief, AnomalyKey, GatewayRun, ReconciliationResponse } from './types';

/**
 * The two reconciliation reports, which answer different questions.
 *
 * The **anomaly report** is internal: conditions that cannot occur in a healthy
 * system, computed from the platform's own invoice table. Every list on it
 * should be empty, and an entry is a document a customer is holding — or not
 * holding — incorrectly.
 *
 * The **gateway report** is external: what the nightly job found when it
 * compared Razorpay's view of the money against ours.
 *
 * **One table, with the condition as a column.** It was six, one per invariant,
 * each with its own heading, its own sentence of meaning, its own remedy
 * `Alert`, its own column head and its own row-count footer — the same four
 * columns declared six times over twenty-eight rows in total, at 4.6 screenfuls.
 * Six tables that share a schema are one table with a facet, which is also the
 * only shape that answers "what is the oldest thing wrong here" — a question the
 * grouped form could not be asked at all, because sorting was per block.
 *
 * Amounts are conspicuously absent from the anomaly tables. The endpoint's brief
 * (`invoice_reports._brief`) returns `amount_cents` with **no currency field**,
 * so there is no honest way to render it as money — a rupee figure printed with
 * a dollar sign on a reconciliation screen is worse than no figure at all. Open
 * a row and the invoice detail supplies both.
 */

interface AnomalyGroup {
  key: AnomalyKey;
  title: string;
  /**
   * The condition as a *label*, for the column's badge.
   *
   * `title` is a sentence, and a sentence in a badge in a 17rem column
   * truncates to "Charged, but holding n…" on every row. The badge says the
   * thing in two or three words; the sentence stays on the filter option, where
   * there is room for it, and the full definition is a tooltip.
   */
  badge: string;
  tone: Tone;
  /** What the condition means. */
  meaning: string;
  /** What to do about it. */
  remedy: string;
}

const GROUPS: readonly AnomalyGroup[] = [
  {
    key: 'unnumbered_charges',
    badge: 'No document',
    title: 'Charged, but holding no document',
    tone: 'danger',
    meaning:
      'A captured payment that never received an invoice number. The customer paid and has no tax document.',
    remedy:
      'Almost always the seller profile has never been saved, which blocks numbering entirely. Save it on the Seller profile tab; the self-heal sweep re-numbers these once the block clears.',
  },
  {
    key: 'refunds_without_credit_note',
    badge: 'No credit note',
    title: 'Refunded without a credit note',
    tone: 'danger',
    meaning:
      'A refunded, part-refunded or lost-dispute document whose reversing credit note is missing or short of the amount reversed.',
    remedy:
      'The credit note was swallowed by a rolled-back savepoint. It has to be re-issued before the period is filed.',
  },
  {
    key: 'broken_totals',
    badge: 'Totals broken',
    title: 'Tax components do not reconcile',
    tone: 'danger',
    meaning:
      'Taxable value plus tax no longer equals the document total, or the GST components no longer sum to the tax. This is impossible through the application.',
    remedy: 'The row was written outside the app. It needs looking at in the database directly.',
  },
  {
    key: 'exports_without_fx',
    badge: 'No rupee mirror',
    title: 'Export with no rupee mirror',
    tone: 'danger',
    meaning:
      'A numbered foreign-currency document with no INR amount stored. It cannot be placed on a rupee-denominated return at all.',
    remedy:
      'Unreachable through finalize, so the row was written outside the application. It must be corrected before filing.',
  },
  {
    key: 'pdfs_pending',
    badge: 'PDF pending',
    title: 'Rendered nothing for over an hour',
    tone: 'warning',
    meaning:
      'A numbered document with no PDF, issued more than an hour ago. The five-minute sweep has had many turns at it.',
    remedy:
      'Check the worker first: one started without the pango library skips every render and only logs “PDF renderer unavailable”. Then open a row and queue a fresh render.',
  },
  {
    key: 'emails_pending',
    badge: 'Not delivered',
    title: 'Rendered but never delivered',
    tone: 'warning',
    meaning:
      'A document with a PDF that the buyer has still not been emailed, more than an hour after issue.',
    remedy:
      'Usually a delivery outage or a buyer snapshot with no email address. Open a row and resend; if it refuses, the address is missing.',
  },
];

const GROUP_BY_KEY = new Map(GROUPS.map((group) => [group.key, group]));

/** One brief, carrying the invariant it broke. */
interface Anomaly extends AnomalyBrief {
  anomaly: AnomalyKey;
}

/**
 * Flatten the six lists into one, in the order `GROUPS` declares — which is
 * severity order, so an unfiltered, unsorted table opens on the documents a
 * customer paid for and never received.
 */
function flatten(report: ReconciliationResponse | null): Anomaly[] {
  if (!report) return [];
  return GROUPS.flatMap((group) =>
    (report[group.key] ?? []).map((brief) => ({ ...brief, anomaly: group.key })),
  );
}

export function ReconciliationTab() {
  const url = useUrlState();
  const condition = url.get('condition');
  const report = usePlatformResource<ReconciliationResponse>('/billing/reconciliation');
  const runs = usePlatformList<GatewayRun>('/reconciliation/gateway', {
    key: 'runs',
    params: { limit: 14 },
  });
  const [openInvoice, setOpenInvoice] = useState<number | null>(null);
  const [openRun, setOpenRun] = useState<GatewayRun | null>(null);

  const counts = report.data?.counts;
  const totalAnomalies = counts ? Object.values(counts).reduce((sum, value) => sum + value, 0) : null;

  const anomalies = flatten(report.data);
  const paged = usePagedRows(anomalies, {
    url,
    filter: condition ? (row) => row.anomaly === condition : undefined,
    comparators: {
      anomaly: byText((row) => GROUP_BY_KEY.get(row.anomaly)?.badge ?? row.anomaly),
      document: byText((row) => row.invoice_number ?? String(row.id)),
      issued: byDate((row) => row.issued_at),
    },
  });

  // The remedy for the one condition being looked at. Six of these used to be
  // on screen at once, above six tables, which is five remedies for problems the
  // reader is not currently holding.
  const focused = condition ? GROUP_BY_KEY.get(condition as AnomalyKey) : undefined;

  const conditionOptions = GROUPS.map((group) => ({
    value: group.key,
    label: `${group.title} · ${formatNumber(counts?.[group.key] ?? 0)}`,
  }));

  const columns: readonly Column<Anomaly>[] = [
    {
      key: 'document',
      header: 'Document',
      pinned: true,
      width: '14rem',
      sortable: true,
      render: (row) => (
        <div className="min-w-0">
          <p className="figure truncate text-sm font-medium text-text-primary">
            {row.invoice_number ?? `#${row.id}`}
          </p>
          <p className="truncate text-2xs text-text-tertiary">{invoiceTypeLabel(row.invoice_type)}</p>
        </div>
      ),
    },
    {
      key: 'anomaly',
      header: 'Condition',
      width: '11rem',
      sortable: true,
      render: (row) => {
        const group = GROUP_BY_KEY.get(row.anomaly);
        if (!group) return <span className="text-sm text-text-secondary">{row.anomaly}</span>;
        // The meaning is a tooltip on the badge, not a paragraph above the
        // table: it is a definition a reader needs once, which is what a
        // tooltip is for — the same argument `RecordList.note` already makes.
        return (
          <Tooltip content={`${group.title}. ${group.meaning}`}>
            <span className="inline-flex">
              <Badge tone={group.tone} dot>
                {group.badge}
              </Badge>
            </span>
          </Tooltip>
        );
      },
    },
    {
      key: 'status',
      header: 'Status',
      width: '10rem',
      render: (row) => (
        <Badge tone={invoiceStatusTone(row.status)} dot>
          {invoiceStatusLabel(row.status)}
        </Badge>
      ),
    },
    {
      key: 'client',
      header: 'Client',
      width: '8rem',
      render: (row) => <span className="figure text-sm text-text-secondary">#{row.client_id}</span>,
    },
    {
      key: 'issued',
      header: 'Issued',
      sortable: true,
      render: (row) => <span className="figure text-sm">{formatDateTime(row.issued_at)}</span>,
    },
  ];

  const runColumns: readonly Column<GatewayRun>[] = [
    {
      key: 'ran_at',
      header: 'Run',
      pinned: true,
      width: '14rem',
      render: (row) => <span className="figure text-sm">{formatDateTime(row.ran_at)}</span>,
    },
    {
      key: 'deltas',
      header: 'Disagreements',
      width: '12rem',
      render: (row) =>
        row.delta_count === 0 ? (
          <Badge tone="success" dot>
            None
          </Badge>
        ) : (
          <Badge tone="danger" dot>
            <span className="figure">{formatNumber(row.delta_count)}</span> found
          </Badge>
        ),
    },
    {
      key: 'report',
      header: 'What disagreed',
      // A dialog rather than an expander in the cell: expanding one row used to
      // inflate it to 256px and shift every row below it, which is the reason
      // an overlay exists.
      render: (row) =>
        row.delta_count === 0 ? (
          <span className="text-sm text-text-tertiary">Razorpay and the platform agreed.</span>
        ) : (
          <Button size="sm" variant="ghost" onClick={() => setOpenRun(row)}>
            Show the report
          </Button>
        ),
    },
  ];

  return (
    <Stack>
      {report.forbidden ? (
        <LockedState
          title={FORBIDDEN_TITLE}
          description={forbiddenDescription('the invoice anomaly report')}
        />
      ) : (
        <>
          {totalAnomalies === 0 ? (
            <Alert tone="success" title="Everything reconciles">
              None of the six invariants is broken.
            </Alert>
          ) : totalAnomalies != null ? (
            <Alert
              tone="danger"
              title={`${formatNumber(totalAnomalies)} document${totalAnomalies === 1 ? '' : 's'} need attention`}
            >
              Every row is a condition that should never persist: a customer holding — or
              missing — a legal document.
            </Alert>
          ) : null}

          <Section
            title="Invoice anomalies"
            description="Computed from the platform's own tables. Every list here should be empty."
            actions={
              <Button size="sm" variant="secondary" onClick={report.reload} loading={report.loading}>
                Re-check
              </Button>
            }
          >
            {report.error && !report.data ? (
              <Card>
                <CardBody>
                  <Alert
                    tone="danger"
                    live
                    title="The anomaly report could not be loaded"
                    action={
                      <Button size="sm" variant="secondary" onClick={report.reload}>
                        Try again
                      </Button>
                    }
                  >
                    {report.error}
                  </Alert>
                </CardBody>
              </Card>
            ) : (
              <>
                <Toolbar sticky className="mb-3">
                  <div className="w-80">
                    <Combobox
                      size="sm"
                      label="Filter by condition"
                      value={condition || null}
                      onValueChange={(next) => url.set({ condition: next })}
                      options={conditionOptions}
                      placeholder="Every condition"
                      clearable
                    />
                  </div>
                  {condition ? (
                    <Button size="sm" variant="ghost" onClick={() => url.set({ condition: null })}>
                      Show every condition
                    </Button>
                  ) : null}
                </Toolbar>

                {/* One remedy, for the condition actually being worked. */}
                {focused && (counts?.[focused.key] ?? 0) > 0 ? (
                  <Alert tone={focused.tone} title="What to do" className="mb-3">
                    {focused.remedy}
                  </Alert>
                ) : null}

                <RecordList
                  caption="Invoice anomalies, most serious condition first"
                  columns={columns}
                  paged={paged}
                  rowKey={(row) => `${row.anomaly}-${row.id}`}
                  rowNoun="document"
                  what="the invoice anomaly report"
                  loading={report.loading && !report.data}
                  onRowClick={(row) => setOpenInvoice(row.id)}
                  note="The report's brief carries an amount with no currency, so no figure is shown here. Open a row for the invoice's own currency and total."
                  empty={
                    <EmptyState
                      compact
                      title={condition ? 'Nothing in this condition' : 'Everything reconciles'}
                      description={
                        condition
                          ? 'No document is currently breaking this invariant.'
                          : 'None of the six invariants is broken.'
                      }
                    />
                  }
                />
              </>
            )}
          </Section>
        </>
      )}

      <Section
        title="Gateway reconciliation"
        description="The nightly job comparing Razorpay's record of the money against ours. Read-only."
      >
        {runs.forbidden ? (
          <LockedState
            size="panel"
            title={FORBIDDEN_TITLE}
            description={forbiddenDescription('reconciliation runs')}
          />
        ) : (
          <DataTable
            caption="Gateway reconciliation runs, newest first"
            columns={runColumns}
            rows={runs.items}
            rowKey={(row) => String(row.id)}
            rowNoun="run"
            loading={runs.loading}
            error={runs.error}
            onRetry={runs.reload}
            pageSize={PAGE_SIZE}
            empty={
              <EmptyState
                title="No reconciliation run recorded"
                description="The nightly safety net has never written a run — an empty list is not the same as a clean result."
              />
            }
          />
        )}
      </Section>

      <Dialog
        open={openRun !== null}
        onOpenChange={(next) => {
          if (!next) setOpenRun(null);
        }}
        size="lg"
        title="Gateway reconciliation report"
        description={openRun ? `Run of ${formatDateTime(openRun.ran_at)}` : undefined}
      >
        {/* Raw on purpose: the report's shape is not contractual, and inventing
            a table for it would hide any field the job started emitting. */}
        <CodeBlock
          label="report.json"
          code={openRun ? JSON.stringify(openRun.report, null, 2) : ''}
        />
      </Dialog>

      <InvoiceDrawer
        invoiceId={openInvoice}
        onOpenChange={(next) => {
          if (!next) setOpenInvoice(null);
        }}
        onChanged={report.reload}
      />
    </Stack>
  );
}
