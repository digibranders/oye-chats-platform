/**
 * Tax disclosure wording, shared by every billing surface that quotes a price.
 *
 * Kept apart from the {@link TaxNote} component so the sentences and the rate
 * formatting can be reused (and pinned by tests) without a component import,
 * and so no surface grows a second, drifting copy of "18% GST".
 *
 * Nothing here computes money. The only arithmetic is a basis-points to percent
 * conversion for display; every amount comes from the server.
 */

/**
 * A tax rate in basis points, rendered as a percentage figure: 1800 -> "18",
 * 1850 -> "18.5". Whole percentages carry no trailing ".0", because "18.0% GST"
 * reads as machine output on a sentence a customer is meant to trust.
 */
export function formatTaxRatePercent(rateBps: number): string {
  const percent = Number(rateBps) / 100;
  if (!Number.isFinite(percent)) return '0';
  return String(Number(percent.toFixed(2)));
}

/**
 * The domestic disclosure. Built from the rate the server reports rather than a
 * hardcoded 18, so a rate change on the server cannot leave this sentence
 * describing a charge that no longer happens.
 */
export function taxNoteInr(rateBps: number): string {
  return `Prices exclude GST. ${formatTaxRatePercent(rateBps)}% GST is added at checkout.`;
}

/**
 * The export disclosure. An export of services carries no Indian GST, so this
 * must never mention it; whatever the customer's own jurisdiction levies is not
 * ours to quote.
 */
export const TAX_NOTE_USD =
  'Prices are in USD. Any taxes due in your own country are not included.';

/**
 * Normalise a rate read off the currency context or an API envelope. A response
 * that predates `tax_rate_bps`, or anything unreadable, is 0: the same answer as
 * a seller who adds no tax, and the only safe thing to say about a rate we
 * cannot read.
 */
export function safeTaxRateBps(value: unknown): number {
  const rate = Number(value);
  return Number.isFinite(rate) && rate > 0 ? rate : 0;
}
