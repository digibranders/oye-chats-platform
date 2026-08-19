import type { JsonValue, PricingConfigRow } from './types';

/**
 * What lives in `pricing_config`, and which of it belongs on this screen.
 *
 * `pricing_config` is one key/value table doing five unrelated jobs. Reading it
 * raw is how a super-admin ends up editing `rag.chunk_overlap` from a screen
 * called "Pricing": `GET /superadmin/pricing-config` and
 * `GET /superadmin/feature-flags` are literally the same handler over the same
 * rows (superadmin_routes_v2.py — `list_feature_flags` calls
 * `list_pricing_config`), and `PUT /superadmin/model-config` writes into the
 * same table under `model.*`, `rag.*`, `crawl.*` and `embed.*`.
 *
 * So the console splits the table by what a key *does*, and every screen names
 * where the keys it is not showing actually live:
 *
 * * **money** — the credit economics, edited here.
 * * **switch** — booleans, edited on Configuration → Flags, because flipping one
 *   is an operation on production rather than a price change.
 * * **runtime** — the model and RAG knobs, edited on Configuration → Runtime,
 *   which is the only writer that validates them against each other.
 * * **content** — the public pricing page's copy, edited on the Pricing page tab
 *   through the validated `pricing-content` endpoints.
 *
 * Anything else is **unknown**: shown, never hidden, and editable only through
 * the raw value it already has.
 */

export type KeyDomain = 'money' | 'switch' | 'runtime' | 'content' | 'unknown';

export interface PricingKeySpec {
  key: string;
  label: string;
  /** What the value means, in units. */
  description: string;
  /** Which code path reads it, so an edit has a blast radius the reader can see. */
  readBy: string;
  domain: Exclude<KeyDomain, 'unknown'>;
  /** How the editor renders it. `json` covers the pack list. */
  kind: 'integer' | 'boolean' | 'json';
  unit?: string;
}

export const PRICING_KEYS: readonly PricingKeySpec[] = [
  {
    key: 'credit_cost.ai_chat',
    label: 'AI reply',
    description: 'Credits deducted for one grounded answer from the chatbot.',
    readBy: 'credit_service.get_action_cost, deducted on every chat completion.',
    domain: 'money',
    kind: 'integer',
    unit: 'credits',
  },
  {
    key: 'credit_cost.url_scan',
    label: 'Crawled page',
    description: 'Credits per page fetched, cleaned, chunked, embedded and stored.',
    readBy: 'The ingestion pipeline, per page of a crawl.',
    domain: 'money',
    kind: 'integer',
    unit: 'credits',
  },
  {
    key: 'credit_cost.document_upload',
    label: 'Document upload — minimum',
    description: 'The floor charge for one uploaded file, however short it is.',
    readBy: 'credit_service.get_document_upload_cost_for_size.',
    domain: 'money',
    kind: 'integer',
    unit: 'credits',
  },
  {
    key: 'credit_cost.document_upload_words_per_credit',
    label: 'Document upload — words per credit',
    description:
      'The divisor: a file costs ceil(words ÷ this), floored at the minimum above. Zero or missing makes the upload path fail closed.',
    readBy: 'credit_service.get_document_upload_cost_for_size.',
    domain: 'money',
    kind: 'integer',
    unit: 'words',
  },
  {
    key: 'credit_cost.email_send',
    label: 'Customer email',
    description: 'Credits per transactional email. Seeded at zero — customer emails are free.',
    readBy: 'credit_service, on the email send path.',
    domain: 'money',
    kind: 'integer',
    unit: 'credits',
  },
  {
    key: 'credit_cost.email_verification',
    label: 'Email verification',
    description: 'Charged once per background lead enrichment, never on the widget blur check.',
    readBy: 'chat_routes lead enrichment. Also gated by feature.email_verification_enabled.',
    domain: 'money',
    kind: 'integer',
    unit: 'credits',
  },
  {
    key: 'credit_cost.company_name',
    label: 'Company lookup',
    description:
      'Charged once per visitor whose employer is actually identified — most consumer ISP ranges name nobody and cost nothing.',
    readBy: 'chat_routes._resolve_and_update_location. Also gated by feature.company_name_enabled.',
    domain: 'money',
    kind: 'integer',
    unit: 'credits',
  },
  {
    key: 'seat_price_cents',
    label: 'Displayed seat price',
    description:
      'INR paise shown for one extra operator seat. Display only — the actual charge is the Razorpay seat plan named in the environment.',
    readBy: 'The customer-facing seat add-on copy.',
    domain: 'money',
    kind: 'integer',
    unit: 'paise',
  },
  {
    key: 'topup_expiry_months',
    label: 'Top-up expiry',
    description: 'Months before purchased credits expire. Zero (or less) means lifetime credits.',
    readBy: 'credit_service.grant_topup and the daily expire_old_topups sweep.',
    domain: 'money',
    kind: 'integer',
    unit: 'months',
  },
  {
    key: 'low_balance_warn_pct',
    label: 'Low-balance warning',
    description: 'The share of the monthly allowance at which the customer is warned.',
    readBy: 'The customer dashboard balance widget.',
    domain: 'money',
    kind: 'integer',
    unit: '%',
  },
  {
    key: 'topup_packs',
    label: 'Top-up packs (charged)',
    description:
      'The packs a customer can actually buy: INR is charged, USD is a display headline, credits is what is granted. Not the same key as the marketing copy on the pricing page.',
    readBy: 'razorpay_service.create_topup_order — a pack must appear here to be purchasable.',
    domain: 'money',
    kind: 'json',
  },
  {
    key: 'kill_switch',
    label: 'Credit kill switch',
    description: 'When on, every credit deduction raises instead of charging.',
    readBy: 'credit_service.is_kill_switch_active.',
    domain: 'switch',
    kind: 'boolean',
  },
  {
    key: 'feature.email_verification_enabled',
    label: 'Email verification enabled',
    description: 'Master switch for the metered Reoon verification. Off means no lookup and no charge, for everyone.',
    readBy: 'credit_service, ahead of the plan gate.',
    domain: 'switch',
    kind: 'boolean',
  },
  {
    key: 'feature.company_name_enabled',
    label: 'Company lookup enabled',
    description: 'Master switch for the metered IP → company lookup. Off means no lookup and no charge, for everyone.',
    readBy: 'credit_service, ahead of the plan gate.',
    domain: 'switch',
    kind: 'boolean',
  },
  {
    key: 'impersonation.enabled',
    label: 'Support impersonation',
    description:
      'The runtime half of the impersonation kill switch. The IMPERSONATION_ENABLED environment variable is a floor this cannot lift.',
    readBy: 'runtime_config.is_impersonation_enabled.',
    domain: 'runtime',
    kind: 'boolean',
  },
];

