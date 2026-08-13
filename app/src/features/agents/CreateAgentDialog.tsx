import { useEffect, useId, useRef, useState, type FormEvent, type ReactElement } from 'react';
import { Link } from 'react-router-dom';
import { Bot as BotIcon, Check, Loader2, AlertCircle, ArrowLeft, Sparkles } from 'lucide-react';
import {
  createBot,
  createBotCheckout,
  getSubscriptionPlans,
  verifyBotCheckout,
} from '../../services/api';
import { openRazorpayCheckout } from '../../lib/razorpay';
import { type Bot } from '../../types/domain';
import { Button, Input, cn } from '../../design-system';
import { requiresSubscription } from '../../utils/apiErrors';
import { describeAgentLimit, type AgentCreationGate } from './agentLimit';
import {
  buildPlan,
  formatCredits,
  formatMoneyMinor,
  planGrantsUnlimitedAgents,
  type PlanView,
} from '../workspace/billingModel';

export interface CreateAgentDialogProps {
  /** Whether the modal is mounted/visible. */
  open: boolean;
  /** Dismiss without creating (backdrop, Cancel, or Esc). */
  onClose: () => void;
  /** Called with the freshly created FREE agent so the parent can refresh + navigate. */
  onCreated: (bot: Bot) => void;
  /** Called after a paid agent's checkout completes, with the new agent's id. */
  onCheckoutComplete: (botId: number) => void;
  /**
   * Whether the workspace's plan still funds another agent, resolved from
   * entitlements BEFORE the form opens. Advisory only - it never decides
   * anything, it just lets the name step say up front that this agent will
   * need its own plan instead of letting the user find out from a 402 after
   * filling the form in. The server remains the decision-maker.
   */
  gate: AgentCreationGate;
  /** The workspace's current plan display name, for the gate notice. */
  planName: string;
}

type Step = 'name' | 'plan';
type BillingCycle = 'monthly' | 'annual';

