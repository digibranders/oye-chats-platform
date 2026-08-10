/**
 * Leads - domain model helpers.
 *
 * Pure, side-effect-free functions that translate the legacy backend shapes
 * (getLeads / getLeadStats / getQualificationFunnel) into the typed,
 * plain-language view models the Leads page renders. Keeping this logic out of
 * the components makes it unit-testable and keeps the JSX declarative.
 *
 * Vocabulary decision (mandate): the backend speaks BANT jargon
 * (unqualified / mql / sal / sql). Buyers of this product don't. Every tier is
 * given a plain-language label ("Ready to buy") so the page answers its one
 * question - "Who are my qualified leads?" - without a glossary.
 */
import { type StatusBadgeProps } from '../../design-system';
import { type Lead } from '../../types/domain';

// ── Tiers ────────────────────────────────────────────────────────────────────

/** Canonical qualification tiers, coldest → hottest. */
export type TierKey = 'unqualified' | 'mql' | 'sal' | 'sql';

/** Tiers in pipeline order (used for filters, funnels, and summaries). */
export const TIER_ORDER: readonly TierKey[] = ['unqualified', 'mql', 'sal', 'sql'];

export interface TierMeta {
  /** Plain-language label shown to the user - no BANT/MQL jargon. */
  readonly label: string;
  /** The industry acronym, kept for the tooltip / power users. */
  readonly code: string;
  /** One-line explanation of what the tier means. */
  readonly hint: string;
  /** DS badge tone for the quality pill. */
  readonly tone: NonNullable<StatusBadgeProps['tone']>;
}

export const TIER_META: Record<TierKey, TierMeta> = {
  unqualified: {
    label: 'Just exploring',
    code: 'Unqualified',
    hint: 'Early interest - keep nurturing before a sales reach-out.',
    tone: 'neutral',
  },
  mql: {
    label: 'Warm lead',
    code: 'MQL',
    hint: 'Showing real buying signals - worth a marketing follow-up.',
    tone: 'info',
  },
  sal: {
    label: 'Strong interest',
    code: 'SAL',
    hint: 'Ready for a sales conversation - reach out soon.',
    tone: 'warning',
  },
  sql: {
    label: 'Ready to buy',
    code: 'SQL',
    hint: 'High intent - prioritise this lead today.',
    tone: 'success',
  },
};

/**
 * Normalise a raw status string (legacy cold/warm/hot/qualified OR the newer
 * BANT unqualified/mql/sal/sql) into a canonical {@link TierKey}. Unknown
 * values fall back to the coldest tier so a row never renders blank.
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

// ── Score → tone ──────────────────────────────────────────────────────────────

export type ScoreTone = 'neutral' | 'info' | 'warning' | 'success';

/** Map a 0–100 qualification score onto a semantic tone for bars/gauges. */
export function scoreTone(score: number): ScoreTone {
  if (score >= 75) return 'success';
  if (score >= 55) return 'warning';
  if (score >= 30) return 'info';
  return 'neutral';
}

/** CSS variable name for a score tone's fill colour. */
export const SCORE_TONE_VAR: Record<ScoreTone, string> = {
  neutral: 'var(--ds-text-subtle)',
  info: 'var(--ds-info)',
  warning: 'var(--ds-warning)',
  success: 'var(--ds-success)',
};

// ── Safe readers for the loosely-typed legacy envelopes ───────────────────────

function toNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

// ── Lead stats summary ────────────────────────────────────────────────────────

export interface LeadStatsSummary {
  total: number;
  unqualified: number;
  mql: number;
  sal: number;
  sql: number;
  /** MQL + SAL + SQL - everyone past the "just exploring" line. */
  qualified: number;
  avgScore: number;
  /** New leads the user hasn't opened yet. */
  unread: number;
}

/**
 * Read the (loosely-typed) getLeadStats envelope into a typed summary. The
 * backend ships either legacy keys (cold/warm/hot/qualified) or BANT keys
 * (unqualified/mql/sal/sql); we accept both.
 */
export function readLeadStats(raw: Record<string, unknown> | null | undefined): LeadStatsSummary {
  const src = raw ?? {};
  const unqualified = toNumber(src.unqualified ?? src.cold);
  const mql = toNumber(src.mql ?? src.warm);
  const sal = toNumber(src.sal ?? src.hot);
  const sql = toNumber(src.sql ?? src.qualified);
  return {
    total: toNumber(src.total),
    unqualified,
    mql,
    sal,
    sql,
    qualified: mql + sal + sql,
    avgScore: Math.round(toNumber(src.avg_score)),
    unread: toNumber(src.unread),
  };
}

// ── Qualification funnel ──────────────────────────────────────────────────────

export interface FunnelStageView {
  readonly key: string;
  readonly label: string;
  readonly sublabel: string;
  count: number;
  /** Share of this stage vs. the top of the funnel (0–100). */
  widthPct: number;
  /** Conversion from the previous stage (0–100), or null for the top stage. */
  conversionFromPrev: number | null;
}

