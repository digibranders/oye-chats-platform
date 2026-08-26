/**
 * billingModel - typed view-models + formatters for the Workspace ▸ Billing page.
 *
 * The reused billing endpoints (getCurrentSubscription / getSubscriptionPlans /
 * getInvoices / getBillingDetails) are declared as `Record<string, unknown>` in
 * `services/api.d.ts`, so this module owns the boundary: it coerces those loose
 * runtime shapes into strict, presentation-ready view-models. The page never
 * touches a raw record.
 *
 * Money note: the platform bills on a single Razorpay INR rail (root CLAUDE.md
 * - "Payments: Razorpay (INR), single provider"), so plan/seat amounts come from
 * the canonical `*_price_cents` (INR paise) columns. The parallel `*_usd_cents`
 * columns exist for an unshipped multi-currency rail and are intentionally not
 * read here.
 * TODO(multi-currency): switch the price source once the USD rail ships.
 */


/**
 * Sentinel meaning "no limit" - mirrors `plan_entitlements_service.py::UNLIMITED`.
 * Plan rows serialize it raw (`included_operator_seats: -1`, `limits.bots: -1`),
 * so every surface that renders one of those numbers has to recognise it.
 */
export const UNLIMITED_LIMIT = -1;

/**
 * Where a contact-sales tier routes. One constant because every surface that
 * offers "Contact sales" must reach a mailbox that exists - this is the address
 * the backend itself hands back as `contact_sales` on a blocked quote
 * (`subscription_routes.py`). A server-supplied `contact_sales` always wins;
 * this is the fallback when there is no quote to read one from.
 */
export const SALES_EMAIL = 'developer@oyechats.com';

// ── Coercion helpers (loose record → strict primitive) ───────────────────────

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function toNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function toText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function toOptionalText(value: unknown): string | null {
  const text = toText(value).trim();
  return text.length > 0 ? text : null;
}

function toBool(value: unknown): boolean {
  return value === true;
}

/**
 * A number that may legitimately be absent. Distinct from {@link toNumber},
 * whose 0 default is correct for a quota but wrong for a price: "this plan has
 * no USD column" and "this plan costs nothing" are different facts, and
 * collapsing them prices a paid tier at $0.
 */
function toOptionalNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

// ── View-model shapes ────────────────────────────────────────────────────────

export interface PlanView {
  /** DB primary key - required by the checkout money-path (change-plan/checkout/quote). */
  id: number;
  slug: string;
  name: string;
  /** Active-cycle price in INR minor units (paise), monthly column. */
  monthlyPriceMinor: number;
  /** Annual price in INR minor units (paise). */
  annualPriceMinor: number;
  /**
   * USD DISPLAY prices in cents, when the backend serves them. Never the charge:
   * the rail debits the INR columns above. `null` when the plan row carries no
   * USD figure, in which case a non-IN buyer's price is derived from the geo
   * rate instead.
   */
  monthlyPriceUsdMinor: number | null;
  annualPriceUsdMinor: number | null;
  extraSeatPriceUsdMinor: number | null;
  creditsPerMonth: number;
  includedSeats: number;
  /** Per-extra-seat monthly price in INR minor units. */
  extraSeatPriceMinor: number;
  isPaid: boolean;
  /**
   * True for a BESPOKE tier - priced on request, sold by a human, with no
   * self-serve checkout. Driven purely by the `contact_sales` / `enterprise`
   * feature flags, which is the only signal a super-admin sets deliberately
   * when provisioning a per-contract plan (`enterprise-acme` and friends).
   *
   * Deliberately NOT keyed off `slug === 'enterprise'`. The seeded `enterprise`
   * tier is a real, priced rung of the public ladder - ₹5,999/mo (or ₹57,588/yr,
   * which is ₹4,799 per month; quoting that figure as the monthly price is the
   * usual mix-up) for 10,000 pooled credits and unlimited agents - sold through
   * the same Razorpay checkout as every other plan. Figures are the seeded ones
   * in `api/scripts/seed_plans.py`; the backend says as much in
   * `plan_entitlements_service.py::_SEEDED_PLAN_SLUGS`. Matching on the slug
   * priced it as "Custom" and dead-ended its checkout at a mailto.
   */
  isContactSales: boolean;
  /**
   * The payload's `annual_discount_percent`, which the backend now DERIVES from
   * the same INR prices this model carries (`core/pricing.annual_saving_percent`,
   * a port of {@link annualSavingPercent} - same floor, same zero cases). Every
   * consumer of `GET /subscriptions/plans` and `GET /public/pricing-catalog`
   * therefore reads one figure computed one way.
   *
   * Still NOT the source for any rendered saving badge - use
   * {@link maxAnnualSavingPercent}. Deriving locally keeps the badge true for
   * whichever rail the surface is displaying (one integer cannot describe both
   * the INR and USD price pairs on a plan row), and it keeps rendering correct
   * against an older API build that still serves the stored column: that column
   * was hand-maintained and drifted - seeded Professional stored 22 while
   * ₹28,188 against 12 × ₹2,999 is a 21.67% saving, which is the disagreement
   * this field is kept around to survive rather than to propagate.
   */
  annualDiscountPercent: number;
  /** Free-trial length in days; 0 for plans with no trial (Free). */
  trialDays: number;
  /** Catalog ordering from the backend (`sort_order`). */
  sortOrder: number;
  /** Raw `features` flags from the plan payload (bant, live_chat, webhooks, …). Read by the plan matrix. */
  features: Record<string, unknown>;
  /** Raw `limits` counters from the plan payload (max_crawl_pages, chat_history_days, …). `-1` = unlimited. */
  limits: Record<string, number>;
  /** Per-credit charge once the monthly allowance is spent, in INR minor units. 0 = no overage billing. */
  overageRateMinor: number;
}

