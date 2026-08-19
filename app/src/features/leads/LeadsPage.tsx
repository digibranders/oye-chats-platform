import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AlertCircle, BadgeCheck, Bot as BotIcon, CheckCheck, Download, Users } from 'lucide-react';
import {
  ABSENT,
  Alert,
  Avatar,
  Badge,
  Button,
  Card,
  CardBody,
  ConfirmDialog,
  DataTable,
  EmptyState,
  LoadingRows,
  LockedState,
  Page,
  PageHeader,
  SearchField,
  Select,
  Stack,
  StatTile,
  Toolbar,
  Tooltip,
  buttonClass,
  cn,
  formatNumber,
  formatRelative,
  type Column,
  type SortState,
} from '../../ui';
import { useBotContext } from '../../context/BotContext';
import { useEntitlements } from '../../hooks/useEntitlements';
import { useSelectedBotPlanSlug } from '../../hooks/useSelectedBotPlanSlug';
import { planIncludesVisitorIntelligence } from '../../lib/planGates';
import { downloadCsv } from '../../lib/downloadCsv';
import { exportLeadsCsv } from '../../services/api';
import type { Lead } from '../../types/domain';
import { buildSelectedLeadsCsv } from './leadsCsv';
import { LEADS_PAGE_SIZE, useLeads } from './useLeads';
import { useLeadAnnotations } from './useLeadAnnotations';
import { LeadDrawer } from './LeadDrawer';
import {
  MIN_SCORE_OPTIONS,
  hasActiveFilters,
  hasClientRefinement,
  readLeadsUrl,
  writeLeadsUrl,
  type LeadsUrlState,
} from './leadsUrl';
import {
  TIER_META,
  TIER_ORDER,
  companyDisplay,
  compareLeads,
  formatLocation,
  hasIntelligence,
  leadDisplayName,
  normalizeTier,
  orderedDimensions,
  refineLeads,
  type ContactFilter,
  type TierKey,
} from './leadModel';

/**
 * Leads — "who asked about buying, and how ready did they sound?"
 *
 * The densest surface in the product after the inbox, and the one the audit
 * found leaning hardest on the browser: it pulled a 200-row slice, ran every
 * filter and sort over that slice, and printed the truncated count as though it
 * were the workspace's total. The API has supported `tier`, `min_score`, `page`
 * and `limit` the whole time.
 *
 * So the division of labour here is explicit, and the page says it out loud:
 * **tier and minimum score are the server's**, applied across every lead and
 * driving the count; **search, lead type and column sorting are the browser's**,
 * applied to the rows on screen. Every one of them lives in the URL, so a
 * filtered view is a link.
 *
 * The pipeline summary at the top is the reason `GET /leads/stats` is called.
 * The page this replaces fetched it on every load and rendered none of it.
 */

const CONTACT_OPTIONS: ReadonlyArray<{ value: ContactFilter; label: string }> = [
  { value: 'all', label: 'Everyone' },
  { value: 'named', label: 'Named leads' },
  { value: 'anonymous', label: 'Anonymous only' },
];

const TIER_OPTIONS = [
  { value: '', label: 'Any quality' },
  ...TIER_ORDER.map((tier) => ({ value: tier, label: TIER_META[tier].label })),
];

const SCORE_OPTIONS = [
  { value: '', label: 'Any score' },
  ...MIN_SCORE_OPTIONS.map((score) => ({ value: String(score), label: `Score ${score}+` })),
];

/**
 * A deliverability verdict beside an email.
 *
 * Renders nothing when `is_valid_email` is absent: the field only exists on
 * plans with Visitor Intelligence, and `null` there means "not checked yet"
 * rather than "bad". Only a definitive verdict earns a mark, so the column
 * never implies a judgement the backend did not make.
 */
function EmailVerdict({ isValid }: { isValid?: boolean | null }) {
  if (isValid !== true && isValid !== false) return null;
  const label = isValid
    ? 'Email verified as deliverable'
    : 'Email failed validation and cannot be contacted';
  return (
    <span role="img" aria-label={label} className="inline-flex shrink-0">
      {isValid ? (
        <BadgeCheck aria-hidden className="h-3.5 w-3.5 text-success" />
      ) : (
        <AlertCircle aria-hidden className="h-3.5 w-3.5 text-danger" />
      )}
    </span>
  );
}

