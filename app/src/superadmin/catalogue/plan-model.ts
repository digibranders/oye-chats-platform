import { ABSENT, formatMoney, formatNumber } from '../../ui';
import type { JsonValue, Plan } from './types';

/**
 * Everything about a plan that is a rule rather than a rendering.
 *
 * The plan editor is the highest-leverage form in the product: one save changes
 * what every customer on that plan may do, on their next request. So the rules
 * live here, as pure functions with tests, rather than inside a component where
 * they can only be verified by clicking.
 *
 * Three of them matter more than the rest:
 *
 * 1. **`-1` is a sentinel, never a number.** `plan_entitlements_service.UNLIMITED`
 *    is `-1`, and it appears in `included_operator_seats` and in any numeric key
 *    of `limits`. Rendered as a figure it reads as "minus one operator seats",
 *    and typed into a spinner it is one keystroke from `-2`, which nothing in
 *    the platform understands. Every read goes through {@link formatLimit} and
 *    every write through a two-part control: unlimited, or a count.
 * 2. **The annual discount is derived, never sent.** `_resolve_annual_discount`
 *    (superadmin_plan_routes.py) answers 422 for a supplied value that disagrees
 *    with the prices. {@link annualSavingPercent} mirrors
 *    `app.core.pricing.annual_saving_percent` exactly — floor, not round — so
 *    the editor previews the same integer the server will store.
 * 3. **A partial update merges.** `update_plan` merges `limits`, `features` and
 *    `marketing` key-by-key, which is what stops a typed editor deleting the
 *    backend-only keys it has never heard of. The editor relies on that and
 *    surfaces the keys it does not know rather than pretending they are not
 *    there.
 */

/** `plan_entitlements_service.UNLIMITED`. The one non-positive value with meaning. */
export const UNLIMITED = -1;

/**
 * RBI e-mandate AFA ceiling in paise (`app.core.pricing.EMANDATE_AFA_CEILING_MINOR`).
 * A recurring debit above it re-authenticates every cycle instead of running silently.
 */
export const EMANDATE_CEILING_MINOR = 1_500_000;

export function isUnlimited(value: number | null | undefined): boolean {
  return value === UNLIMITED;
}

/** A limit, as a person reads it. Never `-1`, never a bare `0` for "absent". */
export function formatLimit(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return ABSENT;
  if (isUnlimited(value)) return 'Unlimited';
  return formatNumber(value);
}

/** Seats, which carry a unit because "3" alone in a plan row is ambiguous. */
export function formatSeats(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return ABSENT;
  if (isUnlimited(value)) return 'Unlimited';
  return value === 1 ? '1 seat' : `${formatNumber(value)} seats`;
}

/** INR paise. The plan table stores every `*_cents` field in the minor unit. */
export function formatInr(paise: number | null | undefined): string {
  return paise == null ? ABSENT : formatMoney(paise, 'INR');
}

export function formatUsd(cents: number | null | undefined): string {
  return cents == null ? ABSENT : formatMoney(cents, 'USD');
}

/**
 * The advertised annual saving, derived from the two INR prices.
 *
 * Mirrors `app.core.pricing.annual_saving_percent`: integer maths, multiply
 * before divide, and **floor**. 21.674% must read as 21 — understating a saving
 * costs nothing, overstating one tells a customer they will be charged less than
 * they will be.
 */
export function annualSavingPercent(
  monthlyMinor: number | null | undefined,
  annualMinor: number | null | undefined,
): number {
  const twelve = Math.trunc(monthlyMinor ?? 0) * 12;
  const annual = Math.trunc(annualMinor ?? 0);
  if (twelve <= 0 || annual <= 0 || annual >= twelve) return 0;
  return Math.floor(((twelve - annual) * 100) / twelve);
}

/* ------------------------------------------------------------------ fields */

export type FieldKind = 'entitlement-limit' | 'entitlement-feature';

export interface LimitFieldSpec {
  key: string;
  label: string;
  /** What the number gates, and which surface enforces it. */
  description: string;
  /** False where unlimited is meaningless, so the control does not offer it. */
  allowsUnlimited: boolean;
}

