/**
 * Codes a visitor arrived with, read back wherever they are needed.
 *
 * A shared link drops its code on the marketing site, not here: `?ref=` and
 * `?code=` land on www.oyechats.com, which parks them in a cookie and appends
 * them to the signup link. By the time the console renders anything, the query
 * string may be several navigations in the past, so both a cookie (set by the
 * site) and sessionStorage (set by our own `/register`) are consulted.
 *
 * Kept in one module because three surfaces read the same two values and had
 * started to disagree about where they live.
 */

const PROMO_SESSION_KEY = 'oyechats_promo_code';
const REFERRAL_SESSION_KEY = 'oyechats_referral_code';
/** Written by the marketing site's `AttributionCapture`. */
const PROMO_COOKIE = 'oyechats_code';
const REFERRAL_COOKIE = 'oyechats_ref';

function readCookie(name: string): string {
  try {
    const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
    return match ? decodeURIComponent(match[1]) : '';
  } catch {
    return '';
  }
}

function readSession(key: string): string {
  try {
    return window.sessionStorage.getItem(key) ?? '';
  } catch {
    // Private mode. The cookie is the other half of the answer.
    return '';
  }
}

/** The campaign code, if the visitor arrived with one. */
export function storedPromoCode(): string {
  return readSession(PROMO_SESSION_KEY) || readCookie(PROMO_COOKIE);
}

/** The affiliate code, if the visitor arrived with one. */
export function storedReferralCode(): string {
  return readSession(REFERRAL_SESSION_KEY) || readCookie(REFERRAL_COOKIE);
}
