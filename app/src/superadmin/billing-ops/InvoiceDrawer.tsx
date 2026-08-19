import { useEffect, useState } from 'react';
import { ExternalLink, FileText, Mail, RefreshCw } from 'lucide-react';
import {
  Alert,
  Badge,
  Button,
  ConfirmDialog,
  DefinitionList,
  Drawer,
  FigureRow,
  LoadingRows,
  LockedState,
  Separator,
  Skeleton,
  buttonClass,
  formatDate,
  formatDateTime,
  toast,
} from '../../ui';
import { platform } from '../client';
import { usePlatformResource } from '../usePlatform';
import type { InvoiceDetail, InvoiceRow } from '../revenue/types';
import { bpsLabel, docMoney, docMoneyWithCode, normaliseCurrency } from '../revenue/money';
import {
  canMarkPaid,
  canRefund,
  canRegeneratePdf,
  canResendEmail,
  invoiceName,
  invoiceStatusLabel,
  invoiceStatusTone,
  invoiceTypeLabel,
  pdfStatus,
} from './invoice';

/**
 * One invoice, and the four things a super-admin can do to it.
 *
 * This is the console's only invoice-action surface. Revenue's invoice list
 * opens it, and so do the reconciliation report's anomaly tables — deliberately:
 * an operator who has just been told "this document's PDF never rendered"
 * should be one click from queueing the render, not navigating to another
 * section to find the same row again.
 *
 * Two of the four actions move real money or change what a financial record
 * says, so they are gated differently from the two that are merely retries:
 *
 * * **Refund** issues a real Razorpay refund when the document carries a
 *   payment id. It cannot be taken back, so it demands the invoice number typed
 *   out — the one place in these two sections where `confirmPhrase` is
 *   warranted.
 * * **Mark paid** writes `status = 'paid'` against a charge that may never have
 *   been collected. It moves no money, which is exactly why it is dangerous:
 *   the customer's tax document then says they paid. It confirms, naming the
 *   customer and the amount, but does not demand a typed phrase — asking for
 *   one on every reconciliation entry trains people to type past it.
 * * **Regenerate PDF** and **Resend email** are recoveries. They confirm
 *   nothing and report their outcome inline.
 *
 * Every outcome lands in an `Alert` inside the drawer as well as a toast:
 * "a render is queued" is a fact the operator still needs while they decide
 * whether to also go and check the worker, and a notice that disappears after
 * five seconds is the wrong home for it.
 */

export interface InvoiceDrawerProps {
  /** The invoice to open, or `null` for closed. */
  invoiceId: number | null;
  /**
   * The list row that opened the drawer, where the caller has one.
   *
   * With it the header, status and amount are right on the first paint. Without
   * it — the reconciliation report, whose brief carries no currency and no PDF
   * url — the body waits for the real record rather than rendering badges
   * derived from fields that were never sent.
   */
  fallback?: InvoiceRow | null;
  onOpenChange: (open: boolean) => void;
  /** Called after any mutation succeeds, so the list behind can re-read. */
  onChanged?: () => void;
}

type Outcome = { tone: 'success' | 'danger'; text: string } | null;

