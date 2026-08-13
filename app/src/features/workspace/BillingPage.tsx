import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertTriangle,
  Building2,
  CalendarClock,
  CreditCard,
  Download,
  ExternalLink,
  FileText,
  LayoutDashboard,
  Loader2,
  Minus,
  Plus,
  ReceiptText,
  RefreshCw,
  Sparkles,
  Users,
  Wallet,
  X,
  type LucideIcon,
} from 'lucide-react';
import {
  Button,
  Card,
  CardContent,
  EmptyState,
  FeedbackBanner,
  PageContainer,
  SectionHeader,
  Skeleton,
  StatusBadge,
  cn,
  useFeedback,
} from '../../design-system';
import { DataTable, type Column } from '../../design-system/components/DataTable';
import {
  cancelScheduledChange,
  getCurrentSubscription,
  getInvoices,
  resumeSubscription,
  verifyRazorpaySubscription,
  recordBillingEvent,
} from '../../services/api';
import { openRazorpayCheckout } from '../../lib/razorpay';
import { pollUntil } from '../../lib/pollUntil';
import { useBotContext } from '../../context/BotContext';
import { useEntitlements } from '../../hooks/useEntitlements';
import { useUpgradeModal } from '../../context/UpgradeModalContext';
import { useBillingData } from './useBillingData';
import { TopupModal } from './billing/TopupModal';
import { SeatChangeDialog } from './billing/SeatChangeDialog';
import { CancelSubscriptionModal } from './billing/CancelSubscriptionModal';
import { BillingDetailsModal } from './billing/BillingDetailsModal';
import { BillingOverview } from './billing/BillingOverview';
import { PaymentMethodsPanel } from './billing/PaymentMethodsPanel';
import { PlansPanel } from './billing/PlansPanel';
import { PromotionBanner } from './billing/PromotionBanner';
import { PlanConfirmModal } from './billing/PlanConfirmModal';
import type { BillingCycle } from './billing/planMath';
import {
  buildInvoice,
  buildSubscription,
  formatDate,
  formatMoneyMinor,
  formatSeatAllowance,
  getRenewalDisplay,
  INVOICE_KIND_LABEL,
  planGrantsUnlimitedAgents,
  statusTone,
  UNLIMITED_LIMIT,
  type BillingDetailsView,
  type InvoiceView,
  type PlanView,
} from './billingModel';

/**
 * BillingPage - the Workspace ▸ Billing surface: a subscription-management
 * dashboard answering "what am I paying for?". Four summary cards
 * (Subscription · Renewal · Payment · Credits) lead; issued invoices and the
 * buyer's tax identity follow; the full plan comparison lives in a collapsed
 * disclosure at the bottom (users come here to manage, not to re-shop).
 *
 * Credit balance and consumption live on the separate Workspace ▸ Usage page.
 * Choosing a plan opens the slim {@link PlanConfirmModal}, which runs the
 * shared checkout money-path against the real Razorpay + subscription
 * endpoints. Every success reloads and surfaces a message in the aria-live
 * notice region.
 */