interface FunnelStageDef {
  readonly key: string;
  readonly label: string;
  readonly sublabel: string;
}

/** The canonical visitor → meeting funnel, in order. */
const FUNNEL_STAGE_DEFS: readonly FunnelStageDef[] = [
  { key: 'total_visitors', label: 'Visitors', sublabel: 'Landed on your site' },
  { key: 'engaged', label: 'Engaged', sublabel: 'Started a chat' },
  { key: 'mql', label: 'Warm leads', sublabel: 'Showed buying signals' },
  { key: 'sal', label: 'Strong interest', sublabel: 'Sales-ready' },
  { key: 'sql', label: 'Ready to buy', sublabel: 'High intent' },
  { key: 'meetings_booked', label: 'Meetings', sublabel: 'Booked a call' },
];

/**
 * Read the getQualificationFunnel envelope (`{ funnel: [{ stage, count }] }`)
 * into ordered, presentation-ready stages with derived widths and
 * stage-to-stage conversion rates.
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
    const count = counts.get(def.key) ?? 0;
    // Clamp to 100: a downstream stage can exceed an upstream one when the two
    // counts come from different measurement windows, which would otherwise
    // overflow the bar / show a >100% conversion pill.
    const conversionFromPrev =
      prev !== null && prev > 0 ? Math.min((count / prev) * 100, 100) : null;
    const widthPct = top > 0 ? Math.min(Math.max((count / top) * 100, count > 0 ? 3 : 0), 100) : 0;
    prev = count;
    return { ...def, count, widthPct, conversionFromPrev };
  });
}

/** Does this funnel carry any data worth rendering? */
export function funnelHasData(stages: FunnelStageView[]): boolean {
  return stages.some((s) => s.count > 0);
}

// ── Lead list filtering ───────────────────────────────────────────────────────

export type ContactFilter = 'named' | 'anonymous' | 'all';

export interface LeadFilters {
  tier: TierKey | null;
  contact: ContactFilter;
  query: string;
}

/** Does the lead have a real contact name attached? */
export function hasContactName(lead: Lead): boolean {
  const name = lead.contact?.name;
  return typeof name === 'string' && name.trim() !== '';
}

/** Apply the active tier / contact-type / search filters to the lead list. */
export function filterLeads(leads: Lead[], filters: LeadFilters): Lead[] {
  const q = filters.query.trim().toLowerCase();
  return leads.filter((lead) => {
    if (filters.tier && normalizeTier(lead.status) !== filters.tier) return false;
    if (filters.contact === 'named' && !hasContactName(lead)) return false;
    if (filters.contact === 'anonymous' && hasContactName(lead)) return false;
    if (q) {
      const haystack = [
        lead.contact?.name,
        lead.contact?.email,
        lead.contact?.company,
        lead.location,
        lead.session_id,
      ]
        .filter((v): v is string => typeof v === 'string')
        .join(' ')
        .toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });
}

// ── Formatters ────────────────────────────────────────────────────────────────

/**
 * Render a lead's location WITHOUT the visitor's IP address.
 *
 * The backend stores `ChatSession.location` as `"<City>, <Country> | <IP>"`
 * (see `chat_routes._resolve_and_update_location`), and stamps a bare
 * `"IP: <addr>"` placeholder before the background geo lookup resolves. A
 * visitor IP is personal data under GDPR/DPDP and has no place in an
 * operator-facing table, so everything from the `|` separator onward is
 * dropped, and the placeholder degrades to "Unknown" rather than printing a
 * bare address. The raw value is left untouched in the database, where ops
 * still needs it.
 */
export function formatLocation(raw: string | null | undefined): string {
  const value = (raw ?? '').trim();
  if (!value) return 'Unknown';
  // "IP: 1.2.3.4" is the pre-resolution stamp — no geography in it at all.
  if (/^ip:/i.test(value)) return 'Unknown';
  const geo = value.split('|')[0]?.trim() ?? '';
  return geo || 'Unknown';
}

/** Format an ISO timestamp as a compact "Jul 21, 3:04 PM"; em-dash on absence. */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '-';
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return '-';
  return new Date(parsed).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** A short display name for a lead - real name, else "Anonymous visitor". */
export function leadDisplayName(lead: Lead): string {
  return hasContactName(lead) ? (lead.contact?.name as string) : 'Anonymous visitor';
}

/** Up-to-two-letter initials for an avatar chip. */
export function leadInitials(lead: Lead): string {
  const name = lead.contact?.name?.trim();
  if (name) {
    const parts = name.split(/\s+/).slice(0, 2);
    return parts.map((p) => p.charAt(0).toUpperCase()).join('');
  }
  return '?';
}

/** Turn a dimension key ("authority") into a label ("Authority"). */
export function humanizeDimension(key: string): string {
  return key
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (m) => m.toUpperCase());
}
