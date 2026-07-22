import { type ReactElement } from 'react';
import {
  AlertTriangle,
  CalendarClock,
  Clock,
  FileText,
  Globe,
  ListOrdered,
  Mail,
  MessageSquare,
  RefreshCw,
  Wallet,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import {
  Button,
  EmptyState,
  PageContainer,
  Progress,
  QuotaMeter,
  SectionHeader,
  Skeleton,
  cn,
} from '../../design-system';
import { MetricCard } from '../../design-system/components/MetricCard';
import { InsightCard } from '../../design-system/components/InsightCard';
import { DataTable, type Column } from '../../design-system/components/DataTable';
import { useEntitlements } from '../../hooks/useEntitlements';
import {
  formatCredits,
  formatDate,
  formatDateTime,
  type CreditBalance,
  type LedgerRow,
  type LedgerTone,
} from './usage-model';
import { useUsageData } from './useUsageData';

// ── Ledger tone → color ──────────────────────────────────────────────────────

const LEDGER_TONE_CLASS: Record<LedgerTone, string> = {
  credit: 'text-[var(--ds-success)]',
  expiry: 'text-[var(--ds-warning)]',
  debit: 'text-[var(--ds-text-muted)]',
};

// ── Credit balance summary ───────────────────────────────────────────────────

interface BalanceSummaryProps {
  readonly balance: CreditBalance;
}

/**
 * The headline credit position: total spendable credits, how much of the
 * monthly plan allowance is gone, and the plan/top-up split with their renewal
 * and expiry dates. Answers the first half of "what am I consuming?" — the
 * pool it's being consumed from.
 */
function BalanceSummary({ balance }: BalanceSummaryProps): ReactElement {
  return (
    <section
      aria-label="Credit balance"
      className="rounded-xl border border-[var(--ds-border)] bg-[var(--ds-bg-surface)] p-6 shadow-[var(--ds-shadow-sm)]"
    >
      <div className="flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
        {/* Total spendable — the number that matters when the AI stops. */}
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[13px] font-medium text-[var(--ds-text-muted)]">
            <Wallet size={16} aria-hidden="true" />
            Credits remaining
          </div>
          <p className="mt-2 text-4xl font-bold tracking-tight tabular-nums text-[var(--ds-text)]">
            {formatCredits(balance.totalRemaining)}
          </p>
          <p className="mt-1 text-[13px] text-[var(--ds-text-subtle)]">
            {formatCredits(balance.planRemaining)} from your plan
            {balance.topupRemaining > 0
              ? ` · ${formatCredits(balance.topupRemaining)} from top-ups`
              : ''}
          </p>
        </div>

        {/* Renewal / expiry facts. */}
        <dl className="grid grid-cols-2 gap-x-8 gap-y-3 text-[13px]">
          <div>
            <dt className="text-[var(--ds-text-subtle)]">Monthly allowance</dt>
            <dd className="mt-0.5 font-semibold tabular-nums text-[var(--ds-text)]">
              {formatCredits(balance.monthlyGrant)}
            </dd>
          </div>
          <div>
            <dt className="text-[var(--ds-text-subtle)]">Plan renews</dt>
            <dd className="mt-0.5 flex items-center gap-1.5 font-semibold text-[var(--ds-text)]">
              <RefreshCw size={13} aria-hidden="true" className="text-[var(--ds-text-subtle)]" />
              {formatDate(balance.resetsAt)}
            </dd>
          </div>
          {balance.topupRemaining > 0 && (
            <div>
              <dt className="text-[var(--ds-text-subtle)]">Top-ups expire</dt>
              <dd className="mt-0.5 flex items-center gap-1.5 font-semibold text-[var(--ds-text)]">
                <Clock size={13} aria-hidden="true" className="text-[var(--ds-text-subtle)]" />
                {formatDate(balance.soonestExpiry)}
              </dd>
            </div>
          )}
        </dl>
      </div>

      {/* Plan allowance consumption. */}
      {balance.monthlyGrant > 0 && (
        <div className="mt-6">
          <div className="mb-2 flex items-center justify-between text-[13px]">
            <span className="font-medium text-[var(--ds-text-muted)]">Plan allowance used</span>
            <span className="tabular-nums font-semibold text-[var(--ds-text)]">
              {balance.planUsedPct}%
            </span>
          </div>
          <Progress value={balance.planUsedPct} label="Plan allowance used this period" />
        </div>
      )}
    </section>
  );
}

// ── Metered activity tile ─────────────────────────────────────────────────────

interface ActivityCardProps {
  readonly label: string;
  readonly icon: LucideIcon;
  /** How many times the activity happened this period. */
  readonly eventCount: number;
  /** Credits it consumed this period. */
  readonly creditsUsed: number;
}

/**
 * A single metered-activity tile: the event count as the headline with the
 * credits it burned as a neutral caption. Mirrors MetricCard's shell but shows
 * the credits via a plain sub-label instead of the trend/delta slot — a static
 * secondary figure must not render behind a ▲/▼/– glyph, which reads as a
 * period-over-period change rather than a neutral value.
 */
function ActivityCard({
  label,
  icon: Icon,
  eventCount,
  creditsUsed,
}: ActivityCardProps): ReactElement {
  return (
    <div className="rounded-xl border border-[var(--ds-border)] bg-[var(--ds-bg-surface)] p-5 shadow-[var(--ds-shadow-sm)]">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[13px] font-medium text-[var(--ds-text-muted)]">{label}</p>
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--ds-bg-sunken)] text-[var(--ds-text-subtle)]">
          <Icon size={16} aria-hidden="true" />
        </span>
      </div>
      <div className="mt-3">
        <span className="text-2xl font-bold tracking-tight text-[var(--ds-text)]">
          {formatCredits(eventCount)}
        </span>
        <p className="mt-1 text-[13px] font-medium tabular-nums text-[var(--ds-text-subtle)]">
          {formatCredits(creditsUsed)} credits
        </p>
      </div>
    </div>
  );
}

