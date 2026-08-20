import type { Tone } from '../../ui';
import type { DunningItem } from './types';

/**
 * Dunning is a queue of customers about to lose access, so it is ordered by how
 * soon that happens — not by subscription id, and not by how much money is at
 * stake. The account with four hours of grace left needs the call before the
 * one worth ten times as much with three weeks to run.
 */

/**
 * Comparator: least grace remaining first.
 *
 * A row with no `days_left` (the subscription is past due but the timestamp for
 * when it went past due is missing) sorts to the **end**, not the start. It
 * cannot be scheduled, and putting an unschedulable row at the top of a
 * save-call queue costs the operator their first minute every time they open
 * the screen. Ties break on the larger amount at risk.
 */
export function byUrgency(a: DunningItem, b: DunningItem): number {
  const left = a.days_left ?? Number.POSITIVE_INFINITY;
  const right = b.days_left ?? Number.POSITIVE_INFINITY;
  if (left !== right) return left - right;
  // A row with no recorded price sorts last within its urgency band rather
  // than producing NaN and scrambling the whole comparator.
  return (b.cycle_at_risk_minor ?? -1) - (a.cycle_at_risk_minor ?? -1);
}

export function sortByUrgency(items: readonly DunningItem[]): DunningItem[] {
  return [...items].sort(byUrgency);
}

/**
 * How close this account is to losing access.
 *
 * Zero days left is `danger` because the grace period is spent — the customer's
 * chatbots are either already off or will be at the next sweep. Anything inside
 * two days is also danger: an operator seeing "warning" on a customer who will
 * be cut off tomorrow morning will not phone today.
 */
export function urgencyTone(daysLeft: number | null): Tone {
  if (daysLeft == null) return 'neutral';
  if (daysLeft <= 2) return 'danger';
  if (daysLeft <= 5) return 'warning';
  return 'neutral';
}

/** The phrase that goes in the badge. Colour is never the only signal. */
export function urgencyLabel(daysLeft: number | null): string {
  if (daysLeft == null) return 'Grace unknown';
  if (daysLeft === 0) return 'Grace spent';
  if (daysLeft === 1) return '1 day left';
  return `${daysLeft} days left`;
}

/**
 * Whether the automated cadence has already reached this customer.
 *
 * `emails_sent` is the set of cadence steps already delivered. Support phoning
 * a customer who has had no email at all is a different conversation from
 * phoning one who has had three, and the row says which.
 */
export function cadenceSummary(emailsSent: readonly string[]): string {
  if (emailsSent.length === 0) return 'No dunning email sent yet';
  if (emailsSent.length === 1) return `1 email sent (${emailsSent[0]})`;
  return `${emailsSent.length} emails sent (${emailsSent.join(', ')})`;
}

/**
 * Totals per currency, over the rows on screen.
 *
 * The server now sends its own per-currency breakdown, which this deliberately
 * does not replace: the server totals every past-due subscription, while this
 * totals what the operator is actually looking at after filtering. Both are
 * useful and they are not the same number, so the screen labels which is which.
 *
 * A row with no recorded price contributes nothing rather than zero — it is
 * excluded, exactly as the server excludes it, so a currency whose every row is
 * missing a price does not appear as a confident ₹0.00.
 */
export function atRiskByCurrency(items: readonly DunningItem[]): { currency: string; minor: number }[] {
  const totals = new Map<string, number>();
  for (const item of items) {
    if (item.cycle_at_risk_minor === null || item.cycle_at_risk_minor === undefined) continue;
    const code = (item.currency || 'INR').toUpperCase();
    totals.set(code, (totals.get(code) ?? 0) + item.cycle_at_risk_minor);
  }
  return [...totals.entries()]
    .map(([currency, minor]) => ({ currency, minor }))
    .sort((a, b) => a.currency.localeCompare(b.currency));
}