export interface PromotionView {
  id: number | null;
  name: string | null;
  /** Billing cycles granted free before the first real charge (e.g. 3). */
  freeCycles: number;
  /** Campaign end (ISO). After this, new signups stop qualifying. */
  endsAt: string | null;
  /** Plan ids the offer covers; `null` = every paid plan. */
  eligiblePlanIds: number[] | null;
}

export interface ScheduledChangeView {
  planName: string | null;
  effectiveAt: string | null;
}

export interface SubscriptionView {
  status: string;
  billingCycle: string;
  /** Total operator seats currently provisioned on the subscription. */
  seats: number;
  trialEnd: string | null;
  currentPeriodEnd: string | null;
  /**
   * First-charge date while a promo's free period is running. Set only until
   * the first `subscription.charged` webhook lands - at that point Razorpay
   * populates `currentPeriodEnd` and this reverts to `null`, so the two are
   * mutually exclusive in practice (see `getRenewalDisplay`).
   */
  promoFreeUntil: string | null;
  /** Post-trial grace deadline after which the workspace is deleted (trial_expired only). */
  dataRetentionUntil: string | null;
  paymentProvider: string | null;
  cancelAtPeriodEnd: boolean;
  scheduledChange: ScheduledChangeView | null;
  /** True when the subscription is billing (active or trialing). */
  hasActive: boolean;
}

export type InvoiceKind = 'tax_invoice' | 'credit_note' | 'receipt' | 'legacy';

export interface InvoiceTaxView {
  /** Pre-tax value in minor units. */
  taxableMinor: number;
  /** Total GST in minor units (the sum of the three components below). */
  totalTaxMinor: number;
  /** Central GST, set only on an intra-state supply. */
  cgstMinor: number;
  /** State GST, set only on an intra-state supply. */
  sgstMinor: number;
  /** Integrated GST, set only on an inter-state supply. */
  igstMinor: number;
  /** Applied rate in basis points (1800 = 18%). */
  rateBps: number;
  /** HSN/SAC code printed on the document. */
  hsnSac: string | null;
  /** `intra_state` | `inter_state` | `export` as issued by the backend. */
  supplyKind: string | null;
  isExport: boolean;
}

/**
 * Whether the customer can actually download this document right now.
 *
 * Three states, not two. `pdf_url` is populated by an ARQ render job, and the
 * root `CLAUDE.md` documents a whole class of bug where that job silently never
 * runs (a worker started without pango logs "PDF renderer unavailable" and the
 * column stays null forever). A dead Download button is the wrong answer to
 * both halves of that: a document issued a minute ago is still rendering, and
 * one issued last week is not coming.
 *
 * `unavailable` is also the honest answer for a legacy row that never had a
 * rendered PDF, and for every row while `INVOICE_EMAILS_ENABLED` is off - the
 * backend nulls `pdf_url` under that kill switch (`subscription_routes.py`
 * `list_invoices`), so "still preparing" would be a lie the moment the customer
 * waits for it.
 */
export type InvoiceDocumentState = 'ready' | 'preparing' | 'unavailable';

export interface InvoiceView {
  id: string;
  number: string | null;
  kind: InvoiceKind;
  amountMinor: number;
  currency: string;
  status: string;
  date: string | null;
  /** Start of the service period this document covers. */
  periodStart: string | null;
  /** End of the service period this document covers. */
  periodEnd: string | null;
  paidAt: string | null;
  pdfUrl: string | null;
  invoiceUrl: string | null;
  description: string | null;
  /** GST breakdown, or `null` on a row that carries no tax fields (legacy / shadow mode). */
  tax: InvoiceTaxView | null;
  document: InvoiceDocumentState;
}

export interface BillingAddress {
  line1?: string;
  line2?: string;
  city?: string;
  state?: string;
  postal_code?: string;
}

export interface BillingDetailsView {
  legalName: string | null;
  gstin: string | null;
  country: string | null;
  stateCode: string | null;
  email: string | null;
  address: BillingAddress | null;
  /** Account company name (from signup) - prefills the legal name when unset. */
  companyName: string | null;
  /** Account login email - where invoices go when billing email is unset. */
  accountEmail: string | null;
  /** True when the customer has entered no tax identity at all. */
  isEmpty: boolean;
}

// ── Builders ─────────────────────────────────────────────────────────────────

/**
 * Coerce a raw `limits` object to a flat number map (`-1` = unlimited passes through).
 *
 * Numeric STRINGS count. `Plan.limits` is JSONB with no schema behind it, and a
 * super-admin editing the Plans page (or seeding a bespoke tier by hand) can
 * store `{"bots": "-1"}` just as easily as `{"bots": -1}`. The backend reads
 * that quota through `int(...)`, which accepts both, so dropping the string
 * here made the client and the server disagree about the same plan row: the
 * picker kept offering an unlimited-agents tier that `POST /bots/checkout`
 * then refused, and the customer's only feedback was a dead-end error after
 * they had chosen it. Matching `toNumber`'s existing string handling is what
 * keeps the two ends reading one value the same way.
 *
 * Anything that is not a finite number after coercion is still DROPPED rather
 * than defaulted to 0: an absent key reads as "this plan declares no such
 * quota", which every consumer already treats conservatively, whereas a 0
 * would read as a real quota of zero.
 */
function toNumberMap(raw: unknown): Record<string, number> {
  const record = asRecord(raw);
  if (!record) return {};
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      out[key] = value;
      continue;
    }
    // `Number('')` and `Number('   ')` are 0, so an empty string would land as
    // a hard quota of zero without this guard.
    if (typeof value === 'string' && value.trim() !== '') {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) out[key] = parsed;
    }
  }
  return out;
}

