import { type ReactElement } from 'react';
import { Check } from 'lucide-react';
import { Button, StatusBadge, cn } from '../../../design-system';
import { formatCredits, formatMoneyMinor, type PlanView } from '../billingModel';
import type { BillingCycle } from './planMath';

const MOST_POPULAR_SLUG = 'standard';

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
 * PlanCards — premium per-plan pricing cards shown above the feature matrix in
 * the Compare-plans disclosure. The current plan gets an accent ring + "Current
 * plan" badge; Standard is marked "Popular". Concise highlights only — the
 * matrix carries the exhaustive comparison.
 */
export function PlanCards({ plans, currentSlug, cycle, onSelect }: PlanCardsProps): ReactElement {
  const ordered = [...plans].sort((a, b) => a.sortOrder - b.sortOrder);

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {ordered.map((plan) => {
        const isCurrent = plan.slug === currentSlug;
        const popular = plan.slug === MOST_POPULAR_SLUG;
        const { amount, suffix } = price(plan, cycle);
        return (
          <div
            key={plan.slug}
            className={cn(
              'flex flex-col rounded-2xl border p-5 transition-colors',
              isCurrent
                ? 'border-[var(--ds-accent)] bg-[var(--ds-accent-soft)] ring-1 ring-[var(--ds-accent)]'
                : popular
                  ? 'border-[var(--ds-accent)] bg-[var(--ds-bg-surface)]'
                  : 'border-[var(--ds-border)] bg-[var(--ds-bg-surface)]',
            )}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-[15px] font-semibold text-[var(--ds-text)]">{plan.name}</span>
              {isCurrent ? (
                <StatusBadge tone="accent" dot>
                  Current
                </StatusBadge>
              ) : popular ? (
                <StatusBadge tone="accent">Popular</StatusBadge>
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
              variant={isCurrent ? 'outline' : popular ? 'primary' : 'outline'}
              className="mt-5 w-full"
              disabled={isCurrent}
              onClick={() => onSelect(plan)}
            >
              {isCurrent ? 'Current plan' : 'Select'}
            </Button>
          </div>
        );
      })}
    </div>
  );
}
