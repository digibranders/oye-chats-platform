import { useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  DataTable,
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
      render: (row) =>
        row.delta_count === 0 ? (
          <span className="text-sm text-text-tertiary">Razorpay and the platform agreed.</span>
        ) : (
          <details>
            <summary className="cursor-pointer text-sm text-accent-600 hover:text-accent-700">
              Show the report
            </summary>
            {/* Rendered raw on purpose: the report's shape is not contractual,
                and inventing a table for it would hide any field the job
                started emitting. */}
            <pre className="mt-2 max-h-64 overflow-auto rounded-md bg-surface-sunken p-3 text-2xs text-text-secondary">
              {JSON.stringify(row.report, null, 2)}
            </pre>
          </details>
        ),
    },
  ];

  return (
    <Stack>
      {report.forbidden ? (
        <LockedState
          title="You cannot read reconciliation"
          description="Your super-admin account is not permitted to read the invoice anomaly report. Nothing was loaded."
        />
      ) : (
        <>
          {totalAnomalies === 0 ? (
            <Alert tone="success" title="Everything reconciles">
              None of the six invariants is broken. That is what a healthy platform looks like — the
              tables below stay empty until something needs a person.
            </Alert>
          ) : totalAnomalies != null ? (
            <Alert
              tone="danger"
              title={`${formatNumber(totalAnomalies)} document${totalAnomalies === 1 ? '' : 's'} need attention`}
            >
              Each block below is a condition that should never persist. Every one of them is a
              customer holding — or missing — a legal document.
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
                    <Card key={group.key}>
                      <CardHeader
                        titleAs="h3"
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
                      />
                      {report.loading && !report.data ? (
                        <CardBody>
                          <EmptyState compact title="Checking…" />
                        </CardBody>
                      ) : count === 0 ? (
                        <EmptyState
                          compact
                          title="Nothing here"
                          description="No document is in this condition."
                        />
                      ) : (
                        <>
                          <CardBody className="pb-0">
                            <Alert tone={group.tone} title="What to do">
                              {group.remedy}
                            </Alert>
                          </CardBody>
                          <CardBody>
                            <DataTable
                              caption={group.title}
                              columns={columns}
                              rows={rows}
                              rowKey={(row) => String(row.id)}
                              rowLabel={(row) => row.invoice_number ?? `document ${row.id}`}
                              onRowClick={(row) => setOpenInvoice(row.id)}
                              pageSize={10}
                              empty={<EmptyState compact title="Nothing here" />}
                            />
                          </CardBody>
                        </>
                      )}
                    </Card>
                  );
                })
              )}
            </Stack>
          </Section>
        </>
      )}

      <Section
        title="Gateway reconciliation"
        description="The nightly job comparing Razorpay's record of the money against ours. Read-only — there is no way to trigger a run from here."
      >
        {runs.forbidden ? (
          <LockedState
            title="You cannot read gateway runs"
            description="Your super-admin account is not permitted to read reconciliation runs. Nothing was loaded."
          />
        ) : (
          <DataTable
            caption="Gateway reconciliation runs, newest first"
            columns={runColumns}
            rows={runs.items}
            rowKey={(row) => String(row.id)}
            loading={runs.loading}
            error={runs.error}
            onRetry={runs.reload}
            pageSize={14}
            empty={
              <EmptyState
                title="No reconciliation run recorded"
                description="The nightly safety net has never written a run. Either it has not run yet on this environment, or the scheduled job is not configured — an empty list is not the same as a clean result."
              />
            }
          />
        )}
      </Section>

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
