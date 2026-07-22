/**
 * Qualification model — the typed shape behind a bot's `bant_config`, plus the
 * pure parse/serialize/mutation helpers the editor drives.
 *
 * `bant_config` is stored server-side as an opaque object whose top level mixes
 * per-dimension scoring maps with a handful of reserved meta keys. This module
 * narrows that loose payload into a strongly-typed `QualModel`, and serializes
 * back to the exact on-disk shape the backend expects — so persisted values stay
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
  timeline_decay_per_30d: number;
  need_decay_per_30d: number;
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

export const DEFAULT_DECAY: QualDecay = {
  enabled: true,
  timeline_decay_per_30d: 5,
  need_decay_per_30d: 3,
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

/** BANT default dimensions — mirrors DEFAULT_BANT_CONFIG in lead_service.py. */
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

function coerceDecay(raw: unknown): QualDecay {
  if (!isRecord(raw)) return { ...DEFAULT_DECAY };
  return {
    enabled: toBool(raw.enabled, DEFAULT_DECAY.enabled),
    timeline_decay_per_30d: toNum(raw.timeline_decay_per_30d, DEFAULT_DECAY.timeline_decay_per_30d),
    need_decay_per_30d: toNum(raw.need_decay_per_30d, DEFAULT_DECAY.need_decay_per_30d),
  };
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
export function parseModel(raw: Record<string, unknown> | null, framework: string): QualModel {
  if (!raw || Object.keys(raw).length === 0) {
    return {
      framework,
      order: [...DEFAULT_ORDER],
      dimensions: structuredClone(DEFAULT_DIMENSIONS),
      thresholds: { ...DEFAULT_THRESHOLDS },
      decay: { ...DEFAULT_DECAY },
      behavioral: { ...DEFAULT_BEHAVIORAL, known_referrers: [...DEFAULT_BEHAVIORAL.known_referrers] },
    };
  }

  const order = readOrder(raw);
  const dimensions: Record<string, QualDimension> = {};
  for (const key of order) {
    dimensions[key] = coerceDimension(raw[key], key);
  }

  return {
    framework: toStr(raw.framework, framework),
    order,
    dimensions,
    thresholds: coerceThresholds(raw.thresholds),
    decay: coerceDecay(raw.decay),
    behavioral: coerceBehavioral(raw.behavioral_config),
  };
}

/** Serialize a typed model back to the exact `bant_config` shape the API stores. */
export function serializeModel(model: QualModel): Record<string, unknown> {
  const out: Record<string, unknown> = {
    framework: model.framework,
    thresholds: { ...model.thresholds },
    conversation_order: [...model.order],
    decay: { ...model.decay },
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
