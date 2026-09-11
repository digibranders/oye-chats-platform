import { pushDataLayerEvent, type DataLayerEvent } from './dataLayer';
import { clearSignupIntent, readSignupIntent } from './signupIntent';

/**
 * `registration_success`: a new account that can use the product.
 *
 * Reported from the three places that know it happened, and nowhere else:
 *
 *   - `VerifyEmail`, when the server accepts the code (email signups);
 *   - `Register`, when the server answers already verified (only under
 *     `DEV_AUTO_VERIFY_EMAIL`; production always verifies by code);
 *   - `OAuthCallback`, when the API reports `new=1` (Google signups).
 *
 * Both methods therefore count the same moment. The container maps the event to
 * GA4's recommended `sign_up`. The payload carries no personal data: no email,
 * no name, and not the account id, which is a sequential integer.
 */

export type RegistrationMethod = 'email' | 'google';

const TRACKED_KEY_PREFIX = 'oyechats_registration_tracked_';

function hasBeenTracked(key: string): boolean {
  try {
    return window.localStorage.getItem(key) !== null;
  } catch {
    return false;
  }
}

function markTracked(key: string): void {
  try {
    window.localStorage.setItem(key, '1');
  } catch {
    // Without storage the server-side once-only guarantees still hold; only the
    // client-side replay guard is lost.
  }
}

export function trackRegistrationSuccess({
  clientId,
  method,
}: {
  clientId: number | string | null;
  method: RegistrationMethod;
}): void {
  // The server makes each confirming moment happen once per account. This
  // guards the client side of it: a double-invoked effect, a refetch re-running
  // the callback effect, a second tab.
  const trackedKey = clientId === null || clientId === '' ? null : `${TRACKED_KEY_PREFIX}${clientId}`;
  if (trackedKey) {
    if (hasBeenTracked(trackedKey)) return;
    markTracked(trackedKey);
  }

  const payload: DataLayerEvent = { event: 'registration_success', method };
  const intent = readSignupIntent();
  if (intent) {
    payload.plan_id = intent.planId;
    if (intent.billingPeriod) payload.billing_period = intent.billingPeriod;
  }

  pushDataLayerEvent(payload);
  clearSignupIntent();
}
