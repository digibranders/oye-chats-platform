import { useState, useEffect } from 'react';
import { Receipt, Download, ExternalLink } from 'lucide-react';
import { getInvoices } from '../../services/api';
import { formatMoney } from '../../lib/currency';
import { cn } from '../../lib/utils';

// Customer-facing invoice list — numbered GST documents with PDF downloads,
// legacy payment-history rows rendered as before (description only). Self-
// loading so it can mount on any billing surface.
const INVOICE_TYPE_LABELS = {
  tax_invoice: 'Tax invoice',
  credit_note: 'Credit note',
  receipt: 'Receipt',
};

const INVOICE_STATUS_STYLES = {
  paid: 'text-emerald-600 dark:text-emerald-400 bg-emerald-500/10',
  issued: 'text-primary-600 dark:text-primary-400 bg-primary-500/10',
};

function formatDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

// A numbered invoice this recent without a PDF is still being rendered by
// the worker (enqueued seconds after payment; 5-min sweep as backstop) —
// poll until the Download link can appear. Older ones without a PDF are
// stuck for some other reason; polling won't fix those.
const PDF_PENDING_WINDOW_MS = 15 * 60 * 1000;
const PDF_POLL_INTERVAL_MS = 8000;

function hasPendingPdf(invoices) {
  const now = Date.now();
  return invoices.some(
    inv =>
      inv.invoice_number &&
      !inv.pdf_url &&
      inv.created_at &&
      now - new Date(inv.created_at).getTime() < PDF_PENDING_WINDOW_MS,
  );
}

export default function InvoicesCard({ limit = 25, refreshKey = 0 }) {
  const [invoices, setInvoices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [pollTick, setPollTick] = useState(0);

  // Refetches whenever the parent bumps refreshKey (post-payment refresh
  // cycle, manual Refresh button) or the PDF poll fires. Only the first
  // load shows the skeleton — refreshes swap the rows in place. A fetch
  // failure is tracked as a distinct error state (audit F36): rendering it
  // as the "no invoices" empty state told customers their tax documents
  // don't exist when the API was merely unreachable.
  useEffect(() => {
    let cancelled = false;
    getInvoices()
      .then(rows => {
        if (!cancelled) {
          setInvoices(rows || []);
          setError(false);
        }
      })
      .catch(() => { if (!cancelled) setError(true); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [refreshKey, pollTick]);

  // Self-terminating: stops the moment no invoice is pending a PDF.
  useEffect(() => {
    if (!hasPendingPdf(invoices)) return undefined;
    const timer = setTimeout(() => setPollTick(t => t + 1), PDF_POLL_INTERVAL_MS);
    return () => clearTimeout(timer);
  }, [invoices]);

  if (loading) {
    return (
      <div className="bg-[var(--bg-card)] dark:bg-surface-900 rounded-2xl border border-surface-200 dark:border-surface-800 p-6">
        <div className="h-4 w-24 rounded bg-surface-100 dark:bg-surface-800 animate-pulse" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-[var(--bg-card)] dark:bg-surface-900 rounded-2xl border border-surface-200 dark:border-surface-800 p-6">
        <h3 className="text-base font-bold tracking-tight text-surface-900 dark:text-surface-50 mb-1">Invoices</h3>
        <p className="text-[13px] text-surface-500 mb-3">
          Couldn&apos;t load your invoices. Check your connection and try again.
        </p>
        <button
          type="button"
          onClick={() => { setLoading(true); setPollTick(t => t + 1); }}
          className="text-[13px] font-medium text-primary-500 hover:text-primary-600"
        >
          Retry
        </button>
      </div>
    );
  }

  if (invoices.length === 0) {
    return (
      <div className="bg-[var(--bg-card)] dark:bg-surface-900 rounded-2xl border border-surface-200 dark:border-surface-800 p-6">
        <h3 className="text-base font-bold tracking-tight text-surface-900 dark:text-surface-50 mb-1">Invoices</h3>
        <p className="text-[13px] text-surface-500">
          Your tax invoices and receipts appear here after each payment.
        </p>
      </div>
    );
  }

  return (
    <div className="bg-[var(--bg-card)] dark:bg-surface-900 rounded-2xl border border-surface-200 dark:border-surface-800 p-6">
      <h3 className="text-base font-bold tracking-tight text-surface-900 dark:text-surface-50 mb-4">Invoices</h3>
      <div className="space-y-2">
        {invoices.slice(0, limit).map(inv => {
          const isCreditNote = inv.invoice_type === 'credit_note';
          const typeLabel = INVOICE_TYPE_LABELS[inv.invoice_type];
          const statusStyle = INVOICE_STATUS_STYLES[inv.status] || 'text-amber-600 dark:text-amber-400 bg-amber-500/10';
          const amount = formatMoney(Math.abs(inv.amount_cents || 0), inv.currency);
          const gstAmount = inv.total_tax_minor ? formatMoney(Math.abs(inv.total_tax_minor), inv.currency) : null;
          return (
            <div
              key={inv.id}
              className="flex items-center justify-between gap-3 py-2.5 px-3 rounded-lg hover:bg-surface-50 dark:hover:bg-surface-800/50 transition-colors"
            >
              <div className="flex items-center gap-3 min-w-0">
                <Receipt size={16} className="text-surface-400 flex-shrink-0" />
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    {inv.invoice_number ? (
                      <p className="text-[13px] font-medium font-mono text-surface-700 dark:text-surface-300 truncate">
                        {inv.invoice_number}
                      </p>
                    ) : (
                      <p className="text-[13px] font-medium text-surface-700 dark:text-surface-300 truncate">
                        {inv.description || 'Invoice'}
                      </p>
                    )}
                    {typeLabel && (
                      <span
                        className={cn(
                          'px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider',
                          isCreditNote
                            ? 'text-primary-600 dark:text-primary-400 bg-primary-500/10'
                            : 'text-surface-500 dark:text-surface-400 bg-surface-500/10',
                        )}
                      >
                        {typeLabel}
                      </span>
                    )}
                  </div>
                  <p className="text-[11px] text-surface-500">
                    {formatDate(inv.issued_at || inv.created_at)}
                    {gstAmount && (
                      <span>
                        {' · '}
                        {isCreditNote ? `GST reversed ${gstAmount}` : `incl. ${gstAmount} GST`}
                      </span>
                    )}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-3 flex-shrink-0">
                <span
                  className={cn(
                    'text-[13px] font-semibold tabular-nums',
                    isCreditNote ? 'text-primary-600 dark:text-primary-400' : 'text-surface-700 dark:text-surface-300',
                  )}
                >
                  {isCreditNote ? `−${amount}` : amount}
                </span>
                <span className={cn('px-2 py-0.5 rounded-full text-[11px] font-semibold capitalize', statusStyle)}>
                  {inv.status}
                </span>
                {inv.pdf_url && (
                  <a
                    href={inv.pdf_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    title="Download PDF"
                    className="inline-flex items-center gap-1 text-[12px] font-medium text-primary-500 hover:text-primary-600"
                  >
                    <Download size={14} />
                    Download
                  </a>
                )}
                {!inv.pdf_url && inv.invoice_url && (
                  <a
                    href={inv.invoice_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    title="View invoice"
                    className="text-primary-500 hover:text-primary-600"
                  >
                    <ExternalLink size={14} />
                  </a>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
