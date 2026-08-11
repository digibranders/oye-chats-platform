import { type ReactElement, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowUpRight,
  Building2,
  CalendarClock,
  ChevronDown,
  FileText,
  Globe,
  ListOrdered,
  MailCheck,
  MessageSquare,
  Wallet,
  type LucideIcon,
} from 'lucide-react';
import { Button, EmptyState, PageContainer, QuotaMeter, SectionHeader, Skeleton, cn } from '../../design-system';
import { MetricCard } from '../../design-system/components/MetricCard';
import { useEntitlements } from '../../hooks/useEntitlements';
import { useUpgradeModal } from '../../context/UpgradeModalContext';
import { useBotContext } from '../../context/BotContext';
import {
  aggregatePool,
  formatCredits,
  formatDate,
  formatTime,
  resolveScopedPool,
  describeTopupExpiry,
  type CreditBalance,
  type LedgerRow,
  type LedgerTone,
  type PoolCredit,
  type UsageBuckets,
} from './usage-model';

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
function PlanLimitStat({ label, icon, value, caption }: PlanLimitStatProps): ReactElement {
  return <MetricCard label={label} icon={icon} value={value} caption={caption} />;
}

/**
 * PlanLimitsSection - the plan's numeric ceilings. `bots` / `operators` /
 * `documents` / `leads` are usage-populated keys, so they render as real
 * used/limit meters. `page_scraping` and `chat_history_days` have no per-page
 * usage on this workspace-wide view, so they render as honest limit-only stats.
 */
