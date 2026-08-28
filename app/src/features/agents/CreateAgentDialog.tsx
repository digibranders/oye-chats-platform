import { useId, useRef, useState, type FormEvent } from 'react';
import { t as translateNow } from '../../i18n/i18n';
import { Link } from 'react-router-dom';
import {
  Alert,
  Button,
  Dialog,
  Field,
  Input,
  LoadingRows,
  RadioCards,
  SegmentedControl,
  normalizeUrl,
  validateUrl,
} from '../../ui';
import {
  createBot,
  createBotCheckout,
  getSubscriptionPlans,
  verifyBotCheckout,
} from '../../services/api';
import { openRazorpayCheckout } from '../../lib/razorpay';
import { requiresSubscription } from '../../utils/apiErrors';
import type { Bot } from '../../types/domain';
import { describeAgentLimit, type AgentCreationGate } from './agentLimit';
import {
  buildPlan,
  formatCredits,
  formatMoneyMinor,
  planGrantsUnlimitedAgents,
  type PlanView,
} from '../workspace/billingModel';
import { useTranslation } from '../../i18n/useTranslation';

const MAX_NAME_LENGTH = 50;

export interface CreateAgentDialogProps {
  open: boolean;
  /** Open and close are driven by the caller, which keeps them in the URL. */
  onOpenChange: (open: boolean) => void;
  /** The freshly created free chatbot, so the caller can refresh and navigate. */
  onCreated: (bot: Bot) => void;
  /** The new chatbot's id after a paid checkout completes; `0` if not yet known. */
  onCheckoutComplete: (botId: number) => void;
  /**
   * Whether the workspace's plan still funds another chatbot, resolved before
   * the form opens. Advisory only — it never decides anything, it just lets the
   * first step say up front that this chatbot will need its own plan rather
   * than letting the user discover it from a 402 after filling the form in.
   */
  gate: AgentCreationGate;
  /** The workspace's current plan name, for that notice. */
  planName: string;
}

type Step = 'name' | 'plan';
type BillingCycle = 'monthly' | 'annual';