export function BillingPage(): ReactElement {
  // Scope Billing to the agent picked in the shell switcher: a selected agent
  // shows its OWN subscription + credits + invoices; "All agents" (null) shows
  // the account-level view. Read side + Buy-credits/seats/cancel are per-agent;
  // plan-switch stays account-scoped until per-agent checkout ships.
  const { selectedBot } = useBotContext();
  const billingBotId = selectedBot?.id ?? null;
  const { loading, error, data, reload, reloadKey } = useBillingData(billingBotId);
  const navigate = useNavigate();
  const { feedback: notice, notify: showNotice, dismiss: dismissNotice } = useFeedback();

  // Top-up packs are a paid feature. Free workspaces get an upgrade nudge in
  // place of the buy modal (the backend rejects the purchase anyway).
  const { hasFeature } = useEntitlements();
  const { openUpgradeModal } = useUpgradeModal();

  const subscription = data?.subscription ?? null;
  const plan = data?.plan ?? null;

  // Comparison billing cycle - seeded to the customer's own cadence.
  const [cycle, setCycle] = useState<BillingCycle>('monthly');
  const [activeTab, setActiveTab] = useState<BillingTab>('overview');
  const [confirmPlan, setConfirmPlan] = useState<PlanView | null>(null);
  // The plan a checkout was blocked on for missing billing details. Held so the
  // confirm step can resume automatically once the details are saved, instead of
  // stranding the customer after they fill the form.
  const [pendingPlan, setPendingPlan] = useState<PlanView | null>(null);
  const [topupOpen, setTopupOpen] = useState(false);
  const [seatDialog, setSeatDialog] = useState<{ open: boolean; delta: number }>({
    open: false,
    delta: 1,
  });
  const [detailsOpen, setDetailsOpen] = useState(false);
  // Set when checkout was refused for an incomplete buyer identity, so the
  // details form can explain WHY it opened rather than appearing unprompted.
  const [detailsPrompt, setDetailsPrompt] = useState<string | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [trialNudgeDismissed, setTrialNudgeDismissed] = useState(false);

  // Gated "Buy credits" entry point shared by the header action and the
  // overview credits card: opens the top-up modal on paid plans, the upgrade
  // modal on Free.
  const handleBuyCredits = (): void => {
    if (hasFeature('topup_allowed')) {
      setTopupOpen(true);
    } else {
      openUpgradeModal('topup_credits');
    }
  };

  // Every successful mutation lands here: surface the message, refetch billing.
  /**
   * Checkout refused because the account isn't invoiceable yet. Not an error -
   * close the plan modal, open the billing-details form, and say why. An
   * invoice is issued from a payment webhook, so this identity has to be on
   * record before the charge, not after.
   */
  const handleBillingDetailsRequired = (missing: string[]): void => {
    const LABELS: Record<string, string> = {
      legal_name: 'registered name',
      billing_address: 'billing address',
      billing_state_code: 'state',
    };
    const wanted = missing.map((f) => LABELS[f] ?? f);
    const list =
      wanted.length > 1 ? `${wanted.slice(0, -1).join(', ')} and ${wanted.at(-1)}` : wanted[0] ?? 'billing details';
    // Remember the plan so checkout can resume after the details are saved.
    setPendingPlan(confirmPlan);
    setConfirmPlan(null);
    setDetailsPrompt(`Add your ${list} so we can issue a valid tax invoice for this purchase.`);
    setDetailsOpen(true);
  };

  const { refresh: refreshEntitlements } = useEntitlements();
  const handleSuccess = useCallback(
    (message: string): void => {
      showNotice({ tone: 'info', message });
      reload();
      // A plan change flips feature gates APP-WIDE (sidebar locks, live chat,
      // BANT, seat limits) — but the entitlements context was fetched at app
      // load and nobody told it the plan changed, so an upgraded customer
      // kept staring at padlocks until a hard refresh. Refresh the context in
      // place: the sidebar unlocks without a jarring full reload. Twice, with
      // a short tail — the activation webhook that busts the server-side
      // entitlements cache can land a beat after the checkout settles.
      void refreshEntitlements();
      window.setTimeout(() => void refreshEntitlements(), 4000);
    },
    [showNotice, reload, refreshEntitlements],
  );

  // Subscription-lifecycle reversals (undo a scheduled downgrade / reactivate a
  // pending cancellation). Both APIs exist; the banners were display-only.
  const [lifecycleBusy, setLifecycleBusy] = useState<'cancel_scheduled' | 'reactivate' | null>(null);
  const [lifecycleError, setLifecycleError] = useState<string | null>(null);

  // Long-lived settle polls outlive a navigation, so they need an unmount
  // signal to stop reading and never notify a page that is gone.
  const unmountedRef = useRef(false);
  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
    };
  }, []);

  /**
   * Wait for the server to actually reflect a lifecycle change before telling
   * the customer it happened.
   *
   * The mandate-authorising paths settle out of band: Razorpay's
   * `subscription.activated` webhook is what supersedes the old subscription
   * row, and it lands seconds (sometimes minutes) after the checkout modal
   * closes. Refetching once on success reads pre-webhook state, so the page
   * kept showing "ends on ... and won't renew" directly underneath a
   * "Subscription reactivated" toast. Poll instead, and only claim the outcome
   * once `/subscriptions/current` agrees.
   */
  const settleLifecycleChange = useCallback(
    async (settledMessage: string, pendingMessage: string): Promise<void> => {
      const outcome = await pollUntil({
        read: () => getCurrentSubscription(billingBotId ?? undefined),
        done: (raw) => {
          const envelope = (raw ?? {}) as Record<string, unknown>;
          return buildSubscription(envelope.subscription).cancelAtPeriodEnd === false;
        },
        // Navigating away mid-poll must stop it: otherwise it keeps refetching
        // for the full 60s and then notifies + reloads against a page that is
        // no longer mounted.
        cancelled: () => unmountedRef.current,
      });
      if (outcome.status === 'cancelled') return;
      // On timeout the payment is still real and the webhook will still land -
      // say what we actually know rather than asserting a renewal we can't see.
      handleSuccess(outcome.status === 'settled' ? settledMessage : pendingMessage);
    },
    [billingBotId, handleSuccess],
  );

  const handleCancelScheduled = async (): Promise<void> => {
    setLifecycleBusy('cancel_scheduled');
    setLifecycleError(null);
    try {
      const res = (await cancelScheduledChange()) as Record<string, unknown> | undefined;
      // `/cancel-scheduled-change` can also answer `reauthorise_required` when
      // the downgrade already cancelled the mandate at the gateway. Ignoring it
      // (as this used to) told the customer they were staying on their plan
      // while no mandate existed to renew it.
      if (String(res?.mandate_action || '') === 'reauthorise_required') {
        setLifecycleError(
          (res?.message as string) ||
            'Your payment mandate was cancelled at the payment provider. Re-authorise payment to stay on this plan.',
        );
        reload();
        return;
      }
      handleSuccess('Scheduled change cancelled - you’ll stay on your current plan.');
    } catch (err) {
      setLifecycleError(err instanceof Error ? err.message : 'Couldn’t cancel the scheduled change.');
    } finally {
      setLifecycleBusy(null);
    }
  };

  /**
   * Reactivate a subscription that is scheduled to cancel.
   *
   * Two shapes come back from `/subscriptions/resume`:
   *
   * - `mandate_action: "none"` - the mandate is still live because `/cancel`
   *   only recorded intent and the gateway cancel hasn't been issued yet. The
   *   server has already cleared the flag; there is nothing to pay. This is the
   *   path almost every customer takes.
   * - `mandate_action: "reauthorise_required"` - the gateway cancel already
   *   fired and Razorpay has no un-cancel, so a fresh mandate must be
   *   authorised. `first_charge_at` says when that mandate first bills; it is
   *   the end of the period the customer already paid for, not today.
   *
   * In the second case the local row deliberately stays on the cancellation
   * track until the activation webhook lands. Asserting "reactivated - it will
   * keep renewing" the moment verify returned was the bug: verify answers 200
   * with `subscription_known: false` when Razorpay is still reporting the
   * subscription as created/pending, so the toast claimed success while the
   * "won't renew" banner underneath it was still correct.
   */
  const handleReactivate = async (): Promise<void> => {
    setLifecycleBusy('reactivate');
    setLifecycleError(null);
    try {
      const res = (await resumeSubscription(billingBotId)) as Record<string, unknown>;
      const checkout = (res?.checkout ?? res) as Record<string, unknown>;
      const needsMandate = String(res?.mandate_action || '') === 'reauthorise_required';

      if (needsMandate) {
        if (!checkout?.key_id || !checkout?.subscription_id) {
          setLifecycleError(
            'Reactivation is temporarily unavailable. Please try again in a moment.',
          );
          return;
        }
        // Stage 1 - authorise the new mandate. A throw here means nothing was
        // authorised, which is safe to surface as-is.
        let cb: Awaited<ReturnType<typeof openRazorpayCheckout>>;
        try {
          cb = await openRazorpayCheckout({
            key: String(checkout.key_id),
            subscription_id: String(checkout.subscription_id),
            name: checkout.name as string | undefined,
            description: checkout.description as string | undefined,
            prefill: checkout.prefill as Record<string, unknown> | undefined,
            theme: checkout.theme as Record<string, unknown> | undefined,
            method: { card: true, upi: true },
          });
        } catch (cbErr: unknown) {
          if ((cbErr as { code?: string })?.code === 'dismissed') {
            void recordBillingEvent('checkout_abandoned', 'resume');
            setLifecycleError(
              'Reactivation cancelled - your plan still ends on the date shown above.',
            );
            return;
          }
          if ((cbErr as { code?: string })?.code === 'payment_failed') {
            void recordBillingEvent('payment_failed', 'resume');
          }
          throw cbErr;
        }

        const firstCharge = res?.first_charge_at as string | undefined;
        const settled = firstCharge
          ? `Subscription reactivated - it will keep renewing. Your next charge is ${formatDate(firstCharge)}.`
          : 'Subscription reactivated - it will keep renewing.';
        const pending = 'Payment authorised - we’re finalising your reactivation.';

        // Stage 2 - the mandate is already authorised, so a verification
        // failure must not read as a failure to the customer. The activation
        // webhook is the authoritative reconciler either way, which is why both
        // branches converge on the same poll rather than asserting an outcome.
        try {
          await verifyRazorpaySubscription({
            razorpay_payment_id: cb.razorpay_payment_id,
            razorpay_subscription_id:
              cb.razorpay_subscription_id || String(checkout.subscription_id),
            razorpay_signature: cb.razorpay_signature,
          });
        } catch {
          await settleLifecycleChange(settled, pending);
          return;
        }
        await settleLifecycleChange(settled, pending);
        return;
      }

      // Mandate still live - the server cleared the flag itself, so this is
      // already true by the time we get here. Trust its message; it names the
      // renewal date.
      handleSuccess(
        (res?.message as string) || 'Subscription reactivated - it will keep renewing.',
      );
    } catch (err) {
      // Resume Mode 2 runs the same pre-charge gates as checkout. A missing
      // buyer identity is not a failure - hand off to the billing-details
      // form (same flow the plan checkout uses) instead of a dead-end toast;
      // the customer clicks Reactivate again after saving.
      const detail =
        (err as { response?: { data?: { detail?: unknown } }; detail?: unknown })?.response?.data
          ?.detail ?? (err as { detail?: unknown })?.detail;
      if (detail && typeof detail === 'object' && (detail as { code?: string }).code === 'billing_details_required') {
        handleBillingDetailsRequired((detail as { missing?: string[] }).missing ?? []);
        return;
      }
      if (
        detail &&
        typeof detail === 'object' &&
        (detail as { reason?: string }).reason === 'billing_country_required'
      ) {
        handleBillingDetailsRequired(['billing_country']);
        return;
      }
      setLifecycleError(err instanceof Error ? err.message : 'Couldn’t reactivate your subscription.');
    } finally {
      setLifecycleBusy(null);
    }
  };

  // Seat math mirrors legacy pages/Billing.jsx: a plan with zero included seats
  // (Free) always shows 0 total, ignoring the Subscription model's legacy
  // default of operator_quantity = 1.
  const includedSeats = plan?.includedSeats ?? 0;
  // `-1` is the UNLIMITED sentinel, never a seat count: an unlimited tier has
  // no seat arithmetic to do (nothing to add, nothing to bill), so it renders a
  // read-only card instead of the add/remove controls.
  const unlimitedSeats = includedSeats === UNLIMITED_LIMIT;
  const totalSeats = useMemo(() => {
    if (unlimitedSeats) return UNLIMITED_LIMIT;
    if (includedSeats === 0) return 0;
    return subscription && subscription.seats > 0 ? subscription.seats : includedSeats;
  }, [includedSeats, unlimitedSeats, subscription]);

  // Plans offered by THIS view's picker.
  //
  // A plan whose `limits.bots` is UNLIMITED is an ACCOUNT product: it sells one
  // credit pool shared across every agent. While an agent is scoped, every
  // plan switch here carries that agent's `bot_id` (see `PlanConfirmModal` →
  // `usePlanCheckout`), which would scope the plan's credits to that single
  // agent's isolated ledger and leave every further agent it entitles unfunded
  // - so `POST /subscriptions/change-plan` refuses it (`plan_not_per_agent`).
  // This filter is the matching UI half, so the option is never offered in the
  // first place.
  //
  // Deliberately NOT pushed down into `PlansPanel`: the same picker serves the
  // account-level Launch Studio steps (`botId={null}`), where such a plan IS
  // purchasable and must stay selectable. The customer's CURRENT plan is also
  // always kept - an account already on that tier must still see its own card
  // (its CTA is a disabled "Current plan", so it cannot re-enter the refusal).
  // A plan row without a `bots` quota is not unlimited and stays selectable -
  // same conservative reading as the server.
  const currentPlanSlug = plan?.slug ?? 'free';
  const selectablePlans = useMemo(() => {
    const all = data?.availablePlans ?? [];
    if (billingBotId === null) return all;
    return all.filter((p) => !planGrantsUnlimitedAgents(p) || p.slug === currentPlanSlug);
  }, [data?.availablePlans, billingBotId, currentPlanSlug]);

  const cycleLabel = subscription?.billingCycle === 'annual' ? 'year' : 'month';
  const priceMinor =
    plan && plan.isPaid
      ? subscription?.billingCycle === 'annual'
        ? plan.annualPriceMinor
        : plan.monthlyPriceMinor
      : 0;
  const priceLabel = plan?.isPaid ? `${formatMoneyMinor(priceMinor)}/${cycleLabel}` : 'Free';

  // A subscription set to cancel at period end will NOT renew - surfacing it as
  // "Renews" would be dishonest. scheduledChange (a downgrade) takes precedence
  // since it has its own banner; a bare pending cancellation is otherwise
  // invisible on the page.
  const pendingCancel = Boolean(subscription?.cancelAtPeriodEnd && !subscription.scheduledChange);
  const { caption: renewalCaption, label: renewalLabel } = getRenewalDisplay(subscription, pendingCancel);
  // "Free until" alone doesn't tell a promo customer what happens after - spell
  // out the price their mandate will actually charge once the free period ends.
  const renewalNote = renewalCaption === 'Free until' && plan?.isPaid ? `then ${priceLabel}` : null;

  const autoRenew = Boolean(subscription?.hasActive && !subscription.cancelAtPeriodEnd);
  // A Free plan isn't billed, so it has no payment method regardless of the
  // subscription's default provider value.
  const provider = plan?.isPaid ? subscription?.paymentProvider ?? null : null;
  const paymentLabel = provider ? capitalize(provider) : 'None';
  // Honest copy: OyeChats never stores or manages the card itself - Razorpay
  // hosts every card/UPI detail at checkout (there is no in-app "update card"
  // endpoint), so both the active and empty states point the customer there
  // rather than implying a management surface we don't have.
  const paymentSub = provider
    ? provider.toLowerCase() === 'razorpay'
      ? 'UPI, card, or NetBanking - managed securely by Razorpay at checkout.'
      : 'Billed manually by our team.'
    : 'Added securely via Razorpay when you start a paid plan.';

  return (
    <PageContainer
      title="Billing"
      description="Manage your subscription, payment methods and invoices."
      actions={
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={handleBuyCredits}>
            <Wallet size={16} aria-hidden="true" />
            Buy credits
          </Button>
          <Button variant="outline" onClick={reload} disabled={loading}>
            <RefreshCw size={16} aria-hidden="true" />
            Refresh
          </Button>
        </div>
      }
    >
      {/* Confirmation for Razorpay-gated actions. */}
      <FeedbackBanner feedback={notice} onDismiss={dismissNotice} />

      {loading && <LoadingState />}

      {error && !loading && (
        <EmptyState
          icon={AlertTriangle}
          title="Couldn’t load your billing"
          description={error}
          action={<Button onClick={reload}>Try again</Button>}
        />
      )}

      {data && !loading && subscription && (
        <>
          {/* Active-trial conversion nudge - a growth prompt to authorise a
              payment method before the trial ends, so the bot/credits/history
              survive. Shown across all tabs during the trial window. */}
          {subscription.status === 'trialing' && subscription.trialEnd && !trialNudgeDismissed && (
            <TrialNudgeBanner
              trialEnd={subscription.trialEnd}
              onPickPlan={() => setActiveTab('plans')}
              onDismiss={() => setTrialNudgeDismissed(true)}
            />
          )}

          {/* Data-retention purge warning - trial/subscription lapsed and the
              account's data is scheduled for deletion. Shown across all tabs
              because it's the most urgent thing on the page. */}
          {subscription.dataRetentionUntil && (
            <DataRetentionBanner
              purgeAt={subscription.dataRetentionUntil}
              onChoosePlan={() => setActiveTab('plans')}
            />
          )}

          {/* Segmented sub-tabs - a pill control, distinct from the underline
              Workspace tabs above, so the two nav levels read as a hierarchy. */}
          <BillingTabs active={activeTab} onChange={setActiveTab} />

          {/* Overview - the management surface: current subscription + credits.
              Subscription-state banners and seat management live here because
              they're about the plan you're ON, not the ones you might switch to. */}
          {activeTab === 'overview' && (
            <div className="space-y-8">
              {subscription.scheduledChange && (
                <ScheduledChangeBanner
                  planName={subscription.scheduledChange.planName}
                  effectiveAt={subscription.scheduledChange.effectiveAt}
                  currentPlanName={plan?.name ?? 'your current plan'}
                  onKeepPlan={() => void handleCancelScheduled()}
                  busy={lifecycleBusy === 'cancel_scheduled'}
                  error={lifecycleBusy === null ? lifecycleError : null}
                />
              )}
              {pendingCancel && (
                <CancellationBanner
                  endsAt={subscription.currentPeriodEnd}
                  planName={plan?.name ?? 'your current plan'}
                  onReactivate={() => void handleReactivate()}
                  busy={lifecycleBusy === 'reactivate'}
                  error={lifecycleBusy === null ? lifecycleError : null}
                />
              )}

              <BillingOverview
                planName={plan?.name ?? 'Free'}
                status={subscription.status}
                priceLabel={priceLabel}
                isPaid={Boolean(plan?.isPaid)}
                renewalCaption={renewalCaption}
                renewalLabel={renewalLabel}
                renewalNote={renewalNote}
                autoRenew={autoRenew}
                paymentLabel={paymentLabel}
                paymentSub={paymentSub}
                creditsPerMonth={plan?.creditsPerMonth ?? 0}
                onChangePlan={() => setActiveTab('plans')}
                onBuyCredits={handleBuyCredits}
                onViewUsage={() => void navigate('/workspace/usage')}
                botId={billingBotId}
                refreshToken={reloadKey}
              />

              {/* What they're paying WITH. Deliberately below the plan card:
                  the mandate and any saved top-up cards are two different
                  things on Razorpay, and the panel keeps them visibly apart. */}
              <PaymentMethodsPanel provider={provider} hasPaidPlan={Boolean(plan?.isPaid)} />

              {/* Operator seats - only meaningful once the plan includes them
                  (any positive allowance, or the unlimited sentinel). */}
              {(includedSeats > 0 || unlimitedSeats) && (
                <SeatManager
                  totalSeats={totalSeats}
                  includedSeats={includedSeats}
                  seatPriceLabel={plan ? `${formatMoneyMinor(plan.extraSeatPriceMinor)}/mo` : '-'}
                  onAddSeat={() => setSeatDialog({ open: true, delta: 1 })}
                  onRemoveSeat={() => setSeatDialog({ open: true, delta: -1 })}
                />
              )}

              {/* Cancel - a live paid subscription that isn't already ending. A
                  quiet, understated row (not an alarming red card): cancellation
                  is cancel-at-period-end and fully reversible. Hidden once
                  cancel_at_period_end is set (the Reactivate banner takes over). */}
              {Boolean(plan?.isPaid) &&
                subscription.status === 'active' &&
                !subscription.cancelAtPeriodEnd && (
                  <CancelSubscriptionRow
                    periodEnd={subscription.currentPeriodEnd}
                    onCancel={() => setCancelOpen(true)}
                  />
                )}
            </div>
          )}

          {/* Plans - switch surface only: the grid + cycle toggle. */}
          {activeTab === 'plans' && selectablePlans.length > 0 && (
            <div className="space-y-5">
              {data.promotion && (
                <PromotionBanner promotion={data.promotion} plans={selectablePlans} />
              )}
              <PlansPanel
                plans={selectablePlans}
                currentSlug={currentPlanSlug}
                cycle={cycle}
                onCycleChange={setCycle}
                onSelect={(candidate) => setConfirmPlan(candidate)}
                currentStatus={subscription.status}
                trialEnd={subscription.trialEnd}
                promotion={data.promotion}
              />
            </div>
          )}

          {activeTab === 'invoices' && (
            <InvoicesTab
              invoices={data.invoices}
              hasError={data.invoicesError}
              onRetry={reload}
              botId={billingBotId}
            />
          )}

          {activeTab === 'details' && (
            <BillingDetailsTab details={data.details} onEdit={() => setDetailsOpen(true)} />
          )}
        </>
      )}

      {/* Centered confirm modal - runs the shared checkout money-path. */}
      <PlanConfirmModal
        open={confirmPlan !== null}
        onClose={() => setConfirmPlan(null)}
        plan={confirmPlan}
        cycle={cycle}
        currentPlanSlug={plan?.slug ?? 'free'}
        currentSubscriptionStatus={subscription?.status ?? null}
        hasActiveSubscription={Boolean(subscription?.hasActive)}
        trialUsed={data?.trialUsed ?? false}
        currentMonthlyPriceMinor={plan?.monthlyPriceMinor ?? 0}
        currentChatHistoryDays={plan?.limits?.chat_history_days ?? null}
        promotion={data?.promotion ?? null}
        botId={billingBotId}
        onSuccess={handleSuccess}
        onBillingDetailsRequired={handleBillingDetailsRequired}
      />

      <TopupModal
        open={topupOpen}
        botId={billingBotId}
        onClose={() => setTopupOpen(false)}
        onSuccess={handleSuccess}
        onBillingDetailsRequired={handleBillingDetailsRequired}
      />

      {seatDialog.open && (
        <SeatChangeDialog
          open={seatDialog.open}
          onClose={() => setSeatDialog({ open: false, delta: seatDialog.delta })}
          delta={seatDialog.delta}
          currentSeats={totalSeats}
          seatPriceLabel={plan ? `${formatMoneyMinor(plan.extraSeatPriceMinor)}/mo` : '-'}
          botId={billingBotId}
          onSuccess={handleSuccess}
        />
      )}

      <BillingDetailsModal
        open={detailsOpen}
        prompt={detailsPrompt}
        onClose={() => {
          setDetailsOpen(false);
          setDetailsPrompt(null);
          // Cancelled the form: drop the held plan so a stale one can't resurface.
          setPendingPlan(null);
        }}
        onSuccess={(message) => {
          setDetailsPrompt(null);
          if (pendingPlan) {
            // Details are now on file: resume the checkout the customer was
            // mid-way through by re-opening the confirm step for that plan.
            showNotice({ tone: 'info', message });
            setConfirmPlan(pendingPlan);
            setPendingPlan(null);
          } else {
            // Plain details edit (from the Billing details tab): reload as before.
            handleSuccess(message);
          }
        }}
      />

      <CancelSubscriptionModal
        open={cancelOpen}
        onClose={() => setCancelOpen(false)}
        planName={plan?.name ?? 'your plan'}
        periodEnd={subscription?.currentPeriodEnd ?? null}
        botId={billingBotId}
        onSuccess={handleSuccess}
      />
    </PageContainer>
  );
}

