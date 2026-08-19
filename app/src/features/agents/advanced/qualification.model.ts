/**
 * Qualification model - the typed shape behind a bot's `bant_config`, plus the
 * pure parse/serialize/mutation helpers the editor drives.
 *
 * `bant_config` is stored server-side as an opaque object whose top level mixes
 * per-dimension scoring maps with a handful of reserved meta keys. This module
 * narrows that loose payload into a strongly-typed `QualModel`, and serializes
 * back to the exact on-disk shape the backend expects - so persisted values stay
 * byte-compatible with:
 *   - api/app/services/lead_service.py    (DEFAULT_BANT_CONFIG, thresholds, decay)
 *   - api/app/services/behavioral_service.py (_DEFAULT_BEHAVIORAL_CONFIG)
 *
 * Reserved top-level meta keys (everything else is a scoring dimension):
 *   framework · thresholds · conversation_order · decay · behavioral_config
 */

// ── Types ────────────────────────────────────────────────────────────────────

export interface QualOption {
  label: string;
  score: number;
}

export interface QualDimension {
  enabled: boolean;
  weight: number;
  options: QualOption[];
  cta_enabled: boolean;
  cta_prompt: string;
  /** Human label; defaults to a title-cased form of the dimension key. */
  label: string;
}

export interface QualThresholds {
  mql: number;
  sal: number;
  sql: number;
}

export interface QualDecay {
  enabled: boolean;
  /**
   * Points shaved off a dimension's score per 30 days since it was last
   * assessed, keyed by dimension.
   *
   * Stored flat as `{dimension}_decay_per_30d`, which is how
   * `lead_service.apply_display_decay` reads it — per dimension, for **any**
   * framework, not just BANT's two. The editor this replaces exposed exactly
   * `timeline_` and `need_`, and hid the whole section for MEDDIC, where the
   * same mechanism works perfectly well and was simply unreachable.
   */
  rates: Record<string, number>;
}

/** Mirrors `_DEFAULT_BEHAVIORAL_CONFIG` in behavioral_service.py (field-for-field). */
export interface BehavioralConfig {
  enabled: boolean;
  max_score: number;
  return_visit_score: number;
  utm_present_score: number;
  time_on_site_threshold: number;
  time_on_site_score: number;
  pages_viewed_threshold: number;
  pages_viewed_score: number;
  known_referrer_score: number;
  known_referrers: string[];
}

/** Fully-typed, normalized view of a `bant_config`. */
export interface QualModel {
  framework: string;
  /** Ordered dimension keys (drives display + serialized `conversation_order`). */
  order: string[];
  dimensions: Record<string, QualDimension>;
  thresholds: QualThresholds;
  decay: QualDecay;
  behavioral: BehavioralConfig;
}

// ── Reserved keys + defaults ─────────────────────────────────────────────────

const META_KEYS: ReadonlySet<string> = new Set([
  'framework',
  'thresholds',
  'conversation_order',
  'decay',
  'behavioral_config',
]);

export const DEFAULT_THRESHOLDS: QualThresholds = { mql: 30, sal: 55, sql: 75 };

/**
 * The rates the server falls back to when a config omits them.
 *
 * `apply_display_decay` merges `DEFAULT_BANT_CONFIG["decay"]` *under* the stored
 * decay object, so omitting `timeline_decay_per_30d` does not mean "no decay on
 * timeline" — it means 5. `serializeModel` therefore writes every dimension's
 * rate explicitly, including the zeros, or a customer who set timeline decay to
 * 0 would find it back at 5.
 */
export const DEFAULT_DECAY_RATES: Readonly<Record<string, number>> = {
  timeline: 5,
  need: 3,
};

export const DEFAULT_DECAY: QualDecay = {
  enabled: true,
  rates: { ...DEFAULT_DECAY_RATES },
};

