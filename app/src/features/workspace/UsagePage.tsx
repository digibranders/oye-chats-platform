import { type ReactElement, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowUpRight,
  FileText,
  Globe,
  ListOrdered,
  Mail,
  MessageSquare,
  Wallet,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { Button, EmptyState, PageContainer, Skeleton, cn } from '../../design-system';
import { MetricCard } from '../../design-system/components/MetricCard';
import { InsightCard } from '../../design-system/components/InsightCard';
import {
  formatCredits,
  formatDate,
  formatTime,
  type LedgerRow,
  type LedgerTone,
} from './usage-model';
import { useUsageData } from './useUsageData';
import { TopupModal } from './billing/TopupModal';
import { UsageHero } from './usage/UsageHero';
import { CreditBreakdown } from './usage/CreditBreakdown';
import { ConsumptionTrend } from './usage/ConsumptionTrend';

const LEDGER_TONE_CLASS: Record<LedgerTone, string> = {
  credit: 'text-[var(--ds-success)]',
  expiry: 'text-[var(--ds-warning)]',
  debit: 'text-[var(--ds-text-muted)]',
};

// ── Metered activity tile ─────────────────────────────────────────────────────

interface ActivityCardProps {
  readonly label: string;
  readonly icon: LucideIcon;
  readonly eventCount: number;
  readonly creditsUsed: number;
}

/**
 * A single metered-activity tile: the event count as the headline with the
 * credits it burned as a neutral caption. A subtle hover lift signals it's a
 * living metric without implying it's clickable.
 */
function ActivityCard({ label, icon: Icon, eventCount, creditsUsed }: ActivityCardProps): ReactElement {
  return (
    <div className="rounded-xl border border-[var(--ds-border)] bg-[var(--ds-bg-surface)] p-5 shadow-[var(--ds-shadow-sm)] transition-colors hover:border-[var(--ds-border-strong)]">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[13px] font-medium text-[var(--ds-text-muted)]">{label}</p>
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--ds-bg-sunken)] text-[var(--ds-text-subtle)]">
          <Icon size={16} aria-hidden="true" />
        </span>
      </div>
      <div className="mt-3">
        <span className="text-2xl font-bold tracking-tight tabular-nums text-[var(--ds-text)]">
          {formatCredits(eventCount)}
        </span>
        <p className="mt-1 text-[13px] font-medium tabular-nums text-[var(--ds-text-subtle)]">
          {formatCredits(creditsUsed)} credits
        </p>
      </div>
    </div>
  );
}

// ── Consumption history (grouped by day) ─────────────────────────────────────

interface DayGroup {
  readonly label: string;
  readonly rows: LedgerRow[];
}