function PlanLimitsSection({ pool }: { pool?: PoolCredit | null }): ReactElement {
  const { entitlements, limitFor, isFree } = useEntitlements();
  // The Leads dashboard is feature-locked on Free (sidebar gate), so a Leads
  // quota meter here would advertise a ceiling for a surface Free can't open.
  // Hide the meter on Free; paid plans keep it.
  const showLeads = !isFree;
  // Free grants 0 operator seats, so a "1 / 0" meter reads as broken (the "1"
  // is a leftover row from a prior paid subscription that wasn't deactivated
  // on downgrade). Hide the tile on any plan whose operator ceiling is 0 so
  // the tile only surfaces when it can plausibly move; the invite path is
  // separately gated in `operator_routes.py`.
  const membersLimit = pool?.planLimits?.operators ?? limitFor('operators');
  const showMembers = membersLimit > 0;

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
          {showMembers && (
            <QuotaMeter label="Members" used={usage.operators} limit={lim('operators')} />
          )}
          <QuotaMeter label="Documents" used={usage.documents} limit={lim('documents')} />
          {showLeads && <QuotaMeter label="Leads" used={usage.leads} limit={lim('leads')} />}
        </div>
        {/* Informational limit boxes kept on their own row so they always pair
            up, regardless of how many usage meters render above. */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
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
        {showMembers && (
          <QuotaMeter label="Members" used={entitlements.usage.operators ?? 0} limit={limitFor('operators')} />
        )}
        <QuotaMeter label="Documents" used={entitlements.usage.documents ?? 0} limit={limitFor('documents')} />
        {showLeads && (
          <QuotaMeter label="Leads" used={entitlements.usage.leads ?? 0} limit={limitFor('leads')} />
        )}
      </div>
      {/* Informational limit boxes kept on their own row so they always pair
          up, regardless of how many usage meters render above. */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
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

// ── How credits work (per-action cost reference) ─────────────────────────────

/** One size bucket in a tiered action's expandable breakdown. */
interface CreditCostTier {
  readonly label: string;
  readonly cost: number;
}

interface CreditCostRow {
  readonly icon: LucideIcon;
  readonly label: string;
  readonly detail: string;
  readonly cost: number;
  /**
   * When present, the row becomes expandable (chevron) and reveals a
   * size→credits table. The flat `cost` acts as the entry-tier floor shown on
   * the collapsed badge. Mirrors the backend
   * `credit_cost.document_upload_tiers` defaults (credit_service.py); max_words
   * is exclusive, so a 100-word doc lands in the 100–500 bucket.
   */
  readonly tiers?: readonly CreditCostTier[];
  /**
   * When set, the card's name gets a deep-link arrow that jumps to the agent
   * tab where this action is configured (e.g. crawl/upload live under
   * Knowledge; the enrichment toggles under Advanced). Omitted for actions
   * with nothing to configure, like the AI chat reply. Resolved against the
   * switcher-selected agent at render time.
   */
  readonly linkTab?: 'knowledge' | 'advanced';
  /**
   * Built but not launched yet — the card shows a muted "Coming soon" badge
   * instead of a credit price, and never charges (the super-admin
   * `feature.company_name_enabled` switch stays off until launch).
   */
  readonly comingSoon?: boolean;
  // No row sets this today — company lookup, the last one that did, has
  // launched. Kept because it is live machinery for the next metered feature
  // that ships dark, not dead code.
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
    icon: Globe,
    label: 'URL crawl',
    detail: 'Charged per page actually ingested into your knowledge base.',
    cost: 5,
    linkTab: 'knowledge',
  },
  {
    icon: FileText,
    label: 'Document upload',
    detail: 'Charged by document size. Refunded if a file fails to save.',
    cost: 5,
    linkTab: 'knowledge',
    // Ranges are stated to match the backend gate EXACTLY. `max_words` there
    // is exclusive (`word_count < cap`, credit_service.py), so the inclusive
    // phrasing these labels used to carry ("Up to 100 words", "100–500 words")
    // was wrong at every boundary — and wrong in the direction that
    // overcharges. Verified against the live function:
    //     100 words   → advertised 5,  charged 15   (3x)
    //     500 words   → advertised 15, charged 30
    //   2,000 words   → advertised 30, charged 75
    //  10,000 words   → advertised 75, charged 150
    // Keep these upper bounds one below the config's `max_words` values.
    tiers: [
      { label: 'Under 100 words', cost: 5 },
      { label: '100–499 words', cost: 15 },
      { label: '500–1,999 words', cost: 30 },
      { label: '2,000–9,999 words', cost: 75 },
      { label: '10,000+ words', cost: 150 },
    ],
  },
  {
    icon: MailCheck,
    label: 'Email verification',
    detail: 'Verifies a captured lead’s email. Standard & Professional plans.',
    cost: 10,
    linkTab: 'advanced',
  },
  {
    icon: Building2,
    label: 'Company lookup',
    // States the charge condition, because it is unusual and in the customer's
    // favour: an IP only names a company when that company owns its range, so
    // most visitors — anyone on a home or mobile connection — resolve to no
    // employer at all. Those cost nothing. Saying only "10 credits" would read
    // as 10 per visitor, which is what it would have been had the charge stayed
    // ahead of the lookup.
    detail: 'Identifies a visitor’s company from their IP. Charged only when a company is found. Professional plan.',
    cost: 10,
    linkTab: 'advanced',
  },
];

/** Format a credit amount for a badge/row ("1 credit" / "30 credits"). */
function formatCreditCost(cost: number): string {
  return cost === 1 ? '1 credit' : `${cost} credits`;
}

/**
 * A single cost card. Flat rows render statically; a row carrying `tiers`
 * becomes expandable — a chevron toggles a size→credits table, and the badge
 * shows the full span (e.g. "5–150 credits") so the range is legible before
 * expanding.
 */
function CreditCostItem({
  row,
  agentBasePath,
  agentName,
}: {
  row: CreditCostRow;
  /** `/agents/:id` for the switcher-selected agent, or null when the account
   *  has no agent yet — the deep-link arrow is hidden in that case. */
  agentBasePath: string | null;
  /** Name of the agent the arrow resolves to; null when no single agent is in
   *  scope, in which case no arrow is shown. */
  agentName: string | null;
}): ReactElement {
  const [expanded, setExpanded] = useState(false);
  const Icon = row.icon;
  // A "coming soon" row is inert — no expandable tiers, no live price.
  const tiers = row.comingSoon ? undefined : row.tiers;
  const badge =
    tiers && tiers.length > 0
      ? `${tiers[0].cost}–${tiers[tiers.length - 1].cost} credits`
      : formatCreditCost(row.cost);

  return (
    // `relative` so the expanded tier list can float as an absolute dropdown —
    // it must NOT reflow the grid, or opening one card shoves the cards in the
    // next row down. `z-20` lifts the open panel above sibling cards.
    <div
      className={cn(
        'relative flex items-start gap-3 rounded-xl border border-[var(--ds-border)] bg-[var(--ds-bg-surface)] p-4 shadow-[var(--ds-shadow-sm)]',
        expanded && 'z-20',
      )}
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--ds-bg-sunken)] text-[var(--ds-text-subtle)]">
        <Icon size={16} aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="inline-flex min-w-0 items-center gap-1.5">
            <span className="truncate text-[13px] font-semibold text-[var(--ds-text)]">
              {row.label}
            </span>
            {row.linkTab && agentBasePath && (
              <Link
                to={`${agentBasePath}/${row.linkTab}`}
                // The agent is NAMED in both labels: this is a per-agent
                // setting reached from a workspace-level page, so "configure
                // this" alone left the customer no way to know which ledger
                // they were about to start spending from.
                aria-label={`Open ${
                  row.linkTab === 'knowledge' ? 'Knowledge' : 'Advanced settings'
                } for ${agentName ?? 'this agent'} to configure this`}
                title={`Open ${
                  row.linkTab === 'knowledge' ? 'Knowledge' : 'Advanced settings'
                } for ${agentName ?? 'this agent'}`}
                className="shrink-0 text-[var(--ds-text-subtle)] transition-colors hover:text-[var(--ds-accent-text)] focus-visible:text-[var(--ds-accent-text)] focus-visible:outline-none"
              >
                <ArrowUpRight size={14} aria-hidden="true" />
              </Link>
            )}
          </span>
          {row.comingSoon ? (
            <span className="shrink-0 rounded-md border border-[var(--ds-border)] bg-transparent px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--ds-text-subtle)]">
              Coming soon
            </span>
          ) : (
            <span className="shrink-0 rounded-md bg-[var(--ds-bg-sunken)] px-2 py-0.5 text-[12px] font-semibold tabular-nums text-[var(--ds-text)]">
              {badge}
            </span>
          )}
        </div>
        <p className="mt-1 text-[12px] leading-relaxed text-[var(--ds-text-subtle)]">{row.detail}</p>
        {tiers && tiers.length > 0 && (
          <button
            type="button"
            onClick={() => setExpanded((prev) => !prev)}
            aria-expanded={expanded}
            className="mt-2 inline-flex items-center gap-1 text-[12px] font-medium text-[var(--ds-accent-text)] hover:underline focus-visible:underline focus-visible:outline-none"
          >
            {expanded ? 'Hide size ranges' : 'See size ranges'}
            <ChevronDown
              size={14}
              aria-hidden="true"
              className={cn('transition-transform duration-200', expanded && 'rotate-180')}
            />
          </button>
        )}
      </div>
      {tiers && tiers.length > 0 && expanded && (
        <ul className="absolute left-3 right-3 top-full z-20 mt-1.5 space-y-1.5 rounded-xl border border-[var(--ds-border)] bg-[var(--ds-bg-surface)] p-3 shadow-[var(--ds-shadow-lg)]">
          {tiers.map((tier) => (
            <li key={tier.label} className="flex items-center justify-between gap-2 text-[12px]">
              <span className="text-[var(--ds-text-muted)]">{tier.label}</span>
              <span className="shrink-0 font-semibold tabular-nums text-[var(--ds-text)]">
                {formatCreditCost(tier.cost)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * CreditCostReference - a compact "what each action costs" card. Lives on the
 * Usage page because it's about consumption, giving the metered activity tiles
 * above their price context.
 */
function CreditCostReference(): ReactElement {
  // Deep links resolve ONLY against the switcher-selected agent. These rows
  // link to per-agent spend controls, and billing attaches to the Bot — so
  // falling back to `bots[0]` when the scope is "All agents" pointed a customer
  // at an agent they had not chosen, with nothing on screen saying which. They
  // would switch enrichment on there, start metered spend on that agent's
  // ledger, and believe it was live on the one capturing their leads.
  //
  // With no single agent in scope the arrow is withheld and the row says which
  // agent to pick, which is honest about the fact that this is a per-agent
  // setting. Null also covers an account with no agents at all.
  const { selectedBot } = useBotContext();
  const agentBasePath = selectedBot ? `/agents/${selectedBot.id}` : null;
  const agentName = selectedBot?.name ?? null;

  return (
    <section aria-label="How credits work" className="space-y-4">
      <SectionHeader
        title="How credits work"
        description="What each action costs from your credit balance."
      />
      <div className="grid grid-cols-1 items-start gap-3 sm:grid-cols-3">
        {CREDIT_COSTS.map((row) => (
          <CreditCostItem
            key={row.label}
            row={row}
            agentBasePath={agentBasePath}
            agentName={agentName}
          />
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
function RecentTopups({
  rows,
  balance,
}: {
  rows: LedgerRow[];
  balance: CreditBalance | null;
}): ReactElement | null {
  const purchases = useMemo(() => rows.filter(isPurchasedTopup).slice(0, 5), [rows]);
  if (purchases.length === 0) return null;

  // This said "Top-up credits never expire" unconditionally, on the same
  // screen as a hero that shows the real expiry date when there is one — the
  // exact self-contradiction. (It previously said "roll over for 12 months",
  // and an earlier fix here swapped one unconditional claim for another.)
  // `describeTopupExpiry` states only what this customer's own ledger proves,
  // and says nothing when it proves nothing.
  const expiryNote = balance ? describeTopupExpiry(balance) : null;

  return (
    <section aria-label="Recent top-ups" className="space-y-4">
      <SectionHeader
        title="Recent top-ups"
        description={`Your latest credit purchases.${expiryNote ? ` ${expiryNote}` : ''}`}
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
  const { hasFeature } = useEntitlements();
  const { openUpgradeModal } = useUpgradeModal();
  // Top-up packs are a paid feature. Free workspaces get an upgrade nudge
  // instead of the buy modal (the backend rejects the purchase anyway).
  const canTopup = hasFeature('topup_allowed');
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
            emailVerification: balance.emailVerification,
            companyName: balance.companyName,
          }
        : {
            aiChat: emptyBucket,
            documentUpload: emptyBucket,
            urlScan: emptyBucket,
            emailSend: emptyBucket,
            emailVerification: emptyBucket,
            companyName: emptyBucket,
          };
  // `null` = closed. A target carries the pool the top-up is scoped to: the
  // shared account balance (`botId: null`) or one agent's isolated balance.
  const navigate = useNavigate();
  const [topupTarget, setTopupTarget] = useState<TopupTarget | null>(null);
  // Single top-up chokepoint for every "Buy credits" affordance (page action +
  // the per-pool heroes). On a paid plan it opens the scoped top-up modal; on
  // Free it opens the upgrade modal instead of the buy flow.
  const handleTopup = (target: TopupTarget): void => {
    if (canTopup) {
      setTopupTarget(target);
    } else {
      openUpgradeModal('topup_credits');
    }
  };
  // The page-level "Buy credits" tops up the current scope: the selected agent's
  // pool when one is active, otherwise the shared account balance.
  const openScopedTopup = (): void =>
    handleTopup(
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
              onTopup={handleTopup}
            />
          ) : phase.balance.botCredits.length > 0 ? (
            <BotCreditsSection
              pools={[
                ...(phase.balance.accountPool ? [phase.balance.accountPool] : []),
                ...phase.balance.botCredits,
              ]}
              onTopup={handleTopup}
            />
          ) : (
            <AgentCreditHero
              pool={aggregatePool(phase.balance)}
              agentName="All agents"
              onTopup={handleTopup}
            />
          )}

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
          {phase.ledger.status === 'ready' && <RecentTopups rows={phase.ledger.rows} balance={balance} />}

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
        // Usage has no billing-details form of its own — the Billing page owns
        // it, so send the customer there to complete the hand-off.
        onBillingDetailsRequired={() => navigate('../billing')}
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