/** Field-for-field port of `_DEFAULT_BEHAVIORAL_CONFIG` (behavioral_service.py). */
export const DEFAULT_BEHAVIORAL: BehavioralConfig = {
  enabled: true,
  max_score: 20,
  return_visit_score: 5,
  utm_present_score: 3,
  time_on_site_threshold: 60,
  time_on_site_score: 3,
  pages_viewed_threshold: 3,
  pages_viewed_score: 4,
  known_referrer_score: 5,
  known_referrers: [
    'google.com',
    'linkedin.com',
    'facebook.com',
    'twitter.com',
    'x.com',
    'bing.com',
    'youtube.com',
    'github.com',
    'producthunt.com',
    'g2.com',
    'capterra.com',
  ],
};

/** BANT default dimensions - mirrors DEFAULT_BANT_CONFIG in lead_service.py. */
const DEFAULT_DIMENSIONS: Record<string, QualDimension> = {
  need: {
    enabled: true,
    weight: 25,
    options: [
      { label: 'Just browsing', score: 5 },
      { label: 'Exploring solutions', score: 10 },
      { label: 'Active pain point', score: 15 },
      { label: 'Urgent need', score: 20 },
      { label: 'Critical / blocking', score: 25 },
    ],
    cta_enabled: false,
    cta_prompt: 'What best describes your situation?',
    label: 'Need',
  },
  timeline: {
    enabled: true,
    weight: 25,
    options: [
      { label: 'No timeline', score: 5 },
      { label: '6-12 months', score: 10 },
      { label: '3-6 months', score: 15 },
      { label: '1-3 months', score: 20 },
      { label: 'This month', score: 25 },
    ],
    cta_enabled: false,
    cta_prompt: 'When are you looking to get started?',
    label: 'Timeline',
  },
  authority: {
    enabled: true,
    weight: 25,
    options: [
      { label: 'Researching for someone', score: 5 },
      { label: 'Team member / influencer', score: 10 },
      { label: 'Manager / champion', score: 15 },
      { label: 'Decision maker', score: 20 },
      { label: 'Budget owner', score: 25 },
    ],
    cta_enabled: false,
    cta_prompt: "What's your role in this decision?",
    label: 'Authority',
  },
  budget: {
    enabled: true,
    weight: 25,
    options: [
      { label: 'No budget yet', score: 5 },
      { label: 'Under $1K/mo', score: 10 },
      { label: '$1K-5K/mo', score: 15 },
      { label: '$5K-20K/mo', score: 20 },
      { label: '$20K+/mo', score: 25 },
    ],
    cta_enabled: false,
    cta_prompt: 'Do you have a budget range in mind?',
    label: 'Budget',
  },
};

const DEFAULT_ORDER: readonly string[] = ['need', 'timeline', 'authority', 'budget'];

