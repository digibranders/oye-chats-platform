
import { t as translateNow } from '../../i18n/i18n';/**
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

// ── Language analytics ───────────────────────────────────────────────────────

/** One language's share of a chatbot's conversations. */
export interface LanguageRow {
  /** Base language code, or null for sessions with no detected language. */
  languageCode: string | null;
  /** Display name, resolved server-side. Never derived in the client. */
  label: string;
  total: number;
  /** Conversations the visitor explicitly marked resolved. A subset of `total`. */
  resolved: number;
  /** Conversations that reached an operator, including ones since closed. */
  liveChat: number;
}

/**
 * Rolling translation activity. NOT history: these come from Redis counters
 * that expire after roughly a day, so `windowHours` bounds everything here and
 * the surface rendering it is required to say so. Durable translation cost
 * lives in `creditsSpent`, which is the ledger and does not expire.
 */
export interface TranslationActivity {
  requests: number;
  ok: number;
  failed: number;
  timeout: number;
  windowHours: number;
}

export interface LanguageBreakdown {
  /** False when the chatbot has multilingual off; the whole panel is hidden. */
  multilingualEnabled: boolean;
  /** False when operator translation is off; the translation figures are hidden. */
  operatorTranslationEnabled: boolean;
  rows: LanguageRow[];
  totals: { total: number; resolved: number; liveChat: number; languages: number };
  /** Rolling. Expires. */
  translation: TranslationActivity;
  /** Durable, from the credit ledger, scoped to the requested period. */
  creditsSpent: number;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Narrow the `/analytics/language-breakdown` payload.
 *
 * Totals are the server's and are NOT recomputed from the rows, so the figures
 * always match what the endpoint reported. Recomputing here would let a
 * client-side parsing quirk silently disagree with the API.
 */
export function parseLanguageBreakdown(record: Record<string, unknown>): LanguageBreakdown {
  const rowsRaw = Array.isArray(record.conversations) ? record.conversations : [];
  const totals = asRecord(record.totals);
  const translation = asRecord(record.translation);
  const cost = asRecord(record.cost);

  const rows: LanguageRow[] = rowsRaw.map((entry) => {
    const row = asRecord(entry);
    const code = typeof row.language_code === 'string' && row.language_code ? row.language_code : null;
    return {
      languageCode: code,
      // The server always sends a label, including for the null row. Falling
      // back keeps a malformed payload readable rather than blank.
      label: typeof row.label === 'string' && row.label ? row.label : (code?.toUpperCase() ?? (translateNow('analytics.notDetected') || 'Not detected')),
      total: toNumber(row.total),
      resolved: toNumber(row.resolved),
      liveChat: toNumber(row.live_chat),
    };
  });

  return {
    multilingualEnabled: record.multilingual_enabled === true,
    operatorTranslationEnabled: record.operator_translation_enabled === true,
    rows,
    totals: {
      total: toNumber(totals.total),
      resolved: toNumber(totals.resolved),
      liveChat: toNumber(totals.live_chat),
      languages: toNumber(totals.languages),
    },
    translation: {
      requests: toNumber(translation.requests),
      ok: toNumber(translation.ok),
      failed: toNumber(translation.failed),
      timeout: toNumber(translation.timeout),
      // Defaulted so the panel never renders "last 0 hours".
      windowHours: toNumber(translation.window_hours) || 24,
    },
    creditsSpent: toNumber(cost.credits),
  };
}