export function InvoiceDrawer({ invoiceId, fallback, onOpenChange, onChanged }: InvoiceDrawerProps) {
  const detail = usePlatformResource<InvoiceDetail>(invoiceId ? `/invoices/${invoiceId}` : null);
  const [outcome, setOutcome] = useState<Outcome>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<'refund' | 'mark-paid' | null>(null);

  // A new invoice in the drawer must not inherit the previous one's result
  // banner: "Refund issued" sitting above a different customer's document is
  // the worst thing this screen could show.
  useEffect(() => {
    setOutcome(null);
    setConfirming(null);
  }, [invoiceId]);

  if (!invoiceId) return null;

  const full = detail.data;
  const record: InvoiceRow | null = full ?? fallback ?? null;
  const name = record ? invoiceName(record) : `invoice #${invoiceId}`;

  async function run(label: string, action: () => Promise<unknown>, success: string): Promise<void> {
    setBusy(label);
    setOutcome(null);
    try {
      await action();
      setOutcome({ tone: 'success', text: success });
      toast.success(success);
      detail.reload();
      onChanged?.();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The server refused this.';
      setOutcome({ tone: 'danger', text: message });
      // Rethrown for ConfirmDialog, which keeps itself open and shows the
      // failure rather than closing as though it had worked.
      throw error;
    } finally {
      setBusy(null);
    }
  }

  const refundable = record ? canRefund(record) : { allowed: false, reason: 'Still loading.' };
  const markable = record ? canMarkPaid(record) : { allowed: false, reason: 'Still loading.' };
  const regenerable = record ? canRegeneratePdf(record) : { allowed: false, reason: 'Still loading.' };
  const resendable = record ? canResendEmail(record) : { allowed: false, reason: 'Still loading.' };

  return (
    <>
      <Drawer
        open
        onOpenChange={onOpenChange}
        width="lg"
        title={name}
        description={
          record
            ? `${invoiceTypeLabel(record.invoice_type)} · ${record.client_name ?? `client #${record.client_id}`}`
            : 'Reading the document…'
        }
        footer={
          <div className="flex w-full flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="secondary"
                disabled={!regenerable.allowed}
                loading={busy === 'regenerate'}
                onClick={() =>
                  void run(
                    'regenerate',
                    () => platform.post(`/invoices/${invoiceId}/regenerate-pdf`),
                    'A fresh render is queued. The worker sweep picks it up within about five minutes; reopen this document to see the new PDF.',
                  ).catch(() => undefined)
                }
                iconLeft={<RefreshCw aria-hidden className="h-3.5 w-3.5" />}
              >
                Regenerate PDF
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={!resendable.allowed}
                loading={busy === 'resend'}
                onClick={() =>
                  void run(
                    'resend',
                    () => platform.post(`/invoices/${invoiceId}/resend-email`),
                    'The document was re-sent to the buyer address on the invoice.',
                  ).catch(() => undefined)
                }
                iconLeft={<Mail aria-hidden className="h-3.5 w-3.5" />}
              >
                Resend email
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="secondary"
                disabled={!markable.allowed}
                onClick={() => setConfirming('mark-paid')}
              >
                Mark paid
              </Button>
              <Button
                size="sm"
                variant="danger"
                disabled={!refundable.allowed}
                onClick={() => setConfirming('refund')}
              >
                Refund
              </Button>
            </div>
          </div>
        }
      >
        {detail.forbidden ? (
          <LockedState
            title="You cannot read this document"
            description="Your super-admin account is not permitted to read invoices. Nothing was loaded."
          />
        ) : (
          <div className="flex flex-col gap-5">
            {outcome ? (
              <Alert
                tone={outcome.tone}
                live
                title={outcome.tone === 'success' ? 'Done' : 'That did not happen'}
              >
                {outcome.text}
              </Alert>
            ) : null}

            {detail.error && !full ? (
              <Alert
                tone="danger"
                live
                title="The document could not be loaded"
                action={
                  <Button size="sm" variant="secondary" onClick={detail.reload}>
                    Try again
                  </Button>
                }
              >
                {detail.error}
                {fallback
                  ? ' The summary below comes from the list row, so the tax breakdown and gateway references are missing.'
                  : ''}
              </Alert>
            ) : null}

            {!record ? (
              <LoadingRows rows={6} />
            ) : (
              <InvoiceBody record={record} full={full} loading={detail.loading} />
            )}

            {record &&
            (!regenerable.allowed || !resendable.allowed || !refundable.allowed || !markable.allowed) ? (
              <Alert tone="neutral" title="Some actions are unavailable for this document">
                <ul className="list-disc space-y-1 pl-4">
                  {!refundable.allowed ? <li>Refund — {refundable.reason}</li> : null}
                  {!markable.allowed ? <li>Mark paid — {markable.reason}</li> : null}
                  {!regenerable.allowed ? <li>Regenerate PDF — {regenerable.reason}</li> : null}
                  {!resendable.allowed ? <li>Resend email — {resendable.reason}</li> : null}
                </ul>
              </Alert>
            ) : null}
          </div>
        )}
      </Drawer>

      {record ? (
        <>
          <ConfirmDialog
            open={confirming === 'refund'}
            onOpenChange={(next) => setConfirming(next ? 'refund' : null)}
            destructive
            title="Refund this invoice?"
            confirmLabel="Refund"
            confirmPhrase={name}
            confirmPhraseLabel={`Type ${name} to confirm`}
            description={
              <>
                {docMoneyWithCode(record.amount_cents, record.currency)} will be refunded to{' '}
                <strong className="font-semibold text-text-primary">
                  {record.client_name ?? `client #${record.client_id}`}
                </strong>{' '}
                against {name}.{' '}
                {full && full.razorpay_payment_id === null
                  ? 'This document has no Razorpay payment reference, so no money moves at the gateway — it is marked refunded locally and recorded as a manual refund.'
                  : 'A real Razorpay refund is issued for the captured amount, and the resulting refund.created webhook claws back any credits that were granted.'}{' '}
                This cannot be undone from the console.
              </>
            }
            onConfirm={() =>
              run('refund', () => platform.post(`/invoices/${invoiceId}/refund`), `${name} is refunded.`).then(
                () => setConfirming(null),
              )
            }
          />

          <ConfirmDialog
            open={confirming === 'mark-paid'}
            onOpenChange={(next) => setConfirming(next ? 'mark-paid' : null)}
            destructive
            title="Record this invoice as paid?"
            confirmLabel="Mark paid"
            description={
              <>
                {name} for{' '}
                <strong className="font-semibold text-text-primary">
                  {record.client_name ?? `client #${record.client_id}`}
                </strong>{' '}
                ({docMoneyWithCode(record.amount_cents, record.currency)}) is currently{' '}
                <strong className="font-semibold text-text-primary">
                  {invoiceStatusLabel(record.status).toLowerCase()}
                </strong>
                . No money is collected by doing this — it changes what the financial record says.
                Only do it once you have confirmed the payment arrived some other way.
                {record.invoice_number
                  ? ' This document is numbered, so its supply date is frozen and only the status moves.'
                  : ' This row is un-numbered, so the paid timestamp is stamped to now.'}
              </>
            }
            onConfirm={() =>
              run(
                'mark-paid',
                () => platform.post(`/invoices/${invoiceId}/mark-paid`),
                `${name} is recorded as paid.`,
              ).then(() => setConfirming(null))
            }
          />
        </>
      ) : null}
    </>
  );
}

