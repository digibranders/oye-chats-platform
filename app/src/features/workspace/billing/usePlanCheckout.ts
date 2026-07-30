/**
 * usePlanCheckout - the plan money-path, extracted verbatim from the legacy
 * PlanModal so the redesigned confirm Drawer can reuse it without
 * reimplementing anything payment-critical.
 *
 * One entry point, `submit(plan, billingCycle, actionKind)`, drives every
 * branch the backend supports:
 *   - downgrade to Free            → change-plan (scheduled at period end)
 *   - trial-eligible paid plan     → start-trial (no card)
 *   - first paid purchase          → checkout → Razorpay → verify
 *   - upgrade/downgrade (active)   → change-plan (proration applied server-side)
 *   - international USD-pending     → surfaced as a notice (contact sales)
 *   - seat overflow on downgrade    → actionable error
 *
 * The two-stage Razorpay handling is deliberate: a throw during the charge is a
 * real payment failure, but a throw during signature verification is NOT - the
 * customer has already been charged and the activation webhook reconciles, so
 * we reassure instead of alarming.
 */
import { useCallback, useState } from 'react';
import { formatTrialDate } from '../../../utils/trial';
import { openRazorpayCheckout } from '../../../lib/razorpay';
import { useCurrency } from '../../../context/CurrencyContext';
import {
  changePlan,
  createCheckoutSession,
  startTrial,
  verifyRazorpaySubscription,
} from '../../../services/api';
import type { PlanView } from '../billingModel';
import type { BillingCycle } from './planMath';

export interface PlanCheckoutContext {
  currentPlanSlug: string;
  currentSubscriptionStatus: string | null;
  hasActiveSubscription: boolean;
  /** Fired with a human-readable message after a successful mutation. */
  onSuccess: (message: string) => void;
  /** Fired to dismiss the surface (drawer close) after success. */
  onDone: () => void;
}

export interface PlanCheckoutResult {
  submitting: boolean;
  error: string;
  notice: string;
  /** Run the checkout money-path for `plan` at `billingCycle`. */
  submit: (plan: PlanView, billingCycle: BillingCycle, actionKind?: string) => Promise<void>;
  /** Clear transient error/notice state (call on drawer open). */
  reset: () => void;
}

// Mirrors planMath.canStartTrial on a PlanView - kept byte-identical in intent
// so the trial gate can never drift between the modal and the drawer.
export function isTrialEligible(
  plan: PlanView,
  currentPlanSlug: string,
  currentSubscriptionStatus: string | null,
): boolean {
  if (plan.slug === currentPlanSlug) return false;
  if (plan.trialDays <= 0) return false;
  const onPaidPlan = Boolean(currentPlanSlug && currentPlanSlug !== 'free');
  return !(currentSubscriptionStatus === 'active' && onPaidPlan);
}

