import {
  type ReactElement,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { GraduationCap, Zap, Palette, Check, Loader2, AlertTriangle, type LucideIcon } from 'lucide-react';
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

// ─── Feature highlights (from the original WelcomeStep) ──────────────────────
const HIGHLIGHTS: { icon: LucideIcon; title: string; body: string }[] = [
  { icon: GraduationCap, title: 'Trained on your content',   body: 'It learns from your website in minutes.' },
  { icon: Zap,           title: 'Live in a few steps',       body: 'A guided path from zero to deployed.' },
  { icon: Palette,       title: 'Yours to shape',            body: 'Name it, style it, and put it live.' },
];

// ─── Local data loader ────────────────────────────────────────────────────────
interface PlanStepData {
  subscription: SubscriptionView;
  currentPlanSlug: string;
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

// ─── WelcomePlanStep ──────────────────────────────────────────────────────────

/**
 * Step 1 — Welcome + Choose Plan (combined).
 *
 * The top section gives a calm product intro (what the chatbot does, what this
 * flow achieves). Below it, the plan picker lets the user choose before they
 * build anything, so credits/limits/features are set from the start.
 *
 * Design decisions:
 * - One scroll → fewer clicks than a dedicated plan step between welcome and create.
 * - Plan cards are below the fold intentionally: the hero still reads first so
 *   the user understands WHAT they're paying for before they see pricing.
 * - Continue is gated on explicit plan selection (including Free).
 * - Free plan → advances immediately (already on Free by default).
 * - Paid/trial → PlanConfirmModal runs the full money-path; on success advance.
 * - Skip-on-resume: if subscription is already active/trialing on mount,
 *   LaunchStudio bumps maxReached past this step automatically.
 */
export function WelcomePlanStep({ onBack, onContinue, isFirst }: StepProps): ReactElement {
  const { refresh: refreshEntitlements } = useEntitlements();

  // ── Selection state ───────────────────────────────────────────────────────
  const [planChosen, setPlanChosen] = useState(false);
  const [successNotice, setSuccessNotice] = useState<string | null>(null);

  /**
   * `planChosen` is also kept in a ref because the modal's `onClose` prop is
   * captured at RENDER time: `onSuccess` and `onDone` fire back-to-back in one
   * React batch, so the `onClose` that actually runs is the closure built
   * before `planChosen` flipped. Reading state there always saw `false`, which
   * is why a successful purchase closed the modal and then advanced nowhere -
   * the user was left on the welcome screen with an unchanged plan card.
   */
  const planChosenRef = useRef(false);
  const markPlanChosen = useCallback((): void => {
    planChosenRef.current = true;
    setPlanChosen(true);
  }, []);

  // ── Plan data ─────────────────────────────────────────────────────────────
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [data, setData] = useState<PlanStepData | null>(null);

  /**
   * `silent` refreshes leave `loading` alone. The first load owns the spinner;
   * a post-payment refresh must NOT blank the panel, because the activation
   * notice lives inside it - replacing the whole surface with a spinner every
   * time we re-read is another way of showing the customer nothing.
   */
  const loadData = useCallback(async (silent: boolean) => {
    if (!silent) {
      setLoading(true);
      setLoadError(null);
    }
    try {
      const d = await loadPlanStepData();
      setData(d);
      // If the account already has an active paid or trialing plan, mark planChosen = true
      if (d.currentPlanSlug !== 'free' || d.subscription.hasActive) {
        markPlanChosen();
      }
    } catch (err) {
      if (!silent) {
        setLoadError(err instanceof Error ? err.message : 'Could not load plans. Please try again.');
      }
    } finally {
      if (!silent) setLoading(false);
    }
  }, [markPlanChosen]);

  const fetchData = useCallback((): Promise<void> => loadData(false), [loadData]);
  const refreshData = useCallback((): Promise<void> => loadData(true), [loadData]);

  useEffect(() => { void fetchData(); }, [fetchData]);

  // ── Billing cycle ─────────────────────────────────────────────────────────
  const [cycle, setCycle] = useState<BillingCycle>('monthly');

  // ── Confirm modal ─────────────────────────────────────────────────────────
  const [confirmPlan, setConfirmPlan] = useState<PlanView | null>(null);

  // ── Billing-details gate ──────────────────────────────────────────────────
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [detailsPrompt, setDetailsPrompt] = useState<string | null>(null);
  const [pendingPlan, setPendingPlan] = useState<PlanView | null>(null);

  // ── Activation ────────────────────────────────────────────────────────────
  /**
   * The mandate settles out of band, so the purchase is not over when the
   * checkout modal closes. This poll is what keeps the screen honest until
   * `/subscriptions/current` agrees the plan is live.
   */
  const activation = usePlanActivation({
    botId: null,
    onSettled: (plan) => {
      setSuccessNotice(`You’re now on ${plan.name}.`);
      void refreshData();
      void refreshEntitlements();
    },
  });
  const { begin: beginActivation, blocking: activationBlocking } = activation;

  /**
   * Set the instant a purchase enters activation - synchronously, in the
   * handler, not derived from `activation.status`. `onActivationPending` and
   * `onDone` fire in one batch, so by the time `handleModalClose` runs the
   * status state has not re-rendered yet; a derived flag would still read
   * "idle" and let the step advance out from under the live poll.
   */
  const activationStartedRef = useRef(false);

  const handleActivationPending = useCallback(
    (plan: PlanView, hint?: ActivationHint): void => {
      activationStartedRef.current = true;
      // The money moved, so the step is satisfied - but nothing is "done" yet,
      // and a green success line here would contradict the activation notice.
      setSuccessNotice(null);
      markPlanChosen();
      beginActivation(plan, hint);
    },
    [beginActivation, markPlanChosen],
  );

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
   * A genuinely settled outcome: a trial started, or the server switched the
   * plan synchronously. There is nothing left to wait for, so one refresh is
   * the truth. The old "refetch now, refetch again at 3s, then close" lived
   * here and was the defect: a Razorpay mandate routinely takes longer than
   * 3s to reach `active`, both refetches read the old Free plan, and the
   * customer was left staring at a screen that said nothing had happened.
   * Anything genuinely unsettled now goes to `handleActivationPending`.
   */
  const handlePlanSuccess = useCallback(
    (message: string): void => {
      setSuccessNotice(message);
      markPlanChosen();
      void refreshData();
      void refreshEntitlements();
    },
    [markPlanChosen, refreshData, refreshEntitlements],
  );

  // PlanConfirmModal calls onClose when done.
  const handleModalClose = useCallback((): void => {
    setConfirmPlan(null);
    // Never advance out from under an in-flight activation: leaving this step
    // unmounts the poll AND the notice, which is precisely the silence that
    // sent a customer back to the pay button for a second ₹5,999 charge.
    if (planChosenRef.current && !activationStartedRef.current) {
      window.setTimeout(() => onContinue(), 300);
    }
  }, [onContinue]);

  const handlePlanSelect = useCallback(
    (plan: PlanView): void => {
      // A plan the customer has already paid for is still switching on. The
      // CTAs are disabled for exactly this reason; this is the belt to that
      // brace, so no path reopens checkout while the charge is settling.
      if (activationBlocking) return;
      // Free — account is already on Free; advance immediately. The
      // `!isContactSales` clause is load-bearing: a bespoke, per-contract tier
      // is priced on request and so is `!isPaid`, and must NOT be treated as
      // Free.
      if (!plan.isPaid && !plan.isContactSales) {
        markPlanChosen();
        onContinue();
        return;
      }
      // Paid, trial, and bespoke contact-sales tiers all open the confirm
      // modal — it short-circuits the quote for `isContactSales` and renders a
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
      {/* ── Welcome hero ─────────────────────────────────────────── */}
      <header className="mb-8">
        <h1 className="text-2xl font-bold tracking-tight text-[var(--ds-text)]">
          Let's launch your AI chatbot
        </h1>
        <p className="mt-2 text-[15px] text-[var(--ds-text-muted)]">
          In a few guided steps you'll create an AI Chatbot trained on your content and put it live on your site.
        </p>
      </header>

      {/* Feature highlights */}
      <ul className="mb-8 space-y-2.5">
        {HIGHLIGHTS.map(({ icon: Icon, title, body }) => (
          <li
            key={title}
            className="flex items-start gap-3 rounded-xl border border-[var(--ds-border)] bg-[var(--ds-bg-surface)] p-4"
          >
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--ds-accent-soft)] text-[var(--ds-accent-text)]">
              <Icon size={17} />
            </div>
            <div className="min-w-0">
              <p className="text-[13px] font-medium text-[var(--ds-text)]">{title}</p>
              <p className="text-[12px] text-[var(--ds-text-subtle)]">{body}</p>
            </div>
          </li>
        ))}
      </ul>

      {/* ── Divider ──────────────────────────────────────────────── */}
      <div className="mb-6 flex items-center gap-3">
        <span className="h-px flex-1 bg-[var(--ds-border)]" />
        <span className="text-[11px] font-bold uppercase tracking-wider text-[var(--ds-text-subtle)]">
          Choose your plan to get started
        </span>
        <span className="h-px flex-1 bg-[var(--ds-border)]" />
      </div>

      {/* ── Plan picker ──────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto">
        {loading && (
          <div className="flex items-center justify-center py-16">
            <Loader2 size={26} className="animate-spin text-[var(--ds-text-subtle)]" />
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
            {/* Persistent for the whole activation window - it is the one thing
                on this screen that must never flash and vanish. */}
            <PlanActivationNotice status={activation.status} planName={activation.planName} />

            {successNotice && (
              <div className="flex items-center gap-2.5 rounded-xl border border-[var(--ds-success-border,#bbf7d0)] bg-[var(--ds-success-soft,#f0fdf4)] px-4 py-3 text-[13px] text-[var(--ds-success-text,#15803d)]">
                <Check size={14} className="shrink-0" />
                {successNotice}
              </div>
            )}

            {data.promotion && (
              <PromotionBanner promotion={data.promotion} plans={data.availablePlans} />
            )}

            <PlansPanel
              plans={data.availablePlans}
              currentSlug={data.currentPlanSlug}
              cycle={cycle}
              onCycleChange={setCycle}
              onSelect={handlePlanSelect}
              currentStatus={data.subscription.status}
              trialEnd={data.subscription.trialEnd}
              promotion={data.promotion}
              allowSelectCurrent={true}
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

      {/* Checkout modal */}
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
            setSuccessNotice(message);
            setConfirmPlan(pendingPlan);
            setPendingPlan(null);
          }
        }}
      />
    </div>
  );
}