/**
 * The numeric entitlements, as seeded by `scripts/seed_plans.py`.
 *
 * The JSONB is open-ended on the server — deliberately, since the key set is
 * product-defined rather than API contract — so this list is the editor's
 * knowledge of it, not a schema. Anything on a plan that is not here is shown
 * as-is under "other keys" and left untouched by the merge.
 */
export const LIMIT_FIELDS: readonly LimitFieldSpec[] = [
  {
    key: 'credits',
    label: 'Credits',
    description:
      'The monthly allowance the credit ledger grants. Mirror of credits_per_month — the public catalogue serialises this copy.',
    allowsUnlimited: false,
  },
  {
    key: 'bots',
    label: 'Chatbots',
    description: 'Included chatbots. Beyond the first, creating one needs a funded subscription.',
    allowsUnlimited: true,
  },
  {
    key: 'operators',
    label: 'Operators',
    description: 'Live-chat seats the account may staff. Read by limit_for("operators").',
    allowsUnlimited: true,
  },
  {
    key: 'leads',
    label: 'Leads',
    description: 'Stored leads. Free caps them; every paid tier is unlimited.',
    allowsUnlimited: true,
  },
  {
    key: 'page_scraping',
    label: 'Pages crawled',
    description: 'Total pages the account may ingest from the web.',
    allowsUnlimited: true,
  },
  {
    key: 'documents',
    label: 'Documents',
    description: 'Uploaded files. Read by limit_for("documents") on the upload path.',
    allowsUnlimited: true,
  },
  {
    key: 'knowledge_characters',
    label: 'Knowledge characters',
    description: 'Total characters across the knowledge base. The real size cap on ingestion.',
    allowsUnlimited: true,
  },
  {
    key: 'chat_history_days',
    label: 'Chat history (days)',
    description: 'How far back a customer can read their own conversations.',
    allowsUnlimited: true,
  },
  {
    key: 'max_crawl_depth',
    label: 'Crawl depth',
    description: 'How many links deep the crawler follows from the seed URL.',
    allowsUnlimited: false,
  },
  {
    key: 'max_crawl_pages',
    label: 'Crawl pages per run',
    description: 'Pages one crawl may fetch. Unlimited on every paid tier; credits meter the cost.',
    allowsUnlimited: true,
  },
  {
    key: 'max_crawl_js_pages',
    label: 'JS-rendered pages',
    description: 'Pages per run that may use the expensive JS-rendering path.',
    allowsUnlimited: true,
  },
  {
    key: 'max_crawl_concurrency',
    label: 'Crawl concurrency',
    description: 'Parallel fetches allowed for one crawl.',
    allowsUnlimited: false,
  },
];

export interface FeatureFieldSpec {
  key: string;
  label: string;
  description: string;
}

/** The boolean entitlements. `has_feature` defaults an unknown key to false. */
export const FEATURE_FIELDS: readonly FeatureFieldSpec[] = [
  {
    key: 'live_chat',
    label: 'Live chat',
    description: 'The operator console and visitor handoff. Gated by has_feature("live_chat").',
  },
  {
    key: 'bant',
    label: 'BANT / MEDDIC qualification',
    description: 'Background lead scoring and tier-transition webhooks and emails.',
  },
  {
    key: 'branding_removable',
    label: 'Branding removable',
    description:
      'Emits the embed snippet without the "Powered by OyeChats" anchor. Turning this on removes attribution from every site on the plan.',
  },
  {
    key: 'webhooks',
    label: 'Outbound webhooks',
    description: 'Customer webhook registrations. Enforced by require_feature("webhooks").',
  },
  { key: 'api_access', label: 'API access', description: 'Programmatic access with the account API key.' },
  { key: 'online_support', label: 'Online support', description: 'In-product support channel.' },
  {
    key: 'topup_allowed',
    label: 'Credit top-ups',
    description: 'Whether the account may buy one-time credit packs.',
  },
  {
    key: 'auto_recrawl',
    label: 'Automatic re-crawl',
    description: 'Scheduled re-ingestion of a crawled site.',
  },
];