export function usePlanCheckout(ctx: PlanCheckoutContext): PlanCheckoutResult {
  const { currentPlanSlug, currentSubscriptionStatus, hasActiveSubscription, onSuccess, onDone } = ctx;
  const { country: acctCountry } = useCurrency();

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const reset = useCallback(() => {
    setError('');
    setNotice('');
  }, []);

  const submit = useCallback(
    async (plan: PlanView, billingCycle: BillingCycle, actionKind: string = 'auto'): Promise<void> => {
      // Free plan: with an active sub, schedule a cancellation at period end;
      // without one there is nothing to do.
      if (plan.slug === 'free') {
        if (hasActiveSubscription) {
          setError('');
          setNotice('');
          setSubmitting(true);
          try {
            await changePlan(plan.id, billingCycle);
            onSuccess('You’ll move to Free at the end of your current billing period.');
            onDone();
          } catch (err: unknown) {
            setError(err instanceof Error ? err.message : 'Could not downgrade.');
          } finally {
            setSubmitting(false);
          }
          return;
        }
        onDone();
        return;
      }

      const trialEligible = isTrialEligible(plan, currentPlanSlug, currentSubscriptionStatus);
      const takeTrialPath = actionKind === 'trial' || (actionKind === 'auto' && trialEligible);
      if (takeTrialPath) {
        setError('');
        setNotice('');
        setSubmitting(true);
        try {
          await startTrial(plan.slug);
          onSuccess(`Your ${plan.trialDays || 7}-day ${plan.name} trial has started.`);
          onDone();
        } catch (err: unknown) {
          setError(err instanceof Error ? err.message : 'Could not start your free trial.');
        } finally {
          setSubmitting(false);
        }
        return;
      }

      setError('');
      setSubmitting(true);
      try {
        const res = (hasActiveSubscription
          ? await changePlan(plan.id, billingCycle)
          : await createCheckoutSession(plan.id, billingCycle, acctCountry)) as Record<string, unknown>;

        const provider = String(res?.provider || '').toLowerCase();
        const status = String(res?.status || '').toLowerCase();

        if (provider === 'razorpay' && res?.subscription_id) {
          if (!res.key_id) {
            setError('Checkout is temporarily unavailable. Please try again in a moment.');
            return;
          }
          // Stage 1 - the charge/authorisation. A throw here means the payment
          // did NOT go through (dismissed, card declined); safe to surface.
          let cb: Awaited<ReturnType<typeof openRazorpayCheckout>>;
          try {
            cb = await openRazorpayCheckout({
              key: String(res.key_id),
              subscription_id: String(res.subscription_id),
              name: res.name as string | undefined,
              description: res.description as string | undefined,
              prefill: res.prefill as Record<string, unknown> | undefined,
              theme: res.theme as Record<string, unknown> | undefined,
              method: { card: true, upi: true },
            });
          } catch (cbErr: unknown) {
            if ((cbErr as { code?: string })?.code === 'dismissed') {
              setNotice('Payment cancelled - you have not been charged.');
              return;
            }
            throw cbErr;
          }

          // Stage 2 - server-side signature verification. The customer has
          // ALREADY been charged, so a failure here must NOT read as a payment
          // error. The activation webhook is the authoritative reconciler.
          try {
            await verifyRazorpaySubscription({
              razorpay_payment_id: cb.razorpay_payment_id,
              razorpay_subscription_id: cb.razorpay_subscription_id || String(res.subscription_id),
              razorpay_signature: cb.razorpay_signature,
            });
          } catch {
            setNotice(
              'Payment received - we’re finalising your subscription. It’ll activate within a minute; if not, contact support.',
            );
            onSuccess('Payment received - finalising your subscription.');
            onDone();
            return;
          }

          onSuccess(
            hasActiveSubscription
              ? `Your plan changed to ${plan.name}.`
              : `You’re now subscribed to ${plan.name}.`,
          );
          onDone();
          return;
        }

        if (status === 'switched') {
          onSuccess(`Your plan changed to ${plan.name}.`);
          onDone();
          return;
        }
        if (status === 'downgraded') {
          onSuccess(`You’ll move to ${plan.name} at the end of your billing period.`);
          onDone();
          return;
        }
        if (status === 'downgrade_scheduled') {
          const effectiveAt = res?.effective_at ? formatTrialDate(String(res.effective_at)) : null;
          onSuccess(`Downgrade to ${plan.name} scheduled${effectiveAt ? ` for ${effectiveAt}` : ''}.`);
          onDone();
          return;
        }

        throw new Error((res?.message as string) || 'Unexpected response from server.');
      } catch (err: unknown) {
        const detail =
          (err as { response?: { data?: { detail?: unknown } }; detail?: unknown })?.response?.data
            ?.detail ?? (err as { detail?: unknown })?.detail;

        if (
          detail &&
          typeof detail === 'object' &&
          (detail as { reason?: string }).reason === 'intl_usd_pending'
        ) {
          setNotice(
            (detail as { message?: string }).message ||
              'USD billing for international customers is coming soon. Please contact sales.',
          );
          return;
        }
        if (detail && typeof detail === 'object' && (detail as { code?: string }).code === 'seat_overflow') {
          const d = detail as {
            message?: string;
            excess?: number;
            active_seats?: number;
            allowed_seats?: number;
          };
          const excess = d.excess || (Number(d.active_seats) - Number(d.allowed_seats));
          setError(
            d.message ||
              `You have ${d.active_seats} active operator(s) but ${plan.name} only includes ${d.allowed_seats}. Deactivate ${excess} operator(s) on the Members page before downgrading.`,
          );
          return;
        }
        setError(err instanceof Error ? err.message : 'Could not start checkout.');
      } finally {
        setSubmitting(false);
      }
    },
    [acctCountry, currentPlanSlug, currentSubscriptionStatus, hasActiveSubscription, onSuccess, onDone],
  );

  return { submitting, error, notice, submit, reset };
}
