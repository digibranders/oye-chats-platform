import { useEffect, useRef, useState } from 'react';
import { Check } from 'lucide-react';

import { Button, Field, Input } from '../../../ui';
import { useTranslation } from '../../../i18n/useTranslation';
import { applyReferralCode, previewCoupon, type CouponPreview } from '../../../services/api';

/**
 * One field for both kinds of code, because a buyer holding one does not know
 * which kind they hold.
 *
 * The old console had this and the rebuild dropped it, leaving
 * `applyReferralCode` defined and never called and no way at all to spend a
 * coupon. The two kinds resolve differently and that difference is deliberately
 * invisible here:
 *
 * A REFERRAL attaches to the account. It is first-touch and permanent, so
 * applying one is a real mutation and the price it changes is fetched again
 * afterwards.
 *
 * A COUPON is spent on one checkout. It is only previewed here and travels to
 * the server in the checkout body, so a buyer who closes the dialog has not
 * used up a redemption.
 *
 * Referral is tried first: it is the one that can be permanent, and trying the
 * throwaway one first would attach nothing while quietly shadowing a code that
 * should have.
 */

export interface AppliedCode {
  code: string;
  /** Set for a coupon. Null for a referral, which needs nothing at checkout. */
  couponCode: string | null;
  description: string;
}

interface DiscountCodeFieldProps {
  /**
   * A code the visitor arrived with, tried once on mount.
   *
   * Silently, and this is the point: the same `?code=` may be a launch
   * PROMOTION, which was already attributed at signup and applies on its own.
   * Surfacing "that code is not recognised" for a code that is working
   * perfectly, on a screen the buyer did not type into, would be a lie.
   */
  initialCode?: string;
  planId: number | null;
  /** Free-period coupons are monthly-only; on annual the field says so. */
  billingCycle: 'monthly' | 'annual';
  applied: AppliedCode | null;
  onApplied: (applied: AppliedCode) => void;
  disabled?: boolean;
}

function describe(
  preview: CouponPreview,
  t: (k: string, v?: Record<string, unknown>) => string | null,
): string {
  if (preview.kind === 'free_months') {
    return preview.free_months === 1
      ? t('billing.oneMonthFree') || '1 month free'
      : t('billing.nMonthsFree', { count: preview.free_months }) || `${preview.free_months} months free`;
  }
  return t('billing.nPercentOff', { pct: preview.discount_pct }) || `${preview.discount_pct}% off`;
}

export function DiscountCodeField({
  initialCode,
  planId,
  billingCycle,
  applied,
  onApplied,
  disabled = false,
}: DiscountCodeFieldProps) {
  const { t } = useTranslation();
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // One attempt per mount, whatever re-renders happen in between.
  const autoTried = useRef(false);

  async function apply(silent = false): Promise<void> {
    const code = (silent ? initialCode ?? '' : value).trim();
    if (!code || busy) return;
    setBusy(true);
    setError('');
    try {
      // A referral attributes server-side and returns the code it attached.
      // `code: null` means it did not match, which is the signal to try the
      // other kind rather than an error worth showing.
      const referral = await applyReferralCode(code).catch(() => ({ code: null, message: '' }));
      if (referral.code) {
        onApplied({
          code: referral.code,
          couponCode: null,
          description:
            referral.discount_pct && referral.discount_pct > 0
              ? t('billing.nPercentOff', { pct: referral.discount_pct }) || `${referral.discount_pct}% off`
              : t('billing.applied') || 'applied',
        });
        return;
      }

      const preview = await previewCoupon(code, planId ?? undefined);
      if (preview.monthly_only && billingCycle === 'annual') {
        setError(t('billing.thisCodeIsMonthlyOnly') || 'This code applies to monthly billing only.');
        return;
      }
      onApplied({ code: preview.code, couponCode: preview.code, description: describe(preview, t) });
    } catch (cause) {
      if (silent) return;
      setError(
        cause instanceof Error && cause.message
          ? cause.message
          : t('billing.thatCodeCouldNotBeApplied') || 'That code could not be applied.',
      );
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (autoTried.current || applied || !initialCode) return;
    autoTried.current = true;
    void apply(true);
    // `apply` closes over state that changes on every keystroke; the ref above
    // is what actually bounds this to one attempt.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialCode, applied]);

  if (applied) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-border px-3 py-2.5 text-sm">
        <Check aria-hidden className="h-icon-sm w-icon-sm shrink-0 text-success" />
        <span className="text-text-primary">
          {t('billing.codeApplied', { code: applied.code }) || `Code ${applied.code} applied`}
          {applied.description ? ` · ${applied.description}` : ''}
        </span>
      </div>
    );
  }

  return (
    <div className="rounded-md border border-border px-3 py-2.5">
      <Field label={t('billing.haveACode') || 'Have a code?'} error={error || null}>
        <div className="flex items-start gap-2">
          <Input
            value={value}
            onChange={(event) => {
              setValue(event.target.value);
              if (error) setError('');
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void apply();
              }
            }}
            placeholder={t('billing.egFriend20') || 'e.g. FRIEND20'}
            className="min-w-0 flex-1 font-mono uppercase"
            disabled={disabled || busy}
            aria-invalid={error ? true : undefined}
          />
          <Button
            variant="secondary"
            onClick={() => void apply()}
            disabled={disabled || busy || !value.trim()}
          >
            {busy ? t('billing.checking') || 'Checking…' : t('billing.apply') || 'Apply'}
          </Button>
        </div>
      </Field>
    </div>
  );
}
