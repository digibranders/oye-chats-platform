/**
 * Typed views over the loosely-typed analytics endpoints.
 *
 * `getRatingsSummary`, `getResolutionSummary` and `getLeadStats` are declared as
 * `Record<string, unknown>` in `services/api.d.ts` (server shapes vary), so these
 * parsers narrow the raw payloads into strict, `any`-free shapes at the boundary.
 * The real server shapes are defined in
 * `api/app/db/repository.py:get_ratings_summary` / `get_resolution_summary` and
 * `api/app/api/lead_routes.py:lead_stats`.
 */

export type RatingStar = 1 | 2 | 3 | 4 | 5;

export interface RatingsSummary {
  /** Weighted average 1–5, or null when there are no ratings yet. */
  avg: number | null;
  /** Total number of ratings. */
  total: number;
  /** Count of ratings per star bucket. */
  distribution: Record<RatingStar, number>;
}

export interface ResolutionSummary {
  resolved: number;
  unresolved: number;
  total: number;
  /** Percentage 0–100, or null when nothing has been rated. */
  rate: number | null;
}

export interface LeadStats {
  /** Total qualified-or-not sessions considered for lead scoring. */
  total: number;
  unqualified: number;
  /** Marketing-qualified leads. */
  mql: number;
  /** Sales-accepted leads. */
  sal: number;
  /** Sales-qualified leads. */
  sql: number;
}

/** One day on the (gap-filled) engagement timeline. */
export interface EngagementPoint {
  /** ISO `YYYY-MM-DD` key. */
  date: string;
  /** Short human label, e.g. "Mar 4". */
  label: string;
  messages: number;
}

const STARS: readonly RatingStar[] = [1, 2, 3, 4, 5];

function toNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function toNullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

export function parseRatingsSummary(raw: Record<string, unknown>): RatingsSummary {
  const dist = asRecord(raw.distribution);
  const distribution = STARS.reduce(
    (acc, star) => {
      acc[star] = toNumber(dist[String(star)] ?? dist[star]);
      return acc;
    },
    { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } as Record<RatingStar, number>,
  );
  return {
    avg: toNullableNumber(raw.avg),
    total: toNumber(raw.total),
    distribution,
  };
}

export function parseResolutionSummary(raw: Record<string, unknown>): ResolutionSummary {
  return {
    resolved: toNumber(raw.resolved),
    unresolved: toNumber(raw.unresolved),
    total: toNumber(raw.total),
    rate: toNullableNumber(raw.rate),
  };
}

/**
 * Narrow the lead-stats payload. Prefers the canonical `unqualified/mql/sal/sql`
 * keys and falls back to the legacy `cold/warm/hot/qualified` aliases the server
 * still emits (see `lead_routes.py:lead_stats`).
 */
export function parseLeadStats(raw: Record<string, unknown>): LeadStats {
  return {
    total: toNumber(raw.total),
    unqualified: toNumber(raw.unqualified ?? raw.cold),
    mql: toNumber(raw.mql ?? raw.warm),
    sal: toNumber(raw.sal ?? raw.hot),
    sql: toNumber(raw.sql ?? raw.qualified),
  };
}
