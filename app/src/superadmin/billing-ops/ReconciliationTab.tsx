import { useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CodeBlock,
  DataTable,
  Dialog,
  EmptyState,
  LockedState,
  Section,
  Stack,
  formatDateTime,
  formatNumber,
  type Column,
  type Tone,
} from '../../ui';
import { usePlatformList, usePlatformResource } from '../usePlatform';
import { FORBIDDEN_TITLE, forbiddenDescription } from '../forbidden';
import { PAGE_SIZE } from '../recordListState';
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
 * Amounts are conspicuously absent from the anomaly tables. The endpoint's brief
 * (`invoice_reports._brief`) returns `amount_cents` with **no currency field**,
 * so there is no honest way to render it as money — a rupee figure printed with
 * a dollar sign on a reconciliation screen is worse than no figure at all. Open
 * a row and the invoice detail supplies both.
 */

interface AnomalyGroup {
  key: AnomalyKey;
  title: string;
  tone: Tone;
  /** What the condition means. */
  meaning: string;
  /** What to do about it. */
  remedy: string;
}

const GROUPS: readonly AnomalyGroup[] = [
  {
    key: 'unnumbered_charges',
    title: 'Charged, but holding no document',
    tone: 'danger',
    meaning:
      'A captured payment that never received an invoice number. The customer paid and has no tax document.',
    remedy:
      'Almost always the seller profile has never been saved, which blocks numbering entirely. Save it on the Seller profile tab; the self-heal sweep re-numbers these once the block clears.',
  },
  {
    key: 'refunds_without_credit_note',
    title: 'Refunded without a credit note',
    tone: 'danger',
    meaning:
      'A refunded, part-refunded or lost-dispute document whose reversing credit note is missing or short of the amount reversed.',
    remedy:
      'The credit note was swallowed by a rolled-back savepoint. It has to be re-issued before the period is filed.',
  },
  {
    key: 'broken_totals',
    title: 'Tax components do not reconcile',
    tone: 'danger',
    meaning:
      'Taxable value plus tax no longer equals the document total, or the GST components no longer sum to the tax. This is impossible through the application.',
    remedy: 'The row was written outside the app. It needs looking at in the database directly.',
  },
  {
    key: 'exports_without_fx',
    title: 'Export with no rupee mirror',
    tone: 'danger',
    meaning:
      'A numbered foreign-currency document with no INR amount stored. It cannot be placed on a rupee-denominated return at all.',
    remedy:
      'Unreachable through finalize, so the row was written outside the application. It must be corrected before filing.',
  },
  {
    key: 'pdfs_pending',
    title: 'Rendered nothing for over an hour',
    tone: 'warning',
    meaning:
      'A numbered document with no PDF, issued more than an hour ago. The five-minute sweep has had many turns at it.',
    remedy:
      'Check the worker first: one started without the pango library skips every render and only logs “PDF renderer unavailable”. Then open a row and queue a fresh render.',
  },
  {
    key: 'emails_pending',
    title: 'Rendered but never delivered',
    tone: 'warning',
    meaning:
      'A document with a PDF that the buyer has still not been emailed, more than an hour after issue.',
    remedy:
      'Usually a delivery outage or a buyer snapshot with no email address. Open a row and resend; if it refuses, the address is missing.',
  },
];

export function ReconciliationTab() {
  const report = usePlatformResource<ReconciliationResponse>('/billing/reconciliation');
  const runs = usePlatformList<GatewayRun>('/reconciliation/gateway', {
    key: 'runs',
    params: { limit: 14 },
  });
  const [openInvoice, setOpenInvoice] = useState<number | null>(null);
  const [openRun, setOpenRun] = useState<GatewayRun | null>(null);

  const counts = report.data?.counts;
  const totalAnomalies = counts ? Object.values(counts).reduce((sum, value) => sum + value, 0) : null;

  const columns: readonly Column<AnomalyBrief>[] = [
    {
      key: 'document',
      header: 'Document',
      pinned: true,
      width: '14rem',
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
              Each block below is a condition that should never persist: a customer holding — or
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
            <Stack>
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
                GROUPS.map((group) => {
                  const rows = report.data?.[group.key] ?? [];
                  const count = counts?.[group.key] ?? 0;
                  return (
                    // A `Section`, not a `Card` around a `DataTable`: the table
                    // draws its own surface, so the card was a second hairline
                    // and a second radius twenty pixels outside the first, six
                    // times down this page.
                    <Section
                      key={group.key}
                      title={group.title}
                      description={group.meaning}
                      actions={
                        count === 0 ? (
                          <Badge tone="success" dot>
                            Clear
                          </Badge>
                        ) : (
                          <Badge tone={group.tone} dot>
                            <span className="figure">{formatNumber(count)}</span> affected
                          </Badge>
                        )
                      }
                    >
                      {count > 0 ? (
                        <Alert tone={group.tone} title="What to do" className="mb-3">
                          {group.remedy}
                        </Alert>
                      ) : null}
                      <DataTable
                        caption={group.title}
                        columns={columns}
                        rows={rows}
                        rowKey={(row) => String(row.id)}
                        rowNoun="document"
                        rowLabel={(row) => row.invoice_number ?? `document ${row.id}`}
                        onRowClick={(row) => setOpenInvoice(row.id)}
                        loading={report.loading && !report.data}
                        pageSize={PAGE_SIZE}
                        empty={
                          <EmptyState
                            compact
                            title="Nothing here"
                            description="No document is in this condition."
                          />
                        }
                      />
                    </Section>
                  );
                })
              )}
            </Stack>
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
