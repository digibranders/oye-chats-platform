import { useEffect, useState, type ReactElement } from 'react';
import { ExternalLink, Loader2, Zap } from 'lucide-react';
import { Modal, cn } from '../../../design-system';
import { useCurrency } from '../../../context/CurrencyContext';
import { openRazorpayCheckout } from '../../../lib/razorpay';
import { getTopupPacks, initiateTopup, verifyTopupPayment } from '../../../services/api';

interface TopupPack {
  amount?: number;
  usd?: number;
  display_amount?: number;
  display_currency?: string;
  currency?: string;
  credits: number;
  bonus_pct?: number;
  badge?: string;
}

export interface TopupModalProps {
  open: boolean;
  onClose: () => void;
  /** Fired after a verified purchase with a status message. */
  onSuccess?: (message: string) => void;
  botId?: number | null;
  botName?: string | null;
}

/** Display a MAJOR-unit amount with the right currency symbol + grouping. */
function formatAmount(amount: number, currency: string): string {
  const isInr = String(currency).toUpperCase() === 'INR';
  const sym = isInr ? '₹' : currency === 'USD' ? '$' : `${currency} `;
  const locale = isInr ? 'en-IN' : undefined;
  const numeric = Number(amount);
  const formatted = Number.isInteger(numeric)
    ? numeric.toLocaleString(locale)
    : numeric.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${sym}${formatted}`;
}

function pricePerKCredits(amount: number, credits: number): string | null {
  if (!amount || !credits) return null;
  return ((amount / credits) * 1000).toFixed(2);
}

/**
 * TopupModal — the redesigned one-off credit purchase dialog. Flat-pack only,
 * no referral discount (those track recurring revenue on the plan flow). The
 * money-path (initiateTopup → Razorpay → verifyTopupPayment) is ported verbatim
 * from the legacy `components/credits/TopupModal.jsx`; presentation is new DS.
 */
export function TopupModal({ open, onClose, onSuccess, botId = null, botName = null }: TopupModalProps): ReactElement | null {
  const { isInr } = useCurrency();
  const [packs, setPacks] = useState<TopupPack[]>([]);
  const [loadingPacks, setLoadingPacks] = useState(false);
  const [submittingPack, setSubmittingPack] = useState<number | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    setLoadingPacks(true);
    setError('');
    getTopupPacks()
      .then((data) => {
        if (!cancelled) setPacks(Array.isArray(data) ? (data as unknown as TopupPack[]) : []);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load top-up packs');
      })
      .finally(() => {
        if (!cancelled) setLoadingPacks(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  async function handleBuy(pack: TopupPack): Promise<void> {
    const amount = Number(pack.amount ?? pack.usd ?? 0);
    if (!amount) {
      setError('Pack is misconfigured (missing amount).');
      return;
    }
    setSubmittingPack(amount);
    setError('');
    try {
      const result = (await initiateTopup(amount, { botId })) as Record<string, unknown>;
      // Fail fast on a malformed order payload instead of opening Razorpay with
      // "undefined"/NaN, which would present the customer a broken checkout.
      if (!result.key_id || !result.order_id || !result.amount) {
        setError('Checkout is temporarily unavailable. Please try again in a moment.');
        return;
      }
      const response = await openRazorpayCheckout({
        key: String(result.key_id),
        order_id: String(result.order_id),
        amount: Number(result.amount),
        currency: (result.currency as string) || 'USD',
        name: (result.name as string) || 'OyeChats credits',
        description: result.description as string | undefined,
        prefill: (result.prefill as Record<string, unknown>) || {},
        theme: (result.theme as Record<string, unknown>) || { color: '#a21caf' },
      });
      try {
        await verifyTopupPayment({
          razorpay_order_id: response.razorpay_order_id ?? String(result.order_id),
          razorpay_payment_id: response.razorpay_payment_id,
          razorpay_signature: response.razorpay_signature,
        });
      } catch (verifyErr: unknown) {
        setError(
          verifyErr instanceof Error
            ? verifyErr.message
            : 'Payment received but verification failed. Contact support if credits don’t appear shortly.',
        );
        return;
      }
      onSuccess?.('Payment successful — credits will appear in a few seconds.');
      onClose();
    } catch (err: unknown) {
      if ((err as { code?: string })?.code === 'dismissed') return;
      setError(err instanceof Error ? err.message : 'Failed to start checkout');
    } finally {
      setSubmittingPack(null);
    }
  }

  if (!open) return null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      dismissible={submittingPack === null}
      size="lg"
      title={botName ? `Top up ${botName}` : 'Top up credits'}
      description={
        botName
          ? `Credits land in ${botName}'s isolated balance. Top-ups roll over for 12 months. Larger packs include bonus credits.`
          : 'Top-up credits don’t expire for 12 months and roll over month-to-month. Larger packs include bonus credits.'
      }
    >
      {error && (
        <div
          role="alert"
          className="mb-4 rounded-lg border border-[var(--ds-danger)] bg-[var(--ds-danger-soft)] px-3 py-2.5 text-[13px] text-[var(--ds-danger)]"
        >
          {error}
        </div>
      )}

      {loadingPacks ? (
        <div className="flex items-center justify-center gap-2 py-12 text-[13px] text-[var(--ds-text-muted)]">
          <Loader2 size={18} className="animate-spin" />
          Loading packs…
        </div>
      ) : packs.length === 0 ? (
        <p className="py-12 text-center text-[13px] text-[var(--ds-text-muted)]">
          No credit packs are available right now. Please try again in a moment — if this keeps happening,
          contact support.
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {packs.map((pack, idx) => {
            const amount = Number(pack.amount ?? pack.usd ?? 0);
            const shownAmount = isInr ? amount : Number(pack.display_amount ?? amount);
            const shownCurrency = isInr
              ? 'INR'
              : (pack.display_currency || pack.currency || 'USD').toUpperCase();
            const featured = Boolean(pack.badge);
            const submitting = submittingPack === amount;
            const perK = pricePerKCredits(shownAmount, pack.credits);
            return (
              <button
                key={`${amount}-${pack.credits}-${idx}`}
                type="button"
                onClick={() => handleBuy(pack)}
                disabled={submitting || submittingPack !== null}
                className={cn(
                  'relative rounded-2xl border p-5 text-left transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-ring)]',
                  'disabled:cursor-not-allowed disabled:opacity-60',
                  featured
                    ? 'border-[var(--ds-accent)] bg-[var(--ds-accent-soft)] hover:border-[var(--ds-accent-hover)]'
                    : 'border-[var(--ds-border)] bg-[var(--ds-bg-surface)] hover:bg-[var(--ds-bg-hover)]',
                )}
              >
                {pack.badge && (
                  <span className="absolute -top-2 right-4 whitespace-nowrap rounded-md bg-[var(--ds-accent)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--ds-accent-fg)]">
                    {pack.badge}
                  </span>
                )}
                <div className="text-2xl font-bold tabular-nums text-[var(--ds-text)]">
                  {formatAmount(shownAmount, shownCurrency)}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-1.5 text-sm text-[var(--ds-text-muted)]">
                  <Zap size={14} className="shrink-0 text-[var(--ds-warning)]" />
                  <strong className="font-semibold text-[var(--ds-text)]">
                    {Number(pack.credits).toLocaleString()}
                  </strong>
                  <span>credits</span>
                  {(pack.bonus_pct ?? 0) > 0 && (
                    <span className="inline-flex items-center rounded bg-[var(--ds-success-soft)] px-1.5 py-0.5 text-[11px] font-semibold text-[var(--ds-success)]">
                      +{pack.bonus_pct}% bonus
                    </span>
                  )}
                </div>
                {perK && (
                  <div className="mt-3 text-xs text-[var(--ds-text-subtle)]">
                    {formatAmount(Number(perK), shownCurrency)} per 1,000 credits
                  </div>
                )}
                <div className="mt-4 flex items-center gap-1.5 text-xs font-medium text-[var(--ds-accent-text)]">
                  {submitting ? (
                    <>
                      <Loader2 size={14} className="animate-spin" />
                      Opening checkout…
                    </>
                  ) : (
                    <>
                      Pay securely
                      <ExternalLink size={14} />
                    </>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      )}

      <p className="mt-4 text-center text-[11px] text-[var(--ds-text-subtle)]">
        Powered by Razorpay (UPI, cards, NetBanking, wallets). Got a referral code? Apply it on the plan
        picker for recurring savings.
      </p>
    </Modal>
  );
}
