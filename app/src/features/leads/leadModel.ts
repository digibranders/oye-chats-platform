/**
 * Leads — the domain model.
 *
 * Pure functions that turn the backend's lead payloads into the values the
 * screen renders. They live apart from the components so the parts worth
 * protecting — tier normalisation, the per-dimension denominator, the
 * comparators, the IP-stripping — can be tested without a DOM.
 *
 * The vocabulary decision stands: the backend speaks BANT (unqualified / mql /
 * sal / sql) and buyers of this product do not, so every tier carries a plain
 * label. What changed is that the acronym is no longer hidden in a `title`
 * attribute — it is a real label with a real tooltip beside it, because a
 * `title` is unreachable by keyboard and invisible on touch.
 */
import type { Lead, LeadContact } from '../../types/domain';
import type { Tone } from '../../ui';
import { t as translateNow } from '../../i18n/i18n';

// ── Tiers ───────────────────────────────────────────────────────────────────

/** Canonical qualification tiers, coldest → hottest. */
export type TierKey = 'unqualified' | 'mql' | 'sal' | 'sql';

/** Tiers in pipeline order. Filters, summaries and the tier comparator read this. */
export const TIER_ORDER: readonly TierKey[] = ['unqualified', 'mql', 'sal', 'sql'];

export interface TierMeta {
  /** Plain language. This is what the user reads. */
  readonly label: string;
  /** The industry acronym, for the operator who already knows it. */
  readonly code: string;
  /** One line on what the tier means and what to do about it. */
  readonly hint: string;
  readonly tone: Tone;
}

/**
 * Colour marks only the two tiers that change what someone does today.
 *
 * The status palette means healthy / pending / failed / off — it is not a rank,
 * and painting a four-rung ladder with it would have `warning` meaning "third
 * best" on this screen and "degraded" everywhere else. So "Ready to buy" is
 * success, "Strong interest" is the one that goes cold if ignored, and the two
 * colder tiers carry their word and nothing more. The ordering and the score
 * carry the rank.
 */
export const TIER_META: Record<TierKey, TierMeta> = {
  unqualified: {
    label: 'Just exploring',
    code: 'Unqualified',
    hint: 'Early interest. Keep nurturing before anyone reaches out.',
    tone: 'neutral',
  },
  mql: {
    label: 'Warm lead',
    code: 'MQL',
    hint: 'Real buying signals. Worth a marketing follow-up.',
    tone: 'neutral',
  },
  sal: {
    label: 'Strong interest',
    code: 'SAL',
    hint: 'Ready for a sales conversation. Reach out soon.',
    tone: 'warning',
  },
  sql: {
    label: 'Ready to buy',
    code: 'SQL',
    hint: 'High intent. Prioritise this lead today.',
    tone: 'success',
  },
};

/**
 * Normalise a raw status string — legacy cold/warm/hot/qualified or the newer
 * BANT unqualified/mql/sal/sql — into a canonical {@link TierKey}. Unknown
 * values fall to the coldest tier so a row never renders blank.
 */
export function normalizeTier(status: string | null | undefined): TierKey {
  switch ((status ?? '').toLowerCase()) {
    case 'sql':
    case 'qualified':
      return 'sql';
    case 'sal':
    case 'hot':
      return 'sal';
    case 'mql':
    case 'warm':
      return 'mql';
    case 'unqualified':
    case 'cold':
    default:
      return 'unqualified';
  }
}

/**
 * Does this payload carry the paid lead-intelligence layer?
 *
 * The server does not null these fields on the Free plan, it deletes them
 * (`build_lead_response`'s `include_intelligence`), so their absence is the
 * only honest signal that the layer is locked. Reading it off the response
 * rather than off a plan slug is what keeps the table from claiming a lock the
 * API did not apply — and from showing a score the API stripped.
 */
export function hasIntelligence(lead: Lead): boolean {
  // `Lead` declares `tier` and `score` as always present, which is true of every
  // paid plan and false of Free. The cast is the honest reading of the wire
  // contract until the shared type splits into two.
  const partial = lead as Partial<Lead>;
  return partial.tier !== undefined && partial.score !== undefined;
}

// ── Safe readers over the loosely-typed stats envelope ───────────────────────

function toNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Present only when the key exists — absence is "not on your plan", not zero. */
function toOptionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

// ── The pipeline summary ─────────────────────────────────────────────────────