/** Relative day label ("Today" / "Yesterday" / a date) for a ledger timestamp. */
function dayLabel(iso: string | null): string {
  if (!iso) return 'Earlier';
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return 'Earlier';
  const startOfDay = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diffDays = Math.round((startOfDay(new Date()) - startOfDay(then)) / 86_400_000);
  if (diffDays <= 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  return formatDate(iso);
}

/** Group already-descending ledger rows into contiguous day buckets. */
function groupByDay(rows: LedgerRow[]): DayGroup[] {
  const groups: DayGroup[] = [];
  for (const row of rows) {
    const label = dayLabel(row.createdAt);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.rows.push(row);
    else groups.push({ label, rows: [row] });
  }
  return groups;
}

function ConsumptionHistory({ rows }: { rows: LedgerRow[] }): ReactElement {
  const groups = useMemo(() => groupByDay(rows), [rows]);
  return (
    <div className="overflow-hidden rounded-xl border border-[var(--ds-border)] bg-[var(--ds-bg-surface)]">
      {groups.map((group) => (
        <div key={group.label} className="border-b border-[var(--ds-border)] last:border-b-0">
          <div className="bg-[var(--ds-bg-subtle)] px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--ds-text-muted)]">
            {group.label}
          </div>
          <ul>
            {group.rows.map((row) => (
              <li
                key={row.id}
                className="flex items-center justify-between gap-4 px-4 py-3 transition-colors hover:bg-[var(--ds-bg-hover)]"
              >
                <div className="min-w-0">
                  <p className="truncate text-[13px] font-medium text-[var(--ds-text)]">{row.label}</p>
                  {row.note && (
                    <p className="truncate text-[12px] text-[var(--ds-text-subtle)]">{row.note}</p>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-4">
                  <span className="tabular-nums text-[12px] text-[var(--ds-text-subtle)]">
                    {formatTime(row.createdAt)}
                  </span>
                  <span className={cn('w-16 text-right tabular-nums text-[13px] font-semibold', LEDGER_TONE_CLASS[row.tone])}>
                    {row.delta > 0 ? '+' : ''}
                    {formatCredits(row.delta)}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

/**
 * UsagePage — the Workspace ▸ Usage analytics surface. One job: answer "how
 * much have I used?". A hero credit position leads; metered activity, a
 * where-credits-go breakdown, and a 30-day trend give the shape of consumption;
 * a grouped ledger gives the detail. Buying credits happens inline; upgrading
 * routes to Billing.
 */
export function UsagePage(): ReactElement {
  const { phase, retry } = useUsageData();
  const navigate = useNavigate();
  const [topupOpen, setTopupOpen] = useState(false);

  const goToBilling = (): void => {
    void navigate('/workspace/billing');
  };

  return (
    <PageContainer
      title="Usage"
      description="Everything your workspace is consuming this period — credits, AI chats, documents, crawled pages, and customer emails."
      actions={
        <Button variant="outline" onClick={() => setTopupOpen(true)}>
          <Wallet size={16} aria-hidden="true" />
          Buy credits
        </Button>
      }
    >
      {phase.status === 'loading' && <LoadingState />}

      {phase.status === 'error' && (
        <EmptyState
          icon={AlertTriangle}
          title="Couldn’t load your usage"
          description={phase.message}
          action={<Button onClick={retry}>Try again</Button>}
        />
      )}

      {phase.status === 'ready' && (
        <>
          {phase.balance.lowBalance && (
            <InsightCard
              tone="warning"
              icon={AlertTriangle}
              title="You’re running low on credits"
              body={
                <>
                  Only {formatCredits(phase.balance.totalRemaining)} credits remain of your{' '}
                  {formatCredits(phase.balance.monthlyGrant)} monthly allowance. When they reach zero your AI
                  stops replying to visitors.
                </>
              }
              action={
                <div className="flex flex-wrap gap-2">
                  <Button onClick={() => setTopupOpen(true)}>
                    <Wallet size={16} aria-hidden="true" />
                    Buy credits
                  </Button>
                  <Button variant="ghost" onClick={goToBilling}>
                    <ArrowUpRight size={16} aria-hidden="true" />
                    Upgrade plan
                  </Button>
                </div>
              }
            />
          )}

          <UsageHero balance={phase.balance} onBuyCredits={() => setTopupOpen(true)} />

          {/* Metered consumption this period. */}
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
            <ActivityCard
              label="AI chat replies"
              icon={MessageSquare}
              eventCount={phase.balance.aiChat.eventCount}
              creditsUsed={phase.balance.aiChat.creditsUsed}
            />
            <ActivityCard
              label="Documents uploaded"
              icon={FileText}
              eventCount={phase.balance.documentUpload.eventCount}
              creditsUsed={phase.balance.documentUpload.creditsUsed}
            />
            <ActivityCard
              label="Pages crawled"
              icon={Globe}
              eventCount={phase.balance.urlScan.eventCount}
              creditsUsed={phase.balance.urlScan.creditsUsed}
            />
            <ActivityCard
              label="Customer emails"
              icon={Mail}
              eventCount={phase.balance.emailSend.eventCount}
              creditsUsed={phase.balance.emailSend.creditsUsed}
            />
            <MetricCard label="Credits used" value={formatCredits(phase.balance.periodCreditsUsed)} icon={Zap} />
          </div>

          {/* Breakdown + trend — the shape of consumption. */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <CreditBreakdown balance={phase.balance} />
            {phase.trend.status === 'ready' && <ConsumptionTrend points={phase.trend.points} />}
          </div>

          {/* Itemized ledger, grouped by day. */}
          <section aria-label="Consumption history" className="space-y-3">
            <h2 className="text-[15px] font-semibold text-[var(--ds-text)]">Consumption history</h2>
            {phase.ledger.status === 'error' ? (
              <EmptyState
                icon={AlertTriangle}
                title="Couldn’t load your history"
                description={phase.ledger.message}
                action={<Button onClick={retry}>Try again</Button>}
              />
            ) : phase.ledger.rows.length > 0 ? (
              <ConsumptionHistory rows={phase.ledger.rows} />
            ) : (
              <EmptyState
                icon={ListOrdered}
                title="No activity yet"
                description="Once your AI starts answering questions and you add knowledge, every credit movement will appear here."
              />
            )}
          </section>
        </>
      )}

      <TopupModal
        open={topupOpen}
        onClose={() => setTopupOpen(false)}
        onSuccess={() => {
          setTopupOpen(false);
          retry();
        }}
      />
    </PageContainer>
  );
}

// ── Loading skeleton ─────────────────────────────────────────────────────────

function LoadingState(): ReactElement {
  return (
    <div className="space-y-6">
      <Skeleton className="h-44 w-full rounded-2xl" />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        {Array.from({ length: 5 }).map((_, index) => (
          <Skeleton key={index} className="h-24 rounded-xl" />
        ))}
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Skeleton className="h-56 rounded-xl" />
        <Skeleton className="h-56 rounded-xl" />
      </div>
      <Skeleton className="h-64 w-full rounded-xl" />
    </div>
  );
}
