import { useEffect, useRef, useState } from 'react';
import { Sparkles, Loader2, ExternalLink, Zap, Gift, CheckCircle2, XCircle } from 'lucide-react';
import Dialog, {
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogBody,
  DialogFooter,
} from '../ui/Dialog';
import { Button } from '../ui/Button';
import { cn } from '../../lib/utils';
import { getTopupPacks, initiateTopup, verifyTopupPayment, applyReferralCode } from '../../services/api';
import { useToast } from '../../context/ToastContext';
import { openRazorpayCheckout } from '../../lib/razorpay';

const TRUSTED_REDIRECT_DOMAINS = ['checkout.stripe.com', 'billing.stripe.com'];
function isTrustedRedirectUrl(url) {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === 'https:' &&
      TRUSTED_REDIRECT_DOMAINS.some(
        (d) => parsed.hostname === d || parsed.hostname.endsWith('.' + d),
      )
    );
  } catch {
    return false;
  }
}

/** Display amount with currency symbol — falls back to "₹" for INR-coded packs. */
function formatAmount(amount, currency) {
  const sym = currency === 'INR' ? '₹' : currency === 'USD' ? '$' : currency + ' ';
  return `${sym}${Number(amount).toLocaleString()}`;
}

/** Per-1k credit unit price for the comparison label. */
function pricePerKCredits(amount, credits) {
  if (!amount || !credits) return null;
  return ((amount / credits) * 1000).toFixed(2);
}

