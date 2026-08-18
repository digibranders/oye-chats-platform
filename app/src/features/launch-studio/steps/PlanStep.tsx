import {
  type ReactElement,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { Check, Loader2, AlertTriangle } from 'lucide-react';
import { Button, EmptyState } from '../../../design-system';
import {
  getSubscriptionPlans,
  getCurrentSubscription,
  getActivePromotion,
} from '../../../services/api';
import {
  buildPlan,
  buildPromotion,
  buildSubscription,
  type PlanView,
  type PromotionView,
  type SubscriptionView,
} from '../../workspace/billingModel';
import { PlansPanel } from '../../workspace/billing/PlansPanel';
import { PlanConfirmModal } from '../../workspace/billing/PlanConfirmModal';
import { PlanActivationNotice } from '../../workspace/billing/PlanActivationNotice';
import { usePlanActivation, type ActivationHint } from '../../workspace/billing/usePlanActivation';
import { BillingDetailsModal } from '../../workspace/billing/BillingDetailsModal';
import { PromotionBanner } from '../../workspace/billing/PromotionBanner';
import { useEntitlements } from '../../../hooks/useEntitlements';
import type { StepProps } from '../steps.config';
import type { BillingCycle } from '../../workspace/billing/planPricing';

// ─── Local data loader ────────────────────────────────────────────────────────
// Fetches only what the plan step needs. Avoids pulling in invoices / seats /
// billing details that are irrelevant during onboarding.

interface PlanStepData {
  subscription: SubscriptionView;
  /** The account's current plan slug (e.g. 'free'). */
  currentPlanSlug: string;
  /** Monthly price minor of the current plan. Used by PlanConfirmModal for up/downgrade logic. */
  currentMonthlyPriceMinor: number;
  availablePlans: PlanView[];
  trialUsed: boolean;
  promotion: PromotionView | null;
}

async function loadPlanStepData(): Promise<PlanStepData> {
  const [subscriptionRaw, plansRaw, promotionRaw] = await Promise.all([
    getCurrentSubscription(undefined),
    getSubscriptionPlans().catch((): Array<Record<string, unknown>> => []),
    getActivePromotion().catch((): Record<string, unknown> => ({ active: false })),
  ]);

  const envelope =
    subscriptionRaw && typeof subscriptionRaw === 'object'
      ? (subscriptionRaw as Record<string, unknown>)
      : {};

  const currentPlanView = buildPlan(envelope.plan);

  return {
    subscription: buildSubscription(envelope.subscription),
    currentPlanSlug: currentPlanView?.slug ?? 'free',
    currentMonthlyPriceMinor: currentPlanView?.monthlyPriceMinor ?? 0,
    availablePlans: (plansRaw as Array<Record<string, unknown>>)
      .map((raw) => buildPlan(raw))
      .filter((p): p is PlanView => p !== null),
    trialUsed: envelope.trial_used === true,
    promotion: buildPromotion(promotionRaw as Record<string, unknown>),
  };
}

// ─── PlanStep ─────────────────────────────────────────────────────────────────

/**
 * PlanStep. Step 2 of the Launch Studio onboarding.
 *
 * Shows the full plan picker (cards + cycle toggle + compare grid) so the user
 * selects and pays for a plan BEFORE creating their first agent. This ensures
 * plan limits (credits, live chat, BANT, branding removal, operator seats) are
 * established before any agent config is built.
 *
 * Behaviour:
 * - Free plan clicked → advances immediately (account is already on Free by
 *   default; no API call needed).
 * - Paid plan / trial clicked → opens PlanConfirmModal which runs the full
 *   usePlanCheckout money-path (free-trial → Razorpay → verify). On `onSuccess`
 *   the entitlements context is refreshed app-wide and `onContinue()` fires.
 * - Bespoke contact-sales tier clicked (a super-admin-provisioned plan carrying
 *   the `contact_sales` / `enterprise` feature flag, i.e. `isContactSales`) →
 *   opens the same PlanConfirmModal, which skips the quote and renders a
 *   "Contact sales" link in place of the pay button; stays on the step. The
 *   priced Enterprise tier is NOT one of these and checks out normally.
 * - The Continue footer is disabled until an explicit selection is made to
 *   prevent accidental skipping.
 */
export function PlanStep({ onBack, onContinue, isFirst }: StepProps): ReactElement {
  const { refresh: refreshEntitlements } = useEntitlements();

  // ── Data loading ──────────────────────────────────────────────────────────
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [data, setData] = useState<PlanStepData | null>(null);

  /**
   * `silent` refreshes leave `loading` alone - a post-payment re-read must not
   * replace the panel (and the activation notice inside it) with a spinner.
   */
  const loadData = useCallback(async (silent: boolean) => {
    if (!silent) {
      setLoading(true);
      setLoadError(null);
    }
    try {
      const d = await loadPlanStepData();
      setData(d);
    } catch (err) {
      if (!silent) {
        setLoadError(err instanceof Error ? err.message : 'Could not load plans. Please try again.');
      }
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  const fetchData = useCallback((): Promise<void> => loadData(false), [loadData]);
  const refreshData = useCallback((): Promise<void> => loadData(true), [loadData]);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  // ── Billing cycle (monthly default. Less intimidating in onboarding) ──────
  const [cycle, setCycle] = useState<BillingCycle>('monthly');

  // ── Plan confirm modal ────────────────────────────────────────────────────
  const [confirmPlan, setConfirmPlan] = useState<PlanView | null>(null);

  // ── Billing details gate ──────────────────────────────────────────────────
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [detailsPrompt, setDetailsPrompt] = useState<string | null>(null);
  const [pendingPlan, setPendingPlan] = useState<PlanView | null>(null);

  // ── Chosen flag. Gates the Continue button ───────────────────────────────
  const [planChosen, setPlanChosen] = useState(false);
  const [successNotice, setSuccessNotice] = useState<string | null>(null);

  /**
   * Mirrors `planChosen` in a ref because the modal's `onClose` prop is
   * captured at render time: `onSuccess` and `onDone` fire in one batch, so the
   * `onClose` that runs still closes over `planChosen === false`. Reading state
   * there meant a paid-for plan closed the modal and advanced nowhere.
   */
  const planChosenRef = useRef(false);
  const markPlanChosen = useCallback((): void => {
    planChosenRef.current = true;
    setPlanChosen(true);
  }, []);

  // ── Activation ────────────────────────────────────────────────────────────
  const activation = usePlanActivation({
    botId: null,
    onSettled: (plan) => {
      setSuccessNotice(`You’re now on ${plan.name}.`);
      void refreshData();
      void refreshEntitlements();
    },
  });
  const { begin: beginActivation, blocking: activationBlocking } = activation;

  /** Set synchronously in the handler - see WelcomePlanStep for why. */
  const activationStartedRef = useRef(false);

  const handleActivationPending = useCallback(
    (plan: PlanView, hint?: ActivationHint): void => {
      activationStartedRef.current = true;
      setSuccessNotice(null);
      markPlanChosen();
      beginActivation(plan, hint);
    },
    [beginActivation, markPlanChosen],
  );

  // Called when checkout is blocked by missing billing identity.
  const handleBillingDetailsRequired = useCallback(
    (missing: string[]): void => {
      const LABELS: Record<string, string> = {
        legal_name: 'registered name',
        billing_address: 'billing address',
        billing_state_code: 'state',
        billing_country: 'billing country',
      };
      const wanted = missing.map((f) => LABELS[f] ?? f);
      const list =
        wanted.length > 1
          ? `${wanted.slice(0, -1).join(', ')} and ${wanted.at(-1)}`
          : (wanted[0] ?? 'billing details');
      setPendingPlan(confirmPlan);
      setConfirmPlan(null);
      setDetailsPrompt(`Add your ${list} so we can issue a valid tax invoice for this purchase.`);
      setDetailsOpen(true);
    },
    [confirmPlan],
  );

  /**
   * A genuinely settled outcome (trial started, plan switched server-side).
   * Anything still waiting on a Razorpay mandate goes to
   * `handleActivationPending`, which polls instead of guessing - a fixed timer
   * here would fire while the subscription was still `created`.
   */
  const handlePlanSuccess = useCallback(
    (message: string): void => {
      setSuccessNotice(message);
      markPlanChosen();
      void refreshData();
      // Refresh entitlements so sidebar gates, BANT, live chat unlock immediately.
      void refreshEntitlements();
    },
    [markPlanChosen, refreshData, refreshEntitlements],
  );

  // PlanConfirmModal calls onClose when done. We use this as our signal to advance.
  const handleModalClose = useCallback((): void => {
    setConfirmPlan(null);
    // Advance only on a settled purchase. Leaving the step mid-activation
    // unmounts the poll and the notice, and the customer is back to staring at
    // a screen that implies nothing happened.
    if (planChosenRef.current && !activationStartedRef.current) {
      window.setTimeout(() => onContinue(), 300);
    }
  }, [onContinue]);

  // Plan card CTA clicked.
  const handlePlanSelect = useCallback(
    (plan: PlanView): void => {
      // A paid-for plan is still switching on - no path may reopen checkout.
      if (activationBlocking) return;
      // Free plan. Account is already on Free; just advance. The
      // `!isContactSales` clause is load-bearing: a bespoke, per-contract tier
      // is priced on request and so is `!isPaid`, and must NOT be treated as
      // Free.
      if (!plan.isPaid && !plan.isContactSales) {
        markPlanChosen();
        onContinue();
        return;
      }
      // Paid, trial, and bespoke contact-sales tiers all open the confirm
      // modal, it short-circuits the quote for `isContactSales` and renders a
      // real "Contact sales" anchor in place of the pay button, so the hand-off
      // keeps link semantics (middle-click, copy address, link role). One
      // contact-sales surface instead of two, matching BillingPage.
      setConfirmPlan(plan);
    },
    [activationBlocking, markPlanChosen, onContinue],
  );

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="flex h-full flex-col">
      {/* Step header */}
      <header className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight text-[var(--ds-text)]">
          Choose your plan
        </h1>
        <p className="mt-2 text-[15px] text-[var(--ds-text-muted)]">
          Pick the plan that fits your needs. You can upgrade, downgrade, or cancel any time, no lock-in.
        </p>
      </header>

      {/* Content area */}
      <div className="flex-1 overflow-y-auto">
        {loading && (
          <div className="flex items-center justify-center py-24">
            <Loader2 size={28} className="animate-spin text-[var(--ds-text-subtle)]" />
          </div>
        )}

        {loadError && !loading && (
          <EmptyState
            icon={AlertTriangle}
            title="Couldn't load plans"
            description={loadError}
            action={<Button onClick={() => void fetchData()}>Try again</Button>}
          />
        )}

        {data && !loading && (
          <div className="space-y-5">
            {/* Persistent across the whole activation window. */}
            <PlanActivationNotice status={activation.status} planName={activation.planName} />

            {/* Post-selection success notice */}
            {successNotice && (
              <div className="flex items-center gap-2.5 rounded-xl border border-[var(--ds-success-border,#bbf7d0)] bg-[var(--ds-success-soft,#f0fdf4)] px-4 py-3 text-[13px] text-[var(--ds-success-text,#15803d)]">
                <Check size={14} className="shrink-0" />
                {successNotice}
              </div>
            )}

            {/* Active launch promotion banner */}
            {data.promotion && (
              <PromotionBanner
                promotion={data.promotion}
                plans={data.availablePlans}
              />
            )}

            {/* Plan picker. Reuses the full billing surface */}
            <PlansPanel
              plans={data.availablePlans}
              currentSlug={data.currentPlanSlug}
              cycle={cycle}
              onCycleChange={setCycle}
              onSelect={handlePlanSelect}
              currentStatus={data.subscription.status}
              trialEnd={data.subscription.trialEnd}
              promotion={data.promotion}
              selectionDisabled={activationBlocking}
            />
          </div>
        )}
      </div>

      {/* Footer */}
      <footer className="mt-8 flex items-center justify-between border-t border-[var(--ds-border)] pt-5">
        <Button variant="ghost" onClick={onBack} disabled={isFirst}>
          ← Back
        </Button>
        <div className="flex flex-col items-end gap-1">
          <Button
            onClick={onContinue}
            disabled={!planChosen}
            title={planChosen ? undefined : 'Select a plan above to continue'}
          >
            Continue →
          </Button>
          {!planChosen && (
            <p className="text-[11px] text-[var(--ds-text-subtle)]">
              Select a plan above to continue
            </p>
          )}
        </div>
      </footer>

      {/* Plan checkout modal */}
      {data && (
        <PlanConfirmModal
          open={confirmPlan !== null}
          onClose={handleModalClose}
          plan={confirmPlan}
          cycle={cycle}
          currentPlanSlug={data.currentPlanSlug}
          currentSubscriptionStatus={data.subscription.status}
          hasActiveSubscription={data.subscription.hasActive}
          trialUsed={data.trialUsed}
          currentMonthlyPriceMinor={data.currentMonthlyPriceMinor}
          currentChatHistoryDays={null}
          promotion={data.promotion}
          botId={null}
          onSuccess={handlePlanSuccess}
          onBillingDetailsRequired={handleBillingDetailsRequired}
          onActivationPending={handleActivationPending}
        />
      )}

      {/* Billing details gate */}
      <BillingDetailsModal
        open={detailsOpen}
        prompt={detailsPrompt}
        onClose={() => {
          setDetailsOpen(false);
          setDetailsPrompt(null);
          setPendingPlan(null);
        }}
        onSuccess={(message) => {
          setDetailsOpen(false);
          setDetailsPrompt(null);
          if (pendingPlan) {
            // Resume the checkout for the held plan after billing details are saved.
            setSuccessNotice(message);
            setConfirmPlan(pendingPlan);
            setPendingPlan(null);
          }
        }}
      />
    </div>
  );
}
