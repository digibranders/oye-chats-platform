/**
 * affiliateModel — typed view-models + formatters for the Workspace ▸ Affiliate
 * area.
 *
 * The reused affiliate endpoints (getAffiliateMe / getAffiliateCodes /
 * getAffiliateStats / getAffiliateCodeReferrals) are declared loosely in
 * `services/api.d.ts`, so this module owns the boundary: it coerces those
 * runtime shapes into strict, presentation-ready view-models. Pages/modals
 * never touch a raw record.
 *
 * Money note: the platform bills on the single Razorpay INR rail, and the
 * backend now reports affiliate earnings in INR minor units (paise). All money
 * here is INR paise; format with `formatInrMinor`.
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

/** The affiliate's own program terms (`GET /affiliate/me`). */
export interface AffiliateProfile {
  id: number;
  /** How many codes the affiliate may keep active at once. */
  maxActiveCodes: number;
  /** The affiliate's total commission pool, as a whole percent (0–100). */
  commissionPct: number;
}

/** One referral code with its lifetime counters (`GET /affiliate/codes`). */
export interface AffiliateCodeView {
  id: number;
  code: string;
  label: string | null;
  active: boolean;
  /** What the affiliate keeps, whole percent. */
  affiliateCommissionPct: number;
  /** What the referred customer saves, whole percent. */
  customerDiscountPct: number;
  clicks: number;
  signups: number;
  /** Signups ÷ clicks, whole percent. */
  conversionPct: number;
  createdAt: string | null;
  deactivatedAt: string | null;
}

/** Aggregate counters for the dashboard header (`GET /affiliate/stats`). */
export interface AffiliateStatsView {
  totalClicks: number;
  totalSignups: number;
  activeCodes: number;
  maxActiveCodes: number;
  conversionPct: number;
}

// ── Coercion ─────────────────────────────────────────────────────────────────

export function toAffiliateProfile(raw: unknown): AffiliateProfile | null {
  const record = asRecord(raw);
  if (!record) return null;
  return {
    id: toNumber(record.id),
    maxActiveCodes: toNumber(record.max_active_codes),
    commissionPct: toNumber(record.commission_pct),
  };
}

export function toAffiliateCode(raw: unknown): AffiliateCodeView | null {
  const record = asRecord(raw);
  if (!record) return null;
  return {
    id: toNumber(record.id),
    code: toText(record.code),
    label: toOptionalText(record.label),
    active: toBool(record.active),
    affiliateCommissionPct: toNumber(record.affiliate_commission_pct),
    customerDiscountPct: toNumber(record.customer_discount_pct),
    clicks: toNumber(record.clicks),
    signups: toNumber(record.signups),
    conversionPct: toNumber(record.conversion_pct),
    createdAt: toOptionalText(record.created_at),
    deactivatedAt: toOptionalText(record.deactivated_at),
  };
}

export function toAffiliateCodes(raw: unknown): AffiliateCodeView[] {
  return Array.isArray(raw)
    ? raw.map(toAffiliateCode).filter((c): c is AffiliateCodeView => c !== null)
    : [];
}

export function toAffiliateStats(raw: unknown): AffiliateStatsView {
  const record = asRecord(raw) ?? {};
  return {
    totalClicks: toNumber(record.total_clicks),
    totalSignups: toNumber(record.total_signups),
    activeCodes: toNumber(record.active_codes),
    maxActiveCodes: toNumber(record.max_active_codes),
    conversionPct: toNumber(record.conversion_pct),
  };
}

// ── Formatters ───────────────────────────────────────────────────────────────

/** Format INR minor units (paise) as a rupee string: `142350 → "₹1,423.50"`. */
export function formatInrMinor(minorUnits: number): string {
  const major = toNumber(minorUnits) / 100;
  try {
    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency: 'INR',
      minimumFractionDigits: Number.isInteger(major) ? 0 : 2,
      maximumFractionDigits: 2,
    }).format(major);
  } catch {
    return `₹${major.toLocaleString('en-IN')}`;
  }
}

/** Format a whole-percent number: `15 → "15%"`, `12.5 → "12.5%"`. */
export function formatPct(pct: number): string {
  const n = toNumber(pct);
  return `${Number.isInteger(n) ? n : n.toFixed(1)}%`;
}

/**
 * The public share URL for a referral code. Clicks on `?ref=CODE` are what the
 * backend attributes, so this is the link an affiliate copies and shares.
 */
export function referralShareUrl(code: string, origin: string): string {
  const base = origin.replace(/\/$/, '');
  return `${base}/?ref=${encodeURIComponent(code)}`;
}

/**
 * Validate a proposed commission split against the affiliate's pool. The
 * affiliate's cut + the customer's discount may not exceed the pool the
 * super-admin granted (mirrors the backend `_validate_split`). Returns an error
 * string, or null when the split is valid.
 */
export function validateSplit(
  affiliatePct: number,
  customerPct: number,
  poolPct: number,
): string | null {
  const a = toNumber(affiliatePct);
  const c = toNumber(customerPct);
  if (a < 0 || c < 0) return 'Percentages cannot be negative.';
  if (a + c > poolPct) {
    return `Your cut (${formatPct(a)}) + customer discount (${formatPct(c)}) exceeds your ${formatPct(poolPct)} pool.`;
  }
  return null;
}

/** Referral-code format rule mirrored from the backend (3–20 url-safe chars). */
const CODE_PATTERN = /^[A-Za-z0-9_-]{3,20}$/;

/** Validate a referral code's format. Returns an error string, or null. */
export function validateCodeFormat(code: string): string | null {
  const trimmed = code.trim();
  if (!trimmed) return 'Enter a code.';
  if (!CODE_PATTERN.test(trimmed)) {
    return 'Use 3–20 letters, numbers, hyphens or underscores.';
  }
  return null;
}