function messageFrom(cause: unknown): string {
  return cause instanceof Error && cause.message
    ? cause.message
    : translateNow('agents.somethingWentWrongPleaseTry') || 'Something went wrong. Please try again.';
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

/**
 * The one way to create a chatbot.
 *
 * The product had two contradictory paths to the same intent — this two-field
 * dialog and a seven-step wizard that lived outside the shell — which meant two
 * definitions of what a new chatbot needs and two places for that answer to rot.
 * The wizard is deleted. This is it.
 *
 * Two steps, because there are genuinely two: name the chatbot, and — when the
 * account has already used its free one — pick the plan that funds it. The first
 * chatbot on an account completes at step one; every later one runs the
 * per-chatbot Razorpay checkout (`/bots/checkout` → Razorpay →
 * `/bots/checkout/verify`), which materialises the chatbot server-side only
 * after the payment captures.
 *
 * `gate` only changes what step one *says*. Step two is still reached the way it
 * always was — by `createBot` answering 402 `must_subscribe` — so the server
 * stays the single decider and the paths only it knows about keep working: the
 * idempotent same-website retry that returns the existing chatbot, and any plan
 * whose quota the client's entitlement snapshot has not caught up with. The gate
 * can be wrong; it can never be load-bearing.
 *
 * It is a real `Dialog` now rather than forty lines of hand-rolled focus trap
 * and scroll lock, and it is undismissable while a request is in flight — the
 * version it replaces let a backdrop click close it mid-checkout, which leaves
 * the customer unable to tell whether they have been charged.
 */
export function CreateAgentDialog({
  open,
  onOpenChange,
  onCreated,
  onCheckoutComplete,
  gate,
  planName,
}: CreateAgentDialogProps) {
  const { t } = useTranslation();
  const formId = useId();
  const [step, setStep] = useState<Step>('name');
  const [name, setName] = useState('');
  const [website, setWebsite] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [websiteError, setWebsiteError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [plans, setPlans] = useState<PlanView[]>([]);
  const [plansLoading, setPlansLoading] = useState(false);
  const [selectedSlug, setSelectedSlug] = useState('');
  const [cycle, setCycle] = useState<BillingCycle>('monthly');

  /**
   * A re-entrancy latch mirroring `submitting` exactly — set beside every
   * `setSubmitting(true)`, cleared in the same `finally`.
   *
   * `submitting` disables both CTAs, but a disabled button is not a guard: two
   * clicks dispatched before React flushes the state update both reach the
   * handler, and on the pay path each one mints a Razorpay subscription
   * server-side. Two authorised mandates each charge a full cycle. A ref is
   * readable synchronously, so the second call sees the first immediately.
   *
   * Deliberately not cleared by the reset below: that runs on open, which can
   * happen while a request is still in flight (close mid-charge, reopen), and
   * clearing it there would reopen the exact window this closes.
   */
  const inFlight = useRef(false);

  // Reset transient state whenever the dialog opens, without an effect.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setStep('name');
      setName('');
      setWebsite('');
      setNameError(null);
      setWebsiteError(null);
      setError(null);
      setSubmitting(false);
      setPlans([]);
      setSelectedSlug('');
      setCycle('monthly');
    }
  }

  const trimmedName = name.trim();
  const selectedPlan = plans.find((plan) => plan.slug === selectedSlug) ?? null;
  // Non-null exactly when the workspace is already at its plan's quota, i.e.
  // when `createBot` is expected to answer 402 and hand this dialog its
  // pricing step.
  const limitNotice = describeAgentLimit(gate, planName);

  async function loadPlans(): Promise<void> {
    setPlansLoading(true);
    try {
      const raw = await getSubscriptionPlans();
      // Paid plans only, minus any plan whose `limits.bots` is UNLIMITED.
      //
      // An unlimited-chatbot plan is an ACCOUNT product: it sells one credit
      // pool shared across every chatbot. This dialog buys a per-chatbot
      // subscription, which scopes the plan's credits to that single chatbot's
      // isolated ledger and leaves every further chatbot it entitles unfunded.
      // The backend rejects such a plan on `POST /bots/checkout`; this filter
      // is the matching UI half, so the option is never offered. A plan row
      // without a `bots` quota is not unlimited and stays selectable — the same
      // conservative reading as the server.
      const parsed = (Array.isArray(raw) ? raw : [])
        .map((row) => buildPlan(row))
        .filter((plan): plan is PlanView => plan !== null && plan.isPaid && !planGrantsUnlimitedAgents(plan));
      setPlans(parsed);
      setSelectedSlug((previous) => previous || (parsed[0]?.slug ?? ''));
    } catch (cause) {
      setError(messageFrom(cause));
    } finally {
      setPlansLoading(false);
    }
  }

  /** Step one. A free chatbot completes here; a paywalled one advances. */
  const submitName = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (submitting || inFlight.current) return;

    const nameProblem = !trimmedName
      ? t('agents.giveYourChatbotAName') || 'Give your chatbot a name.'
      : trimmedName.length > MAX_NAME_LENGTH
        ? `Keep it to ${MAX_NAME_LENGTH} characters or fewer.`
        : null;
    // Validated rather than merely normalised: the previous version accepted
    // anything and sent it, so a typo became a crawl that failed hours later
    // with no obvious cause.
    const websiteProblem = website.trim() ? validateUrl(website.trim()) : null;
    setNameError(nameProblem);
    setWebsiteError(websiteProblem);
    if (nameProblem || websiteProblem) return;

    setError(null);
    inFlight.current = true;
    setSubmitting(true);
    try {
      const bot = await createBot({
        name: trimmedName,
        website: normalizeUrl(website) || undefined,
      });
      onCreated(bot);
    } catch (cause) {
      if (requiresSubscription(cause)) {
        setStep('plan');
        void loadPlans();
      } else {
        setError(messageFrom(cause));
      }
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  };

  /** Step two: pay for the selected plan, then the server creates the chatbot. */
  const subscribe = async (): Promise<void> => {
    if (!selectedPlan || submitting || inFlight.current) return;
    setError(null);
    inFlight.current = true;
    setSubmitting(true);
    try {
      const payload = asRecord(
        await createBotCheckout({
          name: trimmedName,
          website: normalizeUrl(website) || undefined,
          plan_slug: selectedPlan.slug,
          billing_cycle: cycle,
        }),
      );

      let settled: Record<string, unknown>;
      try {
        settled = asRecord(
          await openRazorpayCheckout({
            key: String(payload.key_id),
            subscription_id: String(payload.subscription_id),
            name: (payload.name as string) || 'OyeChats',
            description: payload.description as string | undefined,
            prefill: payload.prefill as Record<string, unknown> | undefined,
            theme: payload.theme as Record<string, unknown> | undefined,
          }),
        );
      } catch (cause) {
        // A user-dismissed Razorpay sheet is not a failure — stay on the step.
        if ((cause as { code?: string })?.code === 'dismissed') return;
        throw cause;
      }

      const result = asRecord(
        await verifyBotCheckout({
          razorpay_payment_id: String(settled.razorpay_payment_id),
          razorpay_subscription_id: String(settled.razorpay_subscription_id),
          razorpay_signature: String(settled.razorpay_signature),
        }),
      );

      const botId = Number(result.bot_id);
      // A zero means the webhook is still materialising the chatbot; the caller
      // falls back to the list, where it appears as soon as it exists.
      onCheckoutComplete(Number.isFinite(botId) && botId > 0 ? botId : 0);
    } catch (cause) {
      setError(messageFrom(cause));
    } finally {
      // Covers the dismissal above too: it returns from inside the `try`, so
      // release is unconditional either way.
      inFlight.current = false;
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={step === 'name' ? t('agents.newChatbot') || 'New chatbot' : `Choose a plan for ${trimmedName || 'your chatbot'}`}
      // Step one's two `Field` labels already say what step one is for, and the
      // step-two title already names the chatbot being funded.
      description={step === 'plan' ? t('agents.itsOwnCreditsItsOwn') || 'Its own credits, its own knowledge base.' : undefined}
      size="sm"
      // Never dismissable mid-request: a customer who closes this during a
      // charge cannot tell whether the charge went through.
      dismissible={!submitting}
      footer={
        step === 'name' ? (
          <>
            <Button variant="ghost" disabled={submitting} onClick={() => onOpenChange(false)}>
              {t('agents.cancel') || 'Cancel'}
            </Button>
            <Button variant="primary" type="submit" form={formId} loading={submitting}>
              {limitNotice ? t('agents.continueToPlans') || 'Continue to plans' : t('agents.createChatbot') || 'Create chatbot'}
            </Button>
          </>
        ) : (
          <>
            <Button
              variant="ghost"
              disabled={submitting}
              onClick={() => {
                setStep('name');
                setError(null);
              }}
            >
              {t('agents.back') || 'Back'}
            </Button>
            <Button
              variant="primary"
              disabled={!selectedPlan}
              loading={submitting}
              onClick={() => void subscribe()}
            >
              {t('agents.subscribeCreateChatbot') || 'Subscribe & create chatbot'}
            </Button>
          </>
        )
      }
    >
      {error ? (
        <Alert tone="danger" live className="mb-4">
          {error}
        </Alert>
      ) : null}

      {step === 'name' ? (
        <form id={formId} onSubmit={(event) => void submitName(event)} className="space-y-4">
          {/* The price, before the form rather than after it. Without this the
              user names the chatbot, submits, and only then learns from a 402
              that this one is paid. The path to pay stays open either way —
              this is copy, not a blocker. */}
          {limitNotice ? (
            <Alert tone="plan" title={t('agents.thisChatbotNeedsItsOwn') || 'This chatbot needs its own plan'}>
              {limitNotice}{' '}
              <Link to="/billing" className="font-medium underline underline-offset-2">
                {t('agents.comparePlans') || 'Compare plans'}
              </Link>
            </Alert>
          ) : null}

          <Field label={t('agents.chatbotName') || 'Chatbot name'} error={nameError} required>
            <Input
              value={name}
              maxLength={MAX_NAME_LENGTH}
              autoComplete="off"
              placeholder={t('agents.supportAssistant') || 'Support assistant'}
              disabled={submitting}
              onChange={(event) => {
                setName(event.target.value);
                if (nameError) setNameError(null);
              }}
            />
          </Field>

          <Field
            label={t('agents.website') || 'Website'}
            optional
            error={websiteError}
            hint={t('agents.whereTheChatbotReadsFrom') || 'Where the chatbot reads from first, and where you will install it.'}
          >
            <Input
              value={website}
              inputMode="url"
              autoComplete="off"
              placeholder="yourcompany.com"
              disabled={submitting}
              onChange={(event) => {
                setWebsite(event.target.value);
                if (websiteError) setWebsiteError(null);
              }}
            />
          </Field>
        </form>
      ) : (
        <div className="space-y-4">
          <SegmentedControl
            label={t('agents.billingCycle') || 'Billing cycle'}
            value={cycle}
            onChange={setCycle}
            items={[
              { value: 'monthly', label: t('agents.monthly') || 'Monthly' },
              { value: 'annual', label: t('agents.annual') || 'Annual' },
            ]}
          />

          {plansLoading ? (
            <LoadingRows rows={3} />
          ) : plans.length === 0 ? (
            <p className="py-6 text-center text-xs text-text-secondary">
              No plans are available right now. Please try again shortly, or contact us if it keeps
              happening.
            </p>
          ) : (
            <RadioCards
              label={t('agents.plan') || 'Plan'}
              value={selectedSlug}
              onChange={setSelectedSlug}
              items={plans.map((plan) => ({
                value: plan.slug,
                label: plan.name,
                description: `${formatCredits(plan.creditsPerMonth)} credits a month`,
                badge: (
                  <span className="figure text-sm font-medium text-text-primary">
                    {formatMoneyMinor(
                      cycle === 'annual' ? plan.annualPriceMinor : plan.monthlyPriceMinor,
                    )}
                    <span className="text-text-tertiary">/{cycle === 'annual' ? 'yr' : 'mo'}</span>
                  </span>
                ),
                disabled: submitting,
              }))}
            />
          )}
        </div>
      )}
    </Dialog>
  );
}
