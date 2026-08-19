/**
 * Typed views over the loose analytics endpoints.
 *
 * Several of them are declared as `Record<string, unknown>` because their server
 * shape varies by plan and by API build. This module narrows those records into
 * strict view models the UI can trust: no `any`, every field defaulted, so a
 * missing key never crashes a card and never silently renders as `0`.
 */

/** Coerce an unknown value into a finite number, defaulting to 0. */
function toNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** Read a numeric field from a loose record, tolerating missing keys. */
function readNumber(record: Record<string, unknown>, ...keys: string[]): number {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return 0;
}

/**
 * Headline totals, from `getDashboardStats`.
 *
 * Only `totalConversations` and `totalMessages` honour the endpoint's `?days=`
 * filter — it narrows on `ChatSession.created_at`. `activeVisitors` is a live
 * fifteen-minute figure and `positiveFeedbackRate` is computed over all rated
 * answers ever, so both are labelled with their own period on screen rather
 * than inheriting the page's range. Rendering them under the range control's
 * label would be a lie the reader has no way to detect.
 */
export interface WorkspaceTotals {
  totalConversations: number;
  totalMessages: number;
  /** Sessions active in the last fifteen minutes. Never windowed. */
  activeVisitors: number;
  /** Share of rated answers that got a thumbs-up, 0 to 100. Never windowed. */
  positiveFeedbackRate: number;
  /** Distinct knowledge sources indexed. Never windowed. */
  knowledgeSources: number;
}

export function parseWorkspaceTotals(record: Record<string, unknown>): WorkspaceTotals {
  return {
    totalConversations: readNumber(record, 'total_conversations'),
    totalMessages: readNumber(record, 'total_messages'),
    activeVisitors: readNumber(record, 'active_users'),
    positiveFeedbackRate: readNumber(record, 'success_rate'),
    knowledgeSources: readNumber(record, 'total_documents'),
  };
}

/** Star-rating breakdown, from `getRatingsSummary`. */
export interface RatingsSummary {
  /** Mean rating 0 to 5. */
  average: number;
  /** Total number of ratings received. */
  total: number;
  /** Count per star, keyed 1 to 5. */
  distribution: Record<1 | 2 | 3 | 4 | 5, number>;
}

export function parseRatingsSummary(record: Record<string, unknown>): RatingsSummary {
  const rawDistribution =
    typeof record.distribution === 'object' && record.distribution !== null
      ? (record.distribution as Record<string, unknown>)
      : {};
  const distribution = {
    1: toNumber(rawDistribution['1']),
    2: toNumber(rawDistribution['2']),
    3: toNumber(rawDistribution['3']),
    4: toNumber(rawDistribution['4']),
    5: toNumber(rawDistribution['5']),
  } as Record<1 | 2 | 3 | 4 | 5, number>;
  return {
    average: readNumber(record, 'avg'),
    total: readNumber(record, 'total'),
    distribution,
  };
}

/** Conversation resolution metrics, from `getResolutionSummary`. */
export interface ResolutionSummary {
  /** Resolution rate 0-100, or null when the API did not report one. */
  rate: number | null;
  total: number;
}

export function parseResolutionSummary(record: Record<string, unknown>): ResolutionSummary {
  const rawRate = record.rate ?? record.resolution_rate;
  const rate = typeof rawRate === 'number' && Number.isFinite(rawRate) ? rawRate : null;
  return { rate, total: readNumber(record, 'total') };
}

/** Lead qualification counts, from `getLeadStats`. Always all-time. */
export interface LeadFunnelStats {
  total: number;
  /** Marketing-qualified leads. */
  mql: number;
  /** Sales-accepted leads. */
  sal: number;
  /** Sales-qualified (fully qualified) leads. */
  sql: number;
  /** Not yet qualified. */
  unqualified: number;
}

export function parseLeadFunnelStats(record: Record<string, unknown>): LeadFunnelStats {
  return {
    total: readNumber(record, 'total'),
    // Canonical keys first, legacy warm/hot/qualified aliases as fallback.
    mql: readNumber(record, 'mql', 'warm'),
    sal: readNumber(record, 'sal', 'hot'),
    sql: readNumber(record, 'sql', 'qualified'),
    unqualified: readNumber(record, 'unqualified', 'cold'),
  };
}
