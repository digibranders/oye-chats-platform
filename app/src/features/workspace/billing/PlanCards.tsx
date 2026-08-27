import { type ReactElement } from 'react';
import { Check } from 'lucide-react';
import { Button, StatusBadge, cn } from '../../../design-system';
import {
  formatCredits,
  formatDate,
  formatFreeMonths,
  formatMoneyMinor,
  formatSeatAllowance,
  planGrantsUnlimitedAgents,
  promotionAppliesToPlan,
  type PlanView,
  type PromotionView,
} from '../billingModel';
import type { BillingCycle } from './planPricing';

/** A subscription that hasn't converted to paid yet - its own plan card offers activation. */
function isUnconverted(status: string | null | undefined): boolean {
  return status === 'trialing' || status === 'trial_expired';
}

/**
 * Short, differentiated highlights per card - the matrix below carries the full
 * grid.
 *
 * Two tiers of copy, not one list:
 *
 * 1. A FOUR-bullet budget of graded entitlements (credits, seats, then whichever
 *    feature flags this plan carries). Four is a deliberate cap on how much one
 *    card may claim, not an accident of how many candidates exist today.
 * 2. The unlimited-agents headline, prepended ABOVE that budget rather than
 *    competing inside it.
 *
 * The prepend is what keeps the card honest. A tier carrying every graded flag
 * already fills the budget, so pushing a fifth candidate into a fixed four
 * displaces a real entitlement whatever order they sit in. That is not
 * hypothetical: it used to displace "BANT lead qualification" on Enterprise,
 * leaving the ₹5,999 tier advertising strictly less than the ₹1,199 one. No
 * ordering fixes that; only the cap can give, and it gives for the unlimited
 * tier alone - one extra line, above the budget, for the thing that tier is
 * sold on.
 *
 * Branding removal is deliberately NOT a candidate. It is a paid add-on bought
 * on top of any paid plan, not a plan inclusion, so a bullet here would sell an
 * entitlement the plan does not carry - and a stale `branding_removable` flag
 * left on a hand-provisioned plan row must not resurrect one.
 *
 * Deliberately asymmetric with the comparison matrix, which carries an "AI
 * agents included" row for EVERY tier. These cards sell one plan at a time
 * rather than comparing five, so a "1 AI agent" bullet on four of the five would
 * spend a line restating the platform default. "1" is information only when it
 * sits next to "Unlimited" - which is the matrix's job, not the cards'.
 */
export const GRADED_BULLET_BUDGET = 4;

function highlights(plan: PlanView): string[] {
  const budget: string[] = [
    `${formatCredits(plan.creditsPerMonth)} credits / month`,
    formatSeatAllowance(plan.includedSeats),
  ];
  if (plan.features.live_chat) budget.push('Live chat & handoff');
  if (plan.features.bant) budget.push('BANT lead qualification');
  const graded = budget.slice(0, GRADED_BULLET_BUDGET);
  return planGrantsUnlimitedAgents(plan) ? ['Unlimited AI chatbots', ...graded] : graded;
}

/**
 * Price for a card. On the annual cycle we lead with the monthly-EQUIVALENT
 * (annual ÷ 12) and caption the annual total billed - the same two-figure
 * presentation as the public pricing page, so the headline stays comparable
 * month-to-month across cycles while staying honest about what's charged.
 */
function price(
  plan: PlanView,
  cycle: BillingCycle,
): { amount: string; suffix: string | null; billed: string | null } {
  if (plan.isContactSales) return { amount: 'Custom', suffix: null, billed: null };
  if (!plan.isPaid) return { amount: 'Free', suffix: null, billed: null };
  const useAnnual = cycle === 'annual' && plan.annualPriceMinor > 0;
  if (useAnnual) {
    return {
      amount: formatMoneyMinor(Math.round(plan.annualPriceMinor / 12)),
      suffix: '/mo',
      billed: `Billed ${formatMoneyMinor(plan.annualPriceMinor)}/yr`,
    };
  }
  return { amount: formatMoneyMinor(plan.monthlyPriceMinor), suffix: '/mo', billed: null };
}

