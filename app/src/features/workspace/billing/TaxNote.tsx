import { type ReactElement } from 'react';
import { cn } from '../../../design-system';
import { useCurrency } from '../../../context/CurrencyContext';

export interface TaxNoteProps {
  /** Spacing for the call site. The note carries no margin of its own. */
  className?: string;
}

/** Wording is exported so tests pin the exact statement, not a paraphrase. */
export const TAX_NOTE_INR = 'Prices exclude GST. 18% GST is added at checkout.';
export const TAX_NOTE_USD =
  'Prices are in USD. Any taxes due in your own country are not included.';

/**
 * TaxNote - the tax disclosure that sits under any price shown BEFORE payment.
 *
 * Every price in this dashboard (plan, seat, branding add-on, credit pack) is a
 * base price, exclusive of tax. What gets added on top depends entirely on the
 * rail the customer is billed on, so this note is rail-conditional rather than
 * one sentence for everyone:
 *
 * - INR: an Indian sale, so 18% GST is added on top at checkout. The listed
 *   price is not what Razorpay debits, and saying so here is the only place the
 *   customer learns that before the payment sheet opens.
 * - USD: an export of services. No Indian GST applies, so naming GST on this
 *   rail would state a charge that will never appear. Whatever the customer's
 *   own jurisdiction levies is not ours to quote, so the note only says it is
 *   not included.
 *
 * It renders nothing while `loading` is true. `useCurrency` reports a safe
 * default (the charge currency) before GET /subscriptions/geo settles, which is
 * a fallback, not an answer. Rendering on that default means an international
 * buyer can be told "18% GST is added" and then watch it disappear a beat
 * later. This is a legal statement about what a customer will be charged, so a
 * note that arrives late is strictly better than one that flips under them.
 */
export function TaxNote({ className }: TaxNoteProps): ReactElement | null {
  const { isInr, loading } = useCurrency();

  if (loading) return null;

  return (
    <p className={cn('text-[13px] text-[var(--ds-text-muted)]', className)}>
      {isInr ? TAX_NOTE_INR : TAX_NOTE_USD}
    </p>
  );
}
