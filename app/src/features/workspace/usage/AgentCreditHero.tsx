import { type ReactElement } from 'react';
import { RefreshCw, Wallet } from 'lucide-react';
import { Button, StatusBadge } from '../../../design-system';
import { formatCredits, formatDate, type PoolCredit } from '../usage-model';
import { type TopupTarget } from './BotCreditsSection';

export interface AgentCreditHeroProps {
  /** The selected agent's credit pool (its own plan pool, or the shared pool it draws from). */
  readonly pool: PoolCredit;
  /** The selected agent's display name - headlines the card. */
  readonly agentName: string;
  /** Open the top-up modal scoped to this pool. */
  readonly onTopup: (target: TopupTarget) => void;
}

/** Low = ≤20% of the monthly grant remaining, matching the account-wide rule. */
function isLow(pool: PoolCredit): boolean {
  return pool.monthlyGrant > 0 && pool.totalRemaining <= pool.monthlyGrant * 0.2;
}

/**
 * AgentCreditHero - the headline credit position for a single selected agent.
 * Mirrors the account hero's layout but is scoped to one agent's pool: agents on
 * their own plan show that plan's isolated balance; an agent still drawing from
 * the shared workspace pool is badged "Shared" so the source is never ambiguous.
 */
export function AgentCreditHero({ pool, agentName, onTopup }: AgentCreditHeroProps): ReactElement {
  const low = isLow(pool);
  const hasPlan = pool.monthlyGrant > 0;
  const planUsed = Math.max(pool.monthlyGrant - pool.planRemaining, 0);

  return (
    <section
      aria-label={`Credit balance for ${agentName}`}
      className="overflow-hidden rounded-2xl border border-[var(--ds-border)] bg-[var(--ds-bg-surface)] shadow-[var(--ds-shadow-sm)]"
    >
      <div className="grid gap-6 p-6 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center lg:gap-10">
        {/* Headline + allowance bar */}
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="flex items-center gap-2 text-[13px] font-medium text-[var(--ds-text-muted)]">
              <Wallet size={16} aria-hidden="true" />
              Credits remaining
            </span>
            <StatusBadge tone="neutral">{pool.planName ?? 'Shared'}</StatusBadge>
          </div>
          <p className="mt-1 truncate text-[13px] font-semibold text-[var(--ds-text)]" title={agentName}>
            {agentName}
          </p>
          <div className="mt-2 flex items-end gap-3">
            <span className="text-[44px] font-bold leading-none tracking-tight tabular-nums text-[var(--ds-text)]">
              {formatCredits(pool.totalRemaining)}
            </span>
            <span className="mb-1 text-[13px] text-[var(--ds-text-subtle)]">credits available now</span>
          </div>
          <p className="mt-1 text-[13px] text-[var(--ds-text-subtle)]">
            {formatCredits(pool.planRemaining)} from your plan
            {pool.topupRemaining > 0 ? ` · ${formatCredits(pool.topupRemaining)} from top-ups` : ''}
          </p>

          {hasPlan && (
            <div className="mt-5">
              <div className="mb-1.5 flex items-center justify-between text-[12px]">
                <span className="text-[var(--ds-text-muted)]">
                  <span className="font-semibold tabular-nums text-[var(--ds-text)]">
                    {formatCredits(planUsed)}
                  </span>{' '}
                  of {formatCredits(pool.monthlyGrant)} used this period
                </span>
                <span className="tabular-nums font-semibold text-[var(--ds-text)]">{pool.planUsedPct}%</span>
              </div>
              <div
                className="h-2.5 overflow-hidden rounded-full bg-[var(--ds-bg-sunken)]"
                role="img"
                aria-label={`${pool.planUsedPct}% of the monthly plan allowance used`}
              >
                <div
                  className={
                    low
                      ? 'h-full rounded-full bg-[var(--ds-warning)] transition-[width] duration-500'
                      : 'h-full rounded-full bg-[var(--ds-accent)] transition-[width] duration-500'
                  }
                  style={{ width: `${Math.min(Math.max(pool.planUsedPct, 2), 100)}%` }}
                />
              </div>
            </div>
          )}
        </div>

        {/* Facts + CTA */}
        <div className="flex flex-col gap-4 border-t border-[var(--ds-border)] pt-5 lg:min-w-[220px] lg:border-l lg:border-t-0 lg:pl-10 lg:pt-0">
          <div>
            <dt className="text-[12px] text-[var(--ds-text-subtle)]">
              {pool.resetsAt ? 'Plan renews' : 'Top-ups'}
            </dt>
            <dd className="mt-0.5 flex items-center gap-1.5 text-[14px] font-semibold text-[var(--ds-text)]">
              <RefreshCw size={13} aria-hidden="true" className="text-[var(--ds-text-subtle)]" />
              {pool.resetsAt ? formatDate(pool.resetsAt) : 'Roll over'}
            </dd>
          </div>
          {pool.topupRemaining > 0 && (
            <div>
              <dt className="text-[12px] text-[var(--ds-text-subtle)]">Top-up credits</dt>
              <dd className="mt-0.5 flex items-center gap-1.5 text-[14px] font-semibold text-[var(--ds-text)]">
                <Wallet size={13} aria-hidden="true" className="text-[var(--ds-text-subtle)]" />
                {formatCredits(pool.topupRemaining)}
              </dd>
            </div>
          )}
          <Button
            onClick={() => onTopup({ botId: pool.botId, botName: pool.botId === null ? null : pool.name })}
            className="w-full"
          >
            <Wallet size={16} aria-hidden="true" />
            Buy credits
          </Button>
        </div>
      </div>
    </section>
  );
}
