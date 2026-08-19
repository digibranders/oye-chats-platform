import type { ConfigRow, JsonValue } from './types';

/**
 * Feature flags — which rows are switches, and what flipping one does.
 *
 * `GET /superadmin/feature-flags` is not its own store. It calls
 * `list_pricing_config` and returns the same rows, so the response contains
 * credit prices, RAG knobs and marketing copy alongside the actual switches.
 * A flags screen that rendered all of them would be a raw key/value editor over
 * production wearing a friendlier name.
 *
 * So a flag here means one specific thing: a **boolean** row that turns platform
 * behaviour off for everybody. Everything else on the response is named and sent
 * to the screen that owns it.
 */

export interface FlagSpec {
  key: string;
  label: string;
  /** What the platform does while it is on. */
  whenOn: string;
  /** What changes the moment it goes off. */
  whenOff: string;
  readBy: string;
  /** True when turning it OFF is the dangerous direction. */
  dangerousOff: boolean;
  /** True when turning it ON is the dangerous direction. */
  dangerousOn: boolean;
}

export const FLAG_SPECS: readonly FlagSpec[] = [
  {
    key: 'kill_switch',
    label: 'Credit kill switch',
    whenOn: 'Every credit deduction raises instead of charging, so metered work across the platform stops.',
    whenOff: 'Credits are deducted normally.',
    readBy: 'credit_service.is_kill_switch_active, checked before every deduction.',
    dangerousOff: false,
    dangerousOn: true,
  },
  {
    key: 'feature.email_verification_enabled',
    label: 'Email verification',
    whenOn: 'Lead enrichment verifies an email through Reoon and charges the configured credits for it.',
    whenOff: 'No verification happens and nothing is charged, for every customer regardless of plan.',
    readBy: 'credit_service, ahead of the per-plan gate.',
    dangerousOff: true,
    dangerousOn: false,
  },
  {
    key: 'feature.company_name_enabled',
    label: 'Company lookup',
    whenOn: 'Visitor intelligence resolves an employer from the IP and charges only when one is identified.',
    whenOff: 'No lookup happens and nothing is charged, for every customer regardless of plan.',
    readBy: 'chat_routes._resolve_and_update_location.',
    dangerousOff: true,
    dangerousOn: false,
  },
];

const BY_KEY = new Map(FLAG_SPECS.map((spec) => [spec.key, spec]));

export function flagSpec(key: string): FlagSpec | undefined {
  return BY_KEY.get(key);
}

/** Keys written by `PUT /superadmin/model-config`, which owns their validation. */
const RUNTIME_PREFIXES = ['model.', 'rag.', 'crawl.', 'embed.', 'impersonation.'];
const CONTENT_PREFIX = 'pricing_';

export interface FlagRow {
  key: string;
  value: boolean;
  updated_at: string | null;
  spec?: FlagSpec;
}

export interface FlagPartition {
  /** Documented switches, in the order they are declared. */
  known: FlagRow[];
  /** Boolean rows nothing in this console can describe. */
  undocumented: FlagRow[];
  /** Documented switches with no row at all — running on a hardcoded default. */
  missing: FlagSpec[];
  /** Non-boolean rows, counted so the screen can say what it is not showing. */
  elsewhere: { runtime: number; pricing: number; content: number };
}

function isBoolean(value: JsonValue): value is boolean {
  return typeof value === 'boolean';
}

/**
 * Split the flags response into switches and everything else.
 *
 * `impersonation.enabled` is boolean but is deliberately not a flag here: it has
 * an environment floor that this endpoint cannot see, so a switch rendered from
 * this row alone would offer to turn on something the environment refuses. It is
 * shown on the runtime screen, which reads `locked_by_env` alongside it.
 */
export function partitionFlags(rows: readonly ConfigRow[]): FlagPartition {
  const known: FlagRow[] = [];
  const undocumented: FlagRow[] = [];
  const elsewhere = { runtime: 0, pricing: 0, content: 0 };

  for (const row of rows) {
    const isRuntime = RUNTIME_PREFIXES.some((prefix) => row.key.startsWith(prefix));
    if (isRuntime) {
      elsewhere.runtime += 1;
      continue;
    }
    if (row.key.startsWith(CONTENT_PREFIX)) {
      elsewhere.content += 1;
      continue;
    }
    if (!isBoolean(row.value)) {
      elsewhere.pricing += 1;
      continue;
    }
    const spec = BY_KEY.get(row.key);
    const entry: FlagRow = { key: row.key, value: row.value, updated_at: row.updated_at, spec };
    if (spec) known.push(entry);
    else undocumented.push(entry);
  }

  const order = FLAG_SPECS.map((spec) => spec.key);
  known.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
  undocumented.sort((a, b) => a.key.localeCompare(b.key));

  const present = new Set(rows.map((row) => row.key));
  const missing = FLAG_SPECS.filter((spec) => !present.has(spec.key));

  return { known, undocumented, missing, elsewhere };
}

/**
 * Whether flipping this flag in this direction is the destructive one.
 *
 * Used to pick the confirm's tone. A destructive confirm on every toggle trains
 * people to click past it, so only the direction that actually removes something
 * from production gets one.
 */
export function isDangerousChange(spec: FlagSpec | undefined, next: boolean): boolean {
  if (!spec) return true;
  return next ? spec.dangerousOn : spec.dangerousOff;
}

/** The consequence of the flip, in the operator's words. */
export function describeFlagChange(spec: FlagSpec | undefined, key: string, next: boolean): string {
  if (!spec)
    return `Nothing in this console knows what reads ${key}. It will be set to ${next ? 'true' : 'false'} for the whole platform.`;
  return next ? spec.whenOn : spec.whenOff;
}
