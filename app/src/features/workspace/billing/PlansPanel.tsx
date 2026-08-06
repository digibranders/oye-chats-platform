import { useState, type ReactElement } from 'react';
import { SectionHeader } from '../../../design-system';
import type { PlanView, PromotionView } from '../billingModel';
import type { BillingCycle } from './planMath';
import { CycleToggle } from './PlanMatrix';
import { PlanCards } from './PlanCards';
import { ComparePlans } from './ComparePlans';

export interface PlansPanelProps {
  plans: PlanView[];
  currentSlug: string;
  cycle: BillingCycle;
  onCycleChange: (cycle: BillingCycle) => void;
  onSelect: (plan: PlanView) => void;
  /** Current subscription status - drives the trial → paid activation CTA. */
  currentStatus?: string | null;
  /** Trial end date (ISO) - shown on the trialing plan's own card. */
  trialEnd?: string | null;
  /** Active launch promotion - marks eligible cards "Free for N months". */
  promotion?: PromotionView | null;
}

/**
 * PlansPanel - the plan picker for the Billing ▸ Plans tab. It leads with the
 * premium pricing cards (price + top highlights + CTA) under one monthly/annual
 * toggle - the fast switch surface - and offers the exhaustive feature matrix
 * in-app via a collapsed {@link ComparePlans} disclosure, so a customer can
 * re-shop line by line without leaving the product. One toggle drives both the
 * cards and the matrix.
 */
export function PlansPanel({
  plans,
  currentSlug,
  cycle,
  onCycleChange,
  onSelect,
  currentStatus = null,
  trialEnd = null,
  promotion = null,
}: PlansPanelProps): ReactElement {
  const [compareOpen, setCompareOpen] = useState(false);
  const maxDiscount = Math.max(0, ...plans.map((p) => p.annualDiscountPercent));

  return (
    <section aria-label="Plans" className="space-y-5">
      <SectionHeader
        title="Compare & switch plans"
        description="The essentials at a glance. Switch or upgrade in a couple of clicks."
        actions={<CycleToggle cycle={cycle} maxDiscount={maxDiscount} onCycleChange={onCycleChange} />}
      />

      <PlanCards
        plans={plans}
        currentSlug={currentSlug}
        cycle={cycle}
        onSelect={onSelect}
        currentStatus={currentStatus}
        trialEnd={trialEnd}
        promotion={promotion}
      />

      {/* Full feature-by-feature breakdown, in-app and one click away. */}
      <ComparePlans
        plans={plans}
        currentSlug={currentSlug}
        cycle={cycle}
        onSelect={onSelect}
        open={compareOpen}
        onOpenChange={setCompareOpen}
        currentStatus={currentStatus}
      />
    </section>
  );
}