export default function TopupModal({ open, onClose, onSuccess }) {
  const { showToast } = useToast();
  const [packs, setPacks] = useState([]);
  const [loadingPacks, setLoadingPacks] = useState(false);
  const [submittingPack, setSubmittingPack] = useState(null);

  const [referralInput, setReferralInput] = useState('');
  const [referralStatus, setReferralStatus] = useState('idle'); // 'idle' | 'applying' | 'applied' | 'invalid'
  const [referralMessage, setReferralMessage] = useState('');
  const referralInputRef = useRef(null);

  useEffect(() => {
    if (!open) {
      setReferralInput('');
      setReferralStatus('idle');
      setReferralMessage('');
      return;
    }
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

  async function handleApplyReferral() {
    const code = referralInput.trim().toUpperCase();
    if (!code) return;
    setReferralStatus('applying');
    setReferralMessage('');
    try {
      const result = await applyReferralCode(code);
      if (result.attributed) {
        setReferralStatus('applied');
        setReferralMessage(result.message);
      } else {
        setReferralStatus('invalid');
        setReferralMessage(result.message);
      }
    } catch (err) {
      setReferralStatus('invalid');
      setReferralMessage(err?.message || 'Failed to apply referral code.');
    }
  }

  /**
   * Razorpay flow:
   *   1. POST /credits/topup → { provider, order_id, amount, key_id, ... }
   *   2. Open Razorpay Checkout with that payload.
   *   3. On handler resolve, POST /credits/topup/verify with the signature trio.
   *   4. Webhook eventually grants credits server-side; we trigger onSuccess
   *      so the parent page polls for the new balance.
   *
   * Stripe flow:
   *   1. POST /credits/topup → { provider, checkout_url, ... }
   *   2. Validate URL host then redirect via window.location.
   *   3. On return ?topup=success, the parent page picks up the success.
   */
  async function handleBuy(pack) {
    const amount = Number(pack.amount ?? pack.usd ?? 0);
    if (!amount) {
      showToast('Pack is misconfigured (missing amount).', 'error');
      return;
    }
    setSubmittingPack(amount);
    try {
      const result = await initiateTopup(amount);
      const provider = String(result?.provider || '').toLowerCase();

      if (provider === 'razorpay') {
        const response = await openRazorpayCheckout({
          key: result.key_id,
          order_id: result.order_id,
          amount: result.amount,
          currency: result.currency || 'INR',
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
        return;
      }

      if (provider === 'stripe') {
        const url = result?.checkout_url;
        if (!url || !isTrustedRedirectUrl(url)) {
          showToast('Could not start checkout — please contact support.', 'error');
          return;
        }
        window.location.href = url;
        return;
      }

      showToast(`Unknown billing provider: ${provider || 'none'}`, 'error');
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
            <Sparkles className="w-5 h-5 text-primary-500" />
            Top up credits
          </span>
        </DialogTitle>
        <DialogDescription>
          Top-up credits don&apos;t expire for 12 months and roll over month-to-month. Larger
          packs include bonus credits.
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
              const currency = pack.currency || 'INR';
              const featured = (pack.bonus_pct || 0) >= 20;
              const submitting = submittingPack === amount;
              const perK = pricePerKCredits(amount, pack.credits);
              return (
                <button
                  key={amount}
                  type="button"
                  onClick={() => handleBuy(pack)}
                  disabled={submitting || submittingPack !== null}
                  className={cn(
                    'relative text-left rounded-2xl border p-5 transition-all duration-200',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/40',
                    'disabled:opacity-60 disabled:cursor-not-allowed',
                    featured
                      ? 'border-primary-500/50 bg-primary-50/50 dark:bg-primary-500/5 hover:border-primary-500'
                      : 'border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-900 hover:border-surface-300 dark:hover:border-surface-600',
                  )}
                >
                  {pack.badge && (
                    <span className="absolute -top-2 right-4 text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-md bg-primary-600 text-white">
                      {pack.badge}
                    </span>
                  )}
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-2xl font-bold text-surface-900 dark:text-surface-50">
                      {formatAmount(amount, currency)}
                    </span>
                    {pack.bonus_pct > 0 && (
                      <span className="text-xs font-semibold text-emerald-600 dark:text-emerald-400">
                        +{pack.bonus_pct}% bonus
                      </span>
                    )}
                  </div>
                  <div className="mt-1 flex items-center gap-1.5 text-sm text-surface-600 dark:text-surface-300">
                    <Zap className="w-3.5 h-3.5 text-amber-500" />
                    <strong className="font-semibold text-surface-900 dark:text-surface-50">
                      {Number(pack.credits).toLocaleString()}
                    </strong>{' '}
                    credits
                  </div>
                  {perK && (
                    <div className="mt-3 text-xs text-surface-500 dark:text-surface-400">
                      {formatAmount(perK, currency)} per 1,000 credits
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
        {/* Referral code */}
        <div className="mt-5 rounded-xl border border-surface-200 dark:border-surface-700 bg-surface-50 dark:bg-surface-800/50 p-4">
          <p className="text-xs font-medium text-surface-600 dark:text-surface-300 mb-2 flex items-center gap-1.5">
            <Gift className="w-3.5 h-3.5 text-primary-500" />
            Have a referral code?
          </p>
          <div className="flex gap-2">
            <input
              ref={referralInputRef}
              type="text"
              value={referralInput}
              onChange={(e) => {
                setReferralInput(e.target.value.toUpperCase());
                if (referralStatus !== 'idle') {
                  setReferralStatus('idle');
                  setReferralMessage('');
                }
              }}
              onKeyDown={(e) => e.key === 'Enter' && referralStatus !== 'applied' && handleApplyReferral()}
              placeholder="e.g. FRIEND20"
              disabled={referralStatus === 'applied' || referralStatus === 'applying'}
              maxLength={20}
              className={cn(
                'flex-1 rounded-lg border px-3 py-1.5 text-sm font-mono tracking-widest uppercase',
                'bg-white dark:bg-surface-900 text-surface-900 dark:text-surface-50',
                'placeholder:text-surface-400 dark:placeholder:text-surface-500 placeholder:font-sans placeholder:tracking-normal',
                'focus:outline-none focus:ring-2 focus:ring-primary-500/40',
                'disabled:opacity-60 disabled:cursor-not-allowed',
                referralStatus === 'applied'
                  ? 'border-emerald-400 dark:border-emerald-500'
                  : referralStatus === 'invalid'
                    ? 'border-red-400 dark:border-red-500'
                    : 'border-surface-300 dark:border-surface-600',
              )}
            />
            <button
              type="button"
              onClick={handleApplyReferral}
              disabled={!referralInput.trim() || referralStatus === 'applied' || referralStatus === 'applying'}
              className={cn(
                'shrink-0 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/40',
                'disabled:opacity-50 disabled:cursor-not-allowed',
                referralStatus === 'applied'
                  ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400'
                  : 'bg-primary-600 text-white hover:bg-primary-700',
              )}
            >
              {referralStatus === 'applying' ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : referralStatus === 'applied' ? (
                <CheckCircle2 className="w-4 h-4" />
              ) : (
                'Apply'
              )}
            </button>
          </div>
          {referralMessage && (
            <p
              className={cn(
                'mt-1.5 text-xs flex items-center gap-1',
                referralStatus === 'applied'
                  ? 'text-emerald-600 dark:text-emerald-400'
                  : 'text-red-500 dark:text-red-400',
              )}
            >
              {referralStatus === 'applied' ? (
                <CheckCircle2 className="w-3 h-3 shrink-0" />
              ) : (
                <XCircle className="w-3 h-3 shrink-0" />
              )}
              {referralMessage}
            </p>
          )}
        </div>

        <p className="mt-3 text-[11px] text-surface-500 dark:text-surface-400 text-center">
          Powered by Razorpay (UPI, cards, NetBanking, wallets) for India · Stripe for international.
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