/** Prefix a bare host with https:// so the API always receives a real URL. */
function normalizeWebsite(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

function messageFromError(err: unknown): string {
  return err instanceof Error && err.message ? err.message : 'Something went wrong. Please try again.';
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

/**
 * CreateAgentDialog - the "new agent" modal for the AI Agents page.
 *
 * Two steps: (1) name the agent, (2) if the account has used its free agent and
 * a new one needs a plan, pick that agent's plan and pay for it. The first agent
 * on an account is free and completes at step 1; additional agents run the
 * per-agent Razorpay checkout (`/bots/checkout` → Razorpay → `/bots/checkout/verify`),
 * which materialises the agent server-side only after the payment captures.
 *
 * `gate` (from the plan's `limits.bots` quota) only changes what step 1 SAYS.
 * The step-2 route is still reached the same way it always was - by `createBot`
 * answering 402 `must_subscribe` - so the server stays the single decider and
 * the paths it alone knows about keep working: the idempotent same-website
 * retry that returns the existing agent, and any plan whose quota the client
 * snapshot has not caught up with. The gate can be wrong; it can never be
 * load-bearing.
 */
export function CreateAgentDialog({
  open,
  onClose,
  onCreated,
  onCheckoutComplete,
  gate,
  planName,
}: CreateAgentDialogProps): ReactElement | null {
  const titleId = useId();
  const [step, setStep] = useState<Step>('name');
  const [name, setName] = useState('');
  const [website, setWebsite] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  // Pricing step
  const [plans, setPlans] = useState<PlanView[]>([]);
  const [plansLoading, setPlansLoading] = useState(false);
  const [selectedSlug, setSelectedSlug] = useState('');
  const [cycle, setCycle] = useState<BillingCycle>('monthly');

  const panelRef = useRef<HTMLDivElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Reset all transient state whenever the dialog (re)opens.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setStep('name');
      setName('');
      setWebsite('');
      setError('');
      setSubmitting(false);
      setPlans([]);
      setSelectedSlug('');
      setCycle('monthly');
    }
  }

  // Focus management + Esc-to-close + Tab focus-trap + body scroll-lock while open.
  useEffect(() => {
    if (!open) return undefined;
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusable = panel.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const focusTimer = window.setTimeout(() => nameInputRef.current?.focus(), 40);

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      window.clearTimeout(focusTimer);
      returnFocusRef.current?.focus();
    };
  }, [open]);

  if (!open) return null;

  const trimmedName = name.trim();
  const canSubmitName = trimmedName.length > 0 && !submitting;
  const selectedPlan = plans.find((p) => p.slug === selectedSlug) ?? null;
  // Non-null exactly when the workspace is already at its plan's agent quota,
  // i.e. when `createBot` is expected to answer 402 and hand this dialog to
  // its pricing step.
  const limitNotice = describeAgentLimit(gate, planName);

  const resetAndClose = (): void => {
    onClose();
  };

  async function loadPlans(): Promise<void> {
    setPlansLoading(true);
    try {
      const raw = await getSubscriptionPlans();
      // Paid plans only, minus any plan whose `limits.bots` is UNLIMITED.
      //
      // An unlimited-agent plan is an ACCOUNT product: it sells one credit pool
      // shared across every agent. This dialog buys a per-agent subscription,
      // which scopes the plan's credits to that single agent's isolated ledger
      // and leaves every further agent it entitles unfunded. The backend rejects
      // such a plan on `POST /bots/checkout`; this filter is the matching UI
      // half, so the option is never offered in the first place. A plan row
      // without a `bots` quota is not unlimited and stays selectable — same
      // conservative reading as the server.
      const parsed = (Array.isArray(raw) ? raw : [])
        .map((r) => buildPlan(r))
        .filter((p): p is PlanView => p !== null && p.isPaid && !planGrantsUnlimitedAgents(p));
      setPlans(parsed);
      setSelectedSlug((prev) => prev || (parsed[0]?.slug ?? ''));
    } catch (err) {
      setError(messageFromError(err));
    } finally {
      setPlansLoading(false);
    }
  }

  // Step 1: name the agent. A free agent completes here; a paywalled one (402
  // `must_subscribe`) advances to the pricing step instead of erroring out.
  const handleNameSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!trimmedName || submitting) return;
    setError('');
    setSubmitting(true);
    try {
      const bot = await createBot({
        name: trimmedName,
        website: normalizeWebsite(website) || undefined,
      });
      onCreated(bot);
    } catch (err) {
      if (requiresSubscription(err)) {
        setStep('plan');
        void loadPlans();
      } else {
        setError(messageFromError(err));
      }
    } finally {
      setSubmitting(false);
    }
  };

  // Step 2: pay for the selected plan, then create the agent server-side.
  const handleSubscribe = async (): Promise<void> => {
    if (!selectedPlan || submitting) return;
    setError('');
    setSubmitting(true);
    try {
      const payload = asRecord(
        await createBotCheckout({
          name: trimmedName,
          website: normalizeWebsite(website) || undefined,
          plan_slug: selectedPlan.slug,
          billing_cycle: cycle,
        }),
      );

      let rzp: Record<string, unknown>;
      try {
        rzp = asRecord(
          await openRazorpayCheckout({
            key: String(payload.key_id),
            subscription_id: String(payload.subscription_id),
            name: (payload.name as string) || 'OyeChats',
            description: payload.description as string | undefined,
            prefill: payload.prefill as Record<string, unknown> | undefined,
            theme: payload.theme as Record<string, unknown> | undefined,
          }),
        );
      } catch (err) {
        // A user-dismissed Razorpay modal is not an error - stay on the step.
        if ((err as { code?: string })?.code === 'dismissed') {
          setSubmitting(false);
          return;
        }
        throw err;
      }

      const result = asRecord(
        await verifyBotCheckout({
          razorpay_payment_id: String(rzp.razorpay_payment_id),
          razorpay_subscription_id: String(rzp.razorpay_subscription_id),
          razorpay_signature: String(rzp.razorpay_signature),
        }),
      );

      const botId = Number(result.bot_id);
      if (Number.isFinite(botId) && botId > 0) {
        onCheckoutComplete(botId);
      } else {
        // Webhook may still be materialising the bot; let the parent refresh.
        onCheckoutComplete(0);
      }
    } catch (err) {
      setError(messageFromError(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) resetAndClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="w-full max-w-md overflow-hidden rounded-2xl border border-[var(--ds-border)] bg-[var(--ds-bg-surface)] shadow-[var(--ds-shadow-lg)]"
      >
        <div className="p-6">
          <div className="mb-5 flex items-center gap-3">
            <span
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[var(--ds-accent-soft)] text-[var(--ds-accent-text)]"
              aria-hidden="true"
            >
              <BotIcon size={20} />
            </span>
            <div className="min-w-0">
              <h2 id={titleId} className="text-base font-semibold text-[var(--ds-text)]">
                {step === 'name' ? 'Create a new agent' : `Choose a plan for ${trimmedName || 'your agent'}`}
              </h2>
              <p className="text-[13px] text-[var(--ds-text-muted)]">
                {step === 'plan'
                  ? 'Each agent runs on its own plan. Pick one to activate it.'
                  : limitNotice
                    ? 'Name it, then choose the plan it runs on.'
                    : 'Give it a name - you can train and customize it next.'}
              </p>
            </div>
          </div>

          {error && (
            <div
              className="mb-4 flex items-start gap-2 rounded-lg border border-[var(--ds-danger-soft)] bg-[var(--ds-danger-soft)] p-3 text-[13px] text-[var(--ds-danger)]"
              role="alert"
            >
              <AlertCircle size={15} className="mt-px shrink-0" aria-hidden="true" />
              <span>{error}</span>
            </div>
          )}

          {/* Say the price before the form, not after it. Without this the
              user names the agent, submits, and only then learns from the 402
              that this one is paid. The upgrade path stays open either way -
              this is copy, not a blocker. */}
          {step === 'name' && limitNotice && (
            <div className="mb-4 flex items-start gap-2 rounded-lg border border-[var(--ds-border)] bg-[var(--ds-bg-sunken)] p-3 text-[13px] text-[var(--ds-text-muted)]">
              <Sparkles size={15} className="mt-px shrink-0 text-[var(--ds-accent)]" aria-hidden="true" />
              <span>
                {limitNotice}{' '}
                <Link
                  to="/workspace/billing"
                  className="font-medium text-[var(--ds-accent-text)] underline-offset-2 hover:underline"
                >
                  Compare plans
                </Link>
              </span>
            </div>
          )}

          {step === 'name' ? (
            <form onSubmit={handleNameSubmit} className="space-y-4">
              <div>
                <label
                  htmlFor="create-agent-name"
                  className="mb-1.5 block text-[13px] font-medium text-[var(--ds-text)]"
                >
                  Agent name
                </label>
                <Input
                  id="create-agent-name"
                  ref={nameInputRef}
                  value={name}
                  required
                  maxLength={50}
                  placeholder="e.g. Support Assistant"
                  onChange={(event) => setName(event.target.value)}
                />
              </div>

              <div>
                <label
                  htmlFor="create-agent-website"
                  className="mb-1.5 block text-[13px] font-medium text-[var(--ds-text)]"
                >
                  Website <span className="font-normal text-[var(--ds-text-subtle)]">(optional)</span>
                </label>
                <Input
                  id="create-agent-website"
                  value={website}
                  inputMode="url"
                  placeholder="yourwebsite.com"
                  onChange={(event) => setWebsite(event.target.value)}
                />
                <p className="mt-1.5 text-[12px] text-[var(--ds-text-subtle)]">
                  We&rsquo;ll use this to help train your agent later.
                </p>
              </div>

              <div className="flex gap-3 pt-1">
                <Button type="button" variant="outline" className="flex-1" onClick={resetAndClose}>
                  Cancel
                </Button>
                <Button type="submit" className="flex-1" disabled={!canSubmitName}>
                  {submitting ? (
                    <>
                      <Loader2 size={16} className="animate-spin" aria-hidden="true" />
                      Creating&hellip;
                    </>
                  ) : limitNotice ? (
                    'Continue to plans'
                  ) : (
                    'Continue'
                  )}
                </Button>
              </div>
            </form>
          ) : (
            <div className="space-y-4">
              {/* Billing cycle toggle */}
              <div
                role="tablist"
                aria-label="Billing cycle"
                className="inline-flex rounded-lg border border-[var(--ds-border)] bg-[var(--ds-bg-sunken)] p-0.5"
              >
                {(['monthly', 'annual'] as const).map((c) => (
                  <button
                    key={c}
                    type="button"
                    role="tab"
                    aria-selected={cycle === c}
                    onClick={() => setCycle(c)}
                    className={cn(
                      'rounded-md px-3 py-1.5 text-[13px] font-medium capitalize transition-colors',
                      cycle === c
                        ? 'bg-[var(--ds-bg-surface)] text-[var(--ds-text)] shadow-[var(--ds-shadow-sm)]'
                        : 'text-[var(--ds-text-muted)] hover:text-[var(--ds-text)]',
                    )}
                  >
                    {c}
                  </button>
                ))}
              </div>

              {/* Plan list */}
              {plansLoading ? (
                <div className="flex items-center justify-center gap-2 py-8 text-[13px] text-[var(--ds-text-muted)]">
                  <Loader2 size={16} className="animate-spin" aria-hidden="true" />
                  Loading plans&hellip;
                </div>
              ) : plans.length === 0 ? (
                <p className="py-6 text-center text-[13px] text-[var(--ds-text-muted)]">
                  No plans are available right now. Please try again shortly.
                </p>
              ) : (
                <ul className="space-y-2" aria-label="Available plans">
                  {plans.map((plan) => {
                    const active = plan.slug === selectedSlug;
                    const priceMinor = cycle === 'annual' ? plan.annualPriceMinor : plan.monthlyPriceMinor;
                    return (
                      <li key={plan.slug}>
                        <button
                          type="button"
                          aria-pressed={active}
                          onClick={() => setSelectedSlug(plan.slug)}
                          className={cn(
                            'flex w-full items-center justify-between gap-3 rounded-xl border p-3.5 text-left transition-colors',
                            active
                              ? 'border-[var(--ds-accent)] bg-[var(--ds-accent-soft)]'
                              : 'border-[var(--ds-border)] hover:bg-[var(--ds-bg-hover)]',
                          )}
                        >
                          <span className="min-w-0">
                            <span className="block text-[14px] font-semibold text-[var(--ds-text)]">
                              {plan.name}
                            </span>
                            <span className="block text-[12px] text-[var(--ds-text-subtle)]">
                              {formatCredits(plan.creditsPerMonth)} credits / month
                            </span>
                          </span>
                          <span className="flex shrink-0 items-center gap-2">
                            <span className="text-right text-[13px] font-semibold text-[var(--ds-text)]">
                              {formatMoneyMinor(priceMinor)}
                              <span className="font-normal text-[var(--ds-text-subtle)]">
                                /{cycle === 'annual' ? 'yr' : 'mo'}
                              </span>
                            </span>
                            {active && (
                              <Check size={16} aria-hidden="true" className="text-[var(--ds-accent)]" />
                            )}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}

              <div className="flex gap-3 pt-1">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setStep('name');
                    setError('');
                  }}
                >
                  <ArrowLeft size={16} aria-hidden="true" />
                  Back
                </Button>
                <Button
                  type="button"
                  className="flex-1"
                  disabled={!selectedPlan || submitting}
                  onClick={() => void handleSubscribe()}
                >
                  {submitting ? (
                    <>
                      <Loader2 size={16} className="animate-spin" aria-hidden="true" />
                      Starting checkout&hellip;
                    </>
                  ) : (
                    'Subscribe & create agent'
                  )}
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