// ── Coercion primitives ──────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Coerce to a finite number, falling back when the value is missing/invalid. */
export function toNum(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function toBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function toStr(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

/** Title-case a dimension key for display, e.g. `decision_role` → `Decision Role`. */
export function toLabel(key: string): string {
  return key
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (match) => match.toUpperCase())
    .trim();
}

/** Normalize a free-text dimension name into a safe object key. */
export function normalizeDimensionKey(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function coerceOption(raw: unknown): QualOption {
  if (!isRecord(raw)) return { label: '', score: 0 };
  return { label: toStr(raw.label, ''), score: toNum(raw.score, 0) };
}

function coerceDimension(raw: unknown, key: string): QualDimension {
  if (!isRecord(raw)) {
    return {
      enabled: true,
      weight: 0,
      options: [],
      cta_enabled: false,
      cta_prompt: '',
      label: toLabel(key),
    };
  }
  const options = Array.isArray(raw.options) ? raw.options.map(coerceOption) : [];
  return {
    enabled: toBool(raw.enabled, true),
    weight: toNum(raw.weight, 0),
    options,
    cta_enabled: toBool(raw.cta_enabled, false),
    cta_prompt: toStr(raw.cta_prompt, ''),
    label: toStr(raw.label, toLabel(key)),
  };
}

function coerceThresholds(raw: unknown): QualThresholds {
  if (!isRecord(raw)) return { ...DEFAULT_THRESHOLDS };
  return {
    mql: toNum(raw.mql, DEFAULT_THRESHOLDS.mql),
    sal: toNum(raw.sal, DEFAULT_THRESHOLDS.sal),
    sql: toNum(raw.sql, DEFAULT_THRESHOLDS.sql),
  };
}

/** The default decay rate for each key in `order` — 0 unless the server has one. */
export function decayRatesFor(order: readonly string[]): Record<string, number> {
  return Object.fromEntries(order.map((key) => [key, DEFAULT_DECAY_RATES[key] ?? 0]));
}

/** Read `{dimension}_decay_per_30d` for every dimension in `order`. */
function coerceDecay(raw: unknown, order: readonly string[]): QualDecay {
  const source = isRecord(raw) ? raw : {};
  const rates: Record<string, number> = {};
  for (const key of order) {
    rates[key] = toNum(source[`${key}_decay_per_30d`], DEFAULT_DECAY_RATES[key] ?? 0);
  }
  return { enabled: toBool(source.enabled, DEFAULT_DECAY.enabled), rates };
}

function coerceBehavioral(raw: unknown): BehavioralConfig {
  if (!isRecord(raw)) return { ...DEFAULT_BEHAVIORAL, known_referrers: [...DEFAULT_BEHAVIORAL.known_referrers] };
  const referrers = Array.isArray(raw.known_referrers)
    ? raw.known_referrers.filter((item): item is string => typeof item === 'string')
    : [...DEFAULT_BEHAVIORAL.known_referrers];
  return {
    enabled: toBool(raw.enabled, DEFAULT_BEHAVIORAL.enabled),
    max_score: toNum(raw.max_score, DEFAULT_BEHAVIORAL.max_score),
    return_visit_score: toNum(raw.return_visit_score, DEFAULT_BEHAVIORAL.return_visit_score),
    utm_present_score: toNum(raw.utm_present_score, DEFAULT_BEHAVIORAL.utm_present_score),
    time_on_site_threshold: toNum(raw.time_on_site_threshold, DEFAULT_BEHAVIORAL.time_on_site_threshold),
    time_on_site_score: toNum(raw.time_on_site_score, DEFAULT_BEHAVIORAL.time_on_site_score),
    pages_viewed_threshold: toNum(raw.pages_viewed_threshold, DEFAULT_BEHAVIORAL.pages_viewed_threshold),
    pages_viewed_score: toNum(raw.pages_viewed_score, DEFAULT_BEHAVIORAL.pages_viewed_score),
    known_referrer_score: toNum(raw.known_referrer_score, DEFAULT_BEHAVIORAL.known_referrer_score),
    known_referrers: referrers,
  };
}

/** Resolve the ordered list of dimension keys from a raw config. */
function readOrder(raw: Record<string, unknown>): string[] {
  const declared = Array.isArray(raw.conversation_order)
    ? raw.conversation_order.filter((item): item is string => typeof item === 'string')
    : [];
  const keys: string[] = [];
  for (const key of declared) {
    if (!META_KEYS.has(key) && isRecord(raw[key]) && !keys.includes(key)) keys.push(key);
  }
  for (const key of Object.keys(raw)) {
    if (META_KEYS.has(key) || keys.includes(key)) continue;
    if (isRecord(raw[key])) keys.push(key);
  }
  return keys;
}

// ── Public parse / serialize ─────────────────────────────────────────────────

/**
 * Narrow a raw `bant_config` (or null) into a fully-typed, normalized model.
 * When the payload is empty, the BANT defaults are used so the editor always has
 * a sensible, complete starting point.
 */
export function parseModel(
  raw: Record<string, unknown> | null,
  framework: string,
  /**
   * The server's own preset for `framework`, from `GET /bots/{id}/framework-presets`.
   *
   * Used when the bot has no stored config, or a config that names a framework
   * but carries no dimensions. Without it a MEDDIC bot with no config rendered
   * BANT's four dimensions — the client only ships BANT defaults — and applying
   * that would have written need/timeline/authority/budget over a MEDDIC bot.
   */
  preset?: Record<string, unknown> | null,
): QualModel {
  const seed = preset && readOrder(preset).length > 0 ? preset : null;

  if (!raw || Object.keys(raw).length === 0) {
    if (seed) return parseModel(seed, framework);
    return {
      framework,
      order: [...DEFAULT_ORDER],
      dimensions: structuredClone(DEFAULT_DIMENSIONS),
      thresholds: { ...DEFAULT_THRESHOLDS },
      decay: { enabled: true, rates: decayRatesFor(DEFAULT_ORDER) },
      behavioral: { ...DEFAULT_BEHAVIORAL, known_referrers: [...DEFAULT_BEHAVIORAL.known_referrers] },
    };
  }

  const order = readOrder(raw);
  const resolvedFramework = toStr(raw.framework, framework);

  // A non-empty but DIMENSIONLESS config (e.g. `{"framework":"bant"}` - what the
  // backend stores when a framework is stamped without a full config) would
  // otherwise render zero scoring dimensions and let "Apply" persist an empty
  // conversation_order. Seed the default dimensions so the editor always has a
  // complete starting point, while preserving any thresholds/decay/behavioural
  // that were stored. (Only BANT presets are available client-side; non-BANT
  // dimensions are filled from the framework preset at scoring time server-side.)
  if (order.length === 0) {
    const seeded = seed ? parseModel(seed, resolvedFramework) : null;
    const seededOrder = seeded ? seeded.order : [...DEFAULT_ORDER];
    return {
      framework: resolvedFramework,
      order: seededOrder,
      dimensions: seeded ? seeded.dimensions : structuredClone(DEFAULT_DIMENSIONS),
      thresholds: coerceThresholds(raw.thresholds),
      decay: coerceDecay(raw.decay, seededOrder),
      behavioral: coerceBehavioral(raw.behavioral_config),
    };
  }

  const dimensions: Record<string, QualDimension> = {};
  for (const key of order) {
    dimensions[key] = coerceDimension(raw[key], key);
  }

  return {
    framework: resolvedFramework,
    order,
    dimensions,
    thresholds: coerceThresholds(raw.thresholds),
    decay: coerceDecay(raw.decay, order),
    behavioral: coerceBehavioral(raw.behavioral_config),
  };
}

/** Serialize a typed model back to the exact `bant_config` shape the API stores. */
export function serializeModel(model: QualModel): Record<string, unknown> {
  const out: Record<string, unknown> = {
    framework: model.framework,
    thresholds: { ...model.thresholds },
    conversation_order: [...model.order],
    decay: {
      enabled: model.decay.enabled,
      ...Object.fromEntries(
        model.order.map((key) => [`${key}_decay_per_30d`, model.decay.rates[key] ?? 0]),
      ),
    },
    behavioral_config: { ...model.behavioral, known_referrers: [...model.behavioral.known_referrers] },
  };
  for (const key of model.order) {
    const dim = model.dimensions[key];
    if (!dim) continue;
    out[key] = {
      enabled: dim.enabled,
      weight: dim.weight,
      options: dim.options.map((option) => ({ label: option.label, score: option.score })),
      cta_enabled: dim.cta_enabled,
      cta_prompt: dim.cta_prompt,
      label: dim.label,
    };
  }
  return out;
}

/** Sum of weights across enabled dimensions (drives the "should sum to 100" hint). */
export function enabledWeightTotal(model: QualModel): number {
  return model.order.reduce((total, key) => {
    const dim = model.dimensions[key];
    return dim && dim.enabled ? total + dim.weight : total;
  }, 0);
}

/** Build a fresh custom dimension with a unique key, ready to append. */
export function makeDimension(existingKeys: readonly string[]): { key: string; dimension: QualDimension } {
  let index = existingKeys.length + 1;
  let key = `dimension_${index}`;
  while (existingKeys.includes(key)) {
    index += 1;
    key = `dimension_${index}`;
  }
  return {
    key,
    dimension: {
      enabled: true,
      weight: 10,
      options: [
        { label: 'Low', score: 4 },
        { label: 'Medium', score: 8 },
        { label: 'High', score: 12 },
      ],
      cta_enabled: false,
      cta_prompt: '',
      label: toLabel(key),
    },
  };
}

// ── Validation ───────────────────────────────────────────────────────────────

export type ThresholdKey = keyof QualThresholds;

export interface QualValidation {
  /** Keyed by dimension key. Rendered by that dimension's own `Field`. */
  dimensions: Record<string, string>;
  /** Keyed by tier. Rendered by that threshold's own `Field`. */
  thresholds: Partial<Record<ThresholdKey, string>>;
  /** One field-level error on the behavioural cap. */
  behavioralMaxScore: string | null;
  /**
   * The single sentence the Save bar shows while saving is refused.
   *
   * Null when the model is safe to persist. It names the specific failure, not
   * "please fix the errors above" — a reader who has scrolled past the offending
   * card has no way to act on the generic form.
   */
  blockedReason: string | null;
}

/** Sum of weights across enabled dimensions. */
export function weightTotal(model: QualModel): number {
  return enabledWeightTotal(model);
}

/**
 * A dimension's real share of the composite score, as a percentage.
 *
 * The server does **not** require weights to sum to 100: `calculate_composite_score`
 * divides each weight by the total across enabled dimensions, so the weights are
 * relative and a set summing to 80 or 130 scores identically to the same ratios
 * summing to 100. Showing the effective share is therefore the honest readout,
 * and it is what stops a customer believing an unbalanced set is broken when it
 * is merely unnormalised.
 */
export function effectiveShare(model: QualModel, key: string): number | null {
  const total = enabledWeightTotal(model);
  const dim = model.dimensions[key];
  if (!dim || !dim.enabled || total <= 0) return null;
  return (dim.weight / total) * 100;
}

/** True when a dimension can ever contribute points (an option above zero). */
export function dimensionCanScore(dimension: QualDimension): boolean {
  return dimension.options.some((option) => option.score > 0);
}

/**
 * Everything that would make this config score wrongly once it is live.
 *
 * The rules are the server's, not a house style:
 *
 * - `calculate_composite_score` returns 0 when no dimension is enabled, or when
 *   the enabled weights total 0. Either state pins every visitor at score 0
 *   forever, so no lead can reach a tier and the whole surface is inert.
 * - A dimension whose options all score 0 contributes nothing while still
 *   claiming its share of the weight, quietly dragging every composite down.
 * - `get_tier` tests SQL, then SAL, then MQL, and the composite is clamped to
 *   0–100. A threshold that is out of order, or above 100, makes its tier
 *   unreachable — the customer configures a tier that can never fire.
 */
export function validateModel(model: QualModel): QualValidation {
  const dimensions: Record<string, string> = {};
  const thresholds: Partial<Record<ThresholdKey, string>> = {};
  let behavioralMaxScore: string | null = null;

  const enabled = model.order.filter((key) => model.dimensions[key]?.enabled);

  for (const key of model.order) {
    const dim = model.dimensions[key];
    if (!dim) continue;
    if (!Number.isInteger(dim.weight) || dim.weight < 0 || dim.weight > 100) {
      dimensions[key] = 'Weight must be a whole number between 0 and 100.';
      continue;
    }
    if (!dim.enabled) continue;
    if (dim.options.length === 0) {
      dimensions[key] =
        'This dimension is switched on but has no answers to score, so it can only ever contribute 0 while still taking its share of the weight. Add an answer or switch it off.';
      continue;
    }
    if (!dimensionCanScore(dim)) {
      dimensions[key] =
        'Every answer here is worth 0 points, so this dimension can only ever contribute 0 while still taking its share of the weight. Give at least one answer a score above 0, or switch it off.';
    }
  }

  const { mql, sal, sql } = model.thresholds;
  const inRange = (value: number): boolean =>
    Number.isInteger(value) && value >= 0 && value <= 100;

  if (!inRange(mql)) thresholds.mql = 'Use a whole number between 0 and 100.';
  if (!inRange(sal)) thresholds.sal = 'Use a whole number between 0 and 100.';
  if (!inRange(sql)) thresholds.sql = 'Use a whole number between 0 and 100.';

  if (inRange(mql) && inRange(sal) && sal <= mql) {
    thresholds.sal = `Sales-accepted must be above marketing-qualified (${mql}). At ${sal} no lead can ever be sales-accepted.`;
  }
  if (inRange(sal) && inRange(sql) && sql <= sal) {
    thresholds.sql = `Sales-qualified must be above sales-accepted (${sal}). At ${sql} no lead can ever be sales-qualified.`;
  }

  if (!Number.isInteger(model.behavioral.max_score) || model.behavioral.max_score < 0) {
    behavioralMaxScore = 'Use a whole number of points, 0 or more.';
  }

  let blockedReason: string | null = null;
  if (enabled.length === 0) {
    blockedReason =
      'Lead scoring needs at least one dimension switched on. With none enabled every visitor scores 0 and no lead can ever reach a tier.';
  } else if (enabledWeightTotal(model) <= 0) {
    blockedReason =
      'Every enabled dimension has a weight of 0, so the composite score is always 0 and no lead can ever reach a tier. Give at least one dimension a weight above 0.';
  } else if (Object.keys(dimensions).length > 0) {
    const first = Object.keys(dimensions)[0];
    blockedReason = `${model.dimensions[first]?.label ?? toLabel(first)} cannot be saved as configured — see the error on that dimension.`;
  } else if (Object.keys(thresholds).length > 0) {
    const order: ThresholdKey[] = ['mql', 'sal', 'sql'];
    const first = order.find((key) => thresholds[key]);
    blockedReason = first
      ? `The ${TIER_SHORT[first]} threshold cannot be saved as configured — see the error on that field.`
      : null;
  } else if (behavioralMaxScore) {
    blockedReason = 'The behavioural score cap cannot be saved as configured.';
  }

  return { dimensions, thresholds, behavioralMaxScore, blockedReason };
}

/** Short spoken form of each tier, for messages that name one. */
export const TIER_SHORT: Record<ThresholdKey, string> = {
  mql: 'marketing-qualified',
  sal: 'sales-accepted',
  sql: 'sales-qualified',
};

/**
 * Rescale the enabled weights so they total 100, preserving their ratios.
 *
 * Offered as an action rather than enforced, because the server normalises
 * anyway. The remainder goes to the largest dimension so the total is exactly
 * 100 rather than 99 after rounding.
 */
export function balanceWeights(model: QualModel): QualModel {
  const enabled = model.order.filter((key) => model.dimensions[key]?.enabled);
  const total = enabledWeightTotal(model);
  if (enabled.length === 0 || total <= 0) return model;

  const dimensions = { ...model.dimensions };
  let assigned = 0;
  let largestKey = enabled[0];
  for (const key of enabled) {
    const dim = model.dimensions[key];
    if (!dim) continue;
    const scaled = Math.round((dim.weight / total) * 100);
    dimensions[key] = { ...dim, weight: scaled };
    assigned += scaled;
    if (dim.weight > (model.dimensions[largestKey]?.weight ?? 0)) largestKey = key;
  }
  const remainder = 100 - assigned;
  if (remainder !== 0) {
    const dim = dimensions[largestKey];
    if (dim) dimensions[largestKey] = { ...dim, weight: Math.max(0, dim.weight + remainder) };
  }
  return { ...model, dimensions };
}

/** A score band produced by a threshold set. */
export interface TierBand {
  label: string;
  /**
   * Green on sales-qualified alone, because that is the band that actually does
   * something — the only tier that sends the email and fires the webhook. The
   * other three are states, not outcomes, so they stay neutral rather than
   * spending three more colours on a ladder the reader can already read.
   */
  tone: 'neutral' | 'success';
  from: number;
  to: number;
}

/**
 * The score bands a threshold set produces.
 *
 * Derived rather than described, because three numbers in three boxes do not
 * tell anyone what a lead scoring 61 is. `get_tier` tests SQL, then SAL, then
 * MQL, so each band runs from its own threshold to one below the next — and a
 * band whose `to` falls below its `from` is a tier that can never fire.
 */
export function bandsFor(thresholds: QualThresholds): TierBand[] {
  const { mql, sal, sql } = thresholds;
  return [
    { label: 'Unqualified', tone: 'neutral', from: 0, to: mql - 1 },
    { label: 'Marketing qualified', tone: 'neutral', from: mql, to: sal - 1 },
    { label: 'Sales accepted', tone: 'neutral', from: sal, to: sql - 1 },
    { label: 'Sales qualified', tone: 'success', from: sql, to: 100 },
  ];
}
