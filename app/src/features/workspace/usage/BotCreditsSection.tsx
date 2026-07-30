import { type ReactElement } from 'react';
import { Bot, Wallet } from 'lucide-react';
import { Button, SectionHeader, StatusBadge, cn } from '../../../design-system';
import { formatCredits, formatDate, type PoolCredit } from '../usage-model';

export interface TopupTarget {
  readonly botId: number | null;
  readonly botName: string | null;
}

export interface BotCreditsSectionProps {
  /** The account pool (when shown) followed by each per-agent pool. */
  readonly pools: PoolCredit[];
  /** Open the top-up modal scoped to a specific pool. */
  readonly onTopup: (target: TopupTarget) => void;
}

/** Low = ≤20% of the monthly grant remaining, matching the aggregate rule. */
function isLow(pool: PoolCredit): boolean {
  return pool.monthlyGrant > 0 && pool.totalRemaining <= pool.monthlyGrant * 0.2;
}

function PoolCard({ pool, onTopup }: { pool: PoolCredit; onTopup: (t: TopupTarget) => void }): ReactElement {
  const low = isLow(pool);
  // The account pool tops up the shared balance (botId null → generic copy);
  // a per-agent pool tops up that agent's isolated balance.
  const target: TopupTarget = {
    botId: pool.botId,
    botName: pool.botId === null ? null : pool.name,
  };

  return (
    <div className="flex flex-col rounded-xl border border-[var(--ds-border)] bg-[var(--ds-bg-surface)] p-5 shadow-[var(--ds-shadow-sm)]">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--ds-bg-sunken)] text-[var(--ds-text-subtle)]">
            <Bot size={16} aria-hidden="true" />
          </span>
          <p className="truncate text-[14px] font-semibold text-[var(--ds-text)]" title={pool.name}>
            {pool.name}
          </p>
        </div>
        {pool.planName ? (
          <StatusBadge tone="neutral">{pool.planName}</StatusBadge>
        ) : (
          <StatusBadge tone="neutral">Shared</StatusBadge>
        )}
      </div>

      <div className="mt-4">
        <div className="flex items-baseline gap-1.5">
          <span
            className={cn(
              'text-2xl font-bold tabular-nums tracking-tight',
              low ? 'text-[var(--ds-warning)]' : 'text-[var(--ds-text)]',
            )}
          >
            {formatCredits(pool.totalRemaining)}
          </span>
          <span className="text-[13px] text-[var(--ds-text-muted)]">credits left</span>
        </div>
        {pool.monthlyGrant > 0 && (
          <p className="mt-0.5 text-[12px] text-[var(--ds-text-subtle)]">
            of {formatCredits(pool.monthlyGrant)} / month
          </p>
        )}
      </div>

      {pool.monthlyGrant > 0 && (
        <div
          className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-[var(--ds-bg-sunken)]"
          role="progressbar"
          aria-valuenow={pool.planUsedPct}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`${pool.name} plan credits used`}
        >
          <div
            className={cn('h-full rounded-full', low ? 'bg-[var(--ds-warning)]' : 'bg-[var(--ds-accent)]')}
            style={{ width: `${pool.planUsedPct}%` }}
          />
        </div>
      )}

      <div className="mt-4 flex items-center justify-between gap-3 border-t border-[var(--ds-border)] pt-4">
        <span className="text-[12px] text-[var(--ds-text-subtle)]">
          {pool.resetsAt ? `Resets ${formatDate(pool.resetsAt)}` : 'Top-ups roll over'}
        </span>
        <Button variant="outline" size="sm" onClick={() => onTopup(target)}>
          <Wallet size={14} aria-hidden="true" />
          Top up
        </Button>
      </div>
    </div>
  );
}

/**
 * BotCreditsSection - the per-agent credit breakdown on the Usage page. When an
 * account runs more than one credit pool (any agent on its own paid
 * subscription keeps an isolated balance), the aggregate hero can't answer
 * "which agent is running low?" or let you top up just that one. This lays the
 * pools side by side - the shared account pool plus one card per agent - each
 * with its own balance, plan-grant progress, reset date, and a scoped top-up.
 */
export function BotCreditsSection({ pools, onTopup }: BotCreditsSectionProps): ReactElement | null {
  if (pools.length === 0) return null;

  return (
    <section aria-label="Credits by agent" className="space-y-4">
      <SectionHeader
        title="Credits by agent"
        description="Each agent on its own plan keeps an isolated balance. Top up just the one that needs it."
      />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {pools.map((pool) => (
          <PoolCard key={pool.botId ?? 'account'} pool={pool} onTopup={onTopup} />
        ))}
      </div>
    </section>
  );
}