/** `integrations` is a string feature, not a boolean, and gates its own logic. */
export const INTEGRATION_OPTIONS = [
  { value: 'all', label: 'All integrations' },
  { value: 'reply_to_only', label: 'Reply-to only' },
] as const;

export const PRICING_MODEL_OPTIONS = [
  { value: 'per_operator', label: 'Per operator' },
  { value: 'flat', label: 'Flat' },
  { value: 'usage', label: 'Usage' },
] as const;

/* ------------------------------------------------------------------- draft */

/**
 * A limit in the editor: unlimited, or a count. Never one control doing both.
 *
 * `absent` is the third state, and it is not cosmetic. A plan row can simply not
 * carry a limit key — `limit_for` resolves a missing key to `0`, "nothing
 * allowed" — and an editor that rendered that as a `0` in a box would offer to
 * write the key on the next unrelated save. So an absent limit says it is
 * absent, is not validated, and is not sent unless somebody actually sets it.
 */
export interface LimitDraft {
  unlimited: boolean;
  value: string;
  /** The plan carries no value for this key, and this session has not set one. */
  absent?: boolean;
}

export interface PlanDraft {
  name: string;
  slug: string;
  description: string;
  pricing_model: string;
  sort_order: string;
  is_active: boolean;
  is_default: boolean;
  monthly_price_cents: string;
  annual_price_cents: string;
  monthly_price_usd_cents: string;
  annual_price_usd_cents: string;
  trial_days: string;
  credits_per_month: string;
  overage_rate_cents: string;
  seats: LimitDraft;
  limits: Record<string, LimitDraft>;
  features: Record<string, boolean>;
  integrations: string;
  tagline: string;
  badge: string;
}

function limitDraft(raw: JsonValue | undefined, fallback: string | null): LimitDraft {
  const numeric = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  if (Number.isFinite(numeric) && numeric === UNLIMITED) return { unlimited: true, value: '' };
  if (Number.isFinite(numeric)) return { unlimited: false, value: String(numeric) };
  // No stored value. On a new plan the fallback is the sensible starting point;
  // on an existing one there is genuinely nothing here, and saying so beats
  // inventing a zero.
  if (fallback === null) return { unlimited: false, value: '', absent: true };
  return { unlimited: false, value: fallback };
}

function text(raw: JsonValue | undefined): string {
  return typeof raw === 'string' ? raw : '';
}

/** A blank plan, or an existing one, as editable text. */
export function draftFromPlan(plan: Plan | null): PlanDraft {
  const limits: Record<string, LimitDraft> = {};
  for (const field of LIMIT_FIELDS) {
    limits[field.key] = limitDraft(plan?.limits?.[field.key], plan ? null : '0');
  }
  const features: Record<string, boolean> = {};
  for (const field of FEATURE_FIELDS) {
    features[field.key] = plan?.features?.[field.key] === true;
  }
  return {
    name: plan?.name ?? '',
    slug: plan?.slug ?? '',
    description: plan?.description ?? '',
    pricing_model: plan?.pricing_model ?? 'per_operator',
    sort_order: String(plan?.sort_order ?? 0),
    is_active: plan?.is_active ?? true,
    is_default: plan?.is_default ?? false,
    monthly_price_cents: String(plan?.monthly_price_cents ?? 0),
    annual_price_cents: String(plan?.annual_price_cents ?? 0),
    monthly_price_usd_cents: plan?.monthly_price_usd_cents == null ? '' : String(plan.monthly_price_usd_cents),
    annual_price_usd_cents: plan?.annual_price_usd_cents == null ? '' : String(plan.annual_price_usd_cents),
    trial_days: String(plan?.trial_days ?? 0),
    credits_per_month: String(plan?.credits_per_month ?? 0),
    overage_rate_cents: String(plan?.overage_rate_cents ?? 0),
    seats: limitDraft(plan?.included_operator_seats ?? undefined, '1'),
    limits,
    features,
    integrations: typeof plan?.features?.integrations === 'string' ? plan.features.integrations : 'all',
    tagline: text(plan?.marketing?.tagline),
    badge: text(plan?.marketing?.badge),
  };
}

