import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  AlertCircle,
  BadgeCheck,
  Bot as BotIcon,
  CheckCheck,
  Download,
  Info,
  MailX,
  MoreHorizontal,
  Users,
} from 'lucide-react';
import {
  ABSENT,
  Alert,
  Avatar,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
  DataTable,
  EmptyState,
  LockedState,
  MenuContent,
  MenuItem,
  MenuRoot,
  MenuTrigger,
  Page,
  PageHeader,
  SearchField,
  Select,
  Stack,
  StatRow,
  Toolbar,
  Tooltip,
  BUTTON_ICON_SLOT,
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
import { SuppressionsDrawer } from './SuppressionsDrawer';
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
 * **The table owns its paging.** `DataTable` takes `page`, `onPageChange` and
 * `rowCount`, and this page hand-rolled a `<nav>` of Previous/Next buttons
 * twenty lines below one that already had them — which cost more than
 * duplication. Because `page` was never passed, the table did not know it was
 * server-paged, so it happily sorted fifty rows out of nine thousand and
 * presented the result as "sorted by score".
 *
 * **The division of labour is a property of the API, not a paragraph.** Tier and
 * minimum score are the server's, applied across every lead. Search and lead
 * type are the browser's, applied to the rows on screen — so while either is
 * active this stops claiming to be page 3 of 128 and reports what it is actually
 * showing. The page used to explain that split in two lines of body copy; it is
 * now one tooltip on one glyph, where a reader who wonders can find it.
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

/** What search and the lead-type filter actually reach. One tooltip, not two lines. */
const SCOPE_NOTE = `Quality and score filter every lead. Search and lead type filter the ${LEADS_PAGE_SIZE} rows on this page.`;

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
        <BadgeCheck aria-hidden className="h-icon-sm w-icon-sm text-success" />
      ) : (
        <AlertCircle aria-hidden className="h-icon-sm w-icon-sm text-danger" />
      )}
    </span>
  );
}

/**
 * How much of the framework this lead answered, as one figure.
 *
 * It was four to five tinted word-chips — `Budget` `Authority` `Need`
 * `Timeline` — each in its own tooltip, wrapping to two lines the moment the
 * framework was MEDDIC, so no two rows in the column were the same height. And
 * the question a reader actually asks down a column is "how complete is this
 * one?", which four words cannot answer at a glance. The words move to the
 * drawer, where there is room to read them; the column carries the count and
 * names every dimension in one tooltip.
 */
function QualificationCell({ lead }: { lead: Lead }) {
  const dimensions = orderedDimensions(lead);
  if (dimensions.length === 0) {
    return <span className="text-text-tertiary">{ABSENT}</span>;
  }
  const captured = dimensions.filter((dimension) => dimension.captured);
  return (
    <Tooltip
      content={
        <ul>
          {dimensions.map((dimension) => (
            <li key={dimension.key}>
              {dimension.label}: {dimension.captured ? (dimension.value ?? 'captured') : 'nothing yet'}
            </li>
          ))}
        </ul>
      }
    >
      <span
        className={cn(
          'figure inline-flex items-center rounded-xs px-1.5 py-0.5 text-xs font-medium',
          captured.length === 0
            ? 'bg-neutral-tint text-neutral'
            : captured.length === dimensions.length
              ? 'bg-success-tint text-success'
              : 'bg-surface-sunken text-text-secondary',
        )}
      >
        {captured.length}/{dimensions.length}
        <span className="sr-only"> dimensions captured</span>
      </span>
    </Tooltip>
  );
}

/**
 * The row's identity cell.
 *
 * Built entirely from `span`s, because `DataTable` wraps the first cell in the
 * button that activates the row and a `<button>` may only contain phrasing
 * content — a `div` or a `ul` in there is invalid, whatever the browser makes
 * of it in practice.
 *
 * One line, not three. It was a 32px avatar beside a name, an email and a wrap
 * of tag chips — about 76px against the 44px row token, so a 1080p screen
 * showed nine leads where Attio shows twenty-four. Unread is weight, not a blue
 * pip: blue means interactive in this system, and a selected unread row had
 * accent as its ground *and* accent as its status mark.
 */
