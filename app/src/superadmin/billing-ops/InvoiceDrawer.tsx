import { useEffect, useState, type ReactElement, type ReactNode } from 'react';
import { ExternalLink, FileText, Mail, RefreshCw } from 'lucide-react';
import {
  Alert,
  Badge,
  Button,
  ConfirmDialog,
  Drawer,
  FigureRow,
  LoadingRows,
  LockedState,
  PropertyGrid,
  Separator,
  Skeleton,
  Tooltip,
  buttonClass,
  formatDate,
  formatDateTime,
  toast,
} from '../../ui';
import { platform } from '../client';
import { usePlatformResource } from '../usePlatform';
import { FORBIDDEN_TITLE, forbiddenDescription } from '../forbidden';
import type { InvoiceDetail, InvoiceRow } from '../revenue/types';
import { bpsLabel, docMoney, docMoneyWithCode, normaliseCurrency } from '../money';
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
          <>
            {/* Two buttons, not four in two nested flex groups that fought the
                footer's own row and wrapped into an unpredictable 2×2 block.
                The two document actions live beside the PDF section they act
                on. Each disabled control carries its own reason, on itself —
                the reason used to be a bullet in an alert 600px below. */}
            <ActionButton
              label="Mark paid"
              gate={markable}
              onClick={() => setConfirming('mark-paid')}
            />
            <ActionButton
              label="Refund"
              variant="danger"
              gate={refundable}
              onClick={() => setConfirming('refund')}
            />
          </>
        }
      >
        {detail.forbidden ? (
          <LockedState title={FORBIDDEN_TITLE} description={forbiddenDescription('invoices')} />
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
              <InvoiceBody
                record={record}
                full={full}
                loading={detail.loading}
                regenerate={
                  <ActionButton
                    label="Regenerate PDF"
                    variant="secondary"
                    gate={regenerable}
                    loading={busy === 'regenerate'}
                    icon={<RefreshCw aria-hidden />}
                    onClick={() =>
                      void run(
                        'regenerate',
                        () => platform.post(`/invoices/${invoiceId}/regenerate-pdf`),
                        'A fresh render is queued. The worker sweep picks it up within about five minutes.',
                      ).catch(() => undefined)
                    }
                  />
                }
                resend={
                  <ActionButton
                    label="Resend email"
                    variant="secondary"
                    gate={resendable}
                    loading={busy === 'resend'}
                    icon={<Mail aria-hidden />}
                    onClick={() =>
                      void run(
                        'resend',
                        () => platform.post(`/invoices/${invoiceId}/resend-email`),
                        'The document was re-sent to the buyer address on the invoice.',
                      ).catch(() => undefined)
                    }
                  />
                }
              />
            )}
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

/**
 * A control whose reason for being disabled travels with it.
 *
 * A greyed-out button with the explanation somewhere else on the page is a
 * reader pressing it, getting nothing, and then hunting. `Tooltip` handles the
 * disabled trigger; the reason is also the accessible description.
 */
function ActionButton({
  label,
  gate,
  onClick,
  variant = 'secondary',
  loading = false,
  icon,
}: {
  label: string;
  gate: { allowed: boolean; reason?: string };
  onClick: () => void;
  variant?: 'secondary' | 'danger';
  loading?: boolean;
  icon?: ReactElement;
}) {
  const button = (
    <Button
      size="sm"
      variant={variant}
      disabled={!gate.allowed}
      loading={loading}
      onClick={onClick}
      iconLeft={icon}
      title={undefined}
    >
      {label}
    </Button>
  );
  if (gate.allowed || !gate.reason) return button;
  // A disabled button takes no pointer events, so the tooltip needs something
  // that does — the wrapper is focusable so a keyboard user reaches the reason.
  return (
    <Tooltip content={gate.reason}>
      <span tabIndex={0} className="inline-flex rounded-sm">
        {button}
      </span>
    </Tooltip>
  );
}

/** The read-only half of the drawer. Split out so the actions above stay legible. */
function InvoiceBody({
  record,
  full,
  loading,
  regenerate,
  resend,
}: {
  record: InvoiceRow;
  full: InvoiceDetail | null;
  loading: boolean;
  regenerate: ReactNode;
  resend: ReactNode;
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
          {currency ? `${currency}, as issued. ` : 'As issued. '}Nothing here is converted.
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
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {record.pdf_url ? (
            <a
              href={record.pdf_url}
              target="_blank"
              rel="noreferrer noopener"
              className={buttonClass('secondary', 'sm')}
            >
              <FileText aria-hidden />
              Open PDF
              <ExternalLink aria-hidden className="h-3 w-3" />
            </a>
          ) : null}
          {regenerate}
          {resend}
        </div>
      </section>

      <Separator />

      <section aria-labelledby="invoice-record">
        <h3 id="invoice-record" className="text-base font-semibold text-text-primary">
          Record
        </h3>
        <PropertyGrid
          columns={2}
          density="compact"
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
            { label: 'Description', value: full?.description },
          ]}
        />
      </section>
    </>
  );
}
