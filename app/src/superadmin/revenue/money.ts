import { ABSENT, formatMoney, formatNumber } from '../../ui';

/**
 * Money, in a console where three different things are all called "cents".
 *
 * The platform charges through Razorpay in INR, issues some documents in USD,
 * and reports its own aggregates in a *third* figure: USD cents that the server
 * produced by dividing INR amounts by a fixed internal display rate
 * (`_to_usd_cents` in `superadmin_plan_routes.py`). Those three are not
 * interchangeable, and the one that is easiest to get wrong is the third,
 * because it looks like real USD and is not — it is a reporting convention.
 *
 * So every amount this section renders goes through one of the two functions
 * below, and each of them forces the caller to say which kind it has.
 */

/**
 * What a normalised figure actually is, said once so every surface says it the
 * same way. Deliberately does not quote the rate: it is an environment variable
 * on the API (`DISPLAY_USD_TO_INR`) and the console has no endpoint that reads
 * it back, so printing the frontend's fallback constant would be a guess
 * presented as a fact.
 */
export const USD_NORMALISED_NOTE =
  'USD. Amounts stored in INR were converted server-side at OyeChats’ fixed display rate — a reporting convention, not a market FX rate.';

/** The short form, for a stat tile's period line or a column header hint. */
export const USD_NORMALISED_SHORT = 'USD (converted)';

const CURRENCY_CODE = /^[A-Za-z]{3}$/;

/**
 * An ISO code, or `null` when the server sent something `Intl` would throw on.
 *
 * `Intl.NumberFormat` raises a `RangeError` for a malformed currency, which
 * would take out the whole table rather than one cell — and the legacy invoice
 * rows in this database predate the currency column being required.
 */
export function normaliseCurrency(currency: string | null | undefined): string | null {
  if (typeof currency !== 'string') return null;
  const code = currency.trim().toUpperCase();
  return CURRENCY_CODE.test(code) ? code : null;
}

/**
 * A figure the server already normalised to USD cents.
 *
 * Always paired on screen with `USD_NORMALISED_NOTE` or `USD_NORMALISED_SHORT`
 * — an unlabelled "$4,182" beside a rupee invoice is exactly the confusion this
 * module exists to prevent.
 */
export function usdCents(cents: number | null | undefined): string {
  if (cents == null || !Number.isFinite(cents)) return ABSENT;
  return formatMoney(cents, 'USD', { showDecimals: true });
}

/** The same figure without decimals, for headline tiles where paise are noise. */
export function usdCentsRounded(cents: number | null | undefined): string {
  if (cents == null || !Number.isFinite(cents)) return ABSENT;
  return formatMoney(cents, 'USD', { showDecimals: false });
}

/**
 * A document amount, in the currency that document is denominated in.
 *
 * No conversion, ever. An invoice is a legal record of a specific sum in a
 * specific currency, and restating it in another one on a support screen is how
 * a refund goes out at the wrong amount.
 */
export function docMoney(
  minor: number | null | undefined,
  currency: string | null | undefined,
): string {
  if (minor == null || !Number.isFinite(minor)) return ABSENT;
  const code = normaliseCurrency(currency);
  // No usable code: show the stored integer and say it is unconverted minor
  // units. Picking a symbol here would be inventing the fact that is missing.
  if (!code) return `${formatNumber(minor)} minor units (currency not recorded)`;
  return formatMoney(minor, code, { showDecimals: true });
}

/** `"₹1,499.00 INR"` — for a cell that sits in a column of mixed currencies. */
export function docMoneyWithCode(
  minor: number | null | undefined,
  currency: string | null | undefined,
): string {
  const amount = docMoney(minor, currency);
  const code = normaliseCurrency(currency);
  if (amount === ABSENT || !code) return amount;
  return `${amount} ${code}`;
}

/** The UNLIMITED sentinel the plan tables use. Never rendered as a number. */
export const UNLIMITED = -1;

/**
 * A plan limit, as words.
 *
 * `-1` means unlimited; `0` means the plan genuinely includes none of this,
 * which is a different fact from "we do not know", and both are different from
 * a real ceiling. All three had been rendering as bare integers.
 */
export function limitLabel(limit: number | null | undefined): string {
  if (limit == null || !Number.isFinite(limit)) return ABSENT;
  if (limit === UNLIMITED || limit < 0) return 'Unlimited';
  return formatNumber(limit);
}

/** `"412 / 500"`, `"412 / Unlimited"`, `"— / 500"`. */
export function usageLabel(used: number | null | undefined, limit: number | null | undefined): string {
  return `${used == null || !Number.isFinite(used) ? ABSENT : formatNumber(used)} / ${limitLabel(limit)}`;
}

/**
 * How full a quota is, as a 0–1 fraction, or `null` when the question does not
 * apply — an unlimited allowance and a zero-sized one both have no meaningful
 * percentage, and dividing by either produces `Infinity` or `NaN`.
 */
export function usageFraction(used: number, limit: number): number | null {
  if (!Number.isFinite(used) || !Number.isFinite(limit)) return null;
  if (limit <= 0) return null;
  return used / limit;
}

/** Tone for a quota row: warning from 80%, danger at or past the limit. */
export function usageTone(used: number, limit: number): 'neutral' | 'warning' | 'danger' {
  const fraction = usageFraction(used, limit);
  if (fraction == null) return 'neutral';
  if (fraction >= 1) return 'danger';
  if (fraction >= 0.8) return 'warning';
  return 'neutral';
}

/** Basis points as a percentage string: `1800` → `18%`. */
export function bpsLabel(bps: number | null | undefined): string {
  if (bps == null || !Number.isFinite(bps)) return ABSENT;
  const percent = bps / 100;
  return `${Number.isInteger(percent) ? percent : percent.toFixed(2)}%`;
}
