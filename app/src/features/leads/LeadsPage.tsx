/**
 * LeadsPage - "Who are my qualified leads?"
 *
 * One job: surface the people who chatted with your AI, ranked by how ready
 * they are to buy, with a one-glance pipeline summary up top and a click-to-open
 * detail drawer. All qualification jargon is translated to plain language
 * (see {@link leadModel}); BANT/MQL only survives as a power-user tooltip.
 *
 * Data comes from the reused backend via {@link useLeads} (list + tier summary +
 * funnel) and {@link useLeadDetail} (drawer). Loading is derived from a status
 * enum, and every state - loading, empty, error, ready - is explained on screen.
 */
import { type ReactElement, useCallback, useMemo, useState } from 'react';
import {
  AlertCircle,
  Bell,
  ChevronRight,
  Download,
  Lock,
  MessageSquare,
  Users,
  X,
} from 'lucide-react';
import {
  Button,
  EmptyState,
  PageContainer,
  Select,
  Skeleton,
  cn,
} from '../../design-system';
// MetricCard + DataTable are Foundation-phase components not yet re-exported
// from the design-system barrel (the orchestrator wires those exports), so we
// import them from their module paths directly.
import { DataTable, type Column } from '../../design-system/components/DataTable';
import { useBotContext } from '../../context/BotContext';
import { useEntitlements } from '../../hooks/useEntitlements';
import { useUpgradeModal } from '../../context/UpgradeModalContext';
import { exportLeadsCsv, markAllLeadsViewed, markLeadViewed } from '../../services/api';
import { type Lead } from '../../types/domain';
import { useLeads } from './useLeads';
import { useLeadDetail } from './useLeadDetail';
import { useLeadAnnotations } from './useLeadAnnotations';
import { LeadDetailDrawer } from './LeadDetailDrawer';
import {
  type ContactFilter,
  type TierKey,
  TIER_META,
  TIER_ORDER,
  filterLeads,
  formatDateTime,
  humanizeDimension,
  leadDisplayName,
  leadInitials,
  normalizeTier,
} from './leadModel';

const CONTACT_FILTER_OPTIONS: ReadonlyArray<{ value: ContactFilter; label: string }> = [
  { value: 'named', label: 'Named leads' },
  { value: 'anonymous', label: 'Anonymous only' },
  { value: 'all', label: 'Everyone' },
];

/** How the lead table is ordered. Exposed via the "Sort by" control. */
const SORT_OPTIONS = [
  { value: 'recent', label: 'Latest activity' },
  { value: 'quality', label: 'BANT' },
] as const;
type SortKey = (typeof SORT_OPTIONS)[number]['value'];

