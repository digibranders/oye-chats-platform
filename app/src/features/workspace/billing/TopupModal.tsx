import { useEffect, useState, type ReactElement } from 'react';
import { ExternalLink, Loader2, Zap } from 'lucide-react';
import { Modal, cn } from '../../../design-system';
import { useCurrency } from '../../../context/CurrencyContext';
import { openRazorpayCheckout } from '../../../lib/razorpay';
import {
  getCreditBalance,
  getTopupPacks,
  initiateTopup,
  verifyTopupPayment,
  recordBillingEvent,
} from '../../../services/api';
import { describeTopupExpiry, parseCreditBalance } from '../usage-model';

interface TopupPack {
  /** INR charge amount (major unit, rupees) - the canonical price on the Razorpay rail. */
  inr?: number;
  /** Legacy alias for the INR charge amount. */
  amount?: number;
  /** USD display price (shown to non-INR buyers) - never charged. */
  usd?: number;
  display_amount?: number;
  display_currency?: string;
  currency?: string;
  credits: number;
  bonus_pct?: number;
  badge?: string;
}

/** The INR amount Razorpay charges for a pack - never the USD display figure. */
function chargeInr(pack: TopupPack): number {
  return Number(pack.inr ?? pack.amount ?? 0);
}

export interface TopupModalProps {
  open: boolean;
  onClose: () => void;
  /** Fired after a verified purchase with a status message. */
  onSuccess?: (message: string) => void;
  /**
   * Fired when the server refuses the purchase until billing details are on
   * record (registered/export buyers). The host page opens the billing-details
   * form focused on the missing fields instead of stranding the customer on
   * an error banner.
   */
  onBillingDetailsRequired?: (missing: string[]) => void;
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

/** The single pack to promote: the first badged one, else the highest-bonus one, else none. */
function featuredPackIndex(packs: TopupPack[]): number {
  const badged = packs.findIndex((p) => p.badge);
  if (badged !== -1) return badged;
  let best = -1;
  let bestBonus = 0;
  packs.forEach((p, i) => {
    const bonus = p.bonus_pct ?? 0;
    if (bonus > bestBonus) {
      bestBonus = bonus;
      best = i;
    }
  });
  return best;
}


/**
 * TopupModal - the redesigned one-off credit purchase dialog. Flat-pack only,
 * no referral discount (those track recurring revenue on the plan flow). The
 * money-path (initiateTopup → Razorpay → verifyTopupPayment) is ported verbatim
 * from the pre-2.0 credits top-up modal; presentation is new DS.
 */
export function TopupModal({
  open,
  onClose,
  onSuccess,
  onBillingDetailsRequired,
  botId = null,
  botName = null,
}: TopupModalProps): ReactElement | null {
  // `isInr` decides which of the two figures on a pack is shown, so it is a
  // price input, not a cosmetic one. Held back behind `currencyLoading`: until
  // /geo settles the context is only reporting its safe default (the charge
  // currency), and rendering ₹1,000 to a buyer who is about to be shown $13
  // is a price that changes under them mid-decision.
  const { isInr, loading: currencyLoading } = useCurrency();
  const [packs, setPacks] = useState<TopupPack[]>([]);
  const [loadingPacks, setLoadingPacks] = useState(false);
  const [submittingPack, setSubmittingPack] = useState<number | null>(null);
  const [error, setError] = useState('');
  // Neutral (non-error) feedback — e.g. "you cancelled, nothing was charged".
  const [notice, setNotice] = useState('');
  // What we can truthfully say about expiry, or null while unknown/unevidenced.
  const [expiryNote, setExpiryNote] = useState<string | null>(null);

  // Expiry is a term of sale, so it is read from the customer's own ledger
  // rather than asserted. Deliberately a separate request from the packs one:
  // it must never delay, block, or fail the purchase path — if it doesn't
  // arrive, the dialog simply makes no expiry claim.
  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    setExpiryNote(null);
    getCreditBalance()
      .then((raw) => {
        if (!cancelled) setExpiryNote(describeTopupExpiry(parseCreditBalance(raw)));
      })
      .catch(() => {
        if (!cancelled) setExpiryNote(null);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    setLoadingPacks(true);
    setError('');
    setNotice('');
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
    // Razorpay charges INR - send the pack's INR price, never the USD figure.
    const amount = chargeInr(pack);
    if (!amount) {
      setError('Pack is misconfigured (missing amount).');
      return;
    }
    setSubmittingPack(amount);
    setError('');
    setNotice('');
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
        theme: (result.theme as Record<string, unknown>) || { color: '#7C3AED' },
        // Tokenise on success so repeat top-ups need only a CVV. Razorpay
        // requires BOTH: customer_id says whose token this is, save=1 opts this
        // payment into tokenisation. Consent is collected inside Razorpay's own
        // UI - we never see the card number, and RBI rules mean we never store
        // more than the last four digits.
        customer_id: result.customer_id as string | undefined,
        save: result.customer_id ? 1 : undefined,
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
      onSuccess?.('Payment successful - credits will appear in a few seconds.');
      onClose();
    } catch (err: unknown) {
      // The customer closed the Razorpay sheet themselves. Detected via the
      // modal's ondismiss (src/lib/razorpay.js) — say so, or returning to the
      // app reads as "nothing happened / did my payment go through?".
      if ((err as { code?: string })?.code === 'dismissed') {
        void recordBillingEvent('checkout_abandoned', 'topup', { amount });
        setNotice('Payment cancelled - you were not charged.');
        return;
      }
      if ((err as { code?: string })?.code === 'payment_failed') {
        void recordBillingEvent('payment_failed', 'topup', { amount });
      }
      const detail =
        (err as { response?: { data?: { detail?: unknown } }; detail?: unknown })?.response?.data
          ?.detail ?? (err as { detail?: unknown })?.detail;
      // Registered/export buyers must complete billing details first — hand
      // off to the form instead of a dead-end banner (B2C buyers below the
      // Rule 46(f) threshold never hit this).
      if (
        detail &&
        typeof detail === 'object' &&
        (detail as { code?: string }).code === 'billing_details_required' &&
        onBillingDetailsRequired
      ) {
        onClose();
        onBillingDetailsRequired((detail as { missing?: string[] }).missing ?? []);
        return;
      }
      setError(err instanceof Error ? err.message : 'Failed to start checkout');
    } finally {
      setSubmittingPack(null);
    }
  }

  if (!open) return null;

  const featuredIndex = featuredPackIndex(packs);
  const description = [
    botName
      ? `Credits land in ${botName}'s isolated balance. One-time purchase.`
      : 'One-time purchase, on top of your plan.',
    expiryNote,
    'Larger packs include bonus credits.',
  ]
    .filter((sentence): sentence is string => sentence !== null)
    .join(' ');

  return (
    <Modal
      open={open}
      onClose={onClose}
      dismissible={submittingPack === null}
      size="lg"
      title={botName ? `Top up ${botName}` : 'Top up credits'}
      description={description}
    >
      {error && (
        <div
          role="alert"
          className="mb-4 rounded-lg border border-[var(--ds-danger)] bg-[var(--ds-danger-soft)] px-3 py-2.5 text-[13px] text-[var(--ds-danger)]"
        >
          {error}
        </div>
      )}

      {notice && !error && (
        <div
          role="status"
          className="mb-4 rounded-lg border border-[var(--ds-border)] bg-[var(--ds-surface-2)] px-3 py-2.5 text-[13px] text-[var(--ds-text-muted)]"
        >
          {notice}
        </div>
      )}

      {loadingPacks || currencyLoading ? (
        <div className="flex items-center justify-center gap-2 py-12 text-[13px] text-[var(--ds-text-muted)]">
          <Loader2 size={18} className="animate-spin" />
          {/* Neutral wording: this spinner covers BOTH waits (the pack list and
              the currency to price it in), so it must not claim to be fetching
              packs that may already have arrived. */}
          Loading…
        </div>
      ) : packs.length === 0 ? (
        <p className="py-12 text-center text-[13px] text-[var(--ds-text-muted)]">
          No credit packs are available right now. Please try again in a moment - if this keeps happening,
          contact support.
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {packs.map((pack, idx) => {
            // One accent per view: only ONE pack is featured - the first badged
            // pack, else the highest-bonus pack. Matches the Plans grid rule so
            // a second badge can't create competing highlights.
            const isFeatured = idx === featuredIndex;
            const amount = chargeInr(pack);
            // INR buyers see the INR charge; non-INR buyers see the USD display
            // price (the Razorpay rail still charges INR - that gate lives on
            // the server). Never show the USD number with a ₹ symbol.
            const shownAmount = isInr ? amount : Number(pack.usd ?? pack.display_amount ?? amount);
            const shownCurrency = isInr
              ? 'INR'
              : (pack.display_currency || pack.currency || 'USD').toUpperCase();
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
                  'focus-visible:outline-none focus-visible:shadow-[0_0_0_1px_var(--ds-ring)]',
                  'disabled:cursor-not-allowed disabled:opacity-60',
                  isFeatured
                    ? 'border-[var(--ds-accent)] bg-[var(--ds-bg-surface)] shadow-[0_0_0_1px_var(--ds-accent),0_8px_24px_-12px_var(--ds-accent)] hover:border-[var(--ds-accent-hover)]'
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