// ── Cancel subscription ───────────────────────────────────────────────────────

/**
 * CancelSubscriptionRow - the understated entry point to cancellation. Framed as
 * a calm management action, not a red alarm: it states the honest cancel-at-
 * period-end outcome inline and hands off to {@link CancelSubscriptionModal} for
 * the reversible confirm. Placed at the foot of the Overview tab, below the plan
 * it governs.
 */
function CancelSubscriptionRow({
  periodEnd,
  onCancel,
}: {
  periodEnd: string | null;
  onCancel: () => void;
}): ReactElement {
  return (
    <div className="flex flex-col gap-3 border-t border-[var(--ds-border)] pt-5 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <p className="text-[14px] font-medium text-[var(--ds-text)]">Cancel subscription</p>
        <p className="mt-0.5 text-[13px] text-[var(--ds-text-muted)]">
          {periodEnd
            ? `You’ll keep full access until ${formatDate(periodEnd)}, then billing stops.`
            : 'You’ll keep full access until the end of your billing period, then billing stops.'}
        </p>
      </div>
      <Button
        variant="ghost"
        onClick={onCancel}
        className="self-start text-[var(--ds-danger)] hover:bg-[var(--ds-danger-soft)] hover:text-[var(--ds-danger)] sm:self-auto"
      >
        Cancel subscription
      </Button>
    </div>
  );
}