export function buildPlan(raw: unknown): PlanView | null {
  const record = asRecord(raw);
  if (!record) return null;
  const monthlyPriceMinor = toNumber(record.monthly_price_cents);
  const slug = toText(record.slug) || 'free';
  const features = asRecord(record.features) ?? {};
  return {
    id: toNumber(record.id),
    slug,
    name: toText(record.name) || 'Free',
    monthlyPriceMinor,
    annualPriceMinor: toNumber(record.annual_price_cents),
    monthlyPriceUsdMinor: toOptionalNumber(record.monthly_price_usd_cents),
    annualPriceUsdMinor: toOptionalNumber(record.annual_price_usd_cents),
    extraSeatPriceUsdMinor: toOptionalNumber(record.extra_seat_price_usd_cents),
    creditsPerMonth: toNumber(record.credits_per_month),
    includedSeats: toNumber(record.included_operator_seats),
    extraSeatPriceMinor: toNumber(record.extra_seat_price_cents),
    // Currency-independent: INR is the canonical column and is always set for
    // a paid tier, so this stays correct regardless of display currency.
    isPaid: monthlyPriceMinor > 0,
    isContactSales: features.contact_sales === true || features.enterprise === true,
    annualDiscountPercent: toNumber(record.annual_discount_percent),
    trialDays: toNumber(record.trial_days),
    sortOrder: toNumber(record.sort_order),
    features,
    limits: toNumberMap(record.limits),
    overageRateMinor: toNumber(record.overage_rate_cents),
  };
}

/**
 * Coerce the `/subscriptions/promo` payload into a PromotionView, or `null` when
 * no promotion is active for the client (`{ active: false }`). Display-only.
 * Checkout re-validates eligibility server-side, so this never grants the offer.
 */
export function buildPromotion(raw: unknown): PromotionView | null {
  const record = asRecord(raw);
  if (!record || record.active !== true) return null;
  const idsRaw = record.eligible_plan_ids;
  const eligiblePlanIds = Array.isArray(idsRaw)
    ? idsRaw.map((value) => toNumber(value)).filter((id) => id > 0)
    : null;
  return {
    id: toNumber(record.id) || null,
    name: toOptionalText(record.name),
    freeCycles: toNumber(record.free_cycles),
    endsAt: toOptionalText(record.ends_at),
    eligiblePlanIds,
  };
}

/**
 * Whether a promotion's free period applies to a plan (paid, self-serve, in scope).
 *
 * Mirrors `promotion_service._plan_eligible`, which scopes an offer by
 * `eligible_plan_ids` alone and otherwise covers every paid plan - the seeded
 * Enterprise tier included. This projection must not be stricter than the
 * server: showing the full price for an offer the backend would grant also
 * routes the purchase through change-plan instead of the checkout path that
 * realises the deferred free period, silently losing the offer. A bespoke
 * contact-sales tier is still excluded - it has no self-serve checkout for a
 * free period to defer. To keep an offer off Enterprise, scope it with
 * `eligible_plan_ids`.
 */
export function promotionAppliesToPlan(promo: PromotionView | null, plan: PlanView): boolean {
  if (!promo || !plan.isPaid || plan.isContactSales) return false;
  return promo.eligiblePlanIds === null || promo.eligiblePlanIds.includes(plan.id);
}

/** "3 months" / "1 month", the free-period length as a bare noun phrase. */
export function formatFreeMonths(freeCycles: number): string {
  const months = Math.max(0, Math.floor(freeCycles));
  return `${months} month${months === 1 ? '' : 's'}`;
}

/**
 * A sentence fragment naming which plans a promotion covers, for the banner
 * copy. Unrestricted (`eligiblePlanIds` null/empty) → "any monthly plan";
 * otherwise the named plan(s) in catalog order, e.g. "the Standard plan" or
 * "the Standard or Professional plan". Falls back to "any monthly plan" if the
 * ids resolve to no known plan, so the banner never renders a blank scope.
 */
export function formatPromotionScope(promotion: PromotionView, plans: PlanView[]): string {
  const ids = promotion.eligiblePlanIds;
  if (!ids || ids.length === 0) return 'any monthly plan';
  const allowed = new Set(ids);
  const names = plans
    .filter((plan) => allowed.has(plan.id))
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((plan) => plan.name);
  if (names.length === 0) return 'any monthly plan';
  if (names.length === 1) return `the ${names[0]} plan`;
  const last = names[names.length - 1];
  return `the ${names.slice(0, -1).join(', ')} or ${last} plan`;
}

export function buildSubscription(raw: unknown): SubscriptionView {
  const record = asRecord(raw);
  const status = record ? toText(record.status) : '';
  const scheduledRaw = record ? asRecord(record.scheduled_change) : null;
  return {
    status,
    billingCycle: (record && toText(record.billing_cycle)) || 'monthly',
    seats: record ? toNumber(record.operator_quantity) : 0,
    trialEnd: record ? toOptionalText(record.trial_end) : null,
    currentPeriodEnd: record ? toOptionalText(record.current_period_end) : null,
    promoFreeUntil: record ? toOptionalText(record.promo_free_until) : null,
    dataRetentionUntil: record ? toOptionalText(record.data_retention_until) : null,
    paymentProvider: record ? toOptionalText(record.payment_provider) : null,
    cancelAtPeriodEnd: record ? toBool(record.cancel_at_period_end) : false,
    scheduledChange: scheduledRaw
      ? {
          planName: toOptionalText(scheduledRaw.plan_name),
          effectiveAt: toOptionalText(scheduledRaw.effective_at),
        }
      : null,
    hasActive: status === 'active' || status === 'trialing',
  };
}