/**
 * The qualification cell: one chip per framework dimension, each carrying its
 * real name.
 *
 * The column this replaces was headed with the literal string "BANT" — the
 * exact jargon the module was written to eliminate — and its four chips were
 * single capital letters whose meaning lived only in a `title` attribute, which
 * is unreachable by keyboard and invisible on touch. Whole words, and a real
 * tooltip carrying what the visitor actually said.
 */
function QualificationChips({ lead }: { lead: Lead }) {
  const dimensions = orderedDimensions(lead);
  if (dimensions.length === 0) {
    return <span className="text-text-tertiary">{ABSENT}</span>;
  }
  return (
    <ul className="flex flex-wrap items-center gap-1">
      {dimensions.map((dimension) => (
        <li key={dimension.key}>
          <Tooltip
            content={
              dimension.captured
                ? `${dimension.label}: ${dimension.value ?? 'captured'}`
                : `${dimension.label}: nothing captured yet`
            }
          >
            <span
              className={cn(
                'inline-flex items-center rounded-xs px-1.5 py-0.5 text-2xs font-medium',
                dimension.captured
                  ? 'bg-success-tint text-success'
                  : 'bg-neutral-tint text-neutral',
              )}
            >
              {dimension.label}
            </span>
          </Tooltip>
        </li>
      ))}
    </ul>
  );
}

/**
 * The row's identity cell.
 *
 * Built entirely from `span`s, because `DataTable` wraps the first cell in the
 * button that activates the row and a `<button>` may only contain phrasing
 * content — a `div` or a `ul` in there is invalid, whatever the browser makes
 * of it in practice.
 */
function LeadCell({ lead, tags }: { lead: Lead; tags: readonly string[] }) {
  return (
    <span className="flex items-center gap-3">
      <Avatar name={leadDisplayName(lead)} size="md" />
      <span className="min-w-0">
        <span className="flex items-center gap-2">
          {lead.unread ? (
            <span
              role="img"
              aria-label="Not opened yet"
              className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent-500"
            />
          ) : null}
          <span className={cn('truncate text-sm text-text-primary', lead.unread && 'font-semibold')}>
            {leadDisplayName(lead)}
          </span>
        </span>
        {lead.contact?.email ? (
          <span className="mt-0.5 flex items-center gap-1 text-xs text-text-secondary">
            <span className="truncate">{lead.contact.email}</span>
            <EmailVerdict isValid={lead.contact.is_valid_email} />
          </span>
        ) : null}
        {tags.length > 0 ? (
          <span className="mt-1 flex flex-wrap items-center gap-1">
            <span className="sr-only">Your private tags: </span>
            {tags.slice(0, 3).map((tag) => (
              <Badge key={tag}>{tag}</Badge>
            ))}
            {tags.length > 3 ? (
              <span className="figure text-2xs text-text-tertiary">+{tags.length - 3}</span>
            ) : null}
          </span>
        ) : null}
      </span>
    </span>
  );
}

