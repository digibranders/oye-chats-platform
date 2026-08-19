import { ABSENT, formatMoney, formatNumber } from '../../ui';
import type { Coupon, Promotion } from './types';

/**
 * Coupons and promotions: the two discount objects, and the rules that separate
 * them.
 *
 * They look alike and behave nothing alike, which is the single most important
 * thing this screen has to convey:
 *
 * * A **promotion** is live. `promotion_service` resolves it at checkout, claims
 *   a slot atomically, and mints a subscription with `promo_free_until` set.
 * * A **coupon** is not. There is a `coupons` table and full CRUD behind it, but
 *   no online redemption path: `subscription_routes._validate_coupon` refuses a
 *   *valid* code with "coupon codes can't be redeemed online yet" and refuses an
 *   invalid one as invalid. So every coupon created here is a record of an offer
 *   someone will apply by hand — never something a customer can type at
 *   checkout.
 *
 * Both editors validate the same rules the handlers do, before the request, for
 * the same reason the plan editor does: a 400 that arrives after the dialog has
 * closed is a worse teacher than a message beside the field.
 */

/* ---------------------------------------------------------------- coupons */

export interface CouponDraft {
  code: string;
  kind: 'percent' | 'amount';
  percent_off: string;
  amount_off_cents: string;
  max_redemptions: string;
  expires_at: string;
  is_active: boolean;
}

export function emptyCouponDraft(): CouponDraft {
  return {
    code: '',
    kind: 'percent',
    percent_off: '10',
    amount_off_cents: '',
    max_redemptions: '',
    expires_at: '',
    is_active: true,
  };
}

export function couponDraftFrom(coupon: Coupon): CouponDraft {
  return {
    code: coupon.code,
    kind: coupon.amount_off_cents != null ? 'amount' : 'percent',
    percent_off: coupon.percent_off == null ? '' : String(coupon.percent_off),
    amount_off_cents: coupon.amount_off_cents == null ? '' : String(coupon.amount_off_cents),
    max_redemptions: coupon.max_redemptions == null ? '' : String(coupon.max_redemptions),
    expires_at: coupon.expires_at ? coupon.expires_at.slice(0, 10) : '',
    is_active: coupon.is_active,
  };
}

function integer(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^-?\d+$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function validateCouponDraft(draft: CouponDraft, isCreate: boolean): Record<string, string> {
  const errors: Record<string, string> = {};

  const code = draft.code.trim();
  if (isCreate && !code) errors.code = 'A coupon needs a code, even though it is applied by hand.';
  else if (code && code.length > 64) errors.code = 'At most 64 characters.';

  if (draft.kind === 'percent') {
    const percent = integer(draft.percent_off);
    if (percent === null) errors.percent_off = 'Enter a whole percentage.';
    else if (percent < 0 || percent > 100) errors.percent_off = 'Between 0 and 100.';
  } else {
    const amount = integer(draft.amount_off_cents);
    if (amount === null) errors.amount_off_cents = 'Enter the amount in paise.';
    else if (amount < 0) errors.amount_off_cents = 'An amount off cannot be negative — that is a credit.';
    else if (amount > 100_000_000) errors.amount_off_cents = 'The API caps this at 100,000,000 paise.';
  }

  if (draft.max_redemptions.trim() !== '') {
    const cap = integer(draft.max_redemptions);
    if (cap === null) errors.max_redemptions = 'Enter a whole number, or leave it blank for uncapped.';
    else if (cap < 1) errors.max_redemptions = 'At least one redemption, or blank for uncapped.';
    else if (cap > 1_000_000) errors.max_redemptions = 'The API caps this at 1,000,000.';
  }

  if (draft.expires_at.trim() !== '' && Number.isNaN(Date.parse(draft.expires_at)))
    errors.expires_at = 'That is not a date.';

  return errors;
}

/** The create body. The two discount kinds are exclusive; the server checks too. */
export function couponCreatePayload(draft: CouponDraft): Record<string, unknown> {
  return {
    code: draft.code.trim(),
    percent_off: draft.kind === 'percent' ? integer(draft.percent_off) : null,
    amount_off_cents: draft.kind === 'amount' ? integer(draft.amount_off_cents) : null,
    max_redemptions: draft.max_redemptions.trim() === '' ? null : integer(draft.max_redemptions),
    expires_at: draft.expires_at.trim() === '' ? null : new Date(draft.expires_at).toISOString(),
  };
}

/**
 * The patch body — only what moved.
 *
 * `update_coupon` merges the patch over the row and then re-checks that exactly
 * one discount kind survives, so switching from percent to amount has to send
 * both fields: the new one, and the old one cleared.
 */
export function couponPatchPayload(draft: CouponDraft, coupon: Coupon): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  if (draft.code.trim() !== coupon.code) payload.code = draft.code.trim();

  const percent = draft.kind === 'percent' ? integer(draft.percent_off) : null;
  const amount = draft.kind === 'amount' ? integer(draft.amount_off_cents) : null;
  if (percent !== coupon.percent_off) payload.percent_off = percent;
  if (amount !== coupon.amount_off_cents) payload.amount_off_cents = amount;

  const cap = draft.max_redemptions.trim() === '' ? null : integer(draft.max_redemptions);
  if (cap !== coupon.max_redemptions) payload.max_redemptions = cap;

  const expires = draft.expires_at.trim() === '' ? null : new Date(draft.expires_at).toISOString();
  const currentExpiry = coupon.expires_at ? new Date(coupon.expires_at).toISOString() : null;
  if (expires !== currentExpiry) payload.expires_at = expires;

  if (draft.is_active !== coupon.is_active) payload.is_active = draft.is_active;
  return payload;
}