const INVOICE_KINDS: ReadonlySet<string> = new Set(['tax_invoice', 'credit_note', 'receipt']);

/**
 * How long a freshly-issued document is allowed to still be rendering before we
 * stop calling it "preparing" and admit it is not coming.
 *
 * The render is an ARQ job plus a five-minute reconciliation cron, so a couple
 * of minutes of patience is honest and an hour of it is not. Fifteen minutes is
 * comfortably past both and still inside the window where a customer who just
 * paid would plausibly refresh.
 */
export const INVOICE_RENDER_GRACE_MS = 15 * 60 * 1000;

function buildInvoiceTax(record: Record<string, unknown>): InvoiceTaxView | null {
  // Presence of a rate OR of any component is what says this row carries a tax
  // document at all. A legacy row (and every row while the customer-facing kill
  // switch is off) has all of them null, and inventing a zero-rated breakdown
  // for it would print "GST 0%" on an invoice that never had a GST line.
  const hasTaxFields =
    record.tax_rate_bps != null ||
    record.total_tax_minor != null ||
    record.taxable_value_minor != null;
  if (!hasTaxFields) return null;
  return {
    taxableMinor: toNumber(record.taxable_value_minor),
    totalTaxMinor: toNumber(record.total_tax_minor),
    cgstMinor: toNumber(record.cgst_minor),
    sgstMinor: toNumber(record.sgst_minor),
    igstMinor: toNumber(record.igst_minor),
    rateBps: toNumber(record.tax_rate_bps),
    hsnSac: toOptionalText(record.hsn_sac),
    supplyKind: toOptionalText(record.supply_kind),
    isExport: toBool(record.is_export),
  };
}

/**
 * Resolve the download state of one invoice. Exported so the rule is testable
 * without rendering a table.
 *
 * `now` is injected rather than read from the clock so a list formats against
 * one instant and a test is not hostage to timing.
 */
export function invoiceDocumentState(
  pdfUrl: string | null,
  issuedAt: string | null,
  now: number,
  graceMs: number = INVOICE_RENDER_GRACE_MS,
): InvoiceDocumentState {
  if (pdfUrl) return 'ready';
  if (!issuedAt) return 'unavailable';
  const issued = new Date(issuedAt).getTime();
  if (Number.isNaN(issued)) return 'unavailable';
  return now - issued < graceMs ? 'preparing' : 'unavailable';
}

export function buildInvoice(raw: unknown, index: number, now: number = Date.now()): InvoiceView {
  const record = asRecord(raw) ?? {};
  const rawType = toText(record.invoice_type);
  const kind: InvoiceKind = INVOICE_KINDS.has(rawType) ? (rawType as InvoiceKind) : 'legacy';
  const idValue = record.id;
  const id =
    typeof idValue === 'string' || typeof idValue === 'number'
      ? String(idValue)
      : `invoice-${index}`;
  // The backend stores credit notes (refunds/adjustments) as a POSITIVE
  // magnitude with `invoice_type='credit_note'` carrying the semantic negation
  // (api/app/services/invoice_service.py). Apply that negation here at the
  // boundary so the amount reads honestly as money returned (e.g. "-₹949")
  // instead of being indistinguishable from a charge. Other kinds keep the
  // magnitude (defensive against inconsistently-signed sources).
  const amountMagnitude = Math.abs(toNumber(record.amount_cents));
  const date = toOptionalText(record.issued_at) ?? toOptionalText(record.created_at);
  const pdfUrl = toOptionalText(record.pdf_url);
  return {
    id,
    number: toOptionalText(record.invoice_number),
    kind,
    amountMinor: kind === 'credit_note' ? -amountMagnitude : amountMagnitude,
    currency: (toText(record.currency) || 'INR').toUpperCase(),
    status: toText(record.status) || 'issued',
    date,
    periodStart: toOptionalText(record.period_start),
    periodEnd: toOptionalText(record.period_end),
    paidAt: toOptionalText(record.paid_at),
    pdfUrl,
    invoiceUrl: toOptionalText(record.invoice_url),
    description: toOptionalText(record.description),
    tax: buildInvoiceTax(record),
    document: invoiceDocumentState(pdfUrl, date, now),
  };
}

export function buildBillingDetails(raw: unknown): BillingDetailsView {
  const record = asRecord(raw);
  const legalName = record ? toOptionalText(record.legal_name) : null;
  const gstin = record ? toOptionalText(record.gstin) : null;
  const country = record ? toOptionalText(record.billing_country) : null;
  const email = record ? toOptionalText(record.billing_email) : null;
  const addressRecord = record ? asRecord(record.billing_address) : null;
  const address: BillingAddress | null = addressRecord
    ? {
        line1: toOptionalText(addressRecord.line1) ?? undefined,
        line2: toOptionalText(addressRecord.line2) ?? undefined,
        city: toOptionalText(addressRecord.city) ?? undefined,
        state: toOptionalText(addressRecord.state) ?? undefined,
        postal_code: toOptionalText(addressRecord.postal_code) ?? undefined,
      }
    : null;
  return {
    legalName,
    gstin,
    country,
    stateCode: record ? toOptionalText(record.billing_state_code) : null,
    email,
    address,
    companyName: record ? toOptionalText(record.company_name) : null,
    accountEmail: record ? toOptionalText(record.account_email) : null,
    isEmpty: !legalName && !gstin && !email && !address,
  };
}

// ── Formatters ───────────────────────────────────────────────────────────────

/**
 * Format a minor-unit amount as currency. Amounts are stored in the smallest
 * unit (INR paise), so we divide by 100. Trailing `.00` is dropped for whole
 * amounts to keep plan prices clean ("₹949" not "₹949.00").
 */
