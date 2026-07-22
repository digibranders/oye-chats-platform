/**
 * LeadsPage — "Who are my qualified leads?"
 *
 * One job: surface the people who chatted with your AI, ranked by how ready
 * they are to buy, with a one-glance pipeline summary up top and a click-to-open
 * detail drawer. All qualification jargon is translated to plain language
 * (see {@link leadModel}); BANT/MQL only survives as a power-user tooltip.
 *
 * Data comes from the reused backend via {@link useLeads} (list + tier summary +
 * funnel) and {@link useLeadDetail} (drawer). Loading is derived from a status
 * enum, and every state — loading, empty, error, ready — is explained on screen.
 */
import { type ReactElement, useMemo, useState } from 'react';
import {
  AlertCircle,
  BadgeCheck,
  Bell,
  ChevronRight,
  Download,
  Gauge,
  Trophy,
  Users,
} from 'lucide-react';
import { Button, EmptyState, PageContainer, Skeleton, StatusBadge, cn } from '../../design-system';
// MetricCard + DataTable are Foundation-phase components not yet re-exported
// from the design-system barrel (the orchestrator wires those exports), so we
// import them from their module paths directly.
import { MetricCard } from '../../design-system/components/MetricCard';
import { DataTable, type Column } from '../../design-system/components/DataTable';
import { useBotContext } from '../../context/BotContext';
import { exportLeadsCsv, markAllLeadsViewed, markLeadViewed } from '../../services/api';
import { type Lead } from '../../types/domain';
import { useLeads } from './useLeads';
import { useLeadDetail } from './useLeadDetail';
import { LeadDetailDrawer } from './LeadDetailDrawer';
import {
  type ContactFilter,
  type TierKey,
  SCORE_TONE_VAR,
  TIER_META,
  TIER_ORDER,
  filterLeads,
  formatDateTime,
  funnelHasData,
  leadDisplayName,
  leadInitials,
  normalizeTier,
  scoreTone,
} from './leadModel';
import type { FunnelStageView, LeadStatsSummary } from './leadModel';

const CONTACT_FILTER_OPTIONS: ReadonlyArray<{ value: ContactFilter; label: string }> = [
  { value: 'named', label: 'Named contacts' },
  { value: 'anonymous', label: 'Anonymous only' },
  { value: 'all', label: 'Everyone' },
];

