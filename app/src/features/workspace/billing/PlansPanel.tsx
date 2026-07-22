import { type ReactElement } from 'react';
import { ArrowUpRight, Table2 } from 'lucide-react';
import { SectionHeader } from '../../../design-system';
import type { PlanView } from '../billingModel';
import type { BillingCycle } from './planMath';
import { CycleToggle } from './PlanMatrix';
import { PlanCards } from './PlanCards';

/** The public pricing page carries the exhaustive feature-by-feature comparison. */
const PRICING_URL = 'https://www.oyechats.com/pricing';

export interface PlansPanelProps {
  plans: PlanView[];
  currentSlug: string;
  cycle: BillingCycle;
  onCycleChange: (cycle: BillingCycle) => void;
  onSelect: (plan: PlanView) => void;
}

/**
 * PlansPanel — the condensed plan picker for the Billing ▸ Plans tab. It shows
 * the premium pricing cards (price + top highlights + CTA) with one monthly/
 * annual toggle, and defers the exhaustive feature matrix to the public pricing
 * page. A subscription-management surface should let you switch fast, not
 * re-shop line by line — so the deep comparison lives one honest click away.
 */
export function PlansPanel({
  plans,
  currentSlug,
  cycle,
  onCycleChange,
  onSelect,
}: PlansPanelProps): ReactElement {
  const maxDiscount = Math.max(0, ...plans.map((p) => p.annualDiscountPercent));

  return (
    <section aria-label="Plans" className="space-y-5">
      <SectionHeader
        title="Compare & switch plans"
        description="The essentials at a glance. Switch or upgrade in a couple of clicks."
        actions={<CycleToggle cycle={cycle} maxDiscount={maxDiscount} onCycleChange={onCycleChange} />}
      />

      <PlanCards plans={plans} currentSlug={currentSlug} cycle={cycle} onSelect={onSelect} />

      {/* Full feature-by-feature breakdown lives on the marketing site. */}
      <a
        href={PRICING_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="group flex items-center justify-between gap-4 rounded-xl border border-[var(--ds-border)] bg-[var(--ds-bg-surface)] px-5 py-4 transition-colors hover:border-[var(--ds-accent)] hover:bg-[var(--ds-bg-hover)] focus-visible:outline-none focus-visible:shadow-[0_0_0_1px_var(--ds-ring)]"
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
              See the full plan breakdown on our pricing page.
            </span>
          </span>
        </span>
        <ArrowUpRight
          size={18}
          aria-hidden="true"
          className="shrink-0 text-[var(--ds-text-subtle)] transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-[var(--ds-accent)]"
        />
      </a>
    </section>
  );
}