export function formatMoneyMinor(minorUnits: number, currency = 'INR'): string {
  // `safeCurrency` is a real ISO code carried by the data, never inferred from
  // the UI language: a workspace billed in INR is billed in INR whatever
  // language the dashboard is read in. The design-system formatter is what
  // makes the digits and grouping follow the chosen locale, and it already
  // degrades to a plain decimal on a code `Intl` refuses.
  const safeCurrency = /^[A-Z]{3}$/.test(currency) ? currency : 'INR';
  return formatMoney(minorUnits, safeCurrency);
}

export function formatCredits(count: number): string {
  return formatNumber(count);
}

/**
 * Operator-seat allowance as a display phrase.
 *
 * `included_operator_seats` is serialized raw to the frontend, and `-1` is the
 * UNLIMITED sentinel (`plan_entitlements_service.py::UNLIMITED`), never a real
 * count. Every seat-rendering surface goes through here so an unlimited tier
 * can't print "-1 operator seats", nor be described as having none by a bare
 * `> 0` test.
 */
export function formatSeatAllowance(includedSeats: number): string {
  if (includedSeats === UNLIMITED_LIMIT) return 'Unlimited operator seats';
  if (includedSeats <= 0) return 'No operator seats';
  return `${includedSeats} operator seat${includedSeats === 1 ? '' : 's'}`;
}

/**
 * Does this plan include UNLIMITED AI agents (`limits.bots === -1`)?
 *
 * Such a plan is an ACCOUNT product: it sells one credit pool shared across
 * every agent. Bought per-agent it would scope those credits to a single
 * agent's isolated ledger and leave every further agent it entitles unfunded.
 *
 * Exactly ONE picker filters on this: `CreateAgentDialog`, which drives
 * `POST /bots/checkout` - a per-agent product that cannot sell a pooled plan,
 * and where the backend refuses accordingly. The workspace Billing picker
 * deliberately does NOT filter: `POST /subscriptions/change-plan` demotes such a
 * purchase to account scope, which is what the tier sells, and filtering there
 * hid the tier from every customer who could buy it.
 *
 * Mirrors `plan_entitlements_service.plan_grants_unlimited_bots`.
 *
 * Conservative on bad data, exactly like the server: a plan row with no `bots`
 * quota (or one that cannot be read as a number at all) is NOT unlimited and
 * stays selectable. A quota stored as the STRING `"-1"` does count, because
 * `int("-1")` is what the server reads it as; `toNumberMap` normalises it.
 */
export function planGrantsUnlimitedAgents(plan: PlanView): boolean {
  return plan.limits.bots === UNLIMITED_LIMIT;
}

/**
 * One plan's annual saving as a whole percent, derived from the two amounts the
 * plan surfaces actually render: `annualPriceMinor` against twelve months of
 * `monthlyPriceMinor`.
 *
 * Deliberately NOT read from the stored `annualDiscountPercent`. That column is
 * one integer for a plan row that carries both an INR and a USD price pair, so
 * it can only ever match one rail; deriving from the displayed minor units
 * instead keeps the badge true in whichever currency the surface is showing,
 * including after the `TODO(multi-currency)` price source switches.
 *
 * Rounds DOWN. This number sits on a checkout surface next to a "Subscribe"
 * button, so the failure modes are not symmetric: understating a saving costs
 * nothing, while overstating one tells a customer they will be charged less
 * than they will be. 21.67% must read as 21%, never 22%.
 *
 * Returns 0 for any plan with no real annual saving to quote - free and
 * contact-sales tiers (no monthly price), plans with no annual price, and the
 * defensive case of an annual price at or above twelve monthly ones, which
 * would otherwise produce a negative "saving".
 */
export function annualSavingPercent(plan: PlanView): number {
  const twelveMonths = plan.monthlyPriceMinor * 12;
  const annual = plan.annualPriceMinor;
  if (twelveMonths <= 0 || annual <= 0 || annual >= twelveMonths) return 0;
  // Multiply before dividing: both operands stay exact integers, so a saving
  // that is exactly N% divides to exactly N and cannot floor down to N-1.
  return Math.floor(((twelveMonths - annual) * 100) / twelveMonths);
}

/**
 * The BEST annual saving across a plan set, as a whole percent - the number
 * behind the cycle toggle's "save up to X%".
 *
 * "Up to" is load-bearing in the label: this is a maximum across plans, not a
 * discount every plan grants, and the toggle is rendered next to tiers that
 * save less than the winner. Any caller phrasing this as a flat "save X%"
 * promises the best plan's deal on whichever plan the customer is reading.
 *
 * Contact-sales tiers are EXCLUDED. `GET /subscriptions/plans` returns every
 * active plan, including bespoke tiers a super-admin provisioned for one
 * account, and those carry real `monthly_price_cents` / `annual_price_cents`
 * even though every plan surface prices them as "Custom". Reducing over them
 * let a bespoke tier's 35% internal annual saving set the public toggle to
 * "Annual · save up to 35%" beside a card quoting no price at all. "Up to"
 * keeps that literally true, but the rate is unattainable on anything the
 * reader can actually buy, which is the one thing the badge is claiming.
 *
 * Returns 0 when no plan has an annual saving - callers should drop the badge
 * entirely rather than render "save up to 0%".
 */
export function maxAnnualSavingPercent(plans: readonly PlanView[]): number {
  return plans.reduce(
    (best, plan) => (plan.isContactSales ? best : Math.max(best, annualSavingPercent(plan))),
    0,
  );
}

/**
 * Dates render through the design system's formatter, not a local copy.
 *
 * Re-exported here only so the billing modules have one import for their
 * formatting. An earlier version had its own `toLocaleDateString` call, which
 * meant an absent date rendered as `-` on this surface and as the console's em
 * dash everywhere else - and rule 10 is that every absent value is the same
 * mark.
 */