export interface PlanCardsProps {
  plans: PlanView[];
  currentSlug: string;
  cycle: BillingCycle;
  onSelect: (plan: PlanView) => void;
  /** Current subscription status - drives the trial → paid activation CTA. */
  currentStatus?: string | null;
  /** Trial end date (ISO) - shown on the trialing plan's own card. */
  trialEnd?: string | null;
  /** Active launch promotion - eligible cards lead with "Free", then the price. */
  promotion?: PromotionView | null;
  /** When true (e.g. during onboarding), the current Free plan card CTA is enabled as 'Continue with Free'. */
  allowSelectCurrent?: boolean;
  /**
   * Retires every CTA in the grid. Set while a paid plan the customer has
   * ALREADY paid for is still activating: a live Select button at that moment
   * mints a second Razorpay subscription and charges them twice.
   */
  selectionDisabled?: boolean;
}

/**
 * PlanCards - the plan grid on Billing ▸ Plans. This is a management surface, so
 * it obeys one rule that keeps it from reading like a marketing page: **one
 * accent, one primary action**. The current plan is a muted "you're here" card
 * with a ghost, disabled CTA - never an accent border. The single violet accent
 * (border + filled CTA) goes to exactly one card: the *recommended upgrade* (the
 * cheapest tier above the current one). Downgrades get a deliberately quiet CTA.
 * No "Popular" ribbon - "popular" is a nudge for anonymous visitors; a customer
 * needs "current" and "recommended", which are different semantics.
 */
