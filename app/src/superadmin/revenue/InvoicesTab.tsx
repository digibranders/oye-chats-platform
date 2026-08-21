import { useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  DataTable,
  EmptyState,
  SearchField,
  Section,
  Select,
  Stack,
  Toolbar,
  formatDate,
  type Column,
} from '../../ui';
import { usePlatformList, useUrlState } from '../usePlatform';
import { FORBIDDEN_TITLE, forbiddenDescription } from '../forbidden';
import { InvoiceDrawer } from '../billing-ops/InvoiceDrawer';
import {
  invoiceStatusLabel,
  invoiceStatusTone,
  invoiceTypeLabel,
  pdfStatus,
} from '../billing-ops/invoice';
import { docMoney, normaliseCurrency } from '../money';
import type { InvoiceRow } from './types';

/**
 * Every document the platform has issued.
 *
 * The only genuinely paginated list in this section, so it is the only one with
 * a pager: `page`, `limit` and a real `total` come back from the server, and the
 * page lives in the URL so an operator can send a colleague the exact screen
 * they are looking at.
 *
 * **Amounts are not converted here and never should be.** An invoice is a legal
 * record of a specific sum in a specific currency; the aggregate USD figures on
 * the Overview tab are a reporting convention laid over these, not a restatement
 * of them. The currency column is therefore not optional decoration — it is the
 * column that stops a rupee invoice being read as a dollar one.
 */

/** `list_all_invoices` — `limit` is bounded at 200; 50 is its own default. */
const PAGE_SIZE = 50;

const TYPE_OPTIONS = [
  { value: '', label: 'All document types' },
  { value: 'tax_invoice', label: 'Tax invoices' },
  { value: 'credit_note', label: 'Credit notes' },
  { value: 'receipt', label: 'Receipts' },
  { value: 'legacy', label: 'Legacy rows' },
];

export function InvoicesTab() {
  const url = useUrlState();
  const page = url.getNumber('page', 1);
  const search = url.get('q');
  const invoiceType = url.get('type');
  const includeLegacy = url.get('legacy') === '1';
  const [open, setOpen] = useState<InvoiceRow | null>(null);

  const list = usePlatformList<InvoiceRow>('/invoices', {
    params: {
      page,
      limit: PAGE_SIZE,
      search: search || undefined,
      invoice_type: invoiceType || undefined,
      include_legacy: includeLegacy || undefined,
    },
  });

  const filtered = Boolean(search || invoiceType);
  const now = new Date();

  const columns: readonly Column<InvoiceRow>[] = [
    {
      key: 'number',
      header: 'Document',
      pinned: true,
      width: '13rem',
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
      key: 'customer',
      header: 'Customer',
      width: '13rem',
      render: (row) => (
        <div className="min-w-0">
          <p className="truncate text-sm text-text-primary">
            {row.client_name ?? `client #${row.client_id}`}
          </p>
          <p className="figure truncate text-2xs text-text-tertiary">client #{row.client_id}</p>
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      width: '9rem',
      render: (row) => (
        <Badge tone={invoiceStatusTone(row.status)} dot>
          {invoiceStatusLabel(row.status)}
        </Badge>
      ),
    },
    {
      key: 'amount',
      header: 'Amount',
      align: 'right',
      width: '10rem',
      render: (row) => <span className="figure">{docMoney(row.amount_cents, row.currency)}</span>,
    },
    {
      key: 'currency',
      header: 'Currency',
      width: '6rem',
      // Its own column rather than a suffix: this table mixes INR and USD
      // documents, and a column of symbols is not something anyone scans.
      render: (row) => (
        <span className="figure text-sm text-text-secondary">
          {normaliseCurrency(row.currency) ?? 'not recorded'}
        </span>
      ),
    },
    {
      key: 'pdf',
      header: 'PDF',
      width: '9rem',
      secondary: true,
      render: (row) => {
        const state = pdfStatus(row, now);
        return (
          <Badge tone={state.tone} dot>
            {state.label}
          </Badge>
        );
      },
    },
    {
      key: 'issued',
      header: 'Issued',
      width: '10rem',
      secondary: true,
      render: (row) => (
        <span className="figure text-sm">{formatDate(row.issued_at ?? row.created_at)}</span>
      ),
    },
  ];

  return (
    <Stack>
      <Section
        title="Invoices"
        description="Newest first. Amounts are shown exactly as issued — nothing here is converted."
      >
        <Toolbar sticky className="mb-3">
          <SearchField
            label="Search invoices by number, customer name or email"
            placeholder="Invoice number, name or email"
            className="w-72"
            size="sm"
            value={search}
            onValueChange={(next) => url.set({ q: next || null })}
          />
          <div className="w-48">
            <Select
              size="sm"
              label="Filter by document type"
              options={TYPE_OPTIONS}
              value={invoiceType}
              onValueChange={(value) => url.set({ type: value })}
            />
          </div>
          {/* `aria-label` as well as `label`: outside a `Field` the primitive has
              no id to hang `htmlFor` on, so the visible text alone would not
              name the control for assistive tech. */}
          <Checkbox
            checked={includeLegacy}
            aria-label="Include legacy payment rows"
            onCheckedChange={(next) => url.set({ legacy: next === true ? '1' : null })}
            label="Include legacy payment rows"
          />
          {filtered || includeLegacy ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => url.set({ q: null, type: null, legacy: null })}
            >
              Clear filters
            </Button>
          ) : null}
        </Toolbar>

        {includeLegacy ? (
          <Alert tone="neutral" className="mb-3" title="Legacy rows are included">
            They mirror a payment, carry no invoice number, and cannot be re-rendered or re-sent.
          </Alert>
        ) : null}

        <DataTable
          caption="Issued documents, newest first"
          columns={columns}
          rows={list.items}
          rowKey={(row) => String(row.id)}
          rowNoun="document"
          rowLabel={(row) => row.invoice_number ?? `payment row ${row.id}`}
          loading={list.loading}
          // Forbidden wins over the error it arrived as: a 403 comes back
          // through the same failure path as an outage, and "we could not load
          // this" would send an operator hunting one that is not there.
          error={list.forbidden ? null : list.error}
          forbidden={
            list.forbidden
              ? { title: FORBIDDEN_TITLE, description: forbiddenDescription('issued documents') }
              : null
          }
          onRetry={list.reload}
          onRowClick={setOpen}
          pageSize={PAGE_SIZE}
          page={page}
          rowCount={list.total}
          onPageChange={(next) => url.set({ page: next })}
          empty={
            <EmptyState
              title={filtered ? 'Nothing matched' : 'No documents issued yet'}
              description={
                filtered
                  ? 'No document matches that search or type. Legacy rows are excluded unless the box above is ticked.'
                  : 'Nothing has been issued. If customers have been charged, they may be un-numbered legacy rows — check the seller profile is saved.'
              }
              action={
                filtered ? (
                  <Button size="sm" onClick={() => url.set({ q: null, type: null })}>
                    Clear filters
                  </Button>
                ) : undefined
              }
            />
          }
        />
      </Section>

      <InvoiceDrawer
        invoiceId={open?.id ?? null}
        fallback={open}
        onOpenChange={(next) => {
          if (!next) setOpen(null);
        }}
        onChanged={list.reload}
      />
    </Stack>
  );
}