/** The number a draft field means, or `null` when it is not one. */
export function parseIntegerField(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  if (!/^-?\d+$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function limitValue(draft: LimitDraft): number | null {
  if (draft.unlimited) return UNLIMITED;
  return parseIntegerField(draft.value);
}

/** True when the plan has no value for this key and nobody has supplied one. */
function isAbsent(draft: LimitDraft): boolean {
  return draft.absent === true && !draft.unlimited && draft.value.trim() === '';
}

export const SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

export interface ValidationOptions {
  isCreate: boolean;
  /** Every slug already in the catalogue, so a clash is caught before the 400. */
  takenSlugs?: readonly string[];
}

/**
 * Everything the server would refuse, refused first.
 *
 * Not because the server's checks are unreliable — they are the real ones — but
 * because a 422 arrives after the operator has left the form, and half of these
 * rules (the seat sentinel, the derived discount) are surprising enough that the
 * message needs to sit next to the field that caused it.
 */
export function validatePlanDraft(
  draft: PlanDraft,
  options: ValidationOptions,
): Record<string, string> {
  const errors: Record<string, string> = {};

  if (!draft.name.trim()) errors.name = 'A plan needs a name — customers see it on the invoice.';

  if (options.isCreate) {
    const slug = draft.slug.trim();
    if (!slug) errors.slug = 'A slug is required. It is the identifier entitlements resolve against.';
    else if (slug.length > 64) errors.slug = 'At most 64 characters.';
    else if (!SLUG_PATTERN.test(slug))
      errors.slug = 'Lowercase letters, digits, hyphen and underscore only, starting with a letter or digit.';
    else if (options.takenSlugs?.includes(slug)) errors.slug = `A plan with the slug "${slug}" already exists.`;
  }

  const money: [keyof PlanDraft, string, boolean][] = [
    ['monthly_price_cents', 'Monthly price', true],
    ['annual_price_cents', 'Annual price', true],
    ['monthly_price_usd_cents', 'Monthly USD price', false],
    ['annual_price_usd_cents', 'Annual USD price', false],
  ];
  for (const [key, label, required] of money) {
    const raw = draft[key] as string;
    if (!required && raw.trim() === '') continue;
    const parsed = parseIntegerField(raw);
    if (parsed === null) errors[key] = `${label} must be a whole number of minor units.`;
    else if (parsed < 0) errors[key] = `${label} cannot be negative.`;
  }

  const counters: [keyof PlanDraft, string][] = [
    ['trial_days', 'Trial days'],
    ['credits_per_month', 'Credits per month'],
    ['overage_rate_cents', 'Overage rate'],
  ];
  for (const [key, label] of counters) {
    const parsed = parseIntegerField(draft[key] as string);
    if (parsed === null) errors[key] = `${label} must be a whole number.`;
    else if (parsed < 0) errors[key] = `${label} cannot be negative.`;
  }

  const sortOrder = parseIntegerField(draft.sort_order);
  if (sortOrder === null) errors.sort_order = 'Sort order must be a whole number.';

  const seats = limitValue(draft.seats);
  if (seats === null) errors.seats = 'Enter a seat count, or mark the plan unlimited.';
  else if (seats !== UNLIMITED && seats < 1)
    errors.seats = 'A plan includes at least one seat, or unlimited. Zero is rejected by the API.';

  for (const field of LIMIT_FIELDS) {
    // An absent limit is a fact about the plan, not a mistake in the form. It
    // blocks nothing: refusing to save a name change because a legacy row never
    // carried `knowledge_characters` would make this editor unusable.
    if (isAbsent(draft.limits[field.key])) continue;
    const value = limitValue(draft.limits[field.key]);
    if (value === null) {
      errors[`limits.${field.key}`] = 'Enter a number, or mark it unlimited.';
    } else if (value < UNLIMITED) {
      errors[`limits.${field.key}`] = 'Only -1 (unlimited) or a value of zero or more.';
    } else if (value === UNLIMITED && !field.allowsUnlimited) {
      errors[`limits.${field.key}`] = 'Unlimited has no meaning for this limit.';
    } else if (value < 0 && field.allowsUnlimited && !draft.limits[field.key].unlimited) {
      errors[`limits.${field.key}`] = 'A negative limit is only ever the unlimited sentinel.';
    }
  }

  if (!draft.is_active && draft.is_default)
    errors.is_default = 'A delisted plan cannot be the default new accounts land on.';

  return errors;
}

/* ---------------------------------------------------------------- warnings */

/**
 * The advisories the server would also return, computed before the save.
 *
 * `_plan_warnings` sends these back after a successful write. Showing the same
 * facts beforehand is the difference between "you have published a tier nobody
 * can buy" and "you published a tier nobody can buy — here is the receipt".
 */
export function planWarnings(draft: PlanDraft, plan: Plan | null): string[] {
  const warnings: string[] = [];
  const monthly = parseIntegerField(draft.monthly_price_cents) ?? 0;
  const annual = parseIntegerField(draft.annual_price_cents) ?? 0;

  if (monthly > EMANDATE_CEILING_MINOR)
    warnings.push(
      `The monthly price is above the ${formatInr(EMANDATE_CEILING_MINOR)} e-mandate ceiling, so every renewal will ask the customer to re-authenticate instead of debiting silently.`,
    );
  if (annual > EMANDATE_CEILING_MINOR)
    warnings.push(
      `The annual price is above the ${formatInr(EMANDATE_CEILING_MINOR)} e-mandate ceiling, so every renewal will ask the customer to re-authenticate instead of debiting silently.`,
    );

  const free = monthly === 0 && annual === 0;
  const wired = Boolean(plan?.razorpay_plan_id_monthly) || Boolean(plan?.razorpay_plan_id_annual);
  if (draft.is_active && !free && !wired)
    warnings.push(
      'This tier is listed and priced but has no INR Razorpay plan id, so the pricing page will quote "Contact sales" rather than a checkout button.',
    );

  const priceChanged =
    plan != null &&
    (monthly !== plan.monthly_price_cents ||
      annual !== plan.annual_price_cents ||
      (parseIntegerField(draft.monthly_price_usd_cents) ?? null) !== plan.monthly_price_usd_cents ||
      (parseIntegerField(draft.annual_price_usd_cents) ?? null) !== plan.annual_price_usd_cents);
  if (priceChanged)
    warnings.push(
      'Razorpay plans are immutable, so saving a new price mints a replacement gateway plan and swaps the id in the same write. Existing mandates keep debiting the old amount until each customer re-subscribes.',
    );

  return warnings;
}

/* ----------------------------------------------------------------- payload */

export type PlanPayload = Record<string, JsonValue>;

function buildLimits(draft: PlanDraft): Record<string, number> {
  const limits: Record<string, number> = {};
  for (const field of LIMIT_FIELDS) {
    if (isAbsent(draft.limits[field.key])) continue;
    const value = limitValue(draft.limits[field.key]);
    if (value !== null) limits[field.key] = value;
  }
  return limits;
}

function buildFeatures(draft: PlanDraft): Record<string, JsonValue> {
  const features: Record<string, JsonValue> = {};
  for (const field of FEATURE_FIELDS) features[field.key] = draft.features[field.key];
  features.integrations = draft.integrations;
  return features;
}

function buildMarketing(draft: PlanDraft): Record<string, JsonValue> {
  const marketing: Record<string, JsonValue> = { tagline: draft.tagline.trim() };
  // Sent only when set: an empty string would publish a blank ribbon on the
  // pricing card rather than removing it.
  if (draft.badge.trim()) marketing.badge = draft.badge.trim();
  return marketing;
}

function scalarPayload(draft: PlanDraft): PlanPayload {
  const seats = limitValue(draft.seats);
  const usdMonthly = draft.monthly_price_usd_cents.trim() === '' ? null : parseIntegerField(draft.monthly_price_usd_cents);
  const usdAnnual = draft.annual_price_usd_cents.trim() === '' ? null : parseIntegerField(draft.annual_price_usd_cents);
  return {
    name: draft.name.trim(),
    description: draft.description.trim() || null,
    pricing_model: draft.pricing_model,
    monthly_price_cents: parseIntegerField(draft.monthly_price_cents) ?? 0,
    annual_price_cents: parseIntegerField(draft.annual_price_cents) ?? 0,
    monthly_price_usd_cents: usdMonthly,
    annual_price_usd_cents: usdAnnual,
    trial_days: parseIntegerField(draft.trial_days) ?? 0,
    credits_per_month: parseIntegerField(draft.credits_per_month) ?? 0,
    overage_rate_cents: parseIntegerField(draft.overage_rate_cents) ?? 0,
    included_operator_seats: seats ?? 1,
    is_active: draft.is_active,
    is_default: draft.is_default,
    sort_order: parseIntegerField(draft.sort_order) ?? 0,
  };
}

/**
 * The body for `POST /superadmin/plans`.
 *
 * `annual_discount_percent` is deliberately absent: the server derives it, and
 * a supplied value that disagrees is a 422. `extra_seat_price_cents` is absent
 * too — the create route defaults it to the canonical seat-add-on price, which
 * is the only value `_reject_seat_price_drift` accepts besides zero, and the
 * console has no way to learn that constant from any endpoint it can call.
 */
export function planCreatePayload(draft: PlanDraft): PlanPayload {
  return {
    ...scalarPayload(draft),
    slug: draft.slug.trim(),
    currency: 'INR',
    limits: buildLimits(draft),
    features: buildFeatures(draft),
    marketing: buildMarketing(draft),
  };
}

/**
 * The body for `PUT /superadmin/plans/{id}` — only what actually changed.
 *
 * A minimal body matters here beyond tidiness: `update_plan` mints a new
 * Razorpay plan for every price field whose value differs, so echoing back an
 * unchanged price is free but echoing back a *rounded* one would silently
 * re-mint the gateway plan. Sending nothing is therefore a real answer, and the
 * caller checks for it.
 */
export function planUpdatePayload(draft: PlanDraft, plan: Plan): PlanPayload {
  const next = scalarPayload(draft);
  const current: PlanPayload = {
    name: plan.name,
    description: plan.description,
    pricing_model: plan.pricing_model,
    monthly_price_cents: plan.monthly_price_cents,
    annual_price_cents: plan.annual_price_cents,
    monthly_price_usd_cents: plan.monthly_price_usd_cents,
    annual_price_usd_cents: plan.annual_price_usd_cents,
    trial_days: plan.trial_days,
    credits_per_month: plan.credits_per_month,
    overage_rate_cents: plan.overage_rate_cents,
    included_operator_seats: plan.included_operator_seats,
    is_active: plan.is_active,
    is_default: plan.is_default,
    sort_order: plan.sort_order,
  };

  const payload: PlanPayload = {};
  for (const [key, value] of Object.entries(next)) {
    if (current[key] !== value) payload[key] = value;
  }

  const limits = buildLimits(draft);
  const changedLimits: Record<string, number> = {};
  for (const [key, value] of Object.entries(limits)) {
    if (plan.limits?.[key] !== value) changedLimits[key] = value;
  }
  if (Object.keys(changedLimits).length > 0) payload.limits = changedLimits;

  const features = buildFeatures(draft);
  const changedFeatures: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(features)) {
    // Compared against the EFFECTIVE value, not the stored one: `has_feature`
    // resolves a missing boolean to false, so a plan without the key and a
    // switch left off are the same entitlement, and writing the key would be a
    // change in the audit log that changed nothing.
    const stored = plan.features?.[key];
    const effective = typeof value === 'boolean' ? stored === true : stored;
    if (effective !== value) changedFeatures[key] = value;
  }
  if (Object.keys(changedFeatures).length > 0) payload.features = changedFeatures;

  const marketing = buildMarketing(draft);
  const changedMarketing: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(marketing)) {
    if (plan.marketing?.[key] !== value) changedMarketing[key] = value;
  }
  if (Object.keys(changedMarketing).length > 0) payload.marketing = changedMarketing;

  return payload;
}