// ── Plan limits ────────────────────────────────────────────────────────────

interface PlanLimitStatProps {
  readonly label: string;
  readonly icon: LucideIcon;
  /** Formatted value — the limit alone, no "used" fraction. Used for the two
   * limit keys the backend doesn't report usage for (`page_scraping`,
   * `chat_history_days`), so this stays honest instead of implying a fill
   * we don't actually know. */
  readonly value: string;
  readonly caption: string;
}

/** An informational limit tile — a ceiling with no matching usage count. */
function PlanLimitStat({ label, icon: Icon, value, caption }: PlanLimitStatProps): ReactElement {
  return (
    <div className="rounded-xl border border-[var(--ds-border)] bg-[var(--ds-bg-surface)] p-5 shadow-[var(--ds-shadow-sm)]">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[13px] font-medium text-[var(--ds-text-muted)]">{label}</p>
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--ds-bg-sunken)] text-[var(--ds-text-subtle)]">
          <Icon size={16} aria-hidden="true" />
        </span>
      </div>
      <div className="mt-3">
        <span className="text-2xl font-bold tracking-tight text-[var(--ds-text)]">{value}</span>
        <p className="mt-1 text-[13px] text-[var(--ds-text-subtle)]">{caption}</p>
      </div>
    </div>
  );
}

const UNLIMITED = -1;

function formatLimit(limit: number, unit: string): string {
  return limit === UNLIMITED ? 'Unlimited' : `${limit.toLocaleString()} ${unit}`;
}

/**
 * PlanLimitsSection — the plan's numeric ceilings, beneath the credit
 * balance. `bots` / `operators` / `documents` / `leads` are usage-populated
 * keys (`entitlements.usage[key]`), so they render as real used/limit
 * meters. `page_scraping` has no page data loaded on this workspace-wide
 * page to derive a "used" count from (unlike the per-agent Knowledge tab),
 * and `chat_history_days` is a retention window, not a countable resource —
 * both render as an honest limit-only stat instead of a fabricated meter.
 */
function PlanLimitsSection(): ReactElement {
  const { entitlements, limitFor } = useEntitlements();

  return (
    <section aria-label="Plan limits" className="space-y-4">
      <SectionHeader
        title="Plan limits"
        description="The ceilings on your current plan, alongside what your workspace has used."
      />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
        <QuotaMeter label="Agents" used={entitlements.usage.bots ?? 0} limit={limitFor('bots')} />
        <QuotaMeter
          label="Members"
          used={entitlements.usage.operators ?? 0}
          limit={limitFor('operators')}
        />
        <QuotaMeter
          label="Documents"
          used={entitlements.usage.documents ?? 0}
          limit={limitFor('documents')}
        />
        <QuotaMeter label="Leads" used={entitlements.usage.leads ?? 0} limit={limitFor('leads')} />
        <PlanLimitStat
          label="Page scraping"
          icon={Globe}
          value={formatLimit(limitFor('page_scraping'), 'pages')}
          caption="Pages your plan allows crawling per period."
        />
        <PlanLimitStat
          label="Chat history retention"
          icon={CalendarClock}
          value={formatLimit(limitFor('chat_history_days'), 'days')}
          caption="How far back conversation history is kept."
        />
      </div>
    </section>
  );
}