// ── Sub-tabs ──────────────────────────────────────────────────────────────────

type BillingTab = 'overview' | 'plans' | 'invoices' | 'details';

const BILLING_TABS: readonly { readonly id: BillingTab; readonly label: string; readonly icon: LucideIcon }[] = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'plans', label: 'Plans', icon: CreditCard },
  { id: 'invoices', label: 'Invoices', icon: ReceiptText },
  { id: 'details', label: 'Billing details', icon: Building2 },
];

/**
 * BillingTabs - a segmented pill control switching the Billing sub-sections. A
 * raised active segment on a sunken track (vs. the underline Workspace tabs)
 * makes the two navigation levels read as a clear hierarchy.
 */
function BillingTabs({
  active,
  onChange,
}: {
  active: BillingTab;
  onChange: (tab: BillingTab) => void;
}): ReactElement {
  return (
    <div
      role="tablist"
      aria-label="Billing sections"
      className="inline-flex items-center gap-1 self-start rounded-xl border border-[var(--ds-border)] bg-[var(--ds-bg-sunken)] p-1"
    >
      {BILLING_TABS.map(({ id, label, icon: Icon }) => {
        const isActive = active === id;
        return (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => onChange(id)}
            className={cn(
              'inline-flex items-center gap-2 whitespace-nowrap rounded-lg px-3.5 py-2 text-[13px] font-medium transition-colors',
              'focus-visible:outline-none focus-visible:shadow-[0_0_0_1px_var(--ds-ring)]',
              isActive
                ? 'bg-[var(--ds-bg-surface)] text-[var(--ds-text)] shadow-[var(--ds-shadow-sm)]'
                : 'text-[var(--ds-text-muted)] hover:text-[var(--ds-text)]',
            )}
          >
            <Icon size={15} aria-hidden="true" />
            {label}
          </button>
        );
      })}
    </div>
  );
}

