import { useState } from 'react';
import { Download, Receipt } from 'lucide-react';
import {
  ABSENT,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  DataTable,
  Dialog,
  EmptyState,
  FigureList,
  FigureRow,
  PropertyGrid,
  buttonClass,
  type Column,
} from '../../../ui';
import {
  INVOICE_KIND_LABEL,
  formatDate,
  formatMoneyMinor,
  humanizeStatus,
  statusTone,
  type InvoiceView,
} from '../billingModel';

/** `1800` → `18%`. Basis points, because GST rates are not always whole percents. */
function formatRateBps(bps: number): string {
  if (!Number.isFinite(bps) || bps <= 0) return ABSENT;
  const percent = bps / 100;
  return `${Number.isInteger(percent) ? percent : percent.toFixed(2)}%`;
}

const SUPPLY_LABEL: Record<string, string> = {
  intra_state: 'Intra-state supply (CGST + SGST)',
  inter_state: 'Inter-state supply (IGST)',
  export: 'Export of service',
};

/**
 * The GST breakdown for one document.
 *
 * India requires the tax to be itemised on the invoice, and the data has been
 * on `Invoice` since invoicing v2 shipped without a single field of it ever
 * reaching the customer - so the only way to see what one had been charged in
 * tax was to open the PDF, which is exactly the artifact that sometimes never
 * renders.
 *
 * CGST/SGST and IGST are mutually exclusive by construction (a supply is either
 * intra-state or inter-state), so only the pair that applies is listed rather
 * than three rows of which one is always zero.
 */
function InvoiceDetail({ invoice, onClose }: { invoice: InvoiceView | null; onClose: () => void }) {
  const tax = invoice?.tax ?? null;
  return (
    <Dialog
      open={invoice !== null}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={invoice?.number ? `Invoice ${invoice.number}` : 'Payment details'}
      description={
        invoice
          ? `${INVOICE_KIND_LABEL[invoice.kind]} issued ${formatDate(invoice.date)}${
              invoice.periodStart && invoice.periodEnd
                ? ` for ${formatDate(invoice.periodStart)} to ${formatDate(invoice.periodEnd)}`
                : ''
            }.`
          : undefined
      }
      size="md"
      footer={
        invoice?.document === 'ready' && invoice.pdfUrl ? (
          <a
            href={invoice.pdfUrl}
            target="_blank"
            rel="noopener noreferrer"
            className={buttonClass('primary', 'md')}
          >
            <Download aria-hidden />
            Download PDF
          </a>
        ) : (
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        )
      }
    >
      {invoice ? (
        <div className="space-y-5">
          <PropertyGrid
            columns={2}
            label="Invoice details"
            items={[
              {
                label: 'Status',
                value: (
                  <Badge tone={statusTone(invoice.status)}>{humanizeStatus(invoice.status)}</Badge>
                ),
              },
              {
                label: 'Paid on',
                value: invoice.paidAt ? formatDate(invoice.paidAt) : undefined,
              },
              { label: 'Currency', value: invoice.currency },
              { label: 'HSN / SAC', value: tax?.hsnSac },
            ]}
          />

          {tax ? (
            <FigureList>
              <FigureRow
                label="Taxable value"
                value={formatMoneyMinor(tax.taxableMinor, invoice.currency)}
              />
              {tax.isExport ? (
                <FigureRow
                  label="GST"
                  value={formatMoneyMinor(0, invoice.currency)}
                  hint="Export of service, zero-rated"
                />
              ) : tax.igstMinor > 0 ? (
                <FigureRow
                  label={`IGST at ${formatRateBps(tax.rateBps)}`}
                  value={formatMoneyMinor(tax.igstMinor, invoice.currency)}
                />
              ) : (
                <>
                  <FigureRow
                    label={`CGST at ${formatRateBps(tax.rateBps / 2)}`}
                    value={formatMoneyMinor(tax.cgstMinor, invoice.currency)}
                  />
                  <FigureRow
                    label={`SGST at ${formatRateBps(tax.rateBps / 2)}`}
                    value={formatMoneyMinor(tax.sgstMinor, invoice.currency)}
                  />
                </>
              )}
              <FigureRow
                label="Total"
                value={formatMoneyMinor(invoice.amountMinor, invoice.currency)}
                hint={tax.supplyKind ? (SUPPLY_LABEL[tax.supplyKind] ?? tax.supplyKind) : undefined}
                emphasis
              />
            </FigureList>
          ) : (
            <p className="text-prose text-text-secondary">
              This payment predates itemised tax invoices, so it carries no GST breakdown. The
              amount charged was {formatMoneyMinor(invoice.amountMinor, invoice.currency)}.
            </p>
          )}

          {invoice.description ? (
            <p className="text-xs leading-relaxed text-text-secondary">{invoice.description}</p>
          ) : null}
        </div>
      ) : null}
    </Dialog>
  );
}