export function LeadsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const state = useMemo(() => readLeadsUrl(searchParams), [searchParams]);

  // The functional form so this callback never depends on the state it reads —
  // otherwise every URL change gives the toolbar new handlers and re-renders it.
  const update = useCallback(
    (patch: Partial<LeadsUrlState>, options?: { replace?: boolean }) => {
      setSearchParams((previous) => writeLeadsUrl(readLeadsUrl(previous), patch), {
        replace: options?.replace ?? false,
      });
    },
    [setSearchParams],
  );

  const { bots, selectedBot, loading: botsLoading } = useBotContext();
  const botId = selectedBot?.id;
  const { isFree } = useEntitlements();
  const planSlug = useSelectedBotPlanSlug();
  // Per agent, matching the backend gate. `null` while the chatbot resolves, so
  // the gate is held closed rather than flashing paid UI we would take away.
  const visitorIntelligence = planSlug !== null && planIncludesVisitorIntelligence(planSlug);

  const leads = useLeads({
    botId,
    tier: state.tier,
    minScore: state.minScore,
    page: state.page,
  });
  const annotations = useLeadAnnotations();

  /**
   * Whether the paid lead-intelligence layer is present.
   *
   * Read off the response first: the server *deletes* score, tier, BANT and
   * location for Free rather than nulling them, so their absence is the fact.
   * The plan flag is only the answer before any lead has arrived.
   */
  const intelligenceLocked =
    leads.leads.length > 0 ? !leads.leads.some(hasIntelligence) : isFree;

  const rows = useMemo(
    () => refineLeads(leads.leads, { contact: state.contact, query: state.query }),
    [leads.leads, state.contact, state.query],
  );

  // ── Selection ─────────────────────────────────────────────────────────────
  // Scoped to what is on screen. The version this replaces kept a selection
  // across filter and page changes, so "3 selected" could mean three rows the
  // user could no longer see, with no way to review them before exporting.
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const scope = `${botId ?? 'all'}|${state.tier}|${state.minScore}|${state.page}|${state.contact}|${state.query}`;
  const [selectionScope, setSelectionScope] = useState(scope);
  if (selectionScope !== scope) {
    setSelectionScope(scope);
    setSelected(new Set());
  }

  const [confirmMarkAll, setConfirmMarkAll] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const openLead = state.openLead;
  const markRead = leads.markRead;
  useEffect(() => {
    if (openLead) markRead(openLead);
  }, [openLead, markRead]);

  const handleSort = useCallback(
    (sort: SortState | null) => update({ sort }, { replace: true }),
    [update],
  );

  const handleExportSelected = useCallback(() => {
    const chosen = leads.leads.filter((lead) => selected.has(lead.session_id));
    if (chosen.length === 0) return;
    downloadCsv(
      buildSelectedLeadsCsv(chosen, annotations.tagsFor),
      `oyechats-leads-selected-${chosen.length}.csv`,
    );
  }, [annotations.tagsFor, leads.leads, selected]);

  async function handleExportAll(): Promise<void> {
    setExporting(true);
    setExportError(null);
    try {
      await exportLeadsCsv(botId);
    } catch (error) {
      setExportError(
        error instanceof Error ? error.message : 'The export could not be produced.',
      );
    } finally {
      setExporting(false);
    }
  }

  const columns = useMemo<Column<Lead>[]>(() => {
    const base: Column<Lead>[] = [
      {
        key: 'lead',
        header: 'Lead',
        sortable: compareLeads.name,
        render: (lead) => <LeadCell lead={lead} tags={annotations.tagsFor(lead.session_id)} />,
      },
      {
        key: 'company',
        header: 'Company',
        secondary: true,
        sortable: compareLeads.company,
        // The domain is derived free of charge from the captured email address.
        // Personal-provider addresses correctly yield nothing, so an em dash
        // here means "consumer email", not "the lookup failed".
        render: (lead) => {
          const company = companyDisplay(lead.contact);
          if (!company) return <span className="text-text-tertiary">{ABSENT}</span>;
          return (
            <span className="block max-w-48 truncate text-sm text-text-primary">
              {company.value}
            </span>
          );
        },
      },
    ];

    if (!intelligenceLocked) {
      base.push(
        {
          key: 'quality',
          header: 'Quality',
          width: '11rem',
          sortable: compareLeads.score,
          render: (lead) => {
            const tier = TIER_META[normalizeTier(lead.status)];
            return (
              <span className="flex items-center gap-2">
                <Tooltip content={`${tier.hint} (${tier.code})`}>
                  <span className="inline-flex">
                    <Badge tone={tier.tone}>{tier.label}</Badge>
                  </span>
                </Tooltip>
                <span className="figure text-xs text-text-secondary">{lead.score}</span>
              </span>
            );
          },
        },
        {
          key: 'qualification',
          header: 'Qualification',
          secondary: true,
          width: '17rem',
          render: (lead) => <QualificationChips lead={lead} />,
        },
        {
          key: 'location',
          header: 'Location',
          secondary: true,
          render: (lead) => {
            const location = formatLocation(lead.location);
            return location === 'Unknown' ? (
              <span className="text-text-tertiary">{ABSENT}</span>
            ) : (
              <span className="text-sm text-text-secondary">{location}</span>
            );
          },
        },
      );
    }

    base.push(
      {
        key: 'chats',
        header: 'Messages',
        align: 'right',
        width: '6rem',
        secondary: true,
        sortable: compareLeads.chats,
        render: (lead) => (lead.chats ? formatNumber(lead.chats) : ABSENT),
      },
      {
        key: 'last_active',
        header: 'Last active',
        align: 'right',
        width: '10rem',
        sortable: compareLeads.lastActive,
        render: (lead) => (
          <span className="whitespace-nowrap">{formatRelative(lead.last_active_at)}</span>
        ),
      },
    );

    return base;
  }, [annotations, intelligenceLocked]);

  // ── Guards ────────────────────────────────────────────────────────────────

  if (botsLoading && bots.length === 0) {
    return (
      <Page width="wide">
        <PageHeader title="Leads" description="Who asked about buying, and how ready they sounded." />
        <Card>
          <CardBody>
            <LoadingRows rows={6} />
          </CardBody>
        </Card>
      </Page>
    );
  }

  if (!botsLoading && bots.length === 0) {
    return (
      <Page width="wide">
        <PageHeader title="Leads" />
        <Card>
          <EmptyState
            icon={BotIcon}
            title="No chatbots yet"
            description="Leads are the people who chat with your chatbot. Create one, put it on your site, and everyone who talks to it turns up here."
            action={
              <Link to="/chatbots?new=1" className={buttonClass('primary', 'sm')}>
                Create your first chatbot
              </Link>
            }
          />
        </Card>
      </Page>
    );
  }

  if (leads.locked) {
    return (
      <Page width="wide">
        <PageHeader title="Leads" description="Who asked about buying, and how ready they sounded." />
        <LockedState
          title="Leads are not included on your plan"
          description="Every visitor who chats with your chatbot becomes a lead here, scored on how ready they sounded to buy, with the whole conversation attached."
          action={
            <Link to="/billing" className={buttonClass('primary', 'md')}>
              See plans
            </Link>
          }
          preview={<LockedPreview />}
        />
      </Page>
    );
  }

  const filtered = hasActiveFilters(state);
  const refined = hasClientRefinement(state);
  const shownFrom = (state.page - 1) * LEADS_PAGE_SIZE + 1;
  const shownTo = Math.min(state.page * LEADS_PAGE_SIZE, leads.total);

  return (
    <Page width="wide">
      <PageHeader
        title="Leads"
        description="Who asked about buying, and how ready they sounded."
        actions={
          <>
            <Button
              variant="ghost"
              iconLeft={<CheckCheck aria-hidden className="h-4 w-4" />}
              disabled={leads.stats === null || leads.stats.unread === 0}
              onClick={() => setConfirmMarkAll(true)}
            >
              Mark all read
            </Button>
            <Tooltip
              content={
                intelligenceLocked
                  ? 'The CSV export is included on Starter and above.'
                  : 'Every lead for this chatbot, ignoring the filters on this page. Your private tags are not in it.'
              }
            >
              <span className="inline-flex">
                <Button
                  variant="secondary"
                  loading={exporting}
                  disabled={intelligenceLocked || leads.total === 0}
                  iconLeft={<Download aria-hidden className="h-4 w-4" />}
                  onClick={() => void handleExportAll()}
                >
                  Export all leads
                </Button>
              </span>
            </Tooltip>
          </>
        }
      />

      <Stack>
        {exportError ? (
          <Alert tone="danger" live title="The export failed">
            {exportError}
          </Alert>
        ) : null}

        {intelligenceLocked ? (
          <Alert
            tone="plan"
            title="Lead scoring is included on Starter and above"
            action={
              <Link to="/billing" className={buttonClass('secondary', 'sm')}>
                See plans
              </Link>
            }
          >
            You can read every conversation and every contact detail here. Quality, score, the
            qualification breakdown, location and the CSV export arrive with a paid plan.
          </Alert>
        ) : null}

        {/* The summary the page owes the reader before any row is scanned. */}
        <Card>
          <CardBody className="grid grid-cols-2 gap-6 lg:grid-cols-5">
            <StatTile
              label="Leads"
              value={leads.stats ? formatNumber(leads.stats.total) : undefined}
              period="All time"
              loading={leads.loading}
            />
            <StatTile
              label="Qualified"
              value={
                leads.stats?.qualified === undefined
                  ? undefined
                  : formatNumber(leads.stats.qualified)
              }
              period="Past just exploring"
              loading={leads.loading}
            />
            <StatTile
              label="Ready to buy"
              value={leads.stats?.sql === undefined ? undefined : formatNumber(leads.stats.sql)}
              period="Highest tier"
              tone={leads.stats?.sql ? 'success' : 'neutral'}
              loading={leads.loading}
            />
            <StatTile
              label="Average score"
              value={
                leads.stats?.avgScore === undefined
                  ? undefined
                  : formatNumber(Math.round(leads.stats.avgScore))
              }
              period="Out of 100"
              loading={leads.loading}
            />
            <StatTile
              label="Not opened"
              value={leads.stats ? formatNumber(leads.stats.unread) : undefined}
              period="Nobody has read these"
              tone={leads.stats?.unread ? 'warning' : 'neutral'}
              loading={leads.loading}
            />
          </CardBody>
        </Card>

        <div>
          {/* Each control is boxed to a width. Both `SearchField` and `Select`
              wrap themselves in a `w-full` element, so dropped straight into a
              wrapping flex row every one of them would claim its own line. */}
          <Toolbar>
            <div className="w-full sm:w-64">
              <SearchField
                label="Search the leads on this page"
                placeholder="Name, email, company…"
                value={state.query}
                onValueChange={(query) => update({ query }, { replace: true })}
              />
            </div>
            {/* Disabled rather than clickable-but-refused. The tier chips this
                replaces were `aria-disabled` and still fired their upgrade modal,
                so arrowing through the filter row was a keyboard trap. */}
            <div className="w-40">
              <Select
                aria-label="Filter by quality"
                value={state.tier ?? ''}
                options={TIER_OPTIONS}
                disabled={intelligenceLocked}
                onChange={(event) =>
                  update({ tier: (event.target.value || null) as TierKey | null })
                }
              />
            </div>
            <div className="w-36">
              <Select
                aria-label="Filter by minimum score"
                value={state.minScore === null ? '' : String(state.minScore)}
                options={SCORE_OPTIONS}
                disabled={intelligenceLocked}
                onChange={(event) =>
                  update({ minScore: event.target.value ? Number(event.target.value) : null })
                }
              />
            </div>
            <div className="w-40">
              <Select
                aria-label="Filter by lead type"
                value={state.contact}
                options={CONTACT_OPTIONS}
                onChange={(event) => update({ contact: event.target.value as ContactFilter })}
              />
            </div>
            {filtered ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  update({ query: '', contact: 'all', tier: null, minScore: null, page: 1 })
                }
              >
                Clear filters
              </Button>
            ) : null}
          </Toolbar>

          <p className="mt-2 text-xs text-text-secondary" aria-live="polite">
            {leads.loading ? (
              'Loading your leads…'
            ) : (
              <>
                <span className="figure">{leads.total === 0 ? 0 : shownFrom}</span>–
                <span className="figure">{shownTo}</span> of{' '}
                <span className="figure">{formatNumber(leads.total)}</span>
                {filtered ? ' matching leads' : ' leads'}
                {refined && rows.length !== leads.leads.length ? (
                  <>
                    {' · '}
                    <span className="figure">{rows.length}</span> of them match what you typed
                  </>
                ) : null}
                {leads.fetching ? ' · updating…' : null}
              </>
            )}
          </p>

          {/* The division of labour, stated rather than implied. The page this
              replaces filtered a truncated slice and reported its length as the
              workspace total. */}
          {leads.total > LEADS_PAGE_SIZE || refined ? (
            <p className="mt-1 text-xs text-text-tertiary">
              Quality and score filter every lead you have. Search, lead type and column sorting
              apply to the {LEADS_PAGE_SIZE} rows on this page.
            </p>
          ) : null}

          <div className="mt-3">
            <DataTable
              caption="Leads captured by your chatbots"
              columns={columns}
              rows={rows}
              rowKey={(lead) => lead.session_id}
              rowLabel={leadDisplayName}
              loading={leads.loading}
              error={leads.error ? leads.error.message : null}
              onRetry={leads.retry}
              sort={state.sort}
              onSortChange={handleSort}
              selectedKeys={selected}
              onSelectionChange={setSelected}
              bulkActions={
                <Button
                  size="sm"
                  variant="secondary"
                  iconLeft={<Download aria-hidden className="h-3.5 w-3.5" />}
                  onClick={handleExportSelected}
                >
                  Export these rows, with your private tags
                </Button>
              }
              onRowClick={(lead) => update({ openLead: lead.session_id, tab: 'profile' })}
              empty={
                filtered ? (
                  <EmptyState
                    title="No leads match these filters"
                    description="Nothing on this page matches. Try widening the quality or score filter, or clearing what you typed."
                    action={
                      <Button
                        size="sm"
                        onClick={() =>
                          update({ query: '', contact: 'all', tier: null, minScore: null, page: 1 })
                        }
                      >
                        Clear filters
                      </Button>
                    }
                  />
                ) : (
                  <EmptyState
                    icon={Users}
                    title="No leads yet"
                    description="Every visitor who starts a conversation with your chatbot turns up here, with what they asked and how ready they sounded to buy."
                  />
                )
              }
            />
          </div>

          {leads.pageCount > 1 ? (
            <nav
              aria-label="Lead pages"
              className="mt-3 flex items-center justify-between gap-3"
            >
              <p className="text-xs text-text-secondary">
                Page <span className="figure">{state.page}</span> of{' '}
                <span className="figure">{leads.pageCount}</span>
              </p>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={state.page <= 1 || leads.fetching}
                  onClick={() => update({ page: state.page - 1 })}
                >
                  Previous
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={state.page >= leads.pageCount || leads.fetching}
                  onClick={() => update({ page: state.page + 1 })}
                >
                  Next
                </Button>
              </div>
            </nav>
          ) : null}
        </div>
      </Stack>

      <LeadDrawer
        sessionId={state.openLead}
        tab={state.tab}
        onTabChange={(tab) => update({ tab }, { replace: true })}
        onClose={() => update({ openLead: null, tab: 'profile' })}
        intelligenceLocked={intelligenceLocked}
        visitorIntelligence={visitorIntelligence}
        annotations={annotations}
      />

      <ConfirmDialog
        open={confirmMarkAll}
        onOpenChange={setConfirmMarkAll}
        title="Mark every lead as read?"
        description={
          <>
            This clears the unread mark on{' '}
            <span className="figure">{formatNumber(leads.stats?.unread ?? 0)}</span> leads across
            every page, not just the ones on screen. There is no way to put the marks back.
          </>
        }
        confirmLabel="Mark all read"
        onConfirm={async () => {
          await leads.markAllRead();
          setConfirmMarkAll(false);
        }}
      />
    </Page>
  );
}