export function couponDiscount(coupon: Coupon): string {
  if (coupon.percent_off != null) return `${coupon.percent_off}%`;
  if (coupon.amount_off_cents != null) return formatMoney(coupon.amount_off_cents, 'INR');
  return ABSENT;
}

export type OfferState = 'active' | 'exhausted' | 'expired' | 'inactive';

/** The state a reader actually needs: not the flag, but whether it would apply. */
export function couponState(coupon: Coupon, now: Date = new Date()): OfferState {
  if (!coupon.is_active) return 'inactive';
  if (coupon.expires_at && new Date(coupon.expires_at) <= now) return 'expired';
  if (coupon.max_redemptions != null && (coupon.redemptions ?? 0) >= coupon.max_redemptions) return 'exhausted';
  return 'active';
}

/* ------------------------------------------------------------- promotions */

export interface PromotionDraft {
  name: string;
  code: string;
  /** `datetime-local` values, i.e. local wall time with no zone. */
  starts_at: string;
  ends_at: string;
  free_cycles: string;
  max_redemptions: string;
  eligible_plan_ids: number[];
  is_active: boolean;
}

function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function emptyPromotionDraft(): PromotionDraft {
  return {
    name: '',
    code: '',
    starts_at: '',
    ends_at: '',
    free_cycles: '3',
    max_redemptions: '',
    eligible_plan_ids: [],
    is_active: true,
  };
}

export function promotionDraftFrom(promotion: Promotion): PromotionDraft {
  return {
    name: promotion.name,
    code: promotion.code ?? '',
    starts_at: toLocalInput(promotion.starts_at),
    ends_at: toLocalInput(promotion.ends_at),
    free_cycles: String(promotion.free_cycles),
    max_redemptions: promotion.max_redemptions == null ? '' : String(promotion.max_redemptions),
    eligible_plan_ids: promotion.eligible_plan_ids ?? [],
    is_active: promotion.is_active,
  };
}

export interface PromotionValidationOptions {
  isCreate: boolean;
  /** Only checked when the field is being set, matching `_refuse_past_end`. */
  endsAtChanged: boolean;
  now?: Date;
}

export function validatePromotionDraft(
  draft: PromotionDraft,
  options: PromotionValidationOptions,
): Record<string, string> {
  const errors: Record<string, string> = {};
  const now = options.now ?? new Date();

  const name = draft.name.trim();
  if (!name) errors.name = 'A campaign needs a name.';
  else if (name.length > 120) errors.name = 'At most 120 characters.';
  if (draft.code.trim().length > 64) errors.code = 'At most 64 characters.';

  const starts = draft.starts_at ? new Date(draft.starts_at) : null;
  const ends = draft.ends_at ? new Date(draft.ends_at) : null;
  if (!starts || Number.isNaN(starts.getTime())) errors.starts_at = 'A start time is required.';
  if (!ends || Number.isNaN(ends.getTime())) errors.ends_at = 'An end time is required.';
  if (starts && ends && !Number.isNaN(starts.getTime()) && !Number.isNaN(ends.getTime())) {
    if (ends <= starts) errors.ends_at = 'The window has to end after it starts.';
    else if ((options.isCreate || options.endsAtChanged) && ends <= now)
      errors.ends_at =
        'That end is already past, so the campaign would be expired the moment it saved. Pause it instead.';
  }

  const cycles = integer(draft.free_cycles);
  if (cycles === null) errors.free_cycles = 'Enter a whole number of billing cycles.';
  else if (cycles < 1 || cycles > 36) errors.free_cycles = 'Between 1 and 36 cycles.';

  if (draft.max_redemptions.trim() !== '') {
    const cap = integer(draft.max_redemptions);
    if (cap === null) errors.max_redemptions = 'Enter a whole number, or leave it blank for uncapped.';
    else if (cap < 1) errors.max_redemptions = 'At least one, or blank for uncapped.';
  }

  return errors;
}

export function promotionPayload(draft: PromotionDraft): Record<string, unknown> {
  return {
    name: draft.name.trim(),
    code: draft.code.trim() || null,
    starts_at: new Date(draft.starts_at).toISOString(),
    ends_at: new Date(draft.ends_at).toISOString(),
    free_cycles: integer(draft.free_cycles) ?? 1,
    max_redemptions: draft.max_redemptions.trim() === '' ? null : integer(draft.max_redemptions),
    eligible_plan_ids: draft.eligible_plan_ids.length > 0 ? draft.eligible_plan_ids : null,
    is_active: draft.is_active,
  };
}

/**
 * Whether a campaign is really running.
 *
 * `is_active` alone is not the answer, and saying it is was worth a comment in
 * the handler: a campaign can read "active" in the list while every eligibility
 * check refuses it because the window closed or the slots ran out.
 */
export function promotionState(promotion: Promotion, now: Date = new Date()): OfferState | 'scheduled' {
  if (!promotion.is_active) return 'inactive';
  if (promotion.ends_at && new Date(promotion.ends_at) <= now) return 'expired';
  if (promotion.starts_at && new Date(promotion.starts_at) > now) return 'scheduled';
  if (promotion.max_redemptions != null && promotion.slots_claimed >= promotion.max_redemptions) return 'exhausted';
  return 'active';
}

/**
 * Slots claimed against the cap, as a sentence.
 *
 * The gap between `slots_claimed` and `stats.subscriptions_created` is real and
 * meaningful — a slot is claimed at checkout, before the mandate authorises — so
 * the two figures are never merged into one.
 */
export function promotionUsage(promotion: Promotion): string {
  const claimed = formatNumber(promotion.slots_claimed);
  if (promotion.max_redemptions == null) return `${claimed} claimed · uncapped`;
  return `${claimed} of ${formatNumber(promotion.max_redemptions)} claimed`;
}