function LeadCell({ lead }: { lead: Lead }) {
  const email = lead.contact?.email;
  return (
    <span className="flex items-center gap-2">
      <Avatar name={leadDisplayName(lead)} size="sm" />
      <span className={cn('shrink-0 truncate', lead.unread && 'font-semibold')}>
        {leadDisplayName(lead)}
      </span>
      {email ? (
        <>
          <span className="min-w-0 truncate text-xs text-text-secondary">{email}</span>
          <EmailVerdict isValid={lead.contact?.is_valid_email} />
        </>
      ) : null}
      {lead.unread ? <span className="sr-only">Not opened yet</span> : null}
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

  const refined = hasClientRefinement(state);
  /**
   * Sorting is offered only when the whole result set is on screen.
   *
   * `GET /leads` takes no sort parameter, so a comparator here can only order
   * the fifty rows this page happens to hold. That is honest when those fifty
   * *are* the result — one page of results, or a client-refined subset of one —
   * and a lie the moment there is a second page. `DataTable` refuses to draw an
   * affordance it cannot honour, so the columns simply stop declaring one.
   */
  const sortable = refined || leads.total <= LEADS_PAGE_SIZE;

  // ── Selection ─────────────────────────────────────────────────────────────
  // Scoped to what is on screen. The version this replaces kept a selection
  // across filter and page changes, so "3 selected" could mean three rows the
  // user could no longer see, with no way to review them before exporting.
  //
  // `query` is deliberately NOT in the scope. `SearchField` debounces at 200ms,
  // so with it in here one keystroke silently discarded a selection the user had
  // built by hand — the reset is right, doing it mid-typing was not.
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const scope = `${botId ?? 'all'}|${state.tier}|${state.minScore}|${state.page}|${state.contact}`;
  const [selectionScope, setSelectionScope] = useState(scope);
  if (selectionScope !== scope) {
    setSelectionScope(scope);
    setSelected(new Set());
  }

  const [confirmMarkAll, setConfirmMarkAll] = useState(false);
  const [suppressionsOpen, setSuppressionsOpen] = useState(false);
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

  const handleMarkSelectedRead = useCallback(() => {
    selected.forEach((sessionId) => markRead(sessionId));
    setSelected(new Set());
  }, [markRead, selected]);

  // The failure belongs beside the control that produced it (DESIGN.md §6.8).
  // It used to render as the first child of the page's `Stack` — left-aligned
  // and full width, about 300px from the top-right button that caused it — so
  // it goes through the header's own toolbar slot instead. Not a toast: the
  // `Toaster` is not mounted at the app root, so a toast here would be silence.
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
        rowHeader: true,
        // Pinned, because this table is wider than the card that holds it and
        // there is no honest way to make it narrower. Eight columns came to
        // 1,383px against 1,126 at 1440 and 966 at 1280, so Messages and Last
        // active sat off the right edge — and the identity column scrolled away
        // with them, leaving rows of scores with nobody's name against them.
        // Trimming the declared widths (below) buys back 257px, which is the
        // whole overflow at 1440 and most of it at 1280; the rest scrolls, with
        // the name anchored and `DataTable`'s pinned-edge shadow marking it.
        //
        // `fit` was the other candidate and is wrong here: it is for a table in
        // a narrow column, and forcing eight columns into 966px cut every
        // visitor's name to "Amara (" — losing the tail of the thing the row is
        // *about*, which is worse than scrolling to reach a message count.
        pinned: true,
        sortable: sortable ? compareLeads.name : undefined,
        render: (lead) => <LeadCell lead={lead} />,
      },
      {
        key: 'tags',
        header: 'Tags',
        secondary: true,
        width: '5rem',
        render: (lead) => {
          const tags = annotations.tagsFor(lead.session_id);
          if (tags.length === 0) return <span className="text-text-tertiary">{ABSENT}</span>;
          return (
            <span className="flex items-center gap-1">
              <span className="sr-only">Your private tags: </span>
              {tags.slice(0, 2).map((tag) => (
                <Badge key={tag}>{tag}</Badge>
              ))}
              {tags.length > 2 ? (
                <span className="figure text-xs text-text-tertiary">+{tags.length - 2}</span>
              ) : null}
            </span>
          );
        },
      },
      {
        key: 'company',
        header: 'Company',
        secondary: true,
        width: '9rem',
        sortable: sortable ? compareLeads.company : undefined,
        // The domain is derived free of charge from the captured email address.
        // Personal-provider addresses correctly yield nothing, so an em dash
        // here means "consumer email", not "the lookup failed".
        render: (lead) => {
          const company = companyDisplay(lead.contact);
          if (!company) return <span className="text-text-tertiary">{ABSENT}</span>;
          return <span className="text-text-primary">{company.value}</span>;
        },
      },
    ];

    if (!intelligenceLocked) {
      base.push(
        {
          key: 'quality',
          header: 'Quality',
          width: '10rem',
          sortable: sortable ? compareLeads.score : undefined,
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
          header: 'Qualified',
          secondary: true,
          align: 'center',
          // 4rem, not 6: the cell is a `4/4` chip about 34px wide, so 96px was
          // 30px of air in a table that did not have 23px to give.
          width: '4rem',
          render: (lead) => <QualificationCell lead={lead} />,
        },
        {
          key: 'location',
          header: 'Location',
          secondary: true,
          width: '6rem',
          render: (lead) => {
            const location = formatLocation(lead.location);
            return location === 'Unknown' ? (
              <span className="text-text-tertiary">{ABSENT}</span>
            ) : (
              <span className="text-text-secondary">{location}</span>
            );
          },
        },
      );
    }

    base.push(
      {
        key: 'chats',
        header: 'Messages',
        type: 'number',
        width: '5rem',
        secondary: true,
        sortable: sortable ? compareLeads.chats : undefined,
        render: (lead) => (lead.chats ? formatNumber(lead.chats) : ABSENT),
      },
      {
        // Left-aligned and set in Inter. `align: 'right'` makes `DataTable` set
        // the cell as a figure, and "3 days ago" is a phrase — right-aligned
        // monospace prose with tabular figures reads as a broken number column.
        key: 'last_active',
        header: 'Last active',
        width: '7rem',
        sortable: sortable ? compareLeads.lastActive : undefined,
        render: (lead) => formatRelative(lead.last_active_at),
      },
    );

    return base;
  }, [annotations, intelligenceLocked, sortable]);

  // ── Guards ────────────────────────────────────────────────────────────────

  if (!botsLoading && bots.length === 0) {
    return (
      <Page width="wide">
        <PageHeader title="Leads" />
        <Card>
          <EmptyState
            icon={BotIcon}
            title="No chatbots yet"
            description="Everyone who chats with your chatbot appears here."
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
        <PageHeader title="Leads" />
        <LockedLeads />
      </Page>
    );
  }

  const filtered = hasActiveFilters(state);
  // While a browser-side refinement is active the rows on screen are no longer
  // "the server's page N", so the table stops reporting the server's total and
  // reports what it is actually showing. Anything else is the count lying.
  const serverPaged = !refined;

  return (
    <Page width="wide">
      <PageHeader
        title="Leads"
        toolbar={
          exportError ? (
            <Alert tone="danger" live title="The export failed">
              {exportError}
            </Alert>
          ) : undefined
        }
        actions={
          <MenuRoot>
            <MenuTrigger
              aria-label="Lead actions"
              className={buttonClass('secondary', 'icon-md', BUTTON_ICON_SLOT['icon-md'])}
            >
              <MoreHorizontal aria-hidden />
            </MenuTrigger>
            <MenuContent>
              <MenuItem
                icon={<Download aria-hidden className="h-icon-sm w-icon-sm" />}
                disabled={intelligenceLocked || leads.total === 0 || exporting}
                onSelect={() => void handleExportAll()}
              >
                Export all leads
              </MenuItem>
              {/* Disabled only when there is genuinely nothing unread.
                  `stats === null` is also the state when the stats request
                  *failed*, and disabling on that rendered a permanently dead
                  command with no reason given — where the action is idempotent
                  and costs nothing to offer. */}
              <MenuItem
                icon={<CheckCheck aria-hidden className="h-icon-sm w-icon-sm" />}
                disabled={leads.stats?.unread === 0}
                onSelect={() => setConfirmMarkAll(true)}
              >
                Mark all read
              </MenuItem>
              <MenuItem
                icon={<MailX aria-hidden className="h-icon-sm w-icon-sm" />}
                onSelect={() => setSuppressionsOpen(true)}
              >
                Unsubscribes
              </MenuItem>
            </MenuContent>
          </MenuRoot>
        }
      />

      <Stack>
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
            Scores, qualification, location and CSV export are on Starter and above.
          </Alert>
        ) : null}

        {/* The summary the page owes the reader before any row is scanned. The
            window is stated once, in the header: `StatRow` suppresses it on
            every tile that inherits it and renders it nowhere itself. */}
        <Card>
          {/* No period in the header. `StatRow` states the strip's window
              itself, in a hairline caption under the tiles, so this printed
              "All time" twice within 90px of itself. */}
          <CardHeader size="sm" title="Pipeline" titleAs="h2" />
          <CardBody flush>
            <StatRow
              label="Lead pipeline"
              period="All time"
              columns={5}
              loading={leads.loading}
              items={[
                {
                  label: 'Leads',
                  value: leads.stats ? formatNumber(leads.stats.total) : undefined,
                  size: 'lg',
                },
                {
                  label: 'Qualified',
                  value:
                    leads.stats?.qualified === undefined
                      ? undefined
                      : formatNumber(leads.stats.qualified),
                },
                {
                  label: 'Ready to buy',
                  value: leads.stats?.sql === undefined ? undefined : formatNumber(leads.stats.sql),
                  tone: leads.stats?.sql ? 'success' : 'neutral',
                },
                {
                  label: 'Average score',
                  value:
                    leads.stats?.avgScore === undefined
                      ? undefined
                      : `${formatNumber(Math.round(leads.stats.avgScore))}/100`,
                },
                {
                  label: 'Not opened',
                  value: leads.stats ? formatNumber(leads.stats.unread) : undefined,
                  tone: leads.stats?.unread ? 'warning' : 'neutral',
                },
              ]}
            />
          </CardBody>
        </Card>

        <div>
          {/* Each control is boxed to a width. Both `SearchField` and `Select`
              wrap themselves in a `w-full` element, so dropped straight into a
              wrapping flex row every one of them would claim its own line. */}
          <Toolbar sticky>
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
            <Tooltip content={SCOPE_NOTE}>
              <button
                type="button"
                aria-label="What these filters cover"
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-xs text-text-tertiary hover:text-text-primary"
              >
                <Info aria-hidden className="h-icon-sm w-icon-sm" />
              </button>
            </Tooltip>
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

          <div className="mt-3">
            <DataTable
              caption="Leads captured by your chatbots"
              columns={columns}
              rows={rows}
              rowKey={(lead) => lead.session_id}
              rowLabel={leadDisplayName}
              rowNoun="lead"
              loading={leads.loading || botsLoading}
              error={leads.error ? leads.error.message : null}
              onRetry={leads.retry}
              sort={state.sort}
              onSortChange={handleSort}
              pageSize={LEADS_PAGE_SIZE}
              page={serverPaged ? state.page : undefined}
              onPageChange={serverPaged ? (page) => update({ page }) : undefined}
              rowCount={serverPaged ? leads.total : undefined}
              // No `stickyOffset`. `DataTable` wraps its own table in an
              // `overflow-auto` box, so that box — not the page — is what the
              // header sticks to, and a 3.25rem offset there is not "clear the
              // toolbar", it is "sit 52px down from the top of the table". The
              // rendered result was a 52px empty band at the top of the card
              // with the column heads floating over the first row of leads
              // (thead at y=454 against a first row at y=446). The toolbar it
              // was trying to clear scrolls with the page and never overlaps
              // this header at all.
              selectedKeys={selected}
              onSelectionChange={setSelected}
              bulkActions={
                <>
                  <Tooltip content="Your private tags are included.">
                    <span className="inline-flex">
                      <Button
                        size="sm"
                        variant="secondary"
                        iconLeft={<Download aria-hidden />}
                        onClick={handleExportSelected}
                      >
                        Export selection
                      </Button>
                    </span>
                  </Tooltip>
                  <Button size="sm" variant="secondary" onClick={handleMarkSelectedRead}>
                    Mark read
                  </Button>
                </>
              }
              onRowClick={(lead) => update({ openLead: lead.session_id, tab: 'profile' })}
              empty={
                filtered ? (
                  <EmptyState
                    size="inline"
                    title="No leads match these filters"
                    description="Try a wider quality or score filter."
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
                    size="inline"
                    icon={Users}
                    title="No leads yet"
                    description="Visitors appear here as soon as they start a conversation."
                  />
                )
              }
            />
          </div>
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

      <SuppressionsDrawer
        open={suppressionsOpen}
        onOpenChange={setSuppressionsOpen}
        botId={botId ?? null}
        bots={bots}
      />

      <ConfirmDialog
        open={confirmMarkAll}
        onOpenChange={setConfirmMarkAll}
        title="Mark every lead as read?"
        description={
          <>
            Clears the unread mark on{' '}
            <span className="figure">{formatNumber(leads.stats?.unread ?? 0)}</span> leads, on every
            page. Cannot be undone.
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
 * The plan wall, with the product behind it.
 *
 * `LockedState` renders its preview `inert`, so it is a picture of the feature
 * rather than the feature. The preview is the real `DataTable` with three
 * fixture rows: asking somebody to buy a surface they have never seen is how the
 * previous locked pages worked, and an approximation of the table is a worse
 * argument than the table.
 */
function LockedLeads() {
  return (
    <LockedState
      title="Leads are not included on your plan"
      description="Every visitor scored on how ready they sounded to buy, with the conversation attached."
      action={
        <Link to="/billing" className={buttonClass('primary', 'md')}>
          See plans
        </Link>
      }
      preview={<LockedPreview />}
    />
  );
}

interface PreviewRow {
  session_id: string;
  name: string;
  company: string | null;
  tier: TierKey;
  score: number;
  lastActive: string;
}

const PREVIEW_ROWS: readonly PreviewRow[] = [
  {
    session_id: 'p1',
    name: 'Priya Raman',
    company: 'infosys.com',
    tier: 'sql',
    score: 84,
    lastActive: '2 hours ago',
  },
  {
    session_id: 'p2',
    name: 'Tom Whitfield',
    company: 'northwind.co.uk',
    tier: 'sal',
    score: 61,
    lastActive: 'Yesterday',
  },
  {
    session_id: 'p3',
    name: 'Anonymous visitor',
    company: null,
    tier: 'mql',
    score: 38,
    lastActive: '3 days ago',
  },
];

const PREVIEW_COLUMNS: Column<PreviewRow>[] = [
  {
    key: 'lead',
    header: 'Lead',
    rowHeader: true,
    render: (row) => (
      <span className="flex items-center gap-2">
        <Avatar name={row.name} size="sm" />
        <span className="truncate">{row.name}</span>
      </span>
    ),
  },
  {
    key: 'company',
    header: 'Company',
    width: '12rem',
    render: (row) =>
      row.company ?? <span className="text-text-tertiary">{ABSENT}</span>,
  },
  {
    key: 'quality',
    header: 'Quality',
    width: '11rem',
    render: (row) => (
      <span className="flex items-center gap-2">
        <Badge tone={TIER_META[row.tier].tone}>{TIER_META[row.tier].label}</Badge>
        <span className="figure text-xs text-text-secondary">{row.score}</span>
      </span>
    ),
  },
  {
    key: 'last_active',
    header: 'Last active',
    width: '10rem',
    render: (row) => row.lastActive,
  },
];

function LockedPreview() {
  return (
    <div className="p-cell">
      <DataTable
        caption="What the leads table looks like"
        columns={PREVIEW_COLUMNS}
        rows={PREVIEW_ROWS}
        rowKey={(row) => row.session_id}
        rowNoun="lead"
        // Invented rows behind a plan lock. Counting them would report the size
        // of the illustration as though it were the size of the reader's data.
        countSummary={false}
      />
    </div>
  );
}
