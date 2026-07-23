import { type ReactElement } from 'react';
import { Check } from 'lucide-react';
import { Button, StatusBadge, cn } from '../../../design-system';
import { formatCredits, formatMoneyMinor, type PlanView } from '../billingModel';
import type { BillingCycle } from './planMath';

/** Short, differentiated highlights per card — the matrix below carries the full grid. */
function highlights(plan: PlanView): string[] {
  const out = [
    `${formatCredits(plan.creditsPerMonth)} credits / month`,
    plan.includedSeats > 0
      ? `${plan.includedSeats} operator seat${plan.includedSeats === 1 ? '' : 's'}`
      : 'No operator seats',
  ];
  if (plan.features.live_chat) out.push('Live chat & handoff');
  if (plan.features.bant) out.push('BANT lead qualification');
  if (plan.features.branding_removable) out.push('Remove OyeChats branding');
  return out.slice(0, 4);
}

function price(plan: PlanView, cycle: BillingCycle): { amount: string; suffix: string | null } {
  if (!plan.isPaid) return { amount: 'Free', suffix: null };
  const useAnnual = cycle === 'annual' && plan.annualPriceMinor > 0;
  return {
    amount: formatMoneyMinor(useAnnual ? plan.annualPriceMinor : plan.monthlyPriceMinor),
    suffix: useAnnual ? '/yr' : '/mo',
  };
}

export interface PlanCardsProps {
  plans: PlanView[];
  currentSlug: string;
  cycle: BillingCycle;
  onSelect: (plan: PlanView) => void;
}

/**
 * PlanCards — the plan grid on Billing ▸ Plans. This is a management surface, so
 * it obeys one rule that keeps it from reading like a marketing page: **one
 * accent, one primary action**. The current plan is a muted "you're here" card
 * with a ghost, disabled CTA — never an accent border. The single violet accent
 * (border + filled CTA) goes to exactly one card: the *recommended upgrade* (the
 * cheapest tier above the current one). Downgrades get a deliberately quiet CTA.
 * No "Popular" ribbon — "popular" is a nudge for anonymous visitors; a customer
 * needs "current" and "recommended", which are different semantics.
 */
export function PlanCards({ plans, currentSlug, cycle, onSelect }: PlanCardsProps): ReactElement {
  const ordered = [...plans].sort((a, b) => a.sortOrder - b.sortOrder);

  // The recommended upgrade = the cheapest plan strictly above the current price.
  // On the top plan there is no recommendation, so no card takes the accent.
  const currentPrice = ordered.find((p) => p.slug === currentSlug)?.monthlyPriceMinor ?? 0;
  const recommendedSlug =
    ordered
      .filter((p) => p.monthlyPriceMinor > currentPrice)
      .sort((a, b) => a.monthlyPriceMinor - b.monthlyPriceMinor)[0]?.slug ?? null;

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {ordered.map((plan) => {
        const isCurrent = plan.slug === currentSlug;
        const isRecommended = plan.slug === recommendedSlug;
        const isDowngrade = !isCurrent && plan.monthlyPriceMinor < currentPrice;
        const { amount, suffix } = price(plan, cycle);

        // Exactly one accent: the recommended upgrade. Current = muted surface.
        const cardTone = isRecommended
          ? 'border-[var(--ds-accent)] bg-[var(--ds-bg-surface)] shadow-[0_0_0_1px_var(--ds-accent),0_8px_24px_-12px_var(--ds-accent)]'
          : isCurrent
            ? 'border-[var(--ds-border)] bg-[var(--ds-bg-sunken)]'
            : 'border-[var(--ds-border)] bg-[var(--ds-bg-surface)]';

        // CTA hierarchy: current = disabled ghost, recommended = filled primary,
        // other upgrade = outline, downgrade = quiet ghost.
        const ctaVariant = isRecommended ? 'primary' : isDowngrade ? 'ghost' : 'outline';
        const ctaLabel = isCurrent
          ? 'Current plan'
          : isRecommended
            ? `Upgrade to ${plan.name}`
            : isDowngrade
              ? 'Downgrade'
              : 'Select';

        return (
          <div
            key={plan.slug}
            className={cn('flex flex-col rounded-2xl border p-5 transition-colors', cardTone)}
          >
            <div className="flex min-h-[24px] items-center justify-between gap-2">
              <span className="text-[15px] font-semibold text-[var(--ds-text)]">{plan.name}</span>
              {isCurrent ? (
                <StatusBadge tone="neutral" dot>
                  Current
                </StatusBadge>
              ) : isRecommended ? (
                <StatusBadge tone="accent">Recommended</StatusBadge>
              ) : null}
            </div>

            <div className="mt-3 flex items-baseline gap-1">
              <span className="text-2xl font-bold tracking-tight text-[var(--ds-text)]">{amount}</span>
              {suffix && <span className="text-[13px] text-[var(--ds-text-muted)]">{suffix}</span>}
            </div>

            <ul className="mt-4 flex-1 space-y-2 text-[13px] text-[var(--ds-text-muted)]">
              {highlights(plan).map((item) => (
                <li key={item} className="flex items-center gap-2">
                  <Check size={14} aria-hidden="true" className="shrink-0 text-[var(--ds-success)]" />
                  {item}
                </li>
              ))}
            </ul>

            <Button
              variant={ctaVariant}
              className="mt-5 w-full"
              disabled={isCurrent}
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
