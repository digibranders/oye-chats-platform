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
import { useCallback, useRef, useState } from 'react';
import { formatTrialDate } from '../../../utils/trial';
import { openRazorpayCheckout } from '../../../lib/razorpay';
import { useCurrency } from '../../../context/CurrencyContext';
import {
  changePlan,
  createCheckoutSession,
  startTrial,
  verifyRazorpaySubscription,
  recordBillingEvent,
} from '../../../services/api';
import { promotionAppliesToPlan, type PlanView, type PromotionView } from '../billingModel';
import type { ActivationHint } from './usePlanActivation';
import type { BillingCycle } from './planMath';

/**
 * Read the server's `retry_after_seconds` poll hint off a verify response.
 * Additive on the backend, so it is absent on older builds and every caller
 * has to work without it.
 */
function activationHint(res: Record<string, unknown> | undefined): ActivationHint | undefined {
  const seconds = res?.retry_after_seconds;
  return typeof seconds === 'number' ? { retryAfterSeconds: seconds } : undefined;
}

/**
 * Fallback copy for "your money arrived, the plan is still switching on". Used
 * whenever the server does not supply its own sentence. It never suggests
 * paying again, because every path that reaches it has already been charged.
 */
export const ACTIVATION_PENDING_MESSAGE =
  'Payment received - we’re activating your plan now. You don’t need to pay again; this usually takes under a minute.';

export interface PlanCheckoutContext {
  currentPlanSlug: string;
  currentSubscriptionStatus: string | null;
  hasActiveSubscription: boolean;
  /**
   * The bot whose subscription the Billing view is scoped to (the agent
   * switcher selection). Threaded into change-plan so an upgrade/downgrade
   * mutates the SELECTED bot's subscription, not the account's highest-priced
   * one. `null` = the account-level ("All agents") view.
   */
  botId?: number | null;
  /** True once the client has consumed their lifetime free trial - closes the trial path. */
  trialUsed: boolean;
  /**
   * Active launch promotion the client qualifies for, if any. When it applies to
   * the selected plan, the money-path is forced through CHECKOUT (where the
   * deferred free-period is realised) rather than change-plan — otherwise a
   * free-tier signup (which holds an active Free sub) would route to change-plan
   * and silently skip the promo it was shown.
   */
  promotion?: PromotionView | null;
  /** Fired with a human-readable message after a successful mutation. */
  onSuccess: (message: string) => void;
  /** Fired to dismiss the surface (drawer close) after success. */
  onDone: () => void;
  /**
   * Fired when the money has moved but the plan is NOT yet live locally - the
   * mandate is still settling at Razorpay, or a second attempt collided with
   * one that already charged (409 `subscription_activation_conflict`).
   *
   * The host is expected to start a poll (see `usePlanActivation`) and hold a
   * persistent "activating" state on screen. Optional only for
   * backwards-compatibility: when it is absent this hook falls back to the old
   * one-shot `onSuccess` message, which is strictly worse - it flashes and
   * leaves the customer staring at their old plan.
   */
  onActivationPending?: (plan: PlanView, hint?: ActivationHint) => void;
  /**
   * Fired when the backend refuses checkout because the buyer's statutory
   * billing identity is incomplete (409 `billing_details_required`). Not an
   * error state: the account simply isn't invoiceable yet, so the host should
   * open the billing-details form rather than show a dead-end message.
   */
  onBillingDetailsRequired?: (missing: string[]) => void;
}

export interface PlanCheckoutResult {
  submitting: boolean;
  error: string;
  notice: string;
  /**
   * True when the server refused with `email_verification_required` (403). The
   * host surfaces `error` with a link to `/verify-email` instead of a dead end,
   * and stops offering the button that just failed - retrying it produces the
   * identical 403.
   */
  emailVerificationRequired: boolean;
  /**
   * True once a charge has landed but the plan is still activating. The host
   * MUST stop offering the pay button while this is set: the customer has
   * already paid, so another click buys a second subscription. Cleared by
   * `reset()` (drawer re-open) like the other terminal gates.
   */
  activationPending: boolean;
  /** Run the checkout money-path for `plan` at `billingCycle`. */
  submit: (plan: PlanView, billingCycle: BillingCycle, actionKind?: string) => Promise<void>;
  /** Clear transient error/notice state (call on drawer open). */
  reset: () => void;
}

