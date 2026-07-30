import { type ReactElement } from 'react';
import { Clock, RefreshCw, Wallet } from 'lucide-react';
import { Button } from '../../../design-system';
import { formatCredits, formatDate, type CreditBalance } from '../usage-model';

export interface UsageHeroProps {
  balance: CreditBalance;
  onBuyCredits: () => void;
}

/**
 * UsageHero - the headline credit position and the page's primary answer to
 * "how much have I used?". Total spendable credits lead; a prominent allowance
 * bar shows how much of the monthly plan is gone; renewal / top-up-expiry facts
 * and a Buy-credits CTA sit alongside. One card, strong hierarchy.
 */
export function UsageHero({ balance, onBuyCredits }: UsageHeroProps): ReactElement {
  const planUsed = Math.max(balance.monthlyGrant - balance.planRemaining, 0);
  const hasPlan = balance.monthlyGrant > 0;

  return (
    <section
      aria-label="Credit balance"
      className="overflow-hidden rounded-2xl border border-[var(--ds-border)] bg-[var(--ds-bg-surface)] shadow-[var(--ds-shadow-sm)]"
    >
      <div className="grid gap-6 p-6 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center lg:gap-10">
        {/* Headline + allowance bar */}
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[13px] font-medium text-[var(--ds-text-muted)]">
            <Wallet size={16} aria-hidden="true" />
            Credits remaining
          </div>
          <div className="mt-2 flex items-end gap-3">
            <span className="text-[44px] font-bold leading-none tracking-tight tabular-nums text-[var(--ds-text)]">
              {formatCredits(balance.totalRemaining)}
            </span>
            {hasPlan && (
              <span className="mb-1 text-[13px] text-[var(--ds-text-subtle)]">
                of {formatCredits(balance.monthlyGrant)} monthly
              </span>
            )}
          </div>
          <p className="mt-1 text-[13px] text-[var(--ds-text-subtle)]">
            {formatCredits(balance.planRemaining)} from your plan
            {balance.topupRemaining > 0 ? ` · ${formatCredits(balance.topupRemaining)} from top-ups` : ''}
          </p>

          {hasPlan && (
            <div className="mt-5">
              <div className="mb-1.5 flex items-center justify-between text-[12px]">
                <span className="text-[var(--ds-text-muted)]">
                  <span className="font-semibold tabular-nums text-[var(--ds-text)]">
                    {formatCredits(planUsed)}
                  </span>{' '}
                  of {formatCredits(balance.monthlyGrant)} used this period
                </span>
                <span className="tabular-nums font-semibold text-[var(--ds-text)]">{balance.planUsedPct}%</span>
              </div>
              <div
                className="h-2.5 overflow-hidden rounded-full bg-[var(--ds-bg-sunken)]"
                role="img"
                aria-label={`${balance.planUsedPct}% of the monthly plan allowance used`}
              >
                <div
                  className={
                    balance.lowBalance
                      ? 'h-full rounded-full bg-[var(--ds-warning)] transition-[width] duration-500'
                      : 'h-full rounded-full bg-[var(--ds-accent)] transition-[width] duration-500'
                  }
                  style={{ width: `${Math.min(Math.max(balance.planUsedPct, 2), 100)}%` }}
                />
              </div>
            </div>
          )}
        </div>

        {/* Facts + CTA */}
        <div className="flex flex-col gap-4 border-t border-[var(--ds-border)] pt-5 lg:min-w-[220px] lg:border-l lg:border-t-0 lg:pl-10 lg:pt-0">
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-1">
            <Fact icon={RefreshCw} label="Plan renews" value={formatDate(balance.resetsAt)} />
            {balance.topupRemaining > 0 && (
              <Fact icon={Clock} label="Top-ups expire" value={formatDate(balance.soonestExpiry)} />
            )}
          </div>
          <Button onClick={onBuyCredits} className="w-full">
            <Wallet size={16} aria-hidden="true" />
            Buy credits
          </Button>
        </div>
      </div>
    </section>
  );
}

function Fact({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Wallet;
  label: string;
  value: string;
}): ReactElement {
  return (
    <div>
      <dt className="text-[12px] text-[var(--ds-text-subtle)]">{label}</dt>
      <dd className="mt-0.5 flex items-center gap-1.5 text-[14px] font-semibold text-[var(--ds-text)]">
        <Icon size={13} aria-hidden="true" className="text-[var(--ds-text-subtle)]" />
        {value}
      </dd>
    </div>
  );
}
