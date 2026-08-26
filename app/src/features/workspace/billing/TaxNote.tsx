import { type ReactElement } from 'react';
import { cn } from '../../../ui';
import { useCurrency } from '../../../context/CurrencyContext';
import { TAX_NOTE_USD, safeTaxRateBps, taxNoteInr } from './taxCopy';

export interface TaxNoteProps {
  /** Spacing for the call site. The note carries no margin of its own. */
  className?: string;
}

/**
 * TaxNote - the tax disclosure that sits under any price shown BEFORE payment,
 * where that price is a BASE price rather than the amount payable.
 *
 * Every listed price in this dashboard (plan, seat, branding add-on, credit
 * pack) is published exclusive of tax. What gets added on top is the rate the
 * server reports on GET /subscriptions/geo, so this note is driven by that rate
 * rather than by a second hardcoded 18%: a rate change on the server would
 * otherwise leave this sentence describing a charge that no longer happens.
 *
 * Three outcomes:
 *
 * - rate > 0: a domestic sale. The listed price is not what Razorpay debits,
 *   and saying so here is the only place the customer learns that before the
 *   payment sheet opens.
 * - rate 0 on the USD rail: an export of services. No Indian GST applies, so
 *   naming GST here would state a charge that will never appear. Whatever the
 *   customer's own jurisdiction levies is not ours to quote, so the note only
 *   says it is not included.
 * - rate 0 on the INR rail: nothing is added, so there is nothing to disclose.
 *   The note renders NOTHING. Announcing a tax that the seller does not charge
 *   is as false as hiding one that it does.
 *
 * A surface that already shows the GROSS (the amount payable) should not render
 * this at all: the disclosure exists to explain a gap that is no longer there.
 *
 * It renders nothing while `loading` is true. `useCurrency` reports a safe
 * default (the charge currency, and no tax) before /geo settles, which is a
 * fallback, not an answer. Rendering on that default means an international
 * buyer can be told "18% GST is added" and then watch it disappear a beat
 * later. This is a legal statement about what a customer will be charged, so a
 * note that arrives late is strictly better than one that flips under them.
 */
export function TaxNote({ className }: TaxNoteProps): ReactElement | null {
  const { isInr, loading, taxRateBps } = useCurrency();

  if (loading) return null;

  const rateBps = safeTaxRateBps(taxRateBps);
  if (rateBps === 0 && isInr) return null;

  return (
    <p className={cn('text-sm text-text-secondary', className)}>
      {rateBps > 0 ? taxNoteInr(rateBps) : TAX_NOTE_USD}
    </p>
  );
}