import { formatDate, formatMoney, formatNumber } from '../../ui/lib/formatters';
export { formatDate };

export interface RenewalDisplay {
  caption: string;
  label: string;
}

/**
 * Caption + date for the Overview "renews" panel. A subscription redeemed on
 * a launch promo has no `currentPeriodEnd` yet - Razorpay only starts a real
 * billing cycle once the free period's deferred `start_at` triggers the first
 * charge - so falling straight through to `currentPeriodEnd` left the panel
 * blank ("Renews -") for every promo customer with no indication they were on
 * a free month at all. Prefer `promoFreeUntil` whenever there's no period end
 * yet, with its own "Free until" caption so it doesn't read as an existing
 * paid cycle renewing.
 */
export function getRenewalDisplay(
  subscription: Pick<SubscriptionView, 'trialEnd' | 'currentPeriodEnd' | 'promoFreeUntil'> | null | undefined,
  pendingCancel: boolean
): RenewalDisplay {
  if (subscription?.trialEnd) {
    return { caption: 'Trial ends', label: formatDate(subscription.trialEnd) };
  }
  if (!subscription?.currentPeriodEnd && subscription?.promoFreeUntil) {
    return { caption: 'Free until', label: formatDate(subscription.promoFreeUntil) };
  }
  return {
    caption: pendingCancel ? 'Plan ends' : 'Renews',
    label: formatDate(subscription?.currentPeriodEnd ?? null),
  };
}

/**
 * The design system's five tones. There is deliberately no `info`: an
 * informational notice is neutral with an ink rule, and a blue one would have
 * collided with the interactive accent (`DESIGN.md` §2.4).
 */
export type BadgeTone = 'neutral' | 'success' | 'warning' | 'danger' | 'plan';

/**
 * Map a subscription or invoice status onto a badge tone.
 *
 * `trialing` is `plan` rather than a status colour: a trial is an entitlement
 * state, and brass is the reserved hue for exactly that. `paused` and
 * `canceled` are NOT the same tone - a paused subscription can resume, a
 * cancelled one has ended - so they get warning and neutral respectively.
 * `pending` is an invoice we are still waiting to be paid, which is a warning;
 * `issued` is a credit note, which is simply a record.
 */
export function statusTone(status: string): BadgeTone {
  switch (status) {
    case 'active':
    case 'paid':
      return 'success';
    case 'trialing':
      return 'plan';
    case 'past_due':
    case 'expired':
    case 'trial_expired':
    case 'failed':
      return 'danger';
    case 'paused':
    case 'pending':
      return 'warning';
    default:
      return 'neutral';
  }
}