/* ------------------------------------------------------------------ review */

function labelFor(key: string): string {
  const limit = LIMIT_FIELDS.find((field) => `limits.${field.key}` === key);
  if (limit) return `Limit · ${limit.label}`;
  const feature = FEATURE_FIELDS.find((field) => `features.${field.key}` === key);
  if (feature) return `Feature · ${feature.label}`;
  const named: Record<string, string> = {
    name: 'Name',
    description: 'Description',
    pricing_model: 'Pricing model',
    monthly_price_cents: 'Monthly price (INR)',
    annual_price_cents: 'Annual price (INR)',
    monthly_price_usd_cents: 'Monthly price (USD)',
    annual_price_usd_cents: 'Annual price (USD)',
    trial_days: 'Trial days',
    credits_per_month: 'Credits per month',
    overage_rate_cents: 'Overage rate',
    included_operator_seats: 'Included seats',
    is_active: 'Listed',
    is_default: 'Default plan',
    sort_order: 'Sort order',
    'features.integrations': 'Feature · Integrations',
    'marketing.tagline': 'Marketing · Tagline',
    'marketing.badge': 'Marketing · Badge',
  };
  return named[key] ?? key;
}

function renderValue(key: string, value: JsonValue): string {
  if (value === null || value === undefined || value === '') return ABSENT;
  if (typeof value === 'boolean') return value ? 'On' : 'Off';
  if (typeof value === 'number') {
    if (key === 'included_operator_seats') return formatSeats(value);
    if (key.startsWith('limits.')) return formatLimit(value);
    if (key.endsWith('_usd_cents')) return formatUsd(value);
    if (key.endsWith('_cents')) return formatInr(value);
    return formatNumber(value);
  }
  return String(value);
}

