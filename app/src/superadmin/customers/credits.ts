/**
 * The rules a manual credit adjustment has to satisfy, kept out of the dialog.
 *
 * They mirror `CreditsGrant` in `superadmin_routes_v2.py:270-277` exactly — a
 * non-zero delta bounded at ±10,000,000 and a 3–500 character reason — so the
 * form refuses locally what the server would refuse remotely, with the same
 * numbers in the message.
 */

import { formatNumber } from '../../ui';

/** The ceiling the API enforces on a single manual adjustment. */
export const MAX_CREDIT_DELTA = 10_000_000;

/** Signed delta from the direction the operator picked. */
export function creditDelta(direction: 'add' | 'remove', amount: number): number {
  const magnitude = Math.trunc(Math.abs(amount));
  return direction === 'remove' ? -magnitude : magnitude;
}

/** Why the amount is not acceptable, or `null`. */
export function creditAmountProblem(amount: number): string | null {
  if (!Number.isFinite(amount) || Math.trunc(amount) <= 0) {
    return 'Enter a whole number of credits above zero.';
  }
  if (Math.trunc(amount) > MAX_CREDIT_DELTA) {
    return `The API refuses a single adjustment above ${formatNumber(MAX_CREDIT_DELTA)} credits.`;
  }
  return null;
}

/** Why the reason is not acceptable, or `null`. */
export function creditReasonProblem(reason: string): string | null {
  const trimmed = reason.trim();
  if (trimmed.length < 3) return 'The API requires a reason of at least 3 characters.';
  if (trimmed.length > 500) return 'The reason must be 500 characters or fewer.';
  return null;
}