/** The read-only half of the drawer. Split out so the actions above stay legible. */
function InvoiceBody({
  record,
  full,
  loading,
}: {
  record: InvoiceRow;
  full: InvoiceDetail | null;
  loading: boolean;
}) {
  const pdf = pdfStatus(record);
  const currency = normaliseCurrency(record.currency);

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={invoiceStatusTone(record.status)} dot>
          {invoiceStatusLabel(record.status)}
        </Badge>
        <Badge tone={pdf.tone} dot>
          {pdf.label}
        </Badge>
        {record.is_export ? <Badge tone="neutral">Export</Badge> : null}
        {record.credit_note_of_id ? (
          <Badge tone="neutral">Credit note for #{record.credit_note_of_id}</Badge>
        ) : null}
      </div>

      <section aria-labelledby="invoice-amount">
        <h3 id="invoice-amount" className="text-base font-semibold text-text-primary">
          Amount
        </h3>
        <p className="mt-1 text-xs text-text-secondary">
          Stated in the document&rsquo;s own currency
          {currency ? ` (${currency})` : ''}. Nothing on this panel is converted.
        </p>
        <dl className="mt-2">
          <FigureRow
            label="Taxable value"
            value={docMoney(record.taxable_value_minor, record.currency)}
          />
          <FigureRow
            label={`Tax${full?.tax_rate_bps ? ` at ${bpsLabel(full.tax_rate_bps)}` : ''}`}
            value={docMoney(record.total_tax_minor, record.currency)}
            hint={
              full && (full.cgst_minor || full.sgst_minor || full.igst_minor)
                ? `CGST ${docMoney(full.cgst_minor, record.currency)} · SGST ${docMoney(full.sgst_minor, record.currency)} · IGST ${docMoney(full.igst_minor, record.currency)}`
                : undefined
            }
          />
          <FigureRow
            emphasis
            label="Document total"
            value={docMoneyWithCode(record.amount_cents, record.currency)}
          />
        </dl>
      </section>

      <Separator />

      <section aria-labelledby="invoice-pdf">
        <h3 id="invoice-pdf" className="text-base font-semibold text-text-primary">
          PDF
        </h3>
        <p className="mt-1 text-xs leading-relaxed text-text-secondary">{pdf.detail}</p>
        {record.pdf_url ? (
          <a
            href={record.pdf_url}
            target="_blank"
            rel="noreferrer noopener"
            className={buttonClass('secondary', 'sm', 'mt-2')}
          >
            <FileText aria-hidden className="h-3.5 w-3.5" />
            Open PDF
            <ExternalLink aria-hidden className="h-3 w-3" />
          </a>
        ) : null}
      </section>

      <Separator />

      <section aria-labelledby="invoice-record">
        <h3 id="invoice-record" className="text-base font-semibold text-text-primary">
          Record
        </h3>
        <DefinitionList
          columns={2}
          className="mt-3"
          items={[
            { label: 'Document number', value: record.invoice_number ?? 'Not numbered' },
            { label: 'Document type', value: invoiceTypeLabel(record.invoice_type) },
            {
              label: 'Customer',
              value: record.client_name ?? `client #${record.client_id}`,
            },
            { label: 'Client id', value: <span className="figure">{record.client_id}</span> },
            { label: 'Issued', value: formatDateTime(record.issued_at) },
            { label: 'Created', value: formatDateTime(record.created_at) },
            {
              label: 'Billing period',
              value: full?.period_start
                ? `${formatDate(full.period_start)} – ${formatDate(full.period_end)}`
                : '—',
            },
            { label: 'Supply kind', value: record.supply_kind ?? '—' },
            { label: 'Place of supply', value: full?.place_of_supply ?? '—' },
            { label: 'HSN / SAC', value: full?.hsn_sac ?? '—' },
            {
              label: 'Razorpay payment',
              value: full ? (
                full.razorpay_payment_id ? (
                  <span className="figure break-all">{full.razorpay_payment_id}</span>
                ) : (
                  'None — a refund here is recorded locally only'
                )
              ) : loading ? (
                <Skeleton className="h-4 w-32" />
              ) : (
                '—'
              ),
            },
            {
              label: 'Razorpay invoice',
              value: full?.razorpay_invoice_id ? (
                <span className="figure break-all">{full.razorpay_invoice_id}</span>
              ) : (
                '—'
              ),
            },
            { label: 'Description', value: full?.description ?? '—' },
          ]}
        />
      </section>
    </>
  );
}
