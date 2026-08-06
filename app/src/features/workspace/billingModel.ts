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
  creditsPerMonth: number;
  includedSeats: number;
  /** Per-extra-seat monthly price in INR minor units. */
  extraSeatPriceMinor: number;
  isPaid: boolean;
  /**
   * True for a "contact sales" tier - priced on request, not self-serve
   * checkout. Derived from `slug === 'enterprise'` or a `contact_sales` /
   * `enterprise` feature flag, so a seeded enterprise plan routes to sales
   * instead of the Razorpay money-path.
   */
  isEnterprise: boolean;
  /** Headline annual discount (e.g. 20 → "–20%"). 0 when the plan has no annual saving. */
  annualDiscountPercent: number;
  /** Free-trial length in days; 0 for plans with no trial (Free). */
  trialDays: number;
  /** Catalog ordering from the backend (`sort_order`). */
  sortOrder: number;
  /** Raw `features` flags from the plan payload (bant, live_chat, webhooks, …). Read by the plan matrix. */
  features: Record<string, unknown>;
  /** Raw `limits` counters from the plan payload (max_crawl_pages, chat_history_days, …). `-1` = unlimited. */
  limits: Record<string, number>;
}

export interface PromotionView {
  id: number | null;
  name: string | null;
  /** Billing cycles granted free before the first real charge (e.g. 3). */
  freeCycles: number;
  /** Campaign end (ISO) — after this, new signups stop qualifying. */
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
  /** Post-trial grace deadline after which the workspace is deleted (trial_expired only). */
  dataRetentionUntil: string | null;
  paymentProvider: string | null;
  cancelAtPeriodEnd: boolean;
  scheduledChange: ScheduledChangeView | null;
  /** True when the subscription is billing (active or trialing). */
  hasActive: boolean;
}

export type InvoiceKind = 'tax_invoice' | 'credit_note' | 'receipt' | 'legacy';

export interface InvoiceView {
  id: string;
  number: string | null;
  kind: InvoiceKind;
  amountMinor: number;
  currency: string;
  status: string;
  date: string | null;
  pdfUrl: string | null;
  invoiceUrl: string | null;
  description: string | null;
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

/** Coerce a raw `limits` object to a flat number map (`-1` = unlimited passes through). */
function toNumberMap(raw: unknown): Record<string, number> {
  const record = asRecord(raw);
  if (!record) return {};
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
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
    creditsPerMonth: toNumber(record.credits_per_month),
    includedSeats: toNumber(record.included_operator_seats),
    extraSeatPriceMinor: toNumber(record.extra_seat_price_cents),
    // Currency-independent: INR is the canonical column and is always set for
    // a paid tier, so this stays correct regardless of display currency.
    isPaid: monthlyPriceMinor > 0,
    isEnterprise: slug === 'enterprise' || features.contact_sales === true || features.enterprise === true,
    annualDiscountPercent: toNumber(record.annual_discount_percent),
    trialDays: toNumber(record.trial_days),
    sortOrder: toNumber(record.sort_order),
    features,
    limits: toNumberMap(record.limits),
  };
}

/**
 * Coerce the `/subscriptions/promo` payload into a PromotionView, or `null` when
 * no promotion is active for the client (`{ active: false }`). Display-only —
 * checkout re-validates eligibility server-side, so this never grants the offer.
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

/** Whether a promotion's free period applies to a plan (paid, non-enterprise, in scope). */
export function promotionAppliesToPlan(promo: PromotionView | null, plan: PlanView): boolean {
  if (!promo || !plan.isPaid || plan.isEnterprise) return false;
  return promo.eligiblePlanIds === null || promo.eligiblePlanIds.includes(plan.id);
}

/** "3 months" / "1 month" — the free-period length as a bare noun phrase. */
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

export function buildInvoice(raw: unknown, index: number): InvoiceView {
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
  return {
    id,
    number: toOptionalText(record.invoice_number),
    kind,
    amountMinor: kind === 'credit_note' ? -amountMagnitude : amountMagnitude,
    currency: (toText(record.currency) || 'INR').toUpperCase(),
    status: toText(record.status) || 'issued',
    date: toOptionalText(record.issued_at) ?? toOptionalText(record.created_at),
    pdfUrl: toOptionalText(record.pdf_url),
    invoiceUrl: toOptionalText(record.invoice_url),
    description: toOptionalText(record.description),
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
  const major = minorUnits / 100;
  const safeCurrency = /^[A-Z]{3}$/.test(currency) ? currency : 'INR';
  try {
    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency: safeCurrency,
      minimumFractionDigits: Number.isInteger(major) ? 0 : 2,
      maximumFractionDigits: 2,
    }).format(major);
  } catch {
    // Unknown currency code → fall back to a plain number with the code.
    return `${safeCurrency} ${major.toLocaleString('en-IN')}`;
  }
}

export function formatCredits(count: number): string {
  return count.toLocaleString('en-IN');
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '-';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

export type BadgeTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info';

/** Map a subscription/invoice status string to a StatusBadge tone. */
export function statusTone(status: string): BadgeTone {
  switch (status) {
    case 'active':
    case 'paid':
      return 'success';
    case 'trialing':
    case 'issued':
      return 'info';
    case 'past_due':
    case 'expired':
      return 'danger';
    case 'paused':
    case 'canceled':
    case 'cancelled':
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
