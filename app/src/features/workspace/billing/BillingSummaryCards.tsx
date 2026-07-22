import { type ReactElement, type ReactNode } from 'react';
import { ArrowUpRight, CalendarClock, Sparkles, Wallet, Zap, type LucideIcon } from 'lucide-react';
import { Button, Card, CardContent, StatusBadge, cn } from '../../../design-system';
import { formatCredits, humanizeStatus, statusTone } from '../billingModel';

export interface BillingSummaryCardsProps {
  planName: string;
  status: string;
  priceLabel: string;
  isPaid: boolean;
  renewalCaption: string;
  renewalLabel: string;
  /** Derived from `!cancelAtPeriodEnd` — false when the plan is set to end. */
  autoRenew: boolean;
  paymentLabel: string;
  paymentSub: string;
  creditsPerMonth: number;
  onChangePlan: () => void;
  onViewUsage: () => void;
}

/**
 * BillingSummaryCards — the subscription-management overview: four focused
 * cards (Subscription · Renewal · Payment method · Credits), each answering one
 * question with strong hierarchy. Replaces the old single band now that Billing
 * reads as a dashboard rather than a pricing page. Responsive 4 / 2 / 1.
 */
export function BillingSummaryCards({
  planName,
  status,
  priceLabel,
  isPaid,
  renewalCaption,
  renewalLabel,
  autoRenew,
  paymentLabel,
  paymentSub,
  creditsPerMonth,
  onChangePlan,
  onViewUsage,
}: BillingSummaryCardsProps): ReactElement {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {/* Subscription */}
      <SummaryCard icon={Sparkles} label="Subscription">
        <div className="flex items-center gap-2">
          <span className="text-xl font-bold tracking-tight text-[var(--ds-text)]">{planName}</span>
          <StatusBadge tone={statusTone(status)}>{humanizeStatus(status)}</StatusBadge>
        </div>
        <p className="mt-1 text-[13px] text-[var(--ds-text-muted)]">{priceLabel}</p>
        <Button size="sm" className="mt-4 w-full" onClick={onChangePlan}>
          <ArrowUpRight size={15} aria-hidden="true" />
          {isPaid ? 'Change plan' : 'Choose a plan'}
        </Button>
      </SummaryCard>

      {/* Renewal */}
      <SummaryCard icon={CalendarClock} label={renewalCaption}>
        <span className="text-xl font-bold tracking-tight text-[var(--ds-text)]">{renewalLabel}</span>
        <div className="mt-3">
          {isPaid ? (
            <StatusBadge tone={autoRenew ? 'success' : 'warning'} dot>
              Auto-renewal {autoRenew ? 'on' : 'off'}
            </StatusBadge>
          ) : (
            <span className="text-[13px] text-[var(--ds-text-subtle)]">No paid subscription</span>
          )}
        </div>
      </SummaryCard>

      {/* Payment method */}
      <SummaryCard icon={Wallet} label="Payment method">
        <span className="text-xl font-bold tracking-tight text-[var(--ds-text)]">{paymentLabel}</span>
        <p className="mt-1 text-[13px] leading-relaxed text-[var(--ds-text-muted)]">{paymentSub}</p>
      </SummaryCard>

      {/* Credits */}
      <SummaryCard icon={Zap} label="Monthly credits">
        <div className="flex items-baseline gap-1.5">
          <span className="text-xl font-bold tracking-tight tabular-nums text-[var(--ds-text)]">
            {creditsPerMonth > 0 ? formatCredits(creditsPerMonth) : '—'}
          </span>
          {creditsPerMonth > 0 && <span className="text-[13px] text-[var(--ds-text-muted)]">/ month</span>}
        </div>
        <button
          type="button"
          onClick={onViewUsage}
          className="mt-4 inline-flex items-center gap-1 text-[13px] font-medium text-[var(--ds-accent-text)] transition-colors hover:text-[var(--ds-accent)] focus-visible:outline-none focus-visible:shadow-[0_0_0_1px_var(--ds-ring)]"
        >
          View usage
          <ArrowUpRight size={14} aria-hidden="true" />
        </button>
      </SummaryCard>
    </div>
  );
}

function SummaryCard({
  icon: Icon,
  label,
  children,
  className,
}: {
  icon: LucideIcon;
  label: string;
  children: ReactNode;
  className?: string;
}): ReactElement {
  return (
    <Card className={cn('transition-colors hover:border-[var(--ds-border-strong)]', className)}>
      <CardContent className="flex h-full flex-col py-5">
        <div className="mb-3 flex items-center gap-2 text-[11px] font-medium uppercase tracking-wide text-[var(--ds-text-subtle)]">
          <Icon size={14} aria-hidden="true" />
          {label}
        </div>
        <div className="flex flex-1 flex-col">{children}</div>
      </CardContent>
    </Card>
  );
}