// ── Consumption ledger ───────────────────────────────────────────────────────

const LEDGER_COLUMNS: Column<LedgerRow>[] = [
  {
    key: 'createdAt',
    header: 'When',
    width: '11rem',
    render: (row) => (
      <span className="whitespace-nowrap tabular-nums text-[var(--ds-text-muted)]">
        {formatDateTime(row.createdAt)}
      </span>
    ),
  },
  {
    key: 'label',
    header: 'Activity',
    render: (row) => <span className="font-medium text-[var(--ds-text)]">{row.label}</span>,
  },
  {
    key: 'note',
    header: 'Details',
    render: (row) => (
      <span className="text-[var(--ds-text-subtle)]">{row.note ?? '—'}</span>
    ),
  },
  {
    key: 'delta',
    header: 'Credits',
    align: 'right',
    width: '8rem',
    render: (row) => (
      <span className={cn('tabular-nums font-semibold', LEDGER_TONE_CLASS[row.tone])}>
        {row.delta > 0 ? '+' : ''}
        {formatCredits(row.delta)}
      </span>
    ),
  },
];

// ── Page ─────────────────────────────────────────────────────────────────────

/**
 * UsagePage — the Workspace ▸ Usage surface. One job: answer
 * "What am I consuming?". Shows the credit balance and how much of the plan
 * allowance is spent, a metered breakdown of this period's activity (AI chats,
 * documents, crawled pages, customer emails, total credits), and the itemized
 * consumption ledger. Read-only — buying credits and the plan live on Billing.
 */
export function UsagePage(): ReactElement {
  const { phase, retry } = useUsageData();

  return (
    <PageContainer
      title="Usage"
      description="Everything your workspace is consuming this period — credits, AI chats, documents, crawled pages, and customer emails."
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
          {/* Running-low nudge — watches the combined bucket, not the plan alone. */}
          {phase.balance.lowBalance && (
            <InsightCard
              tone="warning"
              icon={AlertTriangle}
              title="You’re running low on credits"
              body={
                <>
                  Only {formatCredits(phase.balance.totalRemaining)} credits remain of your{' '}
                  {formatCredits(phase.balance.monthlyGrant)} monthly allowance. When they reach
                  zero your AI stops replying to visitors. Top up or upgrade from Billing to stay
                  online.
                </>
              }
            />
          )}

          <BalanceSummary balance={phase.balance} />

          {/* Metered consumption this period. */}
          <section aria-label="Consumption this period" className="space-y-4">
            <SectionHeader
              title="This period"
              description="What your workspace has spent credits on since the plan last renewed."
            />
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
              <MetricCard
                label="Credits used"
                value={formatCredits(phase.balance.periodCreditsUsed)}
                icon={Zap}
              />
            </div>
          </section>

          <PlanLimitsSection />

          {/* Itemized ledger. */}
          <section aria-label="Consumption history" className="space-y-4">
            <SectionHeader
              title="Consumption history"
              description="Your most recent credit movements — newest first."
            />
            {phase.ledger.status === 'error' ? (
              <EmptyState
                icon={AlertTriangle}
                title="Couldn’t load your history"
                description={phase.ledger.message}
                action={<Button onClick={retry}>Try again</Button>}
              />
            ) : phase.ledger.rows.length > 0 ? (
              <DataTable
                caption="Credit consumption ledger"
                columns={LEDGER_COLUMNS}
                rows={phase.ledger.rows}
                rowKey={(row) => row.id}
              />
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
    </PageContainer>
  );
}

// ── Loading skeleton ─────────────────────────────────────────────────────────

function LoadingState(): ReactElement {
  return (
    <div className="space-y-6">
      <Skeleton className="h-40 w-full rounded-xl" />
      <Skeleton className="h-7 w-40 rounded-lg" />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        {Array.from({ length: 5 }).map((_, index) => (
          <Skeleton key={index} className="h-24 rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-7 w-48 rounded-lg" />
      <Skeleton className="h-64 w-full rounded-xl" />
    </div>
  );
}