/**
 * What sits behind the plan lock.
 *
 * `LockedState` renders this `inert`, so it is a picture of the feature rather
 * than the feature. Asking someone to buy a surface they have never seen is how
 * the previous locked pages worked: a bare card, no page title, no description.
 */
function LockedPreview() {
  return (
    <div className="px-5 py-4">
      <div className="grid grid-cols-3 gap-6">
        <StatTile label="Leads" value="128" period="All time" />
        <StatTile label="Qualified" value="41" period="Past just exploring" />
        <StatTile label="Ready to buy" value="9" period="Highest tier" tone="success" />
      </div>
      <ul className="mt-5 space-y-2">
        {[
          { name: 'Priya Raman', company: 'infosys.com', tier: 'sql' as TierKey, score: 84 },
          { name: 'Tom Whitfield', company: 'northwind.co.uk', tier: 'sal' as TierKey, score: 61 },
          { name: 'Anonymous visitor', company: null, tier: 'mql' as TierKey, score: 38 },
        ].map((row) => (
          <li
            key={row.name}
            className="flex items-center gap-3 rounded-md border border-border px-3 py-2"
          >
            <Avatar name={row.name} size="sm" />
            <span className="min-w-0 flex-1 truncate text-sm text-text-primary">{row.name}</span>
            <span className="truncate text-xs text-text-secondary">{row.company ?? ABSENT}</span>
            <Badge tone={TIER_META[row.tier].tone}>{TIER_META[row.tier].label}</Badge>
            <span className="figure text-xs text-text-secondary">{row.score}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
