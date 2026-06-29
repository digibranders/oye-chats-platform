import { useEffect, useState } from 'react';
import { Loader2, ExternalLink, Zap } from 'lucide-react';
import CreditCoin from '../icons/CreditCoin';
import Dialog, {
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogBody,
  DialogFooter,
} from '../ui/Dialog';
import { Button } from '../ui/Button';
import { cn } from '../../lib/utils';
import { getTopupPacks, initiateTopup, verifyTopupPayment } from '../../services/api';
import { useToast } from '../../context/ToastContext';
import { openRazorpayCheckout } from '../../lib/razorpay';

/** Display amount with USD symbol. */
function formatAmount(amount, currency) {
  const sym = currency === 'USD' ? '$' : currency + ' ';
  const numeric = Number(amount);
  const formatted = Number.isInteger(numeric)
    ? numeric.toLocaleString()
    : numeric.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${sym}${formatted}`;
}

/** Per-1k credit unit price for the comparison label. */
function pricePerKCredits(amount, credits) {
  if (!amount || !credits) return null;
  return ((amount / credits) * 1000).toFixed(2);
}

/**
 * Top-up modal — flat-pack purchase only, no referral discount.
 *
 * Referral discounts deliberately live on the *subscription* flow (PlanModal)
 * rather than here: an affiliate's reward should track recurring revenue, not
 * one-off credit packs.
 */
export default function TopupModal({ open, onClose, onSuccess, botId = null, botName = null }) {
  const { showToast } = useToast();
  const [packs, setPacks] = useState([]);
  const [loadingPacks, setLoadingPacks] = useState(false);
  const [submittingPack, setSubmittingPack] = useState(null);

  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    setLoadingPacks(true);
    getTopupPacks()
      .then((data) => {
        if (!cancelled) setPacks(Array.isArray(data) ? data : []);
      })
      .catch((err) => {
        if (!cancelled) showToast(err?.message || 'Failed to load top-up packs', 'error');
      })
      .finally(() => {
        if (!cancelled) setLoadingPacks(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, showToast]);

  /**
   * 1. POST /credits/topup → { provider, order_id, amount, key_id, ... }
   * 2. Open Razorpay Checkout with that payload.
   * 3. On handler resolve, POST /credits/topup/verify with the signature trio.
   * 4. Webhook eventually grants credits server-side; onSuccess triggers a balance poll.
   */
  async function handleBuy(pack) {
    const amount = Number(pack.amount ?? pack.usd ?? 0);
    if (!amount) {
      showToast('Pack is misconfigured (missing amount).', 'error');
      return;
    }
    setSubmittingPack(amount);
    try {
      const result = await initiateTopup(amount, { botId });
      const response = await openRazorpayCheckout({
        key: result.key_id,
        order_id: result.order_id,
        amount: result.amount,
        currency: result.currency || 'USD',
        name: result.name || 'OyeChats credits',
        description: result.description,
        prefill: result.prefill || {},
        theme: result.theme || { color: '#6366f1' },
      });
      try {
        await verifyTopupPayment(response);
      } catch (verifyErr) {
        showToast(
          verifyErr?.message ||
            'Payment received but verification failed. Contact support if credits don\'t appear shortly.',
          'error',
        );
        return;
      }
      showToast('Payment successful — credits will appear in a few seconds.', 'success');
      onSuccess?.();
      onClose?.();
    } catch (err) {
      // openRazorpayCheckout throws on dismiss with code 'dismissed' — silent.
      if (err?.code === 'dismissed') return;
      showToast(err?.message || 'Failed to start checkout', 'error');
    } finally {
      setSubmittingPack(null);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} size="lg">
      <DialogHeader onClose={onClose}>
        <DialogTitle>
          <span className="flex items-center gap-2">
            <CreditCoin className="w-5 h-5 text-primary-500" />
            {botName ? `Top up ${botName}` : 'Top up credits'}
          </span>
        </DialogTitle>
        <DialogDescription>
          {botName
            ? `Credits land in ${botName}'s isolated balance — they won't be used by any other bot. Top-ups roll over for 12 months. Larger packs include bonus credits.`
            : "Top-up credits don't expire for 12 months and roll over month-to-month. Larger packs include bonus credits."}
        </DialogDescription>
      </DialogHeader>

      <DialogBody>
        {loadingPacks ? (
          <div className="flex items-center justify-center py-12 text-surface-500">
            <Loader2 className="w-5 h-5 animate-spin mr-2" />
            Loading packs…
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {packs.map((pack) => {
              const amount = Number(pack.amount ?? pack.usd ?? 0);
              const displayAmount = Number(pack.display_amount ?? amount);
              const displayCurrency = (pack.display_currency || pack.currency || 'USD').toUpperCase();
              const featured = (pack.bonus_pct || 0) >= 20;
              const submitting = submittingPack === amount;
              const perK = pricePerKCredits(displayAmount, pack.credits);
              return (
                <button
                  key={amount}
                  type="button"
                  onClick={() => handleBuy(pack)}
                  disabled={submitting || submittingPack !== null}
                  className={cn(
                    'relative text-left rounded-2xl border p-5 transition-colors duration-200',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/40',
                    'disabled:opacity-60 disabled:cursor-not-allowed',
                    featured
                      ? 'border-primary-500/50 bg-primary-50/50 dark:bg-primary-500/5 hover:border-primary-500'
                      : 'border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-900 hover:border-surface-300 dark:hover:border-surface-600',
                  )}
                >
                  {pack.badge && (
                    <span className="absolute -top-2 right-4 text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-md bg-primary-600 text-white whitespace-nowrap">
                      {pack.badge}
                    </span>
                  )}
                  <div className="flex items-baseline gap-2 flex-wrap">
                    <span className="text-2xl font-bold tabular-nums text-surface-900 dark:text-surface-50">
                      {formatAmount(displayAmount, displayCurrency)}
                    </span>
                  </div>
                  <div className="mt-1 flex items-center gap-1.5 text-sm text-surface-600 dark:text-surface-300 flex-wrap">
                    <Zap className="w-3.5 h-3.5 text-amber-500 shrink-0" />
                    <strong className="font-semibold text-surface-900 dark:text-surface-50">
                      {Number(pack.credits).toLocaleString()}
                    </strong>
                    <span>credits</span>
                    {pack.bonus_pct > 0 && (
                      <span className="inline-flex items-center text-[11px] font-semibold text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-500/10 px-1.5 py-0.5 rounded">
                        +{pack.bonus_pct}% bonus
                      </span>
                    )}
                  </div>
                  {perK && (
                    <div className="mt-3 text-xs text-surface-500 dark:text-surface-400">
                      {formatAmount(perK, displayCurrency)} per 1,000 credits
                    </div>
                  )}
                  <div className="mt-4 flex items-center text-xs font-medium text-primary-600 dark:text-primary-400">
                    {submitting ? (
                      <>
                        <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                        Opening checkout…
                      </>
                    ) : (
                      <>
                        Pay securely
                        <ExternalLink className="w-3.5 h-3.5 ml-1" />
                      </>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        )}

        <p className="mt-4 text-[11px] text-surface-500 dark:text-surface-400 text-center">
          Powered by Razorpay (UPI, cards, NetBanking, wallets).
          Got a referral code? Apply it on the Plan &amp; seats tab for recurring savings.
        </p>
      </DialogBody>

      <DialogFooter>
        <Button variant="ghost" onClick={onClose} disabled={submittingPack !== null}>
          Close
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
