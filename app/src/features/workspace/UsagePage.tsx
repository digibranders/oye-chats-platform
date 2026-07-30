import { type ReactElement, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CalendarClock,
  FileText,
  Globe,
  ListOrdered,
  MessageSquare,
  Wallet,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { Button, EmptyState, PageContainer, QuotaMeter, SectionHeader, Skeleton, cn } from '../../design-system';
import { MetricCard } from '../../design-system/components/MetricCard';
import { useEntitlements } from '../../hooks/useEntitlements';
import {
  aggregatePool,
  formatCredits,
  formatDate,
  formatTime,
  resolveScopedPool,
  type LedgerRow,
  type LedgerTone,
  type PoolCredit,
  type UsageBuckets,
} from './usage-model';
import { useBotContext } from '../../context/BotContext';
import { useUsageData } from './useUsageData';
import { TopupModal } from './billing/TopupModal';
import { AgentCreditHero } from './usage/AgentCreditHero';
import { CreditBreakdown } from './usage/CreditBreakdown';
import { ConsumptionTrend } from './usage/ConsumptionTrend';
import { BotCreditsSection, type TopupTarget } from './usage/BotCreditsSection';

// ── Plan limits (entitlement-driven quota meters) ────────────────────────────

const UNLIMITED = -1;

function formatLimit(limit: number, unit: string): string {
  return limit === UNLIMITED ? 'Unlimited' : `${limit.toLocaleString()} ${unit}`;
}

interface PlanLimitStatProps {
  readonly label: string;
  readonly icon: LucideIcon;
  /** Formatted value - the limit alone, no "used" fraction, for the two limit
   * keys the backend doesn't report usage for (`page_scraping`,
   * `chat_history_days`), so this stays honest instead of implying a fill. */
  readonly value: string;
  readonly caption: string;
}

/** An informational limit tile - a ceiling with no matching usage count. */
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

/**
 * PlanLimitsSection - the plan's numeric ceilings. `bots` / `operators` /
 * `documents` / `leads` are usage-populated keys, so they render as real
 * used/limit meters. `page_scraping` and `chat_history_days` have no per-page
 * usage on this workspace-wide view, so they render as honest limit-only stats.
 */
function PlanLimitsSection({ pool }: { pool?: PoolCredit | null }): ReactElement {
  const { entitlements, limitFor } = useEntitlements();

  // Per-agent scope: read ceilings from the selected agent's own plan and pair
  // them with that agent's usage. Drops "Agents" (a workspace-level count with
  // no per-agent meaning).
  if (pool && pool.planLimits && pool.limitUsage) {
    const limits = pool.planLimits;
    const usage = pool.limitUsage;
    const lim = (key: string): number => limits[key] ?? 0;
    return (
      <section aria-label="Plan limits" className="space-y-4">
        <SectionHeader
          title="Plan limits"
          description={`The ceilings on ${pool.name}'s plan, alongside what this agent has used.`}
        />
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
          <QuotaMeter label="Members" used={usage.operators} limit={lim('operators')} />
          <QuotaMeter label="Documents" used={usage.documents} limit={lim('documents')} />
          <QuotaMeter label="Leads" used={usage.leads} limit={lim('leads')} />
          <PlanLimitStat
            label="Page scraping"
            icon={Globe}
            value={formatLimit(lim('page_scraping'), 'pages')}
            caption="Pages this plan allows crawling per period."
          />
          <PlanLimitStat
            label="Chat history retention"
            icon={CalendarClock}
            value={formatLimit(lim('chat_history_days'), 'days')}
            caption="How far back conversation history is kept."
          />
        </div>
      </section>
    );
  }

  // Account-wide scope ("All agents"): plan ceilings + workspace-wide usage.
  return (
    <section aria-label="Plan limits" className="space-y-4">
      <SectionHeader
        title="Plan limits"
        description="The ceilings on your current plan, alongside what your workspace has used."
      />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
        <QuotaMeter label="Members" used={entitlements.usage.operators ?? 0} limit={limitFor('operators')} />
        <QuotaMeter label="Documents" used={entitlements.usage.documents ?? 0} limit={limitFor('documents')} />
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

// ── How credits work (per-action cost reference) ─────────────────────────────

interface CreditCostRow {
  readonly icon: LucideIcon;
  readonly label: string;
  readonly detail: string;
  readonly cost: number;
}

/**
 * Per-action credit costs. Ported as static values from the legacy Billing.jsx
 * `COST_ROWS` defaults (`ai_chat: 1, document_upload: 3, url_scan: 5` -
 * Billing.jsx:408): there is no typed pricing endpoint in `services/api.d.ts`
 * to read these from, and the credit-balance payload this page consumes doesn't
 * carry the per-action costs. Super-admins can override them via PricingConfig,
 * but these match the shipped backend defaults. Keep in sync if the defaults
 * change. `email_send` is intentionally omitted - the legacy COST_ROWS kept it
 * commented out as a not-yet-surfaced activity.
 */
const CREDIT_COSTS: readonly CreditCostRow[] = [
  {
    icon: MessageSquare,
    label: 'AI chat reply',
    detail: 'Each completed answer your AI streams to a visitor.',
    cost: 1,
  },
  {
    icon: FileText,
    label: 'Document upload',
    detail: 'Charged per file added to your knowledge base. Refunded if a file fails to save.',
    cost: 3,
  },
  {
    icon: Globe,
    label: 'URL crawl',
    detail: 'Charged per page actually ingested into your knowledge base.',
    cost: 5,
  },
];

/**
 * CreditCostReference - a compact "what each action costs" card. Lives on the
 * Usage page because it's about consumption, giving the metered activity tiles
 * above their price context.
 */
function CreditCostReference(): ReactElement {
  return (
    <section aria-label="How credits work" className="space-y-4">
      <SectionHeader
        title="How credits work"
        description="What each action costs from your credit balance."
      />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {CREDIT_COSTS.map(({ icon: Icon, label, detail, cost }) => (
          <div
            key={label}
            className="flex items-start gap-3 rounded-xl border border-[var(--ds-border)] bg-[var(--ds-bg-surface)] p-4 shadow-[var(--ds-shadow-sm)]"
          >
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--ds-bg-sunken)] text-[var(--ds-text-subtle)]">
              <Icon size={16} aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <div className="flex items-baseline justify-between gap-2">
                <p className="text-[13px] font-semibold text-[var(--ds-text)]">{label}</p>
                <span className="shrink-0 rounded-md bg-[var(--ds-bg-sunken)] px-2 py-0.5 text-[12px] font-semibold tabular-nums text-[var(--ds-text)]">
                  {cost === 1 ? '1 credit' : `${cost} credits`}
                </span>
              </div>
              <p className="mt-1 text-[12px] leading-relaxed text-[var(--ds-text-subtle)]">{detail}</p>
            </div>
          </div>
        ))}
      </div>
    </section>
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

// ── Recent top-ups ────────────────────────────────────────────────────────────

/**
 * A purchased top-up: a positive `topup` movement that isn't a plan-upgrade
 * proration credit (which `resolveLabel` relabels). Mirrors the legacy
 * Billing.jsx TopupsTab, which listed genuine credit purchases only.
 */
function isPurchasedTopup(row: LedgerRow): boolean {
  return row.reason === 'topup' && row.delta > 0 && row.label !== 'Plan upgrade credit';
}

/**
 * RecentTopups - a compact receipt of the last few credit purchases, restoring
 * the legacy TopupsTab's at-a-glance list. Rendered only when the ledger holds
 * genuine purchases; the full itemized ledger below carries everything else.
 */
function RecentTopups({ rows }: { rows: LedgerRow[] }): ReactElement | null {
  const purchases = useMemo(() => rows.filter(isPurchasedTopup).slice(0, 5), [rows]);
  if (purchases.length === 0) return null;

  return (
    <section aria-label="Recent top-ups" className="space-y-4">
      <SectionHeader
        title="Recent top-ups"
        description="Your latest credit purchases. Top-up credits roll over for 12 months."
      />
      <ul className="overflow-hidden rounded-xl border border-[var(--ds-border)] bg-[var(--ds-bg-surface)]">
        {purchases.map((row) => (
          <li
            key={row.id}
            className="flex items-center justify-between gap-4 border-b border-[var(--ds-border)] px-4 py-3 last:border-b-0"
          >
            <div className="flex min-w-0 items-center gap-3">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--ds-success-soft)] text-[var(--ds-success)]">
                <Wallet size={15} aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <p className="truncate text-[13px] font-medium text-[var(--ds-text)]">
                  {row.note || 'Credit top-up'}
                </p>
                <p className="text-[12px] text-[var(--ds-text-subtle)]">{formatDate(row.createdAt)}</p>
              </div>
            </div>
            <span className="shrink-0 tabular-nums text-[13px] font-semibold text-[var(--ds-success)]">
              +{formatCredits(row.delta)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

/**
 * UsagePage - the Workspace ▸ Usage analytics surface. One job: answer "how
 * much have I used?". A hero credit position leads; metered activity, a
 * where-credits-go breakdown, and a 30-day trend give the shape of consumption;
 * a grouped ledger gives the detail. Buying credits happens inline; upgrading
 * routes to Billing.
 */
export function UsagePage(): ReactElement {
  const { selectedBot } = useBotContext();
  const { phase, retry } = useUsageData(selectedBot?.id ?? null);
  const balance = phase.status === 'ready' ? phase.balance : null;
  // The credit pool for the current scope: the selected agent's own-plan pool,
  // the shared pool it draws from, or - as a last resort - the account balance
  // surfaced as a shared pool so the scoped hero always has something to show.
  // Shared with the Billing credits card via `resolveScopedPool` so the two
  // surfaces always agree for the same scope.
  const selectedPool = useMemo<PoolCredit | null>(() => {
    if (!balance || !selectedBot) return null;
    return resolveScopedPool(balance, selectedBot.id);
  }, [balance, selectedBot]);
  // Metered consumption for the current scope: the selected agent's pool, or the
  // whole-workspace aggregate on "All agents". Drives the activity tiles, the
  // "Credits used" total, and the "Where credits go" breakdown.
  const emptyBucket = { creditsUsed: 0, eventCount: 0 };
  const scopedActivity: UsageBuckets =
    selectedBot && selectedPool
      ? selectedPool.activity
      : balance
        ? {
            aiChat: balance.aiChat,
            documentUpload: balance.documentUpload,
            urlScan: balance.urlScan,
            emailSend: balance.emailSend,
          }
        : { aiChat: emptyBucket, documentUpload: emptyBucket, urlScan: emptyBucket, emailSend: emptyBucket };
  const scopedPeriodUsed =
    selectedBot && selectedPool ? selectedPool.periodCreditsUsed : balance?.periodCreditsUsed ?? 0;
  // `null` = closed. A target carries the pool the top-up is scoped to: the
  // shared account balance (`botId: null`) or one agent's isolated balance.
  const [topupTarget, setTopupTarget] = useState<TopupTarget | null>(null);
  // The page-level "Buy credits" tops up the current scope: the selected agent's
  // pool when one is active, otherwise the shared account balance.
  const openScopedTopup = (): void =>
    setTopupTarget(
      selectedBot && selectedPool
        ? { botId: selectedPool.botId, botName: selectedPool.botId === null ? null : selectedPool.name }
        : { botId: null, botName: null },
    );

  return (
    <PageContainer
      title="Usage"
      description="Everything your workspace is consuming this period - credits, AI chats, documents, and crawled pages."
      actions={
        <Button variant="outline" onClick={openScopedTopup}>
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
          {/* Credits are scoped to the agent picked in the shell switcher.
              A selected agent shows its own pool; "All agents" shows every
              agent's pool side by side (or the shared pool when the workspace
              still runs a single balance). The account-wide aggregate hero is
              intentionally gone - credits belong to an agent, not the account. */}
          {selectedBot && selectedPool ? (
            <AgentCreditHero
              pool={selectedPool}
              agentName={selectedBot.name}
              onTopup={setTopupTarget}
            />
          ) : phase.balance.botCredits.length > 0 ? (
            <BotCreditsSection
              pools={[
                ...(phase.balance.accountPool ? [phase.balance.accountPool] : []),
                ...phase.balance.botCredits,
              ]}
              onTopup={setTopupTarget}
            />
          ) : (
            <AgentCreditHero
              pool={aggregatePool(phase.balance)}
              agentName="All agents"
              onTopup={setTopupTarget}
            />
          )}

          {/* Metered consumption this period - scoped to the selected agent. */}
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <ActivityCard
              label="AI chat replies"
              icon={MessageSquare}
              eventCount={scopedActivity.aiChat.eventCount}
              creditsUsed={scopedActivity.aiChat.creditsUsed}
            />
            <ActivityCard
              label="Documents uploaded"
              icon={FileText}
              eventCount={scopedActivity.documentUpload.eventCount}
              creditsUsed={scopedActivity.documentUpload.creditsUsed}
            />
            <ActivityCard
              label="Pages crawled"
              icon={Globe}
              eventCount={scopedActivity.urlScan.eventCount}
              creditsUsed={scopedActivity.urlScan.creditsUsed}
            />
            <MetricCard label="Credits used" value={formatCredits(scopedPeriodUsed)} icon={Zap} />
          </div>

          {/* Breakdown + trend - the shape of consumption. */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <CreditBreakdown activity={scopedActivity} />
            {phase.trend.status === 'ready' && <ConsumptionTrend points={phase.trend.points} />}
          </div>

          {/* Per-action credit costs - price context for the metered tiles above. */}
          <CreditCostReference />

          {/* Plan limits - the selected agent's plan when scoped, else workspace-wide. */}
          <PlanLimitsSection pool={selectedBot ? selectedPool : null} />

          {/* Recent credit purchases - a quick receipt above the full ledger. */}
          {phase.ledger.status === 'ready' && <RecentTopups rows={phase.ledger.rows} />}

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
        open={topupTarget !== null}
        botId={topupTarget?.botId ?? null}
        botName={topupTarget?.botName ?? null}
        onClose={() => setTopupTarget(null)}
        onSuccess={() => {
          setTopupTarget(null);
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
