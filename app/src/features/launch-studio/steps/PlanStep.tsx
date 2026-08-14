import {
  type ReactElement,
  useCallback,
  useEffect,
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
  SALES_EMAIL,
  type PlanView,
  type PromotionView,
  type SubscriptionView,
} from '../../workspace/billingModel';
import { PlansPanel } from '../../workspace/billing/PlansPanel';
import { PlanConfirmModal } from '../../workspace/billing/PlanConfirmModal';
import { BillingDetailsModal } from '../../workspace/billing/BillingDetailsModal';
import { PromotionBanner } from '../../workspace/billing/PromotionBanner';
import { useEntitlements } from '../../../hooks/useEntitlements';
import type { StepProps } from '../steps.config';
import type { BillingCycle } from '../../workspace/billing/planMath';

// ─── Local data loader ────────────────────────────────────────────────────────
// Fetches only what the plan step needs — avoids pulling in invoices / seats /
// billing details that are irrelevant during onboarding.

interface PlanStepData {
  subscription: SubscriptionView;
  /** The account's current plan slug (e.g. 'free'). */
  currentPlanSlug: string;
  /** Monthly price minor of the current plan — used by PlanConfirmModal for up/downgrade logic. */
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
 * PlanStep — Step 2 of the Launch Studio onboarding.
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
 * - Enterprise plan clicked → opens a mailto; stays on the step.
 * - The Continue footer is disabled until an explicit selection is made to
 *   prevent accidental skipping.
 */
export function PlanStep({ onBack, onContinue, isFirst }: StepProps): ReactElement {
  const { refresh: refreshEntitlements } = useEntitlements();

  // ── Data loading ──────────────────────────────────────────────────────────
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [data, setData] = useState<PlanStepData | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const d = await loadPlanStepData();
      setData(d);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Could not load plans. Please try again.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  // ── Billing cycle (monthly default — less intimidating in onboarding) ──────
  const [cycle, setCycle] = useState<BillingCycle>('monthly');

  // ── Plan confirm modal ────────────────────────────────────────────────────
  const [confirmPlan, setConfirmPlan] = useState<PlanView | null>(null);

  // ── Billing details gate ──────────────────────────────────────────────────
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [detailsPrompt, setDetailsPrompt] = useState<string | null>(null);
  const [pendingPlan, setPendingPlan] = useState<PlanView | null>(null);

  // ── Chosen flag — gates the Continue button ───────────────────────────────
  const [planChosen, setPlanChosen] = useState(false);
  const [successNotice, setSuccessNotice] = useState<string | null>(null);

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

  // Called by PlanConfirmModal when checkout succeeds.
  const handlePlanSuccess = useCallback(
    (message: string): void => {
      setSuccessNotice(message);
      setPlanChosen(true);
      // Refresh entitlements so sidebar gates, BANT, live chat unlock immediately.
      void refreshEntitlements();
      window.setTimeout(() => void refreshEntitlements(), 4_000);
    },
    [refreshEntitlements],
  );

  // PlanConfirmModal calls onClose when done — we use this as our signal to advance.
  // We track whether a successful plan was chosen via `planChosen` flag.
  const handleModalClose = useCallback((): void => {
    setConfirmPlan(null);
    // If a paid/trial plan was successfully selected, advance to next step.
    if (planChosen) {
      window.setTimeout(() => onContinue(), 300);
    }
  }, [planChosen, onContinue]);

  // Plan card CTA clicked.
  const handlePlanSelect = useCallback(
    (plan: PlanView): void => {
      if (!plan.isPaid && !plan.isContactSales) {
        // Free plan — account is already on Free; just advance.
        setPlanChosen(true);
        onContinue();
        return;
      }
      // A bespoke, per-contract tier is sold by a human — there is no checkout
      // to open. The priced Enterprise tier is NOT one of these and falls
      // through to the confirm modal like any other paid plan.
      //
      // A `mailto:` is a hand-off to the OS mail client, not a document to
      // render, so it is a plain navigation — same as the anchor the billing
      // confirm modal uses. `window.open` would need a windowFeatures string
      // (its third argument is NOT a rel list: any non-empty value forces a
      // popup window) and would leave a blank tab behind.
      if (plan.isContactSales) {
        window.location.href = `mailto:${SALES_EMAIL}?subject=${encodeURIComponent(
          `${plan.name} plan inquiry`,
        )}`;
        return;
      }
      // Paid / trial → confirm modal.
      setConfirmPlan(plan);
    },
    [onContinue],
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
          Pick the plan that fits your needs. You can upgrade, downgrade, or cancel any time — no lock-in.
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

            {/* Plan picker — reuses the full billing surface */}
            <PlansPanel
              plans={data.availablePlans}
              currentSlug={data.currentPlanSlug}
              cycle={cycle}
              onCycleChange={setCycle}
              onSelect={handlePlanSelect}
              currentStatus={data.subscription.status}
              trialEnd={data.subscription.trialEnd}
              promotion={data.promotion}
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
