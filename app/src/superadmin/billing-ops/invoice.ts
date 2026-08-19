import type { Tone } from '../../ui';
import type { InvoiceRow } from '../revenue/types';

/**
 * Everything the console needs to know about an invoice, as pure functions.
 *
 * It lives in `billing-ops/` rather than `revenue/` because the questions it
 * answers are operational — "is this document renderable", "can this be
 * refunded", "did the PDF fail or has it simply not been rendered yet". The
 * Revenue section imports it for its invoice list; that is one shared module,
 * not two copies of the same rules.
 */

/** `invoice_reports.PDF_STUCK_AFTER` — one hour, in milliseconds. */
export const PDF_STUCK_AFTER_MS = 60 * 60 * 1000;

const INVOICE_TONE: Record<string, Tone> = {
  paid: 'success',
  issued: 'success',
  pending: 'warning',
  created: 'warning',
  attempted: 'warning',
  partially_refunded: 'warning',
  failed: 'danger',
  refunded: 'danger',
  dispute_lost: 'danger',
  void: 'neutral',
  cancelled: 'neutral',
  canceled: 'neutral',
};

export function invoiceStatusTone(status: string | null | undefined): Tone {
  if (!status) return 'neutral';
  return INVOICE_TONE[status] ?? 'neutral';
}

/** `partially_refunded` → `Partially refunded`. Unknown values pass through. */
export function invoiceStatusLabel(status: string | null | undefined): string {
  if (!status) return 'Unknown';
  const spaced = status.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

const TYPE_LABEL: Record<string, string> = {
  tax_invoice: 'Tax invoice',
  credit_note: 'Credit note',
  receipt: 'Receipt',
  legacy: 'Legacy payment row',
};

export function invoiceTypeLabel(type: string | null | undefined): string {
  if (!type) return 'Legacy payment row';
  return TYPE_LABEL[type] ?? type;
}

/**
 * The state of an invoice's rendered PDF.
 *
 * The root `CLAUDE.md` documents a whole class of bug here: the ARQ worker
 * renders invoice PDFs through WeasyPrint, and when it cannot find pango it
 * logs "PDF renderer unavailable" and the render silently never happens —
 * `pdf_url` just stays null forever. A console that shows "no PDF" for both
 * that and for a document issued forty seconds ago makes the failure invisible,
 * which is precisely how it went unnoticed on 2026-07-03.
 *
 * So the two are separated by the same cutoff the server's own reconciliation
 * report uses: under an hour is the sweep still having its turn, over an hour
 * with no PDF is a failure somebody has to act on.
 */
export type PdfState = 'ready' | 'rendering' | 'stuck' | 'not-a-document';

export interface PdfStatus {
  state: PdfState;
  label: string;
  tone: Tone;
  /** What it means and what to do, for the detail panel. */
  detail: string;
}

export function pdfStatus(invoice: InvoiceRow, now: Date = new Date()): PdfStatus {
  if (!invoice.invoice_number) {
    return {
      state: 'not-a-document',
      label: 'No document',
      tone: 'neutral',
      detail:
        'This is a legacy payment-history row, not an issued document. It has no invoice number, so there is nothing to render and regeneration is refused by the server.',
    };
  }
  if (invoice.pdf_url) {
    return {
      state: 'ready',
      label: 'Rendered',
      tone: 'success',
      detail: 'The PDF is rendered and stored. The link opens the current capability URL.',
    };
  }
  const issued = invoice.issued_at ? new Date(invoice.issued_at).getTime() : NaN;
  const waited = Number.isNaN(issued) ? 0 : now.getTime() - issued;
  if (waited > PDF_STUCK_AFTER_MS) {
    return {
      state: 'stuck',
      label: 'Render failed',
      tone: 'danger',
      detail:
        'Numbered more than an hour ago and still has no PDF. The five-minute sweep has had many turns, so this is a renderer failure rather than a queue delay — check the worker (a worker started without the pango library skips renders and logs “PDF renderer unavailable”), then queue a fresh render.',
    };
  }
  return {
    state: 'rendering',
    label: 'Rendering',
    tone: 'warning',
    detail:
      'Issued recently and not yet rendered. The worker sweep picks these up roughly every five minutes; it is only a fault once it has been waiting more than an hour.',
  };
}

/**
 * Whether the two irreversible actions are even offered.
 *
 * A disabled control with a reason beats a control that fails after the
 * confirmation — by then the operator has already decided to do it.
 */
export interface ActionAvailability {
  allowed: boolean;
  /** Why not. Empty when allowed. */
  reason: string;
}

export function canRefund(invoice: InvoiceRow): ActionAvailability {
  if (invoice.status === 'refunded') {
    return { allowed: false, reason: 'Already refunded. The server refuses a second refund.' };
  }
  if (invoice.invoice_type === 'credit_note') {
    return {
      allowed: false,
      reason: 'A credit note is itself the reversal of an invoice. Refund the invoice it reverses.',
    };
  }
  return { allowed: true, reason: '' };
}

export function canMarkPaid(invoice: InvoiceRow): ActionAvailability {
  if (invoice.status === 'paid') {
    return { allowed: false, reason: 'Already recorded as paid.' };
  }
  if (invoice.status === 'refunded') {
    return {
      allowed: false,
      reason: 'This document is refunded. Marking it paid would contradict the refund on record.',
    };
  }
  return { allowed: true, reason: '' };
}

export function canRegeneratePdf(invoice: InvoiceRow): ActionAvailability {
  if (!invoice.invoice_number) {
    return {
      allowed: false,
      reason: 'Legacy rows have no document to regenerate — the server answers 409.',
    };
  }
  return { allowed: true, reason: '' };
}

export function canResendEmail(invoice: InvoiceRow): ActionAvailability {
  if (!invoice.invoice_number) {
    return { allowed: false, reason: 'Legacy rows have no document to send.' };
  }
  if (!invoice.pdf_url) {
    return {
      allowed: false,
      reason: 'There is no rendered PDF to attach yet. The server refuses with 409 until there is.',
    };
  }
  return { allowed: true, reason: '' };
}

/** How an invoice is named to a human: its number, or its id when un-numbered. */
export function invoiceName(invoice: InvoiceRow): string {
  return invoice.invoice_number ?? `payment row #${invoice.id}`;
}