// ── Operator seats ────────────────────────────────────────────────────────────

function SeatManager({
  totalSeats,
  includedSeats,
  seatPriceLabel,
  onAddSeat,
  onRemoveSeat,
}: {
  totalSeats: number;
  includedSeats: number;
  seatPriceLabel: string;
  onAddSeat: () => void;
  onRemoveSeat: () => void;
}): ReactElement {
  // An unlimited allowance has nothing to add or remove, and no per-seat price
  // to quote - the controls would offer a purchase that cannot exist.
  const unlimited = includedSeats === UNLIMITED_LIMIT;
  return (
    <Card>
      <CardContent className="flex flex-col gap-4 py-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[var(--ds-bg-subtle)] text-[var(--ds-text-muted)]">
            <Users size={18} aria-hidden="true" />
          </span>
          <div>
            <p className="text-[15px] font-semibold text-[var(--ds-text)]">
              {formatSeatAllowance(totalSeats)}
            </p>
            <p className="text-[13px] text-[var(--ds-text-muted)]">
              {unlimited
                ? 'Included with your plan · invite as many operators as you need'
                : `${includedSeats} included with your plan · ${seatPriceLabel} per extra seat`}
            </p>
          </div>
        </div>
        {!unlimited && (
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              onClick={onRemoveSeat}
              disabled={totalSeats <= includedSeats}
              title={
                totalSeats <= includedSeats
                  ? `You can’t go below the ${includedSeats} included with your plan`
                  : undefined
              }
            >
              <Minus size={16} aria-hidden="true" />
              Remove
            </Button>
            <Button variant="outline" onClick={onAddSeat}>
              <Plus size={16} aria-hidden="true" />
              Add seat
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Invoices ──────────────────────────────────────────────────────────────────

// A freshly-issued invoice's `pdf_url` is null until the ARQ worker renders it
// (seconds after payment; 5-min sweep as a backstop - see root CLAUDE.md and
// the legacy InvoicesCard). We poll `getInvoices` in place so the Download link
// appears without a manual refresh, and - crucially - WITHOUT the page-blanking
// parent reload (which resets billing to a full-page skeleton every tick).
const INVOICE_POLL_INTERVAL_MS = 5_000;
const MAX_INVOICE_POLLS = 12; // ≈1 min of polling, then stop (manual Refresh stays)
const PDF_PENDING_WINDOW_MS = 15 * 60 * 1000;

/**
 * A numbered invoice whose PDF is still rendering: it has an invoice number but
 * no downloadable/viewable link yet, and was issued recently enough that the
 * worker is plausibly still on it. The recency window stops us from polling
 * forever on an old invoice that's stuck for some other reason.
 */
function isInvoicePreparing(invoice: InvoiceView): boolean {
  if (!invoice.number || invoice.pdfUrl || invoice.invoiceUrl || !invoice.date) return false;
  const issuedMs = new Date(invoice.date).getTime();
  if (Number.isNaN(issuedMs)) return false;
  return Date.now() - issuedMs < PDF_PENDING_WINDOW_MS;
}

function InvoicesTab({
  invoices,
  hasError,
  onRetry,
  botId,
}: {
  invoices: InvoiceView[];
  hasError: boolean;
  onRetry: () => void;
  /** Same agent scope the parent loaded with - see refetchInvoices. */
  botId: number | null;
}): ReactElement {
  // Locally-polled overlay over the server-provided invoices. `null` means
  // "render the parent's list as-is"; a poll swaps in fresh rows so a pending
  // PDF's Download link can appear without blanking the whole page.
  const [polled, setPolled] = useState<InvoiceView[] | null>(null);
  const [pollAttempts, setPollAttempts] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  // When the parent refetches billing (new `invoices` reference - e.g. after a
  // payment), drop our overlay and reset the poll budget so we track the fresh
  // server data. Adjusting state during render on a prop change is React's
  // supported pattern and keeps this out of an effect (no set-state-in-effect).
  const [seenInvoices, setSeenInvoices] = useState(invoices);
  if (invoices !== seenInvoices) {
    setSeenInvoices(invoices);
    setPolled(null);
    setPollAttempts(0);
  }

  const rows = polled ?? invoices;
  const preparingCount = useMemo(() => rows.filter(isInvoicePreparing).length, [rows]);

  // Silent, in-place refetch of just the invoices list - never the parent's
  // page-blanking reload. MUST carry the same scope as the parent load: an
  // unscoped refetch here would silently swap the list between agent-scoped
  // and account-wide results, so Refresh could show different rows than the
  // page it sits on.
  const refetchInvoices = useCallback(async (): Promise<void> => {
    const raw = await getInvoices(botId ?? undefined);
    const next = (Array.isArray(raw) ? raw : []).map((row, index) => buildInvoice(row, index));
    setPolled(next);
  }, [botId]);

  // Auto-poll while any invoice's PDF is still rendering. The timer re-arms via
  // the `pollAttempts` dependency for a bounded ~5s cadence; the effect stops
  // the moment nothing is preparing or the budget is spent, and cleanup clears
  // the pending timer on unmount. setState only ever runs inside async
  // callbacks here - never synchronously in the effect body.
  useEffect(() => {
    if (preparingCount === 0 || pollAttempts >= MAX_INVOICE_POLLS) return undefined;
    const timer = setTimeout(() => {
      void refetchInvoices()
        .catch(() => undefined)
        .finally(() => setPollAttempts((attempts) => attempts + 1));
    }, INVOICE_POLL_INTERVAL_MS);
    return () => clearTimeout(timer);
  }, [preparingCount, pollAttempts, refetchInvoices]);

  const handleManualRefresh = useCallback((): void => {
    setRefreshing(true);
    void refetchInvoices()
      .catch(() => undefined)
      .finally(() => setRefreshing(false));
  }, [refetchInvoices]);

  if (hasError) {
    return (
      <EmptyState
        icon={AlertTriangle}
        title="Couldn’t load your invoices"
        description="Your tax invoices and receipts couldn’t be reached. Check your connection and try again."
        action={<Button onClick={onRetry}>Try again</Button>}
      />
    );
  }

  const columns: Column<InvoiceView>[] = [
    {
      key: 'number',
      header: 'Invoice',
      render: (invoice) => (
        <div className="min-w-0">
          <p className="truncate font-medium text-[var(--ds-text)]">
            {invoice.number ?? INVOICE_KIND_LABEL[invoice.kind]}
          </p>
          {invoice.description && (
            <p className="truncate text-[12px] text-[var(--ds-text-subtle)]">{invoice.description}</p>
          )}
        </div>
      ),
    },
    {
      key: 'kind',
      header: 'Type',
      render: (invoice) => (
        <span className="text-[var(--ds-text-muted)]">{INVOICE_KIND_LABEL[invoice.kind]}</span>
      ),
    },
    {
      key: 'date',
      header: 'Date',
      render: (invoice) => <span className="text-[var(--ds-text-muted)]">{formatDate(invoice.date)}</span>,
    },
    {
      key: 'amountMinor',
      header: 'Amount',
      align: 'right',
      render: (invoice) => (
        <span
          className={cn(
            'tabular-nums font-medium',
            invoice.kind === 'credit_note' ? 'text-[var(--ds-text-muted)]' : 'text-[var(--ds-text)]',
          )}
        >
          {formatMoneyMinor(invoice.amountMinor, invoice.currency)}
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (invoice) => (
        <StatusBadge tone={statusTone(invoice.status)} className="capitalize">
          {invoice.status}
        </StatusBadge>
      ),
    },
    {
      key: 'id',
      header: <span className="sr-only">Download</span>,
      align: 'right',
      width: '9rem',
      render: (invoice) => <InvoiceDownload invoice={invoice} />,
    },
  ];

  return (
    <>
      <SectionHeader
        title="Invoices & receipts"
        description="Every payment produces a numbered tax document you can download for your records."
        actions={
          <Button variant="outline" size="sm" onClick={handleManualRefresh} disabled={refreshing}>
            <RefreshCw
              size={15}
              aria-hidden="true"
              className={refreshing ? 'animate-spin' : undefined}
            />
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </Button>
        }
      />
      {/* Aria-live so the "still preparing" progress is announced as the worker
          renders the PDF. Kept mounted so screen readers see the region early. */}
      <div aria-live="polite">
        {preparingCount > 0 && (
          <p className="mb-3 flex items-center gap-2 text-[12px] text-[var(--ds-text-muted)]">
            <Loader2 size={13} aria-hidden="true" className="animate-spin text-[var(--ds-text-subtle)]" />
            {preparingCount === 1
              ? 'Preparing your latest invoice for download…'
              : `Preparing ${preparingCount} invoices for download…`}
          </p>
        )}
      </div>
      <DataTable
        caption="Invoices"
        columns={columns}
        rows={rows}
        rowKey={(invoice) => invoice.id}
        empty={
          <EmptyState
            className="border-0 py-6"
            icon={ReceiptText}
            title="No invoices yet"
            description="Your tax invoices and receipts appear here after each payment."
          />
        }
      />
    </>
  );
}

function InvoiceDownload({ invoice }: { invoice: InvoiceView }): ReactElement {
  if (invoice.pdfUrl) {
    return (
      <a
        href={invoice.pdfUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[13px] font-medium text-[var(--ds-accent-text)] transition-colors hover:bg-[var(--ds-bg-hover)] focus-visible:outline-none focus-visible:shadow-[0_0_0_1px_var(--ds-ring)]"
      >
        <Download size={14} aria-hidden="true" />
        PDF
      </a>
    );
  }
  if (invoice.invoiceUrl) {
    return (
      <a
        href={invoice.invoiceUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[13px] font-medium text-[var(--ds-accent-text)] transition-colors hover:bg-[var(--ds-bg-hover)] focus-visible:outline-none focus-visible:shadow-[0_0_0_1px_var(--ds-ring)]"
      >
        <ExternalLink size={14} aria-hidden="true" />
        View
      </a>
    );
  }
  // A numbered invoice without a PDF yet is still rendering (worker enqueues it
  // seconds after payment; see legacy InvoicesCard). Communicate, don't hide.
  return (
    <span className="text-[12px] text-[var(--ds-text-subtle)]">
      {invoice.number ? 'Preparing…' : '-'}
    </span>
  );
}

// ── Billing details ───────────────────────────────────────────────────────────

function BillingDetailsTab({
  details,
  onEdit,
}: {
  details: BillingDetailsView;
  onEdit: () => void;
}): ReactElement {
  // A workspace always has exactly one billing identity, so there is no "add"
  // flow - we always show the details, prefilled from the account data we
  // already hold (company name → legal name, login email → billing email,
  // signup country → country) until the customer refines them via Edit.
  const legalName = details.legalName ?? details.companyName;
  const billingEmail = details.email ?? details.accountEmail;

  const addressLines = details.address
    ? [
        details.address.line1,
        details.address.line2,
        [details.address.city, details.address.state, details.address.postal_code]
          .filter(Boolean)
          .join(', '),
      ].filter((line): line is string => Boolean(line && line.trim()))
    : [];

  return (
    <>
      <SectionHeader
        title="Billing details"
        description="The legal identity printed on your invoices and used for tax."
        actions={
          <Button variant="outline" onClick={onEdit}>
            <FileText size={16} aria-hidden="true" />
            Edit details
          </Button>
        }
      />
      <Card>
        <CardContent className="pt-5">
          <dl className="grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2">
            <DetailBlock label="Legal name" value={legalName} />
            <DetailBlock label="Billing email" value={billingEmail} />
            <DetailBlock label="GSTIN" value={details.gstin} mono />
            <DetailBlock label="Country" value={details.country} />
            {details.stateCode && <DetailBlock label="GST state code" value={details.stateCode} />}
            {addressLines.length > 0 && (
              <div className="sm:col-span-2">
                <dt className="text-[12px] font-medium text-[var(--ds-text-muted)]">Billing address</dt>
                <dd className="mt-1 text-[13px] leading-relaxed text-[var(--ds-text)]">
                  {addressLines.map((line) => (
                    <span key={line} className="block">
                      {line}
                    </span>
                  ))}
                </dd>
              </div>
            )}
          </dl>
        </CardContent>
      </Card>
    </>
  );
}

function DetailBlock({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string | null;
  mono?: boolean;
}): ReactElement {
  return (
    <div>
      <dt className="text-[12px] font-medium text-[var(--ds-text-muted)]">{label}</dt>
      <dd
        className={cn(
          'mt-1 text-[13px] text-[var(--ds-text)]',
          mono && value ? 'font-mono tracking-wide' : '',
        )}
      >
        {value ?? <span className="text-[var(--ds-text-subtle)]">Not set</span>}
      </dd>
    </div>
  );
}

// ── Shared bits ───────────────────────────────────────────────────────────────

/** A warning-toned banner with a reversal action + inline error. */
function LifecycleBanner({
  icon: Icon,
  title,
  detail,
  actionLabel,
  onAction,
  busy,
  error,
}: {
  icon: LucideIcon;
  title: ReactElement | string;
  detail: string;
  actionLabel: string;
  onAction: () => void;
  busy: boolean;
  error: string | null;
}): ReactElement {
  return (
    <div
      role="status"
      className="rounded-xl border border-[var(--ds-warning)] bg-[var(--ds-warning-soft)] px-4 py-3 text-[13px] text-[var(--ds-text)]"
    >
      <div className="flex items-start gap-3">
        <Icon size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-[var(--ds-warning)]" />
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-[var(--ds-text)]">{title}</p>
          <p className="mt-0.5 text-[var(--ds-text-muted)]">{detail}</p>
        </div>
        <Button variant="outline" size="sm" onClick={onAction} disabled={busy} className="shrink-0">
          {busy ? 'Working…' : actionLabel}
        </Button>
      </div>
      {error && (
        <p role="alert" className="mt-2 pl-7 text-[12px] text-[var(--ds-danger)]">
          {error}
        </p>
      )}
    </div>
  );
}

function ScheduledChangeBanner({
  planName,
  effectiveAt,
  currentPlanName,
  onKeepPlan,
  busy,
  error,
}: {
  planName: string | null;
  effectiveAt: string | null;
  currentPlanName: string;
  onKeepPlan: () => void;
  busy: boolean;
  error: string | null;
}): ReactElement {
  return (
    <LifecycleBanner
      icon={CalendarClock}
      title={
        <>
          Scheduled downgrade to {planName ?? 'a different plan'}
          {effectiveAt ? ` on ${formatDate(effectiveAt)}` : ''}.
        </>
      }
      detail={`You’ll keep ${currentPlanName} until then.`}
      actionLabel={`Keep ${currentPlanName}`}
      onAction={onKeepPlan}
      busy={busy}
      error={error}
    />
  );
}

function CancellationBanner({
  endsAt,
  planName,
  onReactivate,
  busy,
  error,
}: {
  endsAt: string | null;
  planName: string;
  onReactivate: () => void;
  busy: boolean;
  error: string | null;
}): ReactElement {
  return (
    <LifecycleBanner
      icon={AlertTriangle}
      title={
        <>
          {planName} ends{endsAt ? ` on ${formatDate(endsAt)}` : ' at the end of the current period'} and won’t
          renew.
        </>
      }
      detail="You’ll keep access until then. Reactivate before it ends to stay on the plan."
      actionLabel="Reactivate"
      onAction={onReactivate}
      busy={busy}
      error={error}
    />
  );
}

/**
 * TrialNudgeBanner - an active free trial is running. A calm, accent-toned
 * growth prompt to authorise a payment method (via Pick a plan) before the
 * trial ends so the bot, credits, and chat history are kept. Dismissible for
 * the session; reappears on reload while the trial is still active.
 */
function TrialNudgeBanner({
  trialEnd,
  onPickPlan,
  onDismiss,
}: {
  trialEnd: string;
  onPickPlan: () => void;
  onDismiss: () => void;
}): ReactElement {
  return (
    <div
      role="status"
      className="mb-6 flex flex-col gap-3 rounded-xl border border-[var(--ds-accent)] bg-[var(--ds-accent-soft)] px-4 py-3 text-[13px] text-[var(--ds-text)] sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="flex items-start gap-3">
        <Sparkles size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-[var(--ds-accent-text)]" />
        <p>
          <span className="font-semibold">Your free trial ends {formatDate(trialEnd)}.</span>{' '}
          <span className="text-[var(--ds-text-muted)]">
            Authorise a payment method to keep your bot, credits, and chat history when it ends - you won’t be
            charged until the trial is over.
          </span>
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2 self-end sm:self-auto">
        <Button size="sm" onClick={onPickPlan}>
          Pick a plan
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Dismiss trial reminder"
          onClick={onDismiss}
        >
          <X size={15} aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}

/**
 * DataRetentionBanner - the account has lapsed and its data is scheduled for
 * permanent deletion on `purgeAt`. The most urgent thing on the page, so it's
 * danger-toned and shown above the tabs regardless of which tab is active.
 */
function DataRetentionBanner({
  purgeAt,
  onChoosePlan,
}: {
  purgeAt: string;
  onChoosePlan: () => void;
}): ReactElement {
  return (
    <div
      role="alert"
      className="mb-6 rounded-xl border border-[var(--ds-danger)] bg-[var(--ds-danger-soft)] px-4 py-3 text-[13px] text-[var(--ds-text)]"
    >
      <div className="flex items-start gap-3">
        <AlertTriangle size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-[var(--ds-danger)]" />
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-[var(--ds-text)]">
            Your data is scheduled for deletion on {formatDate(purgeAt)}.
          </p>
          <p className="mt-0.5 text-[var(--ds-text-muted)]">
            Your subscription has lapsed. Choose a plan before this date to keep your agents, knowledge, and
            conversations - after it, they’re permanently removed.
          </p>
        </div>
        <Button size="sm" onClick={onChoosePlan} className="shrink-0">
          Choose a plan
        </Button>
      </div>
    </div>
  );
}

function capitalize(value: string): string {
  if (!value) return '';
  return value.charAt(0).toUpperCase() + value.slice(1);
}

// ── Loading skeleton ──────────────────────────────────────────────────────────

function LoadingState(): ReactElement {
  return (
    <div className="space-y-6">
      <Skeleton className="h-28 rounded-xl" />
      <Skeleton className="h-9 w-72 rounded-lg" />
      <Skeleton className="h-80 rounded-xl" />
    </div>
  );
}