export function PlanCards({
  plans,
  currentSlug,
  cycle,
  onSelect,
  currentStatus = null,
  trialEnd = null,
  promotion = null,
  allowSelectCurrent = false,
  selectionDisabled = false,
}: PlanCardsProps): ReactElement {
  const ordered = [...plans].sort((a, b) => a.sortOrder - b.sortOrder);

  // While trialing, the hero action is converting THIS trial to paid - so the
  // single accent goes to the current (trial) plan's own card, and the upgrade
  // recommendation is suppressed to keep one accent per view.
  const trialing = isUnconverted(currentStatus);

  // Plans the launch promo applies to (monthly cycle only). When an offer is
  // live, the single accent belongs to the offer plan - the free months ARE the
  // hero action - so the ordinary "recommended upgrade" accent stands down to
  // keep one accent per view.
  const hasPromo =
    cycle === 'monthly' && ordered.some((p) => promotionAppliesToPlan(promotion, p));

  // The recommended upgrade = the cheapest plan strictly above the current price.
  // On the top plan, while trialing, or when a promo owns the accent, there is
  // no separate recommendation.
  const currentPrice = ordered.find((p) => p.slug === currentSlug)?.monthlyPriceMinor ?? 0;
  const recommendedSlug =
    trialing || hasPromo
      ? null
      : ordered
          .filter((p) => p.monthlyPriceMinor > currentPrice)
          .sort((a, b) => a.monthlyPriceMinor - b.monthlyPriceMinor)[0]?.slug ?? null;

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {ordered.map((plan) => {
        const isCurrent = plan.slug === currentSlug;
        // The customer is on this plan but hasn't paid yet - its card converts
        // the trial to a paid subscription instead of showing a dead button.
        const isTrialingCurrent = isCurrent && trialing;
        const isRecommended = plan.slug === recommendedSlug;
        const isDowngrade = !isCurrent && plan.monthlyPriceMinor < currentPrice;
        const { amount, suffix, billed } = price(plan, cycle);
        // A launch promo defers this plan's first charge - lead with "Free" and
        // caption the price that resumes after the free period. Monthly-only:
        // "3 months free" on an annual cycle would bill a full year after the
        // free period, so the offer never shows on the annual toggle.
        const promoApplies = cycle === 'monthly' && promotionAppliesToPlan(promotion, plan);

        // Exactly one accent: the offer plan (free months are the hero action),
        // else the recommended upgrade, else - while trialing - the current
        // plan's own card (its activation is the priority action).
        const cardTone =
          promoApplies || isRecommended || isTrialingCurrent
            ? 'border-[var(--ds-accent)] bg-[var(--ds-bg-surface)] shadow-[0_0_0_1px_var(--ds-accent),0_8px_24px_-12px_var(--ds-accent)]'
            : isCurrent
              ? 'border-[var(--ds-border)] bg-[var(--ds-bg-sunken)]'
              : 'border-[var(--ds-border)] bg-[var(--ds-bg-surface)]';

        // CTA hierarchy: a trialing current plan gets a live primary "activate"
        // CTA; a paid current plan is a disabled ghost; recommended = filled
        // primary; other upgrade = outline; downgrade = quiet ghost. A
        // bespoke contact-sales tier always routes to sales rather than
        // checkout - the priced Enterprise tier is not one, and checks out
        // like any other plan.
        const isCurrentFree = isCurrent && !plan.isPaid;

        const ctaVariant =
          isTrialingCurrent || isRecommended || promoApplies
            ? 'primary'
            : plan.isContactSales
              ? 'outline'
              : isDowngrade
                ? 'ghost'
                : 'outline';
        const ctaLabel = isTrialingCurrent
          ? 'Subscribe & pay'
          : isCurrentFree && allowSelectCurrent
            ? 'Continue with Free'
            : isCurrent
              ? 'Current plan'
              : plan.isContactSales
                ? 'Contact sales'
                : promoApplies && promotion
                  ? `Start ${formatFreeMonths(promotion.freeCycles)} free`
                  : isRecommended
                    ? `Upgrade to ${plan.name}`
                    : isDowngrade
                      ? 'Downgrade'
                      : 'Select';
        // Only a genuinely-current PAID plan (or non-selectable current Free) is a dead button
        const ctaDisabled =
          selectionDisabled || (isCurrent && !isTrialingCurrent && !(isCurrentFree && allowSelectCurrent));

        return (
          <div
            key={plan.slug}
            className={cn('flex flex-col rounded-2xl border p-5 transition-colors', cardTone)}
          >
            <div className="flex min-h-[24px] items-center justify-between gap-2">
              <span className="text-[15px] font-semibold text-[var(--ds-text)]">{plan.name}</span>
              {isTrialingCurrent ? (
                <StatusBadge tone="accent" dot>
                  On trial
                </StatusBadge>
              ) : isCurrent ? (
                <StatusBadge tone="neutral" dot>
                  Current
                </StatusBadge>
              ) : promoApplies && promotion ? (
                <StatusBadge tone="accent">{formatFreeMonths(promotion.freeCycles)} free</StatusBadge>
              ) : isRecommended ? (
                <StatusBadge tone="accent">Recommended</StatusBadge>
              ) : null}
            </div>

            {promoApplies && promotion ? (
              <>
                <div className="mt-3 flex items-baseline gap-2">
                  <span className="text-2xl font-bold tracking-tight text-[var(--ds-text)]">Free</span>
                  <span className="text-[13px] text-[var(--ds-text-subtle)] line-through">
                    {amount}
                    {suffix}
                  </span>
                </div>
                <p className="mt-1 min-h-[15px] text-[11px] font-medium uppercase tracking-wide text-[var(--ds-accent-text)]">
                  First {formatFreeMonths(promotion.freeCycles)} free · then {amount}
                  {suffix}
                </p>
              </>
            ) : (
              <>
                <div className="mt-3 flex items-baseline gap-1">
                  <span className="text-2xl font-bold tracking-tight text-[var(--ds-text)]">{amount}</span>
                  {suffix && <span className="text-[13px] text-[var(--ds-text-muted)]">{suffix}</span>}
                </div>
                {/* Reserve the caption row so annual/monthly toggling doesn't shift
                    card heights; annual fills it with the billed-yearly total. */}
                <p className="mt-1 min-h-[15px] text-[11px] font-medium uppercase tracking-wide text-[var(--ds-text-subtle)]">
                  {billed}
                </p>
              </>
            )}

            <ul className="mt-4 flex-1 space-y-2 text-[13px] text-[var(--ds-text-muted)]">
              {highlights(plan).map((item) => (
                <li key={item} className="flex items-center gap-2">
                  <Check size={14} aria-hidden="true" className="shrink-0 text-[var(--ds-success)]" />
                  {item}
                </li>
              ))}
            </ul>

            {/* Trial reassurance on the plan being trialed - states the deadline
                and that activating keeps it, before the CTA. */}
            {isTrialingCurrent && (
              <p className="mt-4 text-[12px] leading-relaxed text-[var(--ds-accent-text)]">
                {trialEnd
                  ? `Trial ends ${formatDate(trialEnd)}. Add a payment method to keep ${plan.name} - you won’t be charged until it ends.`
                  : `Add a payment method to keep ${plan.name} when your trial ends.`}
              </p>
            )}

            <Button
              variant={ctaVariant}
              className="mt-5 w-full"
              disabled={ctaDisabled}
              title={selectionDisabled ? 'Your plan is activating - no need to pay again.' : undefined}
              onClick={() => onSelect(plan)}
            >
              {ctaLabel}
            </Button>
          </div>
        );
      })}
    </div>
  );
}