export interface LeadStatsSummary {
  total: number;
  /** Everything below is absent on plans without lead intelligence. */
  unqualified?: number;
  mql?: number;
  sal?: number;
  sql?: number;
  /** MQL + SAL + SQL — everyone past the "just exploring" line. */
  qualified?: number;
  avgScore?: number;
  unread: number;
}

/**
 * Read `GET /leads/stats` into the summary the page renders.
 *
 * This is the whole reason the endpoint is called. The page it replaces fetched
 * it on every load, used it as a truthiness gate, and rendered none of it — so
 * the surface that promised "a one-glance pipeline summary up top" showed a
 * table and nothing else.
 *
 * Free workspaces get `{total, unread}` only. The tier counts come back
 * `undefined` rather than `0`, so the tiles say "not on your plan" instead of
 * asserting that a workspace has no qualified leads.
 */
export function readLeadStats(raw: Record<string, unknown> | null | undefined): LeadStatsSummary {
  const src = raw ?? {};
  const unqualified = toOptionalNumber(src.unqualified ?? src.cold);
  const mql = toOptionalNumber(src.mql ?? src.warm);
  const sal = toOptionalNumber(src.sal ?? src.hot);
  const sql = toOptionalNumber(src.sql ?? src.qualified);
  const scored = [mql, sal, sql].filter((value): value is number => value !== undefined);
  return {
    total: toNumber(src.total),
    unqualified,
    mql,
    sal,
    sql,
    qualified: scored.length === 3 ? scored[0] + scored[1] + scored[2] : undefined,
    avgScore: toOptionalNumber(src.avg_score),
    unread: toNumber(src.unread),
  };
}

// ── Qualification funnel (read by the Analytics surface) ─────────────────────

export interface FunnelStageView {
  readonly key: string;
  readonly label: string;
  readonly sublabel: string;
  count: number;
  /** Share of this stage vs. the top of the funnel (0 to 100). */
  widthPct: number;
  /** Conversion from the previous stage (0 to 100), or null for the top stage. */
  conversionFromPrev: number | null;
}

interface FunnelStageDef {
  readonly key: string;
  readonly label: string;
  readonly sublabel: string;
}

const FUNNEL_STAGE_DEFS: readonly FunnelStageDef[] = [
  { key: 'total_visitors', label: 'Visitors', sublabel: 'Landed on your site' },
  { key: 'engaged', label: 'Engaged', sublabel: 'Started a chat' },
  { key: 'mql', label: 'Warm leads', sublabel: 'Showed buying signals' },
  { key: 'sal', label: 'Strong interest', sublabel: 'Sales-ready' },
  { key: 'sql', label: 'Ready to buy', sublabel: 'High intent' },
  { key: 'meetings_booked', label: 'Meetings', sublabel: 'Booked a call' },
];

/**
 * Read the `getQualificationFunnel` envelope into ordered, presentation-ready
 * stages. Consumed by Analytics, which owns the funnel surface; it lives here
 * because the stage vocabulary has to agree with {@link TIER_META}.
 */
export function readFunnel(raw: Record<string, unknown> | null | undefined): FunnelStageView[] {
  const rawFunnel = raw && Array.isArray(raw.funnel) ? raw.funnel : [];
  const counts = new Map<string, number>();
  for (const item of rawFunnel) {
    if (isRecord(item) && typeof item.stage === 'string') {
      counts.set(item.stage, toNumber(item.count));
    }
  }

  const top = counts.get(FUNNEL_STAGE_DEFS[0]?.key ?? '') ?? 0;
  let prev: number | null = null;

  return FUNNEL_STAGE_DEFS.map((def) => {
    // Clamp to 100: a downstream stage can exceed an upstream one when the two
    // counts come from different measurement windows, which would otherwise
    // overflow the bar and show a conversion above 100%.
    const count = counts.get(def.key) ?? 0;
    const conversionFromPrev =
      prev !== null && prev > 0 ? Math.min((count / prev) * 100, 100) : null;
    const widthPct = top > 0 ? Math.min(Math.max((count / top) * 100, count > 0 ? 3 : 0), 100) : 0;
    prev = count;
    return { ...def, count, widthPct, conversionFromPrev };
  });
}

/** Does this funnel carry anything worth rendering? */
export function funnelHasData(stages: FunnelStageView[]): boolean {
  return stages.some((stage) => stage.count > 0);
}

// ── Client-side refinement ───────────────────────────────────────────────────

export type ContactFilter = 'all' | 'named' | 'anonymous';

export interface LeadRefinement {
  contact: ContactFilter;
  query: string;
}