/** Small, self-contained left-to-right funnel summary. */
function FunnelSummary({ stages }: { stages: FunnelStageView[] }): ReactElement {
  return (
    <ol className="space-y-2.5">
      {stages.map((stage) => (
        <li key={stage.key} className="flex items-center gap-3">
          <div className="w-32 shrink-0">
            <p className="text-[13px] font-medium text-[var(--ds-text)]">{stage.label}</p>
            <p className="text-[11px] text-[var(--ds-text-subtle)]">{stage.sublabel}</p>
          </div>
          <div className="relative h-7 flex-1">
            <div className="absolute inset-0 rounded-md bg-[var(--ds-bg-sunken)]" />
            {stage.count > 0 && (
              <div
                className="absolute inset-y-0 left-0 flex items-center rounded-md bg-[var(--ds-accent-soft)] px-2"
                style={{ width: `${stage.widthPct}%` }}
              >
                <span className="text-[12px] font-semibold tabular-nums text-[var(--ds-accent-text)]">
                  {stage.count.toLocaleString()}
                </span>
              </div>
            )}
          </div>
          <div className="w-16 shrink-0 text-right">
            {stage.conversionFromPrev !== null ? (
              <span className="text-[12px] font-semibold tabular-nums text-[var(--ds-text-muted)]">
                {stage.conversionFromPrev.toFixed(0)}%
              </span>
            ) : (
              <span className="text-[11px] uppercase tracking-wide text-[var(--ds-text-subtle)]">
                Top
              </span>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}

/** The quality pill cell, shared by the table. */
function QualityCell({ lead }: { lead: Lead }): ReactElement {
  const tier = TIER_META[normalizeTier(lead.status)];
  // The plain-language label carries the meaning on its own; we deliberately
  // avoid a hover-only native `title` (not keyboard-focusable, announced
  // inconsistently by screen readers).
  return <StatusBadge tone={tier.tone}>{tier.label}</StatusBadge>;
}

function ScoreCell({ score }: { score: number }): ReactElement {
  const clamped = Math.max(0, Math.min(100, score));
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-[var(--ds-bg-sunken)]">
        <div
          className="h-full rounded-full"
          style={{ width: `${clamped}%`, backgroundColor: SCORE_TONE_VAR[scoreTone(clamped)] }}
        />
      </div>
      <span className="text-[12px] font-semibold tabular-nums text-[var(--ds-text-muted)]">
        {clamped}
      </span>
    </div>
  );
}

/** The metric row + funnel summary; only shown once stats resolve. */
function LeadsOverview({
  stats,
  funnel,
}: {
  stats: LeadStatsSummary;
  funnel: FunnelStageView[];
}): ReactElement {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <MetricCard label="Total leads" value={stats.total.toLocaleString()} icon={Users} />
        <MetricCard
          label="Qualified"
          value={stats.qualified.toLocaleString()}
          icon={BadgeCheck}
        />
        <MetricCard label="Ready to buy" value={stats.sql.toLocaleString()} icon={Trophy} />
        <MetricCard label="Avg. score" value={`${stats.avgScore}`} icon={Gauge} />
      </div>

      {funnelHasData(funnel) && (
        <section className="rounded-xl border border-[var(--ds-border)] bg-[var(--ds-bg-surface)] p-5 shadow-[var(--ds-shadow-sm)]">
          <div className="mb-4">
            <h2 className="text-[14px] font-semibold text-[var(--ds-text)]">
              How visitors become buyers
            </h2>
            <p className="text-[12px] text-[var(--ds-text-muted)]">
              Where people drop off on the way from a first visit to a booked call · last 30 days
            </p>
          </div>
          <FunnelSummary stages={funnel} />
        </section>
      )}
    </div>
  );
}

export function LeadsPage(): ReactElement {
  const { selectedBot, bots, loading: botsLoading } = useBotContext();
  const botId = selectedBot?.id;

  const { status, leads, stats, funnel, error, reload, markViewedLocal, markAllReadLocal } =
    useLeads(botId);

  const [tierFilter, setTierFilter] = useState<TierKey | null>(null);
  const [contactFilter, setContactFilter] = useState<ContactFilter>('all');
  const [query, setQuery] = useState('');

  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const detailData = useLeadDetail(selectedSessionId);

  const [isExporting, setIsExporting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // Sort by readiness so the list matches the page's promise ("sorted by how
  // ready they are to buy"): hottest tier first, then higher score. The reused
  // backend orders by recency, so we rank client-side. filterLeads returns a
  // fresh array, so sorting in place never mutates the source `leads` state.
  const filtered = useMemo(
    () =>
      filterLeads(leads, { tier: tierFilter, contact: contactFilter, query }).sort(
        (a, b) =>
          TIER_ORDER.indexOf(normalizeTier(b.status)) -
            TIER_ORDER.indexOf(normalizeTier(a.status)) || b.score - a.score,
      ),
    [leads, tierFilter, contactFilter, query],
  );

  const hasUnread = useMemo(() => leads.some((lead) => lead.unread === true), [leads]);

  function openLead(lead: Lead): void {
    setSelectedSessionId(lead.session_id);
    if (lead.unread) {
      markViewedLocal(lead.session_id);
      // Fire-and-forget: the badge already updated optimistically.
      void markLeadViewed(lead.session_id).catch(() => undefined);
    }
  }

  async function handleExport(): Promise<void> {
    setIsExporting(true);
    setActionError(null);
    try {
      await exportLeadsCsv(botId);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Export failed. Please try again.');
    } finally {
      setIsExporting(false);
    }
  }

  async function handleMarkAllRead(): Promise<void> {
    if (!hasUnread) return;
    markAllReadLocal();
    setActionError(null);
    try {
      await markAllLeadsViewed(botId);
    } catch (err) {
      setActionError(
        err instanceof Error ? err.message : 'Could not mark leads as read. Refreshing…',
      );
      reload();
    }
  }

  const columns: Column<Lead>[] = useMemo(
    () => [
      {
        key: 'contact',
        header: 'Contact',
        render: (lead) => (
          <div className="flex items-center gap-3">
            <span
              aria-hidden="true"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--ds-bg-sunken)] text-[11px] font-semibold text-[var(--ds-text-muted)]"
            >
              {leadInitials(lead)}
            </span>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                {lead.unread && (
                  <span
                    className="h-2 w-2 shrink-0 rounded-full bg-[var(--ds-accent)]"
                    aria-label="New lead"
                  />
                )}
                <span
                  className={cn(
                    'truncate text-[13px]',
                    lead.unread ? 'font-semibold text-[var(--ds-text)]' : 'text-[var(--ds-text)]',
                  )}
                >
                  {leadDisplayName(lead)}
                </span>
              </div>
              {lead.contact?.email && (
                <p className="truncate text-[12px] text-[var(--ds-text-subtle)]">
                  {lead.contact.email}
                </p>
              )}
            </div>
          </div>
        ),
      },
      {
        key: 'status',
        header: 'Quality',
        render: (lead) => <QualityCell lead={lead} />,
      },
      {
        key: 'score',
        header: 'Score',
        render: (lead) => <ScoreCell score={lead.score} />,
      },
      {
        key: 'location',
        header: 'Location',
        render: (lead) => (
          <span className="text-[12px] text-[var(--ds-text-muted)]">{lead.location || '—'}</span>
        ),
      },
      {
        key: 'last_active_at',
        header: 'Last active',
        render: (lead) => (
          <span className="whitespace-nowrap text-[12px] text-[var(--ds-text-subtle)]">
            {formatDateTime(lead.last_active_at)}
          </span>
        ),
      },
      {
        key: 'session_id',
        header: '',
        align: 'right',
        width: '3rem',
        render: () => (
          <ChevronRight
            size={16}
            className="text-[var(--ds-text-subtle)]"
            aria-hidden="true"
          />
        ),
      },
    ],
    [],
  );

  // ── Guards ────────────────────────────────────────────────────────────────
  if (botsLoading && bots.length === 0) {
    return (
      <PageContainer title="Leads">
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </div>
        <Skeleton className="h-64 w-full" />
      </PageContainer>
    );
  }

  if (!botsLoading && bots.length === 0) {
    return (
      <PageContainer title="Leads">
        <EmptyState
          icon={Users}
          title="No leads yet"
          description="Create your first AI agent and add it to your site. Every visitor who chats becomes a lead here — ranked by how ready they are to buy."
        />
      </PageContainer>
    );
  }

  const exportAction = (
    <Button
      variant="outline"
      onClick={() => void handleExport()}
      disabled={isExporting || leads.length === 0}
    >
      <Download size={16} aria-hidden="true" />
      {/* Export ignores the active table filters — it always emits the full
          server-side lead set for the agent, so the label says so explicitly. */}
      {isExporting ? 'Exporting…' : 'Export all leads'}
    </Button>
  );

  return (
    <PageContainer
      title="Leads"
      description="The people who talked to your AI — sorted by how ready they are to buy."
      actions={
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={() => void handleMarkAllRead()} disabled={!hasUnread}>
            <Bell size={16} aria-hidden="true" />
            Mark all read
          </Button>
          {exportAction}
        </div>
      }
    >
      {actionError && (
        <div
          role="alert"
          className="flex items-center gap-2 rounded-lg border border-[var(--ds-danger)] bg-[var(--ds-danger-soft)] px-4 py-3 text-[13px] text-[var(--ds-danger)]"
        >
          <AlertCircle size={16} aria-hidden="true" />
          {actionError}
        </div>
      )}

      {status === 'loading' && (
        <>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-24 w-full" />
            ))}
          </div>
          <Skeleton className="h-72 w-full" />
        </>
      )}

      {status === 'error' && (
        <EmptyState
          icon={AlertCircle}
          title="We couldn't load your leads"
          description={error ?? 'Something went wrong. Please try again.'}
          action={
            <Button variant="outline" onClick={reload}>
              Try again
            </Button>
          }
        />
      )}

      {status === 'ready' && stats && (
        <>
          <LeadsOverview stats={stats} funnel={funnel} />

          {/* Filters */}
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <div
              role="group"
              aria-label="Filter by lead quality"
              className="flex flex-wrap items-center gap-1.5"
            >
              <button
                type="button"
                aria-pressed={tierFilter === null}
                onClick={() => setTierFilter(null)}
                className={cn(
                  'rounded-full px-3 py-1.5 text-[12px] font-medium transition-colors',
                  tierFilter === null
                    ? 'bg-[var(--ds-accent-soft)] text-[var(--ds-accent-text)]'
                    : 'text-[var(--ds-text-muted)] hover:bg-[var(--ds-bg-hover)]',
                )}
              >
                All
              </button>
              {TIER_ORDER.map((key) => (
                <button
                  key={key}
                  type="button"
                  aria-pressed={tierFilter === key}
                  onClick={() => setTierFilter(tierFilter === key ? null : key)}
                  className={cn(
                    'rounded-full px-3 py-1.5 text-[12px] font-medium transition-colors',
                    tierFilter === key
                      ? 'bg-[var(--ds-accent-soft)] text-[var(--ds-accent-text)]'
                      : 'text-[var(--ds-text-muted)] hover:bg-[var(--ds-bg-hover)]',
                  )}
                >
                  {TIER_META[key].label}
                </button>
              ))}
            </div>

            <div className="flex flex-1 items-center gap-2 sm:justify-end">
              <label htmlFor="lead-search" className="sr-only">
                Search leads
              </label>
              <input
                id="lead-search"
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search name, email, company…"
                className="h-9 w-full rounded-lg border border-[var(--ds-border)] bg-[var(--ds-bg-surface)] px-3 text-[13px] text-[var(--ds-text)] outline-none transition-colors placeholder:text-[var(--ds-text-subtle)] focus-visible:border-[var(--ds-accent)] focus-visible:shadow-[0_0_0_1px_var(--ds-ring)] sm:max-w-xs"
              />
              <label htmlFor="lead-contact-filter" className="sr-only">
                Filter by contact type
              </label>
              <select
                id="lead-contact-filter"
                value={contactFilter}
                onChange={(event) => setContactFilter(event.target.value as ContactFilter)}
                className="h-9 shrink-0 rounded-lg border border-[var(--ds-border)] bg-[var(--ds-bg-surface)] px-3 text-[13px] text-[var(--ds-text)] outline-none focus-visible:border-[var(--ds-accent)] focus-visible:shadow-[0_0_0_1px_var(--ds-ring)]"
              >
                {CONTACT_FILTER_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Result count — makes any active filter visible so a narrowed
              table never reads as data loss against the headline totals. */}
          <p className="text-[12px] text-[var(--ds-text-subtle)]" aria-live="polite">
            {filtered.length === leads.length
              ? `${leads.length.toLocaleString()} ${leads.length === 1 ? 'lead' : 'leads'}`
              : `Showing ${filtered.length.toLocaleString()} of ${leads.length.toLocaleString()} leads`}
          </p>

          {/* Table */}
          <DataTable
            columns={columns}
            rows={filtered}
            rowKey={(lead) => lead.session_id}
            caption="Leads captured by your AI agents"
            onRowClick={openLead}
            empty={
              leads.length === 0 ? (
                <div className="space-y-1 py-6">
                  <p className="text-[14px] font-medium text-[var(--ds-text)]">No leads yet</p>
                  <p className="text-[13px] text-[var(--ds-text-muted)]">
                    As soon as visitors start chatting with your AI, they'll show up here.
                  </p>
                </div>
              ) : (
                <div className="space-y-2 py-6">
                  <p className="text-[13px] text-[var(--ds-text-muted)]">
                    No leads match these filters.
                  </p>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setTierFilter(null);
                      setContactFilter('all');
                      setQuery('');
                    }}
                  >
                    Clear filters
                  </Button>
                </div>
              )
            }
          />
        </>
      )}

      {selectedSessionId !== null && (
        <LeadDetailDrawer data={detailData} onClose={() => setSelectedSessionId(null)} />
      )}
    </PageContainer>
  );
}
