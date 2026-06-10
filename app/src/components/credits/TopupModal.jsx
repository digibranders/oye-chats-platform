import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Sparkles, Loader2, ExternalLink, Zap, Gift, CheckCircle2, XCircle, X as XIcon } from 'lucide-react';
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

/** Display amount with currency symbol. Defaults to "$" (USD). */
function formatAmount(amount, currency) {
  const sym = currency === 'USD' ? '$' : currency === 'INR' ? '₹' : currency + ' ';
  const numeric = Number(amount);
  // USD prices in the pack config are stored as whole dollars (e.g. 19, 49,
  // 99). Showing decimals on whole numbers looks heavy on the card; only
  // surface decimals for non-round values (e.g. the per-1k credits label).
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

export default function TopupModal({ open, onClose, onSuccess }) {
  const { showToast } = useToast();
  const [packs, setPacks] = useState([]);
  const [loadingPacks, setLoadingPacks] = useState(false);
  const [submittingPack, setSubmittingPack] = useState(null);

  const [referralInput, setReferralInput] = useState('');
  const [referralStatus, setReferralStatus] = useState('idle'); // 'idle' | 'applying' | 'applied' | 'invalid'
  const [referralMessage, setReferralMessage] = useState('');
  // The applied code (server-normalized, uppercased) + its discount % — both
  // sourced from the backend's apply-referral response so the UI always
  // matches what will actually fire at checkout. discountPct is 0 when the
  // code is valid but carries no customer-facing discount.
  const [appliedCode, setAppliedCode] = useState(null);
  const [discountPct, setDiscountPct] = useState(0);
  const referralInputRef = useRef(null);

  useEffect(() => {
    if (!open) {
      setReferralInput('');
      setReferralStatus('idle');
      setReferralMessage('');
      setAppliedCode(null);
      setDiscountPct(0);
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
      // The backend returns `code` + `discount_pct` whenever the code is
      // valid — regardless of attribution outcome — so the UI can show
      // the discount applied for idempotent re-entries too. When `code`
      // is null we treat the input as invalid.
      if (result.code) {
        setReferralStatus('applied');
        setReferralMessage(result.message);
        setAppliedCode(result.code);
        setDiscountPct(Number(result.discount_pct) || 0);
      } else {
        setReferralStatus('invalid');
        setReferralMessage(result.message);
        setAppliedCode(null);
        setDiscountPct(0);
      }
    } catch (err) {
      setReferralStatus('invalid');
      setReferralMessage(err?.message || 'Failed to apply referral code.');
      setAppliedCode(null);
      setDiscountPct(0);
    }
  }

  function handleClearReferral() {
    setReferralInput('');
    setReferralStatus('idle');
    setReferralMessage('');
    setAppliedCode(null);
    setDiscountPct(0);
    setTimeout(() => referralInputRef.current?.focus(), 50);
  }

  /** Apply the active discount to a pack's amount. Rounded down to whole rupees. */
  function discountedAmount(amount) {
    if (!discountPct) return amount;
    return Math.max(0, Math.floor(amount * (1 - discountPct / 100)));
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
              const currency = pack.currency || 'USD';
              const featured = (pack.bonus_pct || 0) >= 20;
              const submitting = submittingPack === amount;
              const perK = pricePerKCredits(amount, pack.credits);
              const hasDiscount = discountPct > 0 && appliedCode;
              const finalAmount = hasDiscount ? discountedAmount(amount) : amount;
              return (
                <motion.button
                  key={amount}
                  type="button"
                  onClick={() => handleBuy(pack)}
                  disabled={submitting || submittingPack !== null}
                  animate={
                    hasDiscount
                      ? {
                          scale: [1, 1.015, 1],
                          boxShadow: [
                            '0 0 0 0 rgba(16, 185, 129, 0)',
                            '0 0 0 6px rgba(16, 185, 129, 0.18)',
                            '0 0 0 0 rgba(16, 185, 129, 0)',
                          ],
                        }
                      : { scale: 1, boxShadow: '0 0 0 0 rgba(16, 185, 129, 0)' }
                  }
                  transition={{ duration: 0.6, ease: 'easeOut' }}
                  className={cn(
                    'relative text-left rounded-2xl border p-5 transition-colors duration-200',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/40',
                    'disabled:opacity-60 disabled:cursor-not-allowed',
                    hasDiscount
                      ? 'border-emerald-400/70 dark:border-emerald-500/50 bg-emerald-50/40 dark:bg-emerald-500/[0.04] hover:border-emerald-500'
                      : featured
                        ? 'border-primary-500/50 bg-primary-50/50 dark:bg-primary-500/5 hover:border-primary-500'
                        : 'border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-900 hover:border-surface-300 dark:hover:border-surface-600',
                  )}
                >
                  {/* Top-right badge — only ONE shows at a time. Discount wins
                      over pack.badge ("Best value") which wins over bonus_pct.
                      Keeps the corner uncluttered and avoids the prior overflow
                      where strikethrough + bonus pill collided with the badge. */}
                  <AnimatePresence mode="wait">
                    {hasDiscount ? (
                      <motion.span
                        key="applied-badge"
                        initial={{ opacity: 0, y: -6, scale: 0.85 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: -6, scale: 0.85 }}
                        transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
                        className="absolute -top-2 right-4 inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-md bg-emerald-500 text-white shadow-sm shadow-emerald-500/30 whitespace-nowrap"
                      >
                        <CheckCircle2 className="w-2.5 h-2.5" />
                        {discountPct.toFixed(0)}% Off
                      </motion.span>
                    ) : pack.badge ? (
                      <span className="absolute -top-2 right-4 text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-md bg-primary-600 text-white whitespace-nowrap">
                        {pack.badge}
                      </span>
                    ) : null}
                  </AnimatePresence>

                  <div className="flex items-baseline gap-2 flex-wrap">
                    <AnimatePresence mode="wait" initial={false}>
                      <motion.span
                        key={hasDiscount ? `disc-${finalAmount}` : `full-${amount}`}
                        initial={{ opacity: 0, y: 6 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -6 }}
                        transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
                        className={cn(
                          'text-2xl font-bold tabular-nums',
                          hasDiscount
                            ? 'text-emerald-600 dark:text-emerald-400'
                            : 'text-surface-900 dark:text-surface-50',
                        )}
                      >
                        {formatAmount(finalAmount, currency)}
                      </motion.span>
                    </AnimatePresence>
                    <AnimatePresence>
                      {hasDiscount && (
                        <motion.span
                          key="strike"
                          initial={{ opacity: 0, x: -4 }}
                          animate={{ opacity: 1, x: 0 }}
                          exit={{ opacity: 0, x: -4 }}
                          transition={{ duration: 0.22, delay: 0.05 }}
                          className="text-base font-medium line-through text-surface-400 dark:text-surface-500 tabular-nums"
                        >
                          {formatAmount(amount, currency)}
                        </motion.span>
                      )}
                    </AnimatePresence>
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
                      {formatAmount(perK, currency)} per 1,000 credits
                    </div>
                  )}
                  <div
                    className={cn(
                      'mt-4 flex items-center text-xs font-medium',
                      hasDiscount
                        ? 'text-emerald-600 dark:text-emerald-400'
                        : 'text-primary-600 dark:text-primary-400',
                    )}
                  >
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
                </motion.button>
              );
            })}
          </div>
        )}
        {/* Referral code */}
        <motion.div
          animate={
            referralStatus === 'applied'
              ? {
                  borderColor: 'rgba(16, 185, 129, 0.6)',
                  backgroundColor: 'rgba(16, 185, 129, 0.06)',
                }
              : {}
          }
          transition={{ duration: 0.3 }}
          className="mt-5 rounded-xl border border-surface-200 dark:border-surface-700 bg-surface-50 dark:bg-surface-800/50 p-4"
        >
          <p className="text-xs font-medium text-surface-600 dark:text-surface-300 mb-2 flex items-center gap-1.5">
            <Gift
              className={cn(
                'w-3.5 h-3.5 transition-colors',
                referralStatus === 'applied' ? 'text-emerald-500' : 'text-primary-500',
              )}
            />
            {referralStatus === 'applied' ? 'Referral code active' : 'Have a referral code?'}
          </p>

          <AnimatePresence mode="wait">
            {referralStatus === 'applied' && appliedCode ? (
              <motion.div
                key="applied-chip"
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
                className="flex items-center justify-between gap-2 rounded-lg bg-emerald-50 dark:bg-emerald-500/10 border border-emerald-200 dark:border-emerald-500/30 px-3 py-2"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
                  <div className="min-w-0">
                    <p className="text-[13px] font-semibold text-emerald-700 dark:text-emerald-300 truncate">
                      <code className="font-mono tracking-wider">{appliedCode}</code> applied
                      {discountPct > 0 && (
                        <span className="ml-1 font-bold">— {discountPct.toFixed(0)}% off</span>
                      )}
                    </p>
                    {discountPct === 0 && (
                      <p className="text-[11px] text-emerald-600/80 dark:text-emerald-400/80 mt-0.5">
                        Thanks — your referrer is credited.
                      </p>
                    )}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={handleClearReferral}
                  className="shrink-0 inline-flex items-center justify-center w-6 h-6 rounded-md text-emerald-700 dark:text-emerald-400 hover:bg-emerald-100 dark:hover:bg-emerald-500/20 transition-colors"
                  aria-label="Remove referral code"
                  title="Remove referral code"
                >
                  <XIcon className="w-3.5 h-3.5" />
                </button>
              </motion.div>
            ) : (
              <motion.div
                key="input"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.18 }}
                className="flex gap-2"
              >
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
                  onKeyDown={(e) => e.key === 'Enter' && handleApplyReferral()}
                  placeholder="e.g. FRIEND20"
                  disabled={referralStatus === 'applying'}
                  maxLength={20}
                  className={cn(
                    'flex-1 rounded-lg border px-3 py-1.5 text-sm font-mono tracking-widest uppercase',
                    'bg-white dark:bg-surface-900 text-surface-900 dark:text-surface-50',
                    'placeholder:text-surface-400 dark:placeholder:text-surface-500 placeholder:font-sans placeholder:tracking-normal',
                    'focus:outline-none focus:ring-2 focus:ring-primary-500/40',
                    'disabled:opacity-60 disabled:cursor-not-allowed',
                    referralStatus === 'invalid'
                      ? 'border-red-400 dark:border-red-500'
                      : 'border-surface-300 dark:border-surface-600',
                  )}
                />
                <button
                  type="button"
                  onClick={handleApplyReferral}
                  disabled={!referralInput.trim() || referralStatus === 'applying'}
                  className={cn(
                    'shrink-0 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/40',
                    'disabled:opacity-50 disabled:cursor-not-allowed',
                    'bg-primary-600 text-white hover:bg-primary-700',
                  )}
                >
                  {referralStatus === 'applying' ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    'Apply'
                  )}
                </button>
              </motion.div>
            )}
          </AnimatePresence>

          <AnimatePresence>
            {referralStatus === 'invalid' && referralMessage && (
              <motion.p
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.18 }}
                className="mt-1.5 text-xs flex items-center gap-1 text-red-500 dark:text-red-400"
              >
                <XCircle className="w-3 h-3 shrink-0" />
                {referralMessage}
              </motion.p>
            )}
          </AnimatePresence>
        </motion.div>

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
