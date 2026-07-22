import { type ReactElement, useId } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '../../../design-system';
import type { PlanView } from '../billingModel';
import type { BillingCycle } from './planMath';
import { CycleToggle, PlanMatrix } from './PlanMatrix';
import { PlanCards } from './PlanCards';

export interface ComparePlansProps {
  plans: PlanView[];
  currentSlug: string;
  cycle: BillingCycle;
  onCycleChange: (cycle: BillingCycle) => void;
  onSelect: (plan: PlanView) => void;
  /** Controlled disclosure state so the summary card's "Change plan" can open it. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * ComparePlans — a disclosure, collapsed by default, that keeps the full plan
 * comparison out of the way on a subscription-management page. Expanded, it
 * leads with premium pricing cards and follows with the exhaustive feature
 * matrix, both driven by one shared monthly/annual toggle.
 */
export function ComparePlans({
  plans,
  currentSlug,
  cycle,
  onCycleChange,
  onSelect,
  open,
  onOpenChange,
}: ComparePlansProps): ReactElement {
  const regionId = useId();
  const maxDiscount = Math.max(0, ...plans.map((p) => p.annualDiscountPercent));

  return (
    <section id="compare-plans" aria-label="Compare plans" className="scroll-mt-6 rounded-xl border border-[var(--ds-border)]">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={regionId}
        onClick={() => onOpenChange(!open)}
        className="flex w-full items-center justify-between gap-4 rounded-xl px-5 py-4 text-left transition-colors hover:bg-[var(--ds-bg-hover)] focus-visible:outline-none focus-visible:shadow-[0_0_0_1px_var(--ds-ring)_inset]"
      >
        <span>
          <span className="block text-[15px] font-semibold text-[var(--ds-text)]">Compare plans</span>
          <span className="mt-0.5 block text-[13px] text-[var(--ds-text-muted)]">
            See every tier side by side and switch or upgrade.
          </span>
        </span>
        <ChevronDown
          size={18}
          aria-hidden="true"
          className={cn(
            'shrink-0 text-[var(--ds-text-subtle)] transition-transform duration-200',
            open && 'rotate-180',
          )}
        />
      </button>

      {open && (
        <div id={regionId} className="space-y-5 border-t border-[var(--ds-border)] p-5">
          <div className="flex justify-end">
            <CycleToggle cycle={cycle} maxDiscount={maxDiscount} onCycleChange={onCycleChange} />
          </div>
          <PlanCards plans={plans} currentSlug={currentSlug} cycle={cycle} onSelect={onSelect} />
          <PlanMatrix
            plans={plans}
            currentSlug={currentSlug}
            cycle={cycle}
            onCycleChange={onCycleChange}
            onSelect={onSelect}
            hideToggle
          />
        </div>
      )}
    </section>
  );
}