export interface PlanChange {
  key: string;
  label: string;
  before: string;
  after: string;
}

/**
 * What this save actually does, in the operator's words.
 *
 * The confirm dialog reads from this rather than from the payload, because
 * `{"limits":{"documents":-1}}` is not a sentence anybody should have to parse
 * on the way to changing what four hundred paying accounts may upload.
 */
export function describePlanChanges(payload: PlanPayload, plan: Plan): PlanChange[] {
  const changes: PlanChange[] = [];
  for (const [key, value] of Object.entries(payload)) {
    if (key === 'limits' || key === 'features' || key === 'marketing') {
      const group = (plan[key] ?? {}) as Record<string, JsonValue>;
      for (const [nested, nestedValue] of Object.entries(value as Record<string, JsonValue>)) {
        const path = `${key}.${nested}`;
        changes.push({
          key: path,
          label: labelFor(path),
          before: renderValue(path, group[nested] ?? null),
          after: renderValue(path, nestedValue),
        });
      }
      continue;
    }
    changes.push({
      key,
      label: labelFor(key),
      before: renderValue(key, (plan as unknown as Record<string, JsonValue>)[key] ?? null),
      after: renderValue(key, value),
    });
  }
  return changes;
}

/** Keys on the stored plan that this editor does not model, and will not touch. */
export function unknownKeys(
  stored: Record<string, JsonValue> | null | undefined,
  known: readonly string[],
): { key: string; value: JsonValue }[] {
  if (!stored) return [];
  return Object.entries(stored)
    .filter(([key]) => !known.includes(key))
    .map(([key, value]) => ({ key, value }));
}

/**
 * The one seat price the API will accept, learned from the catalogue itself.
 *
 * `_reject_seat_price_drift` allows exactly two values: zero, or the canonical
 * `RAZORPAY_SEAT_PLAN_PRICE_CENTS` from the environment. No endpoint serves that
 * constant, so the console derives it from the rows that already carry it — the
 * same rule guarantees every non-zero value in the table is that constant. When
 * every plan sells seats at zero there is nothing to derive, and the control
 * that would restore a paid seat price says so instead of guessing.
 */
export function canonicalSeatPrices(plans: readonly Plan[]): { inr: number | null; usd: number | null } {
  const inr = plans.map((plan) => plan.extra_seat_price_cents).filter((value) => value > 0);
  const usd = plans
    .map((plan) => plan.extra_seat_price_usd_cents ?? 0)
    .filter((value) => value > 0);
  return {
    inr: inr.length > 0 ? Math.max(...inr) : null,
    usd: usd.length > 0 ? Math.max(...usd) : null,
  };
}