/**
 * The download control, in the three states a rendered PDF actually has.
 *
 * The root `CLAUDE.md` documents a whole class of bug in which the render job
 * silently never runs and `pdf_url` stays null forever. A button that does
 * nothing is the worst possible answer to that: the customer clicks it, nothing
 * happens, and they have no idea whether to wait or to ask for help. So a
 * document that is still rendering says so, and one that is not coming says
 * that instead and offers the provider's own copy if there is one.
 */
function DocumentCell({ invoice }: { invoice: InvoiceView }) {
  if (invoice.document === 'ready' && invoice.pdfUrl) {
    return (
      <a
        href={invoice.pdfUrl}
        target="_blank"
        rel="noopener noreferrer"
        className={buttonClass('ghost', 'sm')}
      >
        <Download aria-hidden />
        PDF
      </a>
    );
  }
  if (invoice.document === 'preparing') {
    return <span className="text-xs text-text-secondary">Preparing</span>;
  }
  if (invoice.invoiceUrl) {
    return (
      <a
        href={invoice.invoiceUrl}
        target="_blank"
        rel="noopener noreferrer"
        className={buttonClass('ghost', 'sm')}
      >
        Receipt
      </a>
    );
  }
  return <span className="text-xs text-text-tertiary">Unavailable</span>;
}

export function InvoicesSection({
  invoices,
  loading,
  error,
  onRetry,
}: {
  invoices: InvoiceView[];
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  const [open, setOpen] = useState<InvoiceView | null>(null);

  // The row's activation control lives in the first column, so the first column
  // has to be the one that names the row: "DB/26-27/000012, Tax invoice" is a
  // usable accessible name for a button that opens a tax breakdown, and a bare
  // date is not.
  const columns: readonly Column<InvoiceView>[] = [
    {
      key: 'number',
      header: 'Document',
      pinned: true,
      width: '13rem',
      rowHeader: true,
      render: (row) => (
        <span className="flex min-w-0 flex-col">
          <span className="figure truncate text-sm text-text-primary">{row.number ?? ABSENT}</span>
          <span className="text-xs text-text-tertiary">{INVOICE_KIND_LABEL[row.kind]}</span>
        </span>
      ),
    },
    {
      key: 'date',
      header: 'Issued',
      width: '9rem',
      sortable: (a, b) => (a.date ?? '').localeCompare(b.date ?? ''),
      render: (row) => <span className="figure text-sm">{formatDate(row.date)}</span>,
    },
    {
      key: 'period',
      header: 'Period covered',
      secondary: true,
      width: '13rem',
      render: (row) =>
        row.periodStart && row.periodEnd ? (
          <span className="figure text-sm text-text-secondary">
            {formatDate(row.periodStart)} – {formatDate(row.periodEnd)}
          </span>
        ) : (
          <span className="text-text-tertiary">{ABSENT}</span>
        ),
    },
    {
      key: 'tax',
      header: 'GST',
      align: 'right',
      secondary: true,
      width: '8rem',
      sortable: (a, b) => (a.tax?.totalTaxMinor ?? 0) - (b.tax?.totalTaxMinor ?? 0),
      render: (row) =>
        row.tax ? (
          <span className="figure text-sm text-text-secondary">
            {formatMoneyMinor(row.tax.totalTaxMinor, row.currency)}
          </span>
        ) : (
          <span className="text-text-tertiary">{ABSENT}</span>
        ),
    },
    {
      key: 'amount',
      header: 'Amount',
      align: 'right',
      width: '9rem',
      sortable: (a, b) => a.amountMinor - b.amountMinor,
      render: (row) => (
        <span className="figure text-sm font-medium text-text-primary">
          {formatMoneyMinor(row.amountMinor, row.currency)}
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      width: '7rem',
      render: (row) => <Badge tone={statusTone(row.status)}>{humanizeStatus(row.status)}</Badge>,
    },
    {
      key: 'document',
      header: <span className="sr-only">Document</span>,
      align: 'right',
      width: '6rem',
      render: (row) => <DocumentCell invoice={row} />,
    },
  ];

  return (
    <Card>
      <CardHeader eyebrow="Billing history" title="Invoices and receipts" titleAs="h2" />
      <CardBody flush>
        <DataTable
          seated
          columns={columns}
          rows={invoices}
          rowKey={(row) => row.id}
          caption="Invoices and receipts issued to this workspace"
          loading={loading}
          error={error}
          onRetry={onRetry}
          defaultSort={{ key: 'date', direction: 'desc' }}
          pageSize={10}
          onRowClick={(row) => setOpen(row)}
          rowNoun="document"
          empty={
            <EmptyState
              icon={Receipt}
              title="No invoices yet"
              description="Your first invoice appears here the moment a paid plan is charged."
            />
          }
        />
      </CardBody>
      <InvoiceDetail invoice={open} onClose={() => setOpen(null)} />
    </Card>
  );
}