/** Human label for a subscription status (title-cased, underscores → spaces). */
export function humanizeStatus(status: string): string {
  if (!status) return 'No subscription';
  return status
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export const INVOICE_KIND_LABEL: Record<InvoiceKind, string> = {
  tax_invoice: 'Tax invoice',
  credit_note: 'Credit note',
  receipt: 'Receipt',
  legacy: 'Payment',
};

// ── Geo and the two currencies ───────────────────────────────────────────────

/**
 * The geo/currency profile from `GET /subscriptions/geo`.
 *
 * `displayCurrency` is what the customer should READ. It is not necessarily
 * what Razorpay will DEBIT: the rail is INR-only today, so a buyer whose
 * country resolves outside India sees USD over an INR charge. That divergence
 * is a compliance fact, not a formatting detail, which is why every price this
 * module produces carries both halves.
 */
export interface BillingGeoView {
  /** ISO-2 billing country, or null when nothing has resolved one. */
  country: string | null;
  /**
   * How the country was established. `stored` is an account fact the customer
   * confirmed; `detected` is an IP signal that is display-grade ONLY and must
   * never be echoed back into a money route as `billing_country`; `null` means
   * unresolved, which the charge gate treats as domestic.
   */
  countrySource: 'stored' | 'detected' | null;
  /** `INR` or `USD`. What prices are shown in. */
  displayCurrency: string;
  /** USD→INR rate used to derive a display price when a plan has no USD column. */
  displayRate: number;
  /** False when Razorpay is not wired, so no surface may offer a pay button. */
  checkoutAvailable: boolean;
  contactSalesEmail: string;
}

/** The currency Razorpay actually debits. One rail, and it is rupees. */
export const CHARGE_CURRENCY = 'INR';

export function buildGeo(raw: unknown): BillingGeoView {
  const record = asRecord(raw);
  const source = record ? toText(record.country_source) : '';
  const rate = record ? toNumber(record.display_rate) : 0;
  return {
    country: record ? toOptionalText(record.country) : null,
    countrySource: source === 'stored' || source === 'detected' ? source : null,
    // Unknown resolves to the charge currency, never to USD. The opposite
    // default was a live money bug: the top-up modal rendered $13/$50/$125
    // while Razorpay debited ₹1,000/₹4,000/₹10,000.
    displayCurrency: (record ? toText(record.display_currency) : '').toUpperCase() || CHARGE_CURRENCY,
    displayRate: rate > 0 ? rate : 0,
    checkoutAvailable: record ? record.checkout_available !== false : false,
    contactSalesEmail: (record && toOptionalText(record.contact_sales_email)) || SALES_EMAIL,
  };
}

export type BillingCycleKey = 'monthly' | 'annual';

/**
 * One plan price, told honestly.
 *
 * `displayMinor`/`displayCurrency` is what the customer reads.
 * `chargeMinor`/`chargeCurrency` is what the gateway debits. When they differ,
 * `converted` says whether the displayed figure was derived from a rate rather
 * than read from a real USD price column - which matters because a derived
 * figure moves with the rate and the charge does not.
 */
export interface PlanPriceView {
  displayMinor: number;
  displayCurrency: string;
  chargeMinor: number;
  chargeCurrency: string;
  /** True when display and charge are not the same currency. */
  crossCurrency: boolean;
  /** True when the display figure came from a conversion rate, not a stored USD price. */
  converted: boolean;
}

/**
 * Resolve what to show and what will be charged for one plan at one cycle.
 *
 * The INR column is the source of truth for the charge in every branch - it is
 * the amount the Razorpay mandate is created for. USD is display only: read
 * from the plan's own `*_price_usd_cents` when the backend serves one, and
 * otherwise derived from the geo rate so a non-IN buyer is never shown a rupee
 * figure they cannot read. Either way the INR charge travels with it.
 */
export function resolvePlanPrice(
  plan: PlanView,
  cycle: BillingCycleKey,
  geo: BillingGeoView | null,
): PlanPriceView {
  const chargeMinor = cycle === 'annual' ? plan.annualPriceMinor : plan.monthlyPriceMinor;
  const usdMinorOverride =
    cycle === 'annual' ? plan.annualPriceUsdMinor : plan.monthlyPriceUsdMinor;
  const displayCurrency = (geo?.displayCurrency ?? CHARGE_CURRENCY).toUpperCase();
  if (displayCurrency === CHARGE_CURRENCY) {
    return {
      displayMinor: chargeMinor,
      displayCurrency: CHARGE_CURRENCY,
      chargeMinor,
      chargeCurrency: CHARGE_CURRENCY,
      crossCurrency: false,
      converted: false,
    };
  }
  if (usdMinorOverride != null && usdMinorOverride > 0) {
    return {
      displayMinor: usdMinorOverride,
      displayCurrency,
      chargeMinor,
      chargeCurrency: CHARGE_CURRENCY,
      crossCurrency: true,
      converted: false,
    };
  }
  const rate = geo?.displayRate ?? 0;
  // No usable rate means no honest conversion, so fall back to quoting the
  // charge itself rather than inventing a number. A wrong price on a checkout
  // surface is worse than an unfamiliar currency symbol.
  if (rate <= 0) {
    return {
      displayMinor: chargeMinor,
      displayCurrency: CHARGE_CURRENCY,
      chargeMinor,
      chargeCurrency: CHARGE_CURRENCY,
      crossCurrency: false,
      converted: false,
    };
  }
  return {
    displayMinor: Math.round(chargeMinor / rate),
    displayCurrency,
    chargeMinor,
    chargeCurrency: CHARGE_CURRENCY,
    crossCurrency: true,
    converted: true,
  };
}

/**
 * The sentence that has to sit under a cross-currency price.
 *
 * Returns `null` when display and charge agree, so a domestic customer is not
 * shown a disclaimer about a conversion that never happens. When they differ
 * the charge amount is named in full: showing a converted price as if it were
 * the charge is a compliance problem, not a nicety.
 */
export function chargeDisclosure(price: PlanPriceView): string | null {
  if (!price.crossCurrency) return null;
  const charged = formatMoneyMinor(price.chargeMinor, price.chargeCurrency);
  return price.converted
    ? `Charged as ${charged}. The ${price.displayCurrency} figure is an indication at today's rate; your card is debited in rupees.`
    : `Charged as ${charged}. Payments settle on our Indian rupee rail.`;
}

// ── Plan allowances ──────────────────────────────────────────────────────────

/**
 * How many chatbots a plan entitles, as a phrase.
 *
 * `limits.bots` is `-1` for the unlimited (agency) tiers and the sentinel is
 * never rendered as a number. A plan row that declares no `bots` quota at all
 * is reported as unknown rather than as zero, matching the backend's own
 * "this plan lost a term" logging path in `bot_routes._plan_bots_limit_allows`.
 */
export function formatAgentAllowance(plan: PlanView | null): string {
  if (!plan) return 'Not set';
  const quota = plan.limits.bots;
  if (quota === undefined) return 'Not set';
  if (quota === UNLIMITED_LIMIT) return 'Unlimited chatbots';
  if (quota <= 0) return 'No chatbots included';
  return `${quota} chatbot${quota === 1 ? '' : 's'}`;
}

/**
 * The plan's overage rate per credit, or null when it charges none.
 *
 * Configured per plan (`Plan.overage_rate_cents`) and never shown until now, so
 * a customer could exceed their allowance without knowing what the next credit
 * would cost.
 */
export function formatOverageRate(overageRateMinor: number, currency = CHARGE_CURRENCY): string | null {
  if (!Number.isFinite(overageRateMinor) || overageRateMinor <= 0) return null;
  const major = overageRateMinor / 100;
  const safeCurrency = /^[A-Z]{3}$/.test(currency) ? currency : CHARGE_CURRENCY;
  try {
    return `${new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency: safeCurrency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 4,
    }).format(major)} per extra credit`;
  } catch {
    return `${safeCurrency} ${major} per extra credit`;
  }
}

/** "7-day free trial" / null when the plan offers none. */
export function formatTrialOffer(trialDays: number): string | null {
  const days = Math.floor(trialDays);
  return days > 0 ? `${days}-day free trial` : null;
}

// ── Dunning: the state a failed card puts a workspace in ─────────────────────

/**
 * Whether the gateway can still rescue this subscription.
 *
 * Tri-state on purpose, mirroring `GET /subscriptions/payment-recovery`:
 * `true` means there is a hosted page to send the customer to, `false` means
 * the mandate is terminal and a new subscription is the only way back, and
 * `null` means we could not reach Razorpay to ask. `null` must never render as
 * a dead button, and must never render as "your subscription is gone" - the
 * customer is past due either way, and that part is locally known.
 */
export type RecoveryState = 'recoverable' | 'settled' | 'unknown';

export interface DunningView {
  pastDue: boolean;
  recovery: RecoveryState;
  /** Hosted Razorpay page that re-authorises the mandate. Present only when recoverable. */
  recoveryUrl: string | null;
  /** Days left in the grace window before the subscription expires to Free. */
  daysLeft: number | null;
  planName: string | null;
}

export function buildDunning(raw: unknown): DunningView {
  const record = asRecord(raw);
  const pastDue = record ? toBool(record.past_due) : false;
  const recoverable = record ? record.recoverable : undefined;
  const daysRaw = record ? record.days_left : null;
  return {
    pastDue,
    recovery:
      recoverable === true ? 'recoverable' : recoverable === false ? 'settled' : 'unknown',
    recoveryUrl: record ? toOptionalText(record.recovery_url) : null,
    daysLeft: typeof daysRaw === 'number' && Number.isFinite(daysRaw) ? daysRaw : null,
    planName: record ? toOptionalText(record.plan_name) : null,
  };
}

/**
 * What the customer must be told when their card has failed.
 *
 * Three sentences, in this order: what happened, what happens next and when,
 * and what they can do. The console had no dunning surface at all before this,
 * so a customer whose card failed learned about it when their chatbot stopped
 * answering.
 */
export function dunningMessage(dunning: DunningView): string {
  const plan = dunning.planName ? `your ${dunning.planName} plan` : 'your plan';
  const deadline =
    dunning.daysLeft == null
      ? `${plan} will be downgraded to Free when the grace period ends`
      : dunning.daysLeft <= 0
        ? `${plan} is being downgraded to Free now`
        : `${plan} will be downgraded to Free in ${dunning.daysLeft} day${dunning.daysLeft === 1 ? '' : 's'}`;
  const remedy =
    dunning.recovery === 'recoverable'
      ? 'Pay the outstanding amount to keep it.'
      : dunning.recovery === 'settled'
        ? 'This mandate can no longer be retried, so pick a plan again to restore it.'
        : 'We could not reach the payment gateway to check whether it can be retried. Try again in a few minutes.';
  return `We could not take your last payment. ${deadline}. ${remedy}`;
}

// ── Downgrade re-auth: past_due that is not a failed payment ─────────────────

/**
 * The grace row a paid→paid downgrade leaves behind.
 *
 * It reads `past_due` but nothing failed: the customer owes a one-time
 * authorisation of the NEW, cheaper mandate. Rendering it in the dunning banner
 * would tell a customer their payment was declined when it was not, and there
 * is no mandate to build a recovery link from, so the two states are kept apart
 * here exactly as the backend keeps them apart in `payment_recovery`.
 */
export interface ReauthView {
  required: boolean;
  targetPlanName: string | null;
  graceUntil: string | null;
  daysLeft: number | null;
}

export function buildReauth(raw: unknown): ReauthView | null {
  const record = asRecord(raw);
  if (!record || record.required !== true) return null;
  const daysRaw = record.days_left;
  return {
    required: true,
    targetPlanName: toOptionalText(record.target_plan_name),
    graceUntil: toOptionalText(record.grace_until),
    daysLeft: typeof daysRaw === 'number' && Number.isFinite(daysRaw) ? daysRaw : null,
  };
}

// ── Cancellation: the consequence, stated in full ────────────────────────────

export interface CancellationConsequence {
  /** The date access actually ends. Null when the API has not told us one. */
  endsAt: string | null;
  /** Sentences to put in the confirm dialog, in reading order. */
  lines: string[];
}

/**
 * What cancelling actually does, with the real date.
 *
 * "This cannot be undone" is not a consequence. Cancelling here is scheduled,
 * not immediate: the plan runs to the end of the period already paid for, the
 * plan credit grant stops at that date, purchased top-up credits survive it
 * because they were bought outright, and the workspace drops to Free rather
 * than disappearing. Every one of those is something a customer would
 * reasonably assume the other way round.
 */
export function cancellationConsequence(
  subscription: Pick<SubscriptionView, 'currentPeriodEnd' | 'trialEnd' | 'status'>,
  planName: string | null,
  topupCreditsRemaining: number,
): CancellationConsequence {
  const endsAt = subscription.trialEnd ?? subscription.currentPeriodEnd;
  const when = endsAt ? formatDate(endsAt) : null;
  const plan = planName ?? 'your plan';
  const lines: string[] = [];
  lines.push(
    when
      ? `${plan} stays active until ${when}. You keep everything it includes until then, and you are not charged again.`
      : `${plan} stays active until the end of the period you have already paid for, and you are not charged again.`,
  );
  lines.push(
    when
      ? `On ${when} the workspace drops to Free. Your monthly credit grant stops, and any unused plan credits are lost.`
      : 'When it ends the workspace drops to Free. Your monthly credit grant stops, and any unused plan credits are lost.',
  );
  if (topupCreditsRemaining > 0) {
    lines.push(
      `Your ${formatCredits(topupCreditsRemaining)} purchased top-up credits are unaffected - you bought those outright and they stay in the workspace.`,
    );
  }
  lines.push('Your chatbots, documents and conversations are kept. You can resubscribe at any time.');
  return { endsAt, lines };
}

/**
 * The HTTP status behind a rejected API call, when there was one.
 *
 * `buildApiError` stamps it onto the Error it throws, which is the only way a
 * surface can tell "your plan does not include this" (403) apart from "we could
 * not load this" (a network failure) - and those are two of the four states
 * every surface owes its user.
 */
export function errorStatus(error: unknown): number | null {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : null;
}

/** The user-facing message on a rejected API call, with a stated fallback. */
export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
