import { type ReactElement, useId } from 'react';
import { ChevronDown, Table2 } from 'lucide-react';
import { cn } from '../../../design-system';
import type { PlanView } from '../billingModel';
import type { BillingCycle } from './planMath';
import { PlanMatrix } from './PlanMatrix';

export interface ComparePlansProps {
  plans: PlanView[];
  currentSlug: string;
  cycle: BillingCycle;
  onSelect: (plan: PlanView) => void;
  /** Controlled disclosure state so a parent affordance can open it. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Current subscription status — forwarded so the matrix can offer activation. */
  currentStatus?: string | null;
}

/**
 * ComparePlans — a disclosure, collapsed by default, that reveals the full
 * feature-by-feature {@link PlanMatrix} in-app. A subscription-management page
 * leads with the premium plan cards (the fast switch surface); the exhaustive
 * comparison lives one click away rather than an external redirect, so a
 * customer can re-shop line by line without leaving the app. The parent owns the
 * monthly/annual toggle, so the matrix renders with `hideToggle` and both the
 * cards and the matrix stay driven by one shared cycle.
 */
export function ComparePlans({
  plans,
  currentSlug,
  cycle,
  onSelect,
  open,
  onOpenChange,
  currentStatus = null,
}: ComparePlansProps): ReactElement {
  const regionId = useId();

  return (
    <section
      id="compare-plans"
      aria-label="Compare plans"
      className="scroll-mt-6 overflow-hidden rounded-xl border border-[var(--ds-border)]"
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={regionId}
        onClick={() => onOpenChange(!open)}
        className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left transition-colors hover:bg-[var(--ds-bg-hover)] focus-visible:outline-none focus-visible:shadow-[0_0_0_1px_var(--ds-ring)_inset]"
      >
        <span className="flex items-center gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--ds-accent-soft)] text-[var(--ds-accent-text)]">
            <Table2 size={17} aria-hidden="true" />
          </span>
          <span className="min-w-0">
            <span className="block text-[14px] font-semibold text-[var(--ds-text)]">
              Compare every feature side by side
            </span>
            <span className="mt-0.5 block text-[13px] text-[var(--ds-text-muted)]">
              See every tier in one table, then switch or upgrade.
            </span>
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
        <div id={regionId} className="border-t border-[var(--ds-border)] p-5">
          <PlanMatrix
            plans={plans}
            currentSlug={currentSlug}
            cycle={cycle}
            onCycleChange={() => undefined}
            onSelect={onSelect}
            hideToggle
            currentStatus={currentStatus}
          />
        </div>
      )}
    </section>
  );
}
