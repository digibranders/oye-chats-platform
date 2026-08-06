import { type ReactElement } from 'react';
import { Sparkles } from 'lucide-react';
import {
  formatFreeMonths,
  formatPromotionScope,
  type PlanView,
  type PromotionView,
} from '../billingModel';

export interface PromotionBannerProps {
  promotion: PromotionView;
  /** Plan catalog, used to name which plan(s) the offer covers (e.g. "the Standard plan"). */
  plans: PlanView[];
}

/**
 * PromotionBanner - the launch-offer callout above the plan grid. It states the
 * offer plainly (free period + how billing resumes) so the "Free" prices on the
 * cards below read as a deliberate promotion, not a glitch. One accent, no
 * gradient/glow - it sits inside the management surface, not a marketing page.
 *
 * Display-only: eligibility is enforced server-side at checkout, so this banner
 * appearing never means a charge was skipped without a mandate.
 */
export function PromotionBanner({ promotion, plans }: PromotionBannerProps): ReactElement {
  const months = formatFreeMonths(promotion.freeCycles);
  const scope = formatPromotionScope(promotion, plans);
  const heading = promotion.name
    ? `${promotion.name}: your first ${months} are free`
    : `Your first ${months} are free`;

  return (
    <div
      className="flex items-start gap-3 rounded-2xl border border-[var(--ds-accent)] bg-[var(--ds-accent-soft)] p-4"
      role="status"
    >
      <span
        className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--ds-accent)] text-white"
        aria-hidden="true"
      >
        <Sparkles size={16} />
      </span>
      <div className="min-w-0">
        <p className="text-[14px] font-semibold text-[var(--ds-text)]">{heading}</p>
        <p className="mt-0.5 text-[13px] leading-relaxed text-[var(--ds-text-muted)]">
          Choose {scope} and pay ₹0 for {months}. Add a card or UPI now, and you’re only
          charged once your {months} are up. Cancel anytime before then. UPI may show a small
          verification charge that’s refunded instantly.
        </p>
      </div>
    </div>
  );
}