// Mirrors planMath.canStartTrial on a PlanView - kept byte-identical in intent
// so the trial gate can never drift between the modal and the drawer.
// ``trialUsed`` reflects the backend's lifetime one-trial-per-client rule
// (from /subscriptions/current); without it the UI would offer a trial the
// start-trial endpoint rejects with ``already_trialed``.
export function isTrialEligible(
  plan: PlanView,
  currentPlanSlug: string,
  currentSubscriptionStatus: string | null,
  trialUsed: boolean,
): boolean {
  if (trialUsed) return false;
  if (plan.slug === currentPlanSlug) return false;
  if (plan.trialDays <= 0) return false;
  const onPaidPlan = Boolean(currentPlanSlug && currentPlanSlug !== 'free');
  return !(currentSubscriptionStatus === 'active' && onPaidPlan);
}

export function usePlanCheckout(ctx: PlanCheckoutContext): PlanCheckoutResult {
  const {
    currentPlanSlug,
    currentSubscriptionStatus,
    hasActiveSubscription,
    trialUsed,
    promotion,
    botId = null,
    onSuccess,
    onDone,
    onBillingDetailsRequired,
    onActivationPending,
  } = ctx;
  const { country: acctCountry, countrySource } = useCurrency();

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [emailVerificationRequired, setEmailVerificationRequired] = useState(false);
  const [activationPending, setActivationPending] = useState(false);
  /**
   * Re-entrancy latch for `submit`, mirroring `submitting` exactly - set beside
   * every `setSubmitting(true)`, cleared in the same `finally`.
   *
   * `submitting` disables both CTAs, but a disabled button is not a guard: two
   * clicks dispatched before React flushes the state update both reach the
   * handler, and each one mints a Razorpay subscription server-side. A ref is
   * readable synchronously, so the second call sees the first immediately.
   *
   * Deliberately NOT cleared by `reset()`. `reset` runs on drawer open, which
   * can happen while a request is still in flight (close the drawer mid-charge,
   * reopen); clearing the latch there would reopen the exact window this closes.
   * The `finally` blocks are the only correct release points.
   */
  const inFlight = useRef(false);

  const reset = useCallback(() => {
    setError('');
    setNotice('');
    setEmailVerificationRequired(false);
    setActivationPending(false);
  }, []);

  const submit = useCallback(
    async (plan: PlanView, billingCycle: BillingCycle, actionKind: string = 'auto'): Promise<void> => {
      // One attempt at a time - a second click must not open a second checkout.
      if (inFlight.current) return;
      /**
       * The money moved but the plan is not live yet. Every caller of this
       * lands in the same place: a persistent "activating" state owned by the
       * host, a disabled pay button here, and NO claim that the subscription
       * exists. `onSuccess` is only used as a degraded fallback when the host
       * has wired no poll - firing both would put a green "done" banner next
       * to a spinner that says otherwise.
       */
      const enterActivationPending = (message: string, hint?: ActivationHint): void => {
        setActivationPending(true);
        setNotice(message);
        if (onActivationPending) {
          onActivationPending(plan, hint);
        } else {
          onSuccess('Payment received - finalising your subscription.');
        }
      };
      // Stale gate state must never outlive the attempt that produced it.
      setEmailVerificationRequired(false);
      // Free plan: with an active sub, schedule a cancellation at period end;
      // without one there is nothing to do.
      if (plan.slug === 'free') {
        if (hasActiveSubscription) {
          setError('');
          setNotice('');
          inFlight.current = true;
          setSubmitting(true);
          try {
            await changePlan(plan.id, billingCycle, botId);
            onSuccess('You’ll move to Free at the end of your current billing period.');
            onDone();
          } catch (err: unknown) {
            setError(err instanceof Error ? err.message : 'Could not downgrade.');
          } finally {
            inFlight.current = false;
            setSubmitting(false);
          }
          return;
        }
        onDone();
        return;
      }

      // A promo-eligible selection runs the CHECKOUT money-path so the deferred
      // free-period (start_at) is applied. Used to (a) suppress the auto-trial
      // path — the 3-month promo beats a 7-day trial and is what the customer
      // was shown — and (b) force checkout over change-plan below. Monthly-only:
      // annual + promo would bill a full year after the free period, so the
      // backend never applies it there either.
      const promoApplies = billingCycle === 'monthly' && promotionAppliesToPlan(promotion ?? null, plan);

      const trialEligible = isTrialEligible(plan, currentPlanSlug, currentSubscriptionStatus, trialUsed);
      const takeTrialPath = actionKind === 'trial' || (actionKind === 'auto' && trialEligible && !promoApplies);
      if (takeTrialPath) {
        setError('');
        setNotice('');
        inFlight.current = true;
        setSubmitting(true);
        try {
          await startTrial(plan.slug);
          onSuccess(`Your ${plan.trialDays || 7}-day ${plan.name} trial has started.`);
          onDone();
        } catch (err: unknown) {
          setError(err instanceof Error ? err.message : 'Could not start your free trial.');
        } finally {
          inFlight.current = false;
          setSubmitting(false);
        }
        return;
      }

      setError('');
      inFlight.current = true;
      setSubmitting(true);
      try {
        // Routing:
        // - Promo → checkout, always, so the deferred free-period (start_at) is
        //   applied (a free-tier signup holds an active Free sub, which would
        //   otherwise route to change-plan and skip the promo).
        // - Per-agent selection (botId set) → change-plan, so a downgraded bot
        //   is revived IN PLACE via change_plan Branch 3 (same bot_key/embed,
        //   its previous knowledge reactivated), and an active bot upgrades as
        //   before.
        // - Account-level with an active sub → change-plan; a fresh account-level
        //   purchase → checkout.
        // Only a charge-grade country may be sent as billing_country: the
        // account's stored fact or one the user picked this session. A
        // 'detected' (IP geo) country is display-only — echoing it here would
        // launder the IP signal into the server's request-confirmation slot
        // and silently rail-switch a mis-detected traveller. Omitted, the
        // server refuses with billing_country_required and we hand off to the
        // billing-details form below.
        const chargeGradeCountry = countrySource === 'detected' ? undefined : (acctCountry ?? undefined);
        const res = ((botId != null || hasActiveSubscription) && !promoApplies
          ? await changePlan(plan.id, billingCycle, botId)
          : await createCheckoutSession(plan.id, billingCycle, chargeGradeCountry)) as Record<string, unknown>;

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
              void recordBillingEvent('checkout_abandoned', 'plan', { plan_id: plan.id });
              setNotice('Payment cancelled - you have not been charged.');
              return;
            }
            if ((cbErr as { code?: string })?.code === 'payment_failed') {
              void recordBillingEvent('payment_failed', 'plan', { plan_id: plan.id });
            }
            throw cbErr;
          }

          // Stage 2 - server-side signature verification. The customer has
          // ALREADY been charged, so a failure here must NOT read as a payment
          // error. The activation webhook is the authoritative reconciler.
          let verified: Record<string, unknown> | undefined;
          try {
            verified = (await verifyRazorpaySubscription({
              razorpay_payment_id: cb.razorpay_payment_id,
              razorpay_subscription_id: cb.razorpay_subscription_id || String(res.subscription_id),
              razorpay_signature: cb.razorpay_signature,
            })) as Record<string, unknown>;
          } catch {
            enterActivationPending(ACTIVATION_PENDING_MESSAGE);
            onDone();
            return;
          }

          // A 200 from `/subscriptions/verify` means the SIGNATURE checked out,
          // not that a subscription exists: the route answers
          // `subscription_known: false` whenever neither the activation webhook
          // nor the inline reconcile produced a local row (Razorpay still
          // reporting created/pending, a reconcile failure, or a sink refusal).
          // Asserting "You're now subscribed" on that told a charged customer
          // they had a plan the app could not see - the same bug the reactivate
          // path fixed by refusing to assert an outcome it hasn't observed.
          //
          // `status: "verified"` above is emphatically NOT a second opinion on
          // this: it describes the SIGNATURE, and reading it as "active" is the
          // mistake that made the modal claim a subscription that did not
          // exist. `activation_pending` is the newer, explicit spelling of the
          // same fact; either one routes here.
          if (verified?.subscription_known === false || verified?.activation_pending === true) {
            enterActivationPending(ACTIVATION_PENDING_MESSAGE, activationHint(verified));
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

        // The account hasn't proved it owns its email yet, so the server
        // refuses to take money (`require_verified_email` /
        // `require_verified_email_for_workspace` - both send this exact
        // detail, keyed on `error`). Recoverable in seconds, but only if the
        // UI says where to go: the host pairs this flag with a link to
        // `/verify-email` rather than leaving a dead button under a red
        // message.
        if (
          detail &&
          typeof detail === 'object' &&
          (detail as { error?: string }).error === 'email_verification_required'
        ) {
          setEmailVerificationRequired(true);
          setError(
            (detail as { message?: string }).message ||
              'Please verify your email to continue.',
          );
          return;
        }
        // The customer has ALREADY paid for this plan and clicked again while
        // the first mandate was still settling; the backend refuses the second
        // charge with a 409. The money is safe and the plan is genuinely on
        // its way, so this is reassurance, not failure: rendering the server's
        // (correct) copy in red error styling is precisely what sends someone
        // who has just paid to a third attempt or a support ticket. Mirrors the
        // `intl_usd_pending` notice branch, and starts the activation poll -
        // the plan really is activating, so the host must keep saying so.
        if (
          detail &&
          typeof detail === 'object' &&
          (detail as { reason?: string }).reason === 'subscription_activation_conflict'
        ) {
          enterActivationPending(
            (detail as { message?: string }).message || ACTIVATION_PENDING_MESSAGE,
            activationHint(detail as Record<string, unknown>),
          );
          return;
        }
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
        // The server refuses to charge when its only country signal is IP
        // geo (display-grade). Ask the customer to confirm their billing
        // country via the same billing-details hand-off as a missing
        // identity - the form's country field is the cure.
        if (
          detail &&
          typeof detail === 'object' &&
          (detail as { reason?: string }).reason === 'billing_country_required'
        ) {
          if (onBillingDetailsRequired) {
            onBillingDetailsRequired(['billing_country']);
          } else {
            setError(
              (detail as { message?: string }).message ||
                'Please confirm your billing country before checkout.',
            );
          }
          return;
        }
        // A locked tax country (live mandate) is a support conversation, not
        // a form fix - surface the server's full explanation.
        if (
          detail &&
          typeof detail === 'object' &&
          (detail as { reason?: string }).reason === 'billing_country_locked'
        ) {
          setError(
            (detail as { message?: string }).message ||
              'Your billing country is locked while a subscription mandate is active. Contact support.',
          );
          return;
        }
        // Not a failure - the account is simply not invoiceable yet. An
        // invoice is issued from a webhook, so the buyer identity has to be on
        // record BEFORE the charge; hand off to the billing-details form
        // instead of stranding the customer on an error.
        if (
          detail &&
          typeof detail === 'object' &&
          (detail as { code?: string }).code === 'billing_details_required'
        ) {
          const missing = (detail as { missing?: string[] }).missing ?? [];
          if (onBillingDetailsRequired) {
            onBillingDetailsRequired(missing);
          } else {
            setError(
              (detail as { message?: string }).message ||
                'Add your billing details so we can issue a valid tax invoice.',
            );
          }
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
        // Knowledge-base overflow — same hard-block contract as seats: the
        // downgrade is refused until the customer trims uploaded documents to
        // the target plan's allowance. Point them at the Knowledge base.
        if (detail && typeof detail === 'object' && (detail as { code?: string }).code === 'document_overflow') {
          const d = detail as {
            message?: string;
            excess?: number;
            current_documents?: number;
            allowed_documents?: number;
          };
          const excess = d.excess || (Number(d.current_documents) - Number(d.allowed_documents));
          setError(
            d.message ||
              `You have ${d.current_documents} uploaded document(s) but ${plan.name} includes ${d.allowed_documents}. Delete ${excess} document(s) from your Knowledge base before downgrading.`,
          );
          return;
        }
        setError(err instanceof Error ? err.message : 'Could not start checkout.');
      } finally {
        inFlight.current = false;
        setSubmitting(false);
      }
    },
    [
      acctCountry,
      countrySource,
      currentPlanSlug,
      currentSubscriptionStatus,
      onBillingDetailsRequired,
      hasActiveSubscription,
      trialUsed,
      promotion,
      botId,
      onSuccess,
      onDone,
      onActivationPending,
    ],
  );

  return {
    submitting,
    error,
    notice,
    emailVerificationRequired,
    activationPending,
    submit,
    reset,
  };
}