/** Does the lead have a real contact name attached? */
export function hasContactName(lead: Lead): boolean {
  const name = lead.contact?.name;
  return typeof name === 'string' && name.trim() !== '';
}

/**
 * Narrow the rows already on screen.
 *
 * Deliberately named "refine", not "filter": tier and minimum score are applied
 * by the server across every lead, while this runs over one fetched page. The
 * page says so out loud, because the version this replaces ran every filter
 * over a 200-row client cap and then reported the truncated count as the total.
 */
export function refineLeads(leads: readonly Lead[], refinement: LeadRefinement): Lead[] {
  const needle = refinement.query.trim().toLowerCase();
  return leads.filter((lead) => {
    if (refinement.contact === 'named' && !hasContactName(lead)) return false;
    if (refinement.contact === 'anonymous' && hasContactName(lead)) return false;
    if (!needle) return true;
    const haystack = [
      lead.contact?.name,
      lead.contact?.email,
      lead.contact?.phone,
      lead.contact?.company,
      // The RESOLVED company name, which is what the drawer shows and therefore
      // what an operator will type. Searching only the raw domain meant
      // "Infosys Limited" — the name on screen — matched nothing.
      lead.contact?.company_name,
      lead.location,
      lead.session_id,
    ]
      .filter((value): value is string => typeof value === 'string')
      .join(' ')
      .toLowerCase();
    return haystack.includes(needle);
  });
}

// ── Ordering ─────────────────────────────────────────────────────────────────

