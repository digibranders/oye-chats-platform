/**
 * The plan a visitor picked on the marketing site's pricing page.
 *
 * The pricing CTAs link to `/register?plan=<id>&billing=<monthly|annual>`, but
 * the account is not confirmed on that screen: an email signup confirms on
 * `/verify-email`, and a Google signup after a round trip through Google and
 * `/auth/callback`. sessionStorage survives both hops in the same tab, which is
 * the lifetime this needs and no longer.
 *
 * An analytics attribute only. It does not choose the plan an account starts on.
 */

const STORAGE_KEY = 'oyechats_signup_intent';

/**
 * The site's tier ids (`free`, `starter`, `standard`, ...). Matched by shape
 * rather than by a list, so a tier added to the site is not dropped here, while
 * anything a crafted link could smuggle into Google Analytics is.
 */
const PLAN_ID_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

export type BillingPeriod = 'monthly' | 'annual';

export interface SignupIntent {
  planId: string;
  billingPeriod: BillingPeriod | null;
}

function parseBillingPeriod(value: unknown): BillingPeriod | null {
  return value === 'monthly' || value === 'annual' ? value : null;
}

function parsePlanId(value: unknown): string | null {
  return typeof value === 'string' && PLAN_ID_PATTERN.test(value) ? value : null;
}

/** Store the plan from a signup URL. A URL without a valid plan changes nothing. */
export function captureSignupIntent(params: URLSearchParams): void {
  const planId = parsePlanId(params.get('plan'));
  if (!planId) return;
  const intent: SignupIntent = { planId, billingPeriod: parseBillingPeriod(params.get('billing')) };
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(intent));
  } catch {
    // Private mode. The registration event is still sent, without the plan.
  }
}

export function readSignupIntent(): SignupIntent | null {
  let raw: string | null;
  try {
    raw = window.sessionStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;

  const record = parsed as Record<string, unknown>;
  const planId = parsePlanId(record.planId);
  if (!planId) return null;
  return { planId, billingPeriod: parseBillingPeriod(record.billingPeriod) };
}

export function clearSignupIntent(): void {
  try {
    window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage unavailable, so nothing was stored to clear.
  }
}