/** Epoch ms of a lead's last activity; undated/invalid sinks to 0 so it sorts last. */
function leadActivityTime(lead: Lead): number {
  const parsed = lead.last_active_at ? Date.parse(lead.last_active_at) : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Comparator per sort key. Every option has a stable secondary tiebreak. */
function leadComparator(sortBy: SortKey): (a: Lead, b: Lead) => number {
  if (sortBy === 'quality') {
    return (a, b) =>
      TIER_ORDER.indexOf(normalizeTier(b.status)) - TIER_ORDER.indexOf(normalizeTier(a.status)) ||
      b.score - a.score;
  }
  // 'recent' (default): most recent chat first, higher score breaks ties.
  return (a, b) => leadActivityTime(b) - leadActivityTime(a) || b.score - a.score;
}

/** Escape one CSV field: quote it and double any embedded quotes (RFC 4180). */
function csvField(value: string | number | null | undefined): string {
  const raw = value === null || value === undefined ? '' : String(value);
  return `"${raw.replace(/"/g, '""')}"`;
}

/**
 * Build a CSV for a subset of leads entirely client-side. The server export
 * (`exportLeadsCsv`) only emits the full set, so "Export selected" assembles its
 * own file from the rows the user ticked - including their private tags.
 */
function buildSelectedLeadsCsv(leads: Lead[], tagsFor: (sessionId: string) => readonly string[]): string {
  const header = ['Name', 'Email', 'Phone', 'Company', 'Quality', 'Score', 'Location', 'Tags', 'Last active'];
  const rows = leads.map((lead) => {
    const tier = TIER_META[normalizeTier(lead.status)];
    return [
      csvField(lead.contact?.name),
      csvField(lead.contact?.email),
      csvField(lead.contact?.phone),
      csvField(lead.contact?.company),
      csvField(tier.label),
      csvField(lead.score),
      csvField(lead.location),
      csvField(tagsFor(lead.session_id).join('; ')),
      csvField(formatDateTime(lead.last_active_at)),
    ].join(',');
  });
  return [header.map(csvField).join(','), ...rows].join('\r\n');
}

/** Trigger a browser download of `content` as a UTF-8 CSV named `filename`. */
function downloadCsv(content: string, filename: string): void {
  // Lead with a UTF-8 BOM so Excel opens accented characters correctly.
  const blob = new Blob(['﻿', content], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

/**
 * Canonical B-A-N-T display order. The backend emits a bot's framework
 * dimensions in its own order (e.g. need/timeline/authority/budget); we surface
 * them in Budget → Authority → Need → Timeline order so the chips always read
 * "BANT". Dimensions outside this set (MEDDIC/CHAMP frameworks) sort after the
 * BANT four, keeping their original relative order (Array#sort is stable).
 */
const BANT_ORDER: readonly string[] = ['budget', 'authority', 'need', 'timeline'];

function bantOrderIndex(key: string): number {
  const index = BANT_ORDER.indexOf(key.toLowerCase());
  return index === -1 ? BANT_ORDER.length : index;
}

/**
 * BantSignal - the at-a-glance qualification cell: one small chip per framework
 * dimension (Budget / Authority / Need / Timeline for a BANT bot, or the bot's
 * real dimensions for MEDDIC/CHAMP). A chip turns green once that dimension is
 * "accepted" - i.e. the AI captured a positive signal for it (score > 0);
 * un-assessed dimensions stay a quiet neutral. This restores the "which boxes
 * has this lead ticked?" read the table used to give, in place of the single
 * plain-language quality pill (the tier still drives the top filters, the sort,
 * and the detail drawer's verdict).
 */
function BantSignal({ lead }: { lead: Lead }): ReactElement {
  const dimensions = Object.entries(lead.bant ?? {}).sort(
    ([a], [b]) => bantOrderIndex(a) - bantOrderIndex(b),
  );
  if (dimensions.length === 0) {
    return <span className="text-[12px] text-[var(--ds-text-subtle)]">-</span>;
  }
  return (
    <div className="flex items-center gap-1" role="group" aria-label="Qualification signals">
      {dimensions.map(([key, dim]) => {
        const accepted = (dim?.score ?? 0) > 0;
        const label = humanizeDimension(key);
        return (
          <span
            key={key}
            title={`${label}: ${dim?.value || 'Not captured'}`}
            aria-label={`${label}: ${accepted ? 'captured' : 'not captured'}`}
            className={cn(
              'flex h-5 w-5 items-center justify-center rounded text-[9px] font-bold uppercase',
              accepted
                ? 'bg-[var(--ds-success-soft)] text-[var(--ds-success)]'
                : 'bg-[var(--ds-bg-sunken)] text-[var(--ds-text-subtle)]',
            )}
          >
            {label.charAt(0)}
          </span>
        );
      })}
    </div>
  );
}

/**
 * LockedValue - a Free-plan stand-in for a paid lead-intelligence cell
 * (quality score, location). The column stays VISIBLE so Free users see the
 * feature exists; the value is replaced by a lock affordance that opens the
 * upgrade modal instead of the real data.
 */
function LockedValue({ onUpgrade }: { onUpgrade: () => void }): ReactElement {
  return (
    <button
      type="button"
      title="Upgrade to unlock"
      aria-label="Upgrade to unlock"
      onClick={(event) => {
        event.stopPropagation();
        onUpgrade();
      }}
      className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[12px] font-medium text-[var(--ds-text-subtle)] transition-colors hover:text-[var(--ds-accent-text)]"
    >
      <Lock size={12} aria-hidden="true" />
      Locked
    </button>
  );
}

/** The metric row; only shown once stats resolve. */
export function LeadsPage(): ReactElement {
  const { selectedBot, bots, loading: botsLoading } = useBotContext();
  const botId = selectedBot?.id;
  const { isFree, hasFeature } = useEntitlements();
  const bantUnlocked = hasFeature('bant');
  const { openUpgradeModal } = useUpgradeModal();

  // Free-plan workspaces never get the list - the backend's `/leads` route
  // 403s for them. `useLeads` takes `enabled: false` so it never issues that
  // doomed request; a Free user (including one who deep-links `/leads`) sees
  // the upgrade teaser below instead of a broken fetch.
  const {
    status,
    leads,
    stats,
    error,
    reload,
    markViewedLocal,
    markAllReadLocal,
  } = useLeads(botId);

  const annotations = useLeadAnnotations();

  const [tierFilter, setTierFilter] = useState<TierKey | null>(null);
  const [contactFilter, setContactFilter] = useState<ContactFilter>('all');
  const [query, setQuery] = useState('');
  const [sortBy, setSortBy] = useState<SortKey>('recent');

  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  // Which face the drawer opens on: the full lead profile ('detail', row click)
  // or the conversation only ('chat', the row's "View chat" button).
  const [drawerView, setDrawerView] = useState<'detail' | 'chat'>('detail');
  const detailData = useLeadDetail(selectedSessionId);

  // Bulk-select for "Export selected". Keyed by session id so a selection
  // survives re-sorts and filter changes; stale ids are simply never matched.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());

  const [isExporting, setIsExporting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // Filter, then order by the chosen sort key (default: most recent chat first).
  // filterLeads returns a fresh array, so sorting in place never mutates the
  // source `leads` state.
  const filtered = useMemo(
    () =>
      filterLeads(leads, { tier: tierFilter, contact: contactFilter, query }).sort(
        leadComparator(sortBy),
      ),
    [leads, tierFilter, contactFilter, query, sortBy],
  );

  const hasUnread = useMemo(() => leads.some((lead) => lead.unread === true), [leads]);

  const allFilteredSelected =
    filtered.length > 0 && filtered.every((lead) => selectedIds.has(lead.session_id));

  const toggleSelect = useCallback((sessionId: string): void => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });
  }, []);

  const toggleSelectAll = useCallback((): void => {
    setSelectedIds((prev) => {
      const everySelected =
        filtered.length > 0 && filtered.every((lead) => prev.has(lead.session_id));
      if (everySelected) return new Set();
      return new Set(filtered.map((lead) => lead.session_id));
    });
  }, [filtered]);

  const clearSelection = useCallback((): void => setSelectedIds(new Set()), []);

  const handleExportSelected = useCallback((): void => {
    const chosen = leads.filter((lead) => selectedIds.has(lead.session_id));
    if (chosen.length === 0) return;
    const csv = buildSelectedLeadsCsv(chosen, annotations.tagsFor);
    downloadCsv(csv, `selected-leads-${chosen.length}.csv`);
    setSelectedIds(new Set());
  }, [leads, selectedIds, annotations]);

  const markSeen = useCallback(
    (lead: Lead): void => {
      if (lead.unread) {
        markViewedLocal(lead.session_id);
        // Fire-and-forget: the badge already updated optimistically.
        void markLeadViewed(lead.session_id).catch(() => undefined);
      }
    },
    [markViewedLocal],
  );

  // Row click → full lead profile (no transcript). "View chat" → transcript only.
  // On plans without BANT (Free / Starter) the detail drawer's core value —
  // dimension breakdown, signal evidence, tier verdict — is empty, so we
  // route the click to the qualification upgrade modal instead of opening
  // a hollow drawer. The "View chat" button (`openChat`) stays wired so
  // Starter can still reach the transcript, which is not gated.
  const openLead = useCallback(
    (lead: Lead): void => {
      if (!bantUnlocked) {
        openUpgradeModal('view_qualification');
        return;
      }
      setDrawerView('detail');
      setSelectedSessionId(lead.session_id);
      markSeen(lead);
    },
    [bantUnlocked, openUpgradeModal, markSeen],
  );

  const openChat = useCallback(
    (lead: Lead): void => {
      setDrawerView('chat');
      setSelectedSessionId(lead.session_id);
      markSeen(lead);
    },
    [markSeen],
  );

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
    () => {
      const all: Column<Lead>[] = [
      {
        key: 'select',
        header: (
          <input
            type="checkbox"
            checked={allFilteredSelected}
            onChange={toggleSelectAll}
            aria-label="Select all leads in view"
            className="h-4 w-4 cursor-pointer accent-[var(--ds-accent)] align-middle"
          />
        ),
        width: '2.5rem',
        cellClassName: 'py-0',
        render: (lead) => (
          <input
            type="checkbox"
            checked={selectedIds.has(lead.session_id)}
            onChange={() => toggleSelect(lead.session_id)}
            onClick={(event) => event.stopPropagation()}
            aria-label={`Select ${leadDisplayName(lead)}`}
            className="h-4 w-4 cursor-pointer accent-[var(--ds-accent)] align-middle"
          />
        ),
      },
      {
        key: 'contact',
        header: 'Lead',
        render: (lead) => {
          const tags = annotations.tagsFor(lead.session_id);
          return (
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
                {tags.length > 0 && (
                  <ul className="mt-1 flex flex-wrap gap-1" aria-label="Tags">
                    {tags.slice(0, 3).map((tag) => (
                      <li
                        key={tag}
                        className="inline-flex max-w-[8rem] items-center truncate rounded-full bg-[var(--ds-accent-soft)] px-2 py-0.5 text-[10px] font-medium text-[var(--ds-accent-text)]"
                      >
                        {tag}
                      </li>
                    ))}
                    {tags.length > 3 && (
                      <li className="inline-flex items-center text-[10px] font-medium text-[var(--ds-text-subtle)]">
                        +{tags.length - 3}
                      </li>
                    )}
                  </ul>
                )}
              </div>
            </div>
          );
        },
      },
      {
        key: 'status',
        header: <span className="text-[var(--ds-success)]">BANT</span>,
        // BANT scoring is a Standard+ feature (`hasFeature('bant')`). On Free
        // AND Starter the RAG pipeline skips extraction, so the dimension
        // pills would render as four blank neutrals — worse than an honest
        // lock. Route the click straight to the qualification upgrade.
        render: (lead) =>
          !bantUnlocked ? (
            <LockedValue onUpgrade={() => openUpgradeModal('view_qualification')} />
          ) : (
            <BantSignal lead={lead} />
          ),
      },
      {
        key: 'view_chat',
        header: 'Chat',
        render: (lead) => (
          <button
            type="button"
            onClick={(event) => {
              // Stop the row's onRowClick from double-firing; the button opens
              // the same lead drawer (which carries the full chat transcript).
              event.stopPropagation();
              openChat(lead);
            }}
            className="inline-flex items-center gap-1.5 rounded-md border border-[var(--ds-border)] px-2.5 py-1 text-[12px] font-medium text-[var(--ds-text-muted)] transition-colors hover:border-[var(--ds-border-strong)] hover:text-[var(--ds-text)]"
          >
            <MessageSquare size={13} aria-hidden="true" />
            View chat
          </button>
        ),
      },
      {
        key: 'location',
        header: 'Location',
        render: (lead) =>
          isFree ? (
            <LockedValue onUpgrade={() => openUpgradeModal('view_leads')} />
          ) : (
            <span className="text-[12px] text-[var(--ds-text-muted)]">{lead.location || '-'}</span>
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
      ];
      // Free tier keeps every column VISIBLE — the Quality/Location cells
      // render a locked affordance (see their `render`), and the row opens a
      // locked lead-detail drawer. Nothing is hidden; the paid bits are gated.
      return all;
    },
    [
      allFilteredSelected,
      selectedIds,
      toggleSelect,
      toggleSelectAll,
      annotations,
      openChat,
      isFree,
      bantUnlocked,
      openUpgradeModal,
    ],
  );

  // ── Guards ────────────────────────────────────────────────────────────────
  // Free plan now reaches Leads too, with a reduced surface: the list hides the
  // quality/location columns (see `columns`) and rows open the conversation
  // (`openChat`) instead of the full lead-intelligence drawer.
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
          description="Create your first AI chatbot and add it to your site. Every visitor who chats becomes a lead here - ranked by how ready they are to buy."
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
      {/* Export ignores the active table filters - it always emits the full
          server-side lead set for the agent, so the label says so explicitly. */}
      {isExporting ? 'Exporting…' : 'Export all leads'}
    </Button>
  );

  return (
    <PageContainer
      title="Leads"
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
              {TIER_ORDER.map((key) => {
                // Without BANT (Free / Starter) the whole tier axis is moot:
                // no lead is ever scored, so every chip either shows the
                // full list or an empty list. Lock all four and route to the
                // qualification upgrade modal so the row honestly reads as
                // "not on this plan" instead of a broken filter.
                const locked = !bantUnlocked;
                const active = tierFilter === key;
                return (
                  <button
                    key={key}
                    type="button"
                    aria-pressed={active}
                    aria-disabled={locked || undefined}
                    onClick={() =>
                      locked
                        ? openUpgradeModal('view_qualification')
                        : setTierFilter(active ? null : key)
                    }
                    className={cn(
                      'inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-medium transition-colors',
                      active && !locked
                        ? 'bg-[var(--ds-accent-soft)] text-[var(--ds-accent-text)]'
                        : locked
                          ? 'text-[var(--ds-text-subtle)] hover:bg-[var(--ds-bg-hover)] hover:text-[var(--ds-text-muted)]'
                          : 'text-[var(--ds-text-muted)] hover:bg-[var(--ds-bg-hover)]',
                    )}
                  >
                    {locked && (
                      <Lock size={11} strokeWidth={1.75} aria-hidden="true" />
                    )}
                    {TIER_META[key].label}
                  </button>
                );
              })}
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
                Filter by lead type
              </label>
              <Select
                id="lead-contact-filter"
                value={contactFilter}
                onChange={(next) => setContactFilter(next as ContactFilter)}
                className="h-9 w-auto shrink-0 text-[13px]"
                options={CONTACT_FILTER_OPTIONS.map((option) => ({
                  value: option.value,
                  label: option.label,
                }))}
              />
              <label htmlFor="lead-sort" className="sr-only">
                Sort leads by
              </label>
              <Select
                id="lead-sort"
                value={sortBy}
                onChange={(next) => setSortBy(next as SortKey)}
                className="h-9 w-auto shrink-0 text-[13px]"
                options={SORT_OPTIONS.map((option) => ({
                  value: option.value,
                  label: option.label,
                }))}
              />
            </div>
          </div>

          {/* Result count - makes any active filter visible so a narrowed
              table never reads as data loss against the headline totals. */}
          <p className="text-[12px] text-[var(--ds-text-subtle)]" aria-live="polite">
            {filtered.length === leads.length
              ? `${leads.length.toLocaleString()} ${leads.length === 1 ? 'lead' : 'leads'}`
              : `Showing ${filtered.length.toLocaleString()} of ${leads.length.toLocaleString()} leads`}
          </p>

          {/* Bulk-action bar - appears only with a live selection. Exports the
              ticked rows to a CSV built client-side (tags included). */}
          {selectedIds.size > 0 && (
            <div className="flex flex-wrap items-center gap-3 rounded-lg border border-[var(--ds-accent)] bg-[var(--ds-accent-soft)] px-4 py-2.5">
              <span className="text-[13px] font-medium text-[var(--ds-accent-text)]">
                {selectedIds.size} selected
              </span>
              <div className="ml-auto flex items-center gap-2">
                <Button variant="outline" size="sm" onClick={handleExportSelected}>
                  <Download size={15} aria-hidden="true" />
                  Export selected
                </Button>
                <Button variant="ghost" size="sm" onClick={clearSelection}>
                  <X size={15} aria-hidden="true" />
                  Clear
                </Button>
              </div>
            </div>
          )}

          {/* Table */}
          <DataTable
            columns={columns}
            rows={filtered}
            rowKey={(lead) => lead.session_id}
            caption="Leads captured by your AI chatbots"
            pageSize={20}
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
        <LeadDetailDrawer
          data={detailData}
          view={drawerView}
          locked={isFree}
          onClose={() => setSelectedSessionId(null)}
          annotations={annotations.controllerFor(selectedSessionId)}
        />
      )}
    </PageContainer>
  );
}