/** Epoch ms of a lead's last activity; undated or invalid sinks to 0. */
export function leadActivityTime(lead: Lead): number {
  const parsed = lead.last_active_at ? Date.parse(lead.last_active_at) : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * The table's comparators, ascending. `DataTable` negates for descending rather
 * than reversing the array, so ties keep their order in both directions.
 *
 * Every one of them has a stable tiebreak on `session_id`. Without it two leads
 * with the same score swap places on every re-render, which reads as the table
 * shuffling under the cursor.
 */
export const compareLeads = {
  name: (a: Lead, b: Lead) =>
    leadDisplayName(a).localeCompare(leadDisplayName(b)) || a.session_id.localeCompare(b.session_id),
  company: (a: Lead, b: Lead) =>
    (companyDisplay(a.contact)?.value ?? '').localeCompare(companyDisplay(b.contact)?.value ?? '') ||
    a.session_id.localeCompare(b.session_id),
  score: (a: Lead, b: Lead) =>
    (a.score ?? 0) - (b.score ?? 0) ||
    TIER_ORDER.indexOf(normalizeTier(a.status)) - TIER_ORDER.indexOf(normalizeTier(b.status)) ||
    a.session_id.localeCompare(b.session_id),
  chats: (a: Lead, b: Lead) =>
    (a.chats ?? 0) - (b.chats ?? 0) || a.session_id.localeCompare(b.session_id),
  lastActive: (a: Lead, b: Lead) =>
    leadActivityTime(a) - leadActivityTime(b) || a.session_id.localeCompare(b.session_id),
} as const;

// ── Qualification dimensions ─────────────────────────────────────────────────

/**
 * Canonical B-A-N-T display order.
 *
 * The backend emits a bot's framework dimensions in its own order (need /
 * timeline / authority / budget), so they are re-sorted here to read "BANT".
 * Dimensions outside this set — MEDDIC, CHAMP — sort after the four and keep
 * their original relative order, because `Array#sort` is stable.
 */
const BANT_ORDER: readonly string[] = ['budget', 'authority', 'need', 'timeline'];

function bantOrderIndex(key: string): number {
  const index = BANT_ORDER.indexOf(key.toLowerCase());
  return index === -1 ? BANT_ORDER.length : index;
}

export interface LeadDimension {
  key: string;
  /** "Budget", "Economic buyer" — a real word, never an initial. */
  label: string;
  score: number;
  /** What the visitor actually said, when the extractor captured something. */
  value: string | null;
  captured: boolean;
}

/** Turn a dimension key ("economic_buyer") into a label ("Economic buyer"). */
export function humanizeDimension(key: string): string {
  const spaced = key.replace(/_/g, ' ').trim();
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : key;
}

/** A lead's framework dimensions, in BANT reading order. */
export function orderedDimensions(lead: Pick<Lead, 'bant'>): LeadDimension[] {
  return Object.entries(lead.bant ?? {})
    .sort(([a], [b]) => bantOrderIndex(a) - bantOrderIndex(b))
    .map(([key, dimension]) => ({
      key,
      label: humanizeDimension(key),
      score: dimension?.score ?? 0,
      value: dimension?.value ?? null,
      captured: (dimension?.score ?? 0) > 0,
    }));
}

/**
 * The denominator shown beside a dimension's score.
 *
 * The composite score is 100 shared equally across the framework's dimensions,
 * so the ceiling is `100 / count` — 25 for BANT, 20 for a five-dimension
 * framework like MEDDIC. It is deliberately NOT floored to the highest observed
 * score: doing that made the denominator a property of the lead rather than of
 * the bot, so two leads on the same chatbot were shown "18 / 25" and "30 / 30"
 * and neither number meant anything. An unevenly-weighted dimension that
 * exceeds the ceiling is clamped in the bar and reported honestly in the text.
 */
export function dimensionMax(dimensionCount: number): number {
  return Math.max(1, Math.round(100 / Math.max(dimensionCount, 1)));
}

// ── Identity and contact ─────────────────────────────────────────────────────

/** A short display name — the real one, else "Anonymous visitor". */
export function leadDisplayName(lead: Lead): string {
  return hasContactName(lead) ? (lead.contact?.name as string).trim() : translateNow('leads.anonymousVisitor') || 'Anonymous visitor';
}

/** Up to two letters for an avatar, or `?` when the visitor stayed anonymous. */
export function leadInitials(lead: Lead): string {
  const name = lead.contact?.name?.trim();
  if (!name) return '?';
  const parts = name.split(/\s+/).filter(Boolean).slice(0, 2);
  return parts.map((part) => part.charAt(0).toUpperCase()).join('') || '?';
}

/**
 * What a lead's company row shows: the resolved name with the raw domain
 * beneath it, or just the domain, or nothing.
 *
 * `contact.company` holds the registrable domain of the captured email
 * ("infosys.com") and always has. `contact.company_name` is the resolved
 * identity ("Infosys Limited"), produced by a Professional-gated paid
 * enrichment and therefore frequently ABSENT — resolution can fail, be switched
 * off per agent, or still be in flight.
 *
 * So the resolved name appends to the domain, never replaces it. Rendering only
 * `company_name` would blank the company row for every lead on a lower plan and
 * every domain that could not be resolved.
 */
export function companyDisplay(
  contact: LeadContact | null | undefined,
): { value: string; secondary?: string } | null {
  const domain = contact?.company?.trim() || null;
  const resolved = contact?.company_name?.trim() || null;

  if (resolved) return domain ? { value: resolved, secondary: domain } : { value: resolved };
  return domain ? { value: domain } : null;
}

// ── Location ─────────────────────────────────────────────────────────────────

/**
 * What a cell shows when a lead's geography could not be resolved.
 *
 * Exported because non-table consumers have to recognise it and substitute
 * their own representation of absence — the CSV export blanks it, since a
 * spreadsheet says "no value" with an empty cell and a CRM importing the word
 * would create a country called Unknown.
 */
export const UNKNOWN_LOCATION = 'Unknown';

/**
 * Render a lead's location WITHOUT the visitor's IP address.
 *
 * The backend stores `ChatSession.location` as `"<City>, <Country> | <IP>"`
 * (see `chat_routes._resolve_and_update_location`) and stamps a bare
 * `"IP: <addr>"` placeholder before the background geo lookup resolves. A
 * visitor IP is personal data under GDPR/DPDP and has no place in an
 * operator-facing table, so everything from the `|` separator onward is
 * dropped, and the placeholder degrades to {@link UNKNOWN_LOCATION} rather than
 * printing a bare address.
 *
 * MIRROR. This is the twin of `format_visitor_location` in
 * `api/app/core/visitor_privacy.py`, which is the source of truth: the server
 * redacts at every serialisation boundary, so a `location` arriving here has
 * already been through the Python copy. This one stays as belt and braces for
 * payloads cached from an older build, and because the export it feeds is
 * assembled entirely in the browser. It is idempotent, so the two passes cannot
 * fight. Change one, change the other — a divergence between exactly these two
 * implementations is what leaked every lead's IP through `GET /leads/export`.
 */
export function formatLocation(raw: string | null | undefined): string {
  const value = (raw ?? '').trim();
  if (!value) return UNKNOWN_LOCATION;
  // "IP: 1.2.3.4" is the pre-resolution stamp. No geography in it at all.
  if (/^ip:/i.test(value)) return UNKNOWN_LOCATION;
  const geo = value.split('|')[0]?.trim() ?? '';
  return geo || UNKNOWN_LOCATION;
}