const BY_KEY = new Map(PRICING_KEYS.map((spec) => [spec.key, spec]));

const RUNTIME_PREFIXES = ['model.', 'rag.', 'crawl.', 'embed.', 'impersonation.'];
const CONTENT_KEYS = ['pricing_faq', 'pricing_feature_matrix', 'pricing_topup_packs', 'pricing_credit_costs'];

/** Which screen owns a key. Prefix rules cover the keys `model-config` invents. */
export function domainOf(key: string): KeyDomain {
  const spec = BY_KEY.get(key);
  if (spec) return spec.domain;
  if (CONTENT_KEYS.includes(key)) return 'content';
  if (RUNTIME_PREFIXES.some((prefix) => key.startsWith(prefix))) return 'runtime';
  return 'unknown';
}

export function specFor(key: string): PricingKeySpec | undefined {
  return BY_KEY.get(key);
}

export interface PartitionedConfig {
  money: PricingConfigRow[];
  switches: PricingConfigRow[];
  runtime: PricingConfigRow[];
  content: PricingConfigRow[];
  unknown: PricingConfigRow[];
  /** Documented money keys the database does not have a row for yet. */
  missingMoneyKeys: PricingKeySpec[];
}

/**
 * Split one flat key/value dump into the screens that own each part.
 *
 * A documented key with no row is reported rather than dropped: `credit_service`
 * falls back to a hardcoded default for a missing key, so "not in the table" and
 * "set to the default" look identical from the outside and only one of them
 * survives someone editing the defaults.
 */
export function partitionConfig(rows: readonly PricingConfigRow[]): PartitionedConfig {
  const out: PartitionedConfig = {
    money: [],
    switches: [],
    runtime: [],
    content: [],
    unknown: [],
    missingMoneyKeys: [],
  };
  for (const row of rows) {
    switch (domainOf(row.key)) {
      case 'money':
        out.money.push(row);
        break;
      case 'switch':
        out.switches.push(row);
        break;
      case 'runtime':
        out.runtime.push(row);
        break;
      case 'content':
        out.content.push(row);
        break;
      default:
        out.unknown.push(row);
    }
  }
  const present = new Set(rows.map((row) => row.key));
  out.missingMoneyKeys = PRICING_KEYS.filter((spec) => spec.domain === 'money' && !present.has(spec.key));

  const order = PRICING_KEYS.map((spec) => spec.key);
  const byOrder = (a: PricingConfigRow, b: PricingConfigRow) => order.indexOf(a.key) - order.indexOf(b.key);
  out.money.sort(byOrder);
  out.switches.sort(byOrder);
  out.runtime.sort((a, b) => a.key.localeCompare(b.key));
  out.unknown.sort((a, b) => a.key.localeCompare(b.key));
  return out;
}

/** A stored value as one readable line. Objects and arrays stay JSON. */
export function formatConfigValue(value: JsonValue): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') return value ? 'On' : 'Off';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? '' : 's'}`;
  return JSON.stringify(value);
}

/**
 * Parse what the operator typed back into the JSON the endpoint stores.
 *
 * `PUT /superadmin/pricing-config/{key}` takes `{"value": <anything>}` with no
 * schema at all, so a typo lands in the table and the reader of the key fails
 * closed — `credit_cost.*` logs "non-numeric" and charges the hardcoded default.
 * The kind we already know for a documented key is therefore enforced here.
 */
export function parseConfigValue(
  kind: PricingKeySpec['kind'],
  raw: string,
): { ok: true; value: JsonValue } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (kind === 'integer') {
    if (!/^-?\d+$/.test(trimmed)) return { ok: false, error: 'This key must be a whole number.' };
    const parsed = Number(trimmed);
    if (!Number.isSafeInteger(parsed)) return { ok: false, error: 'That number is too large to store safely.' };
    if (parsed < 0) return { ok: false, error: 'A negative value here has no meaning; use zero.' };
    return { ok: true, value: parsed };
  }
  if (kind === 'boolean') {
    if (trimmed === 'true') return { ok: true, value: true };
    if (trimmed === 'false') return { ok: true, value: false };
    return { ok: false, error: 'This key must be true or false.' };
  }
  try {
    return { ok: true, value: JSON.parse(trimmed) as JsonValue };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'That is not valid JSON.' };
  }
}
