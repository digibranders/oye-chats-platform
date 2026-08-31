/**
 * Email-verification gate - decides whether an authenticated session must be
 * held on `/verify-email` before it may use the product.
 *
 * Pure and synchronous on purpose. It reads the persisted `admin_is_verified`
 * flag (written from the server's `is_verified` at login/register/OAuth) rather
 * than awaiting `/auth/me`, so no authenticated route pays a request or a
 * loading flash. The authoritative reconciliation lives on the other side: the
 * verify screen asks `/auth/me` on mount and releases a session the server
 * considers verified, so a stale `'false'` self-heals instead of trapping.
 *
 * The gate is deliberately positive-only - it fires when the flag explicitly
 * says `'false'`, never on `null`/unknown. An unreadable or absent flag means
 * "don't know", and guessing "unverified" there would lock out sessions we have
 * no evidence against.
 */
import { getAuthItem } from '../utils/authStorage';
import { isImpersonating } from '../utils/impersonation';

/** Serialised `'true'`/`'false'` verification flag, or null when never written. */
export type VerifiedFlag = string | null;

export interface GateInputs {
  /** Persisted `admin_is_verified`. */
  verifiedFlag: VerifiedFlag;
  /** Persisted `auth_type` - `'operator'` for a legacy operator login. */
  authType: string | null;
  /** Persisted `is_superadmin`. */
  isSuperadmin: string | null;
  /** True for a super-admin impersonation tab. */
  impersonating: boolean;
}

/**
 * Should this session be redirected to `/verify-email`?
 *
 * Exempt, and why each one matters:
 *
 * - **Operators.** `/auth/me` reports the workspace OWNER's `is_verified` for an
 *   operator session (auth_routes.py), not the operator's own. Gating them
 *   would trap an employee behind someone else's inbox with no lever to clear
 *   it - they cannot receive or enter that OTP. The owner is who must verify.
 * - **Super-admins.** Platform staff are provisioned outside the OTP path, and
 *   the backend already bypasses them in `require_verified_email`. Gating here
 *   would contradict the server and lock staff out of their own console.
 * - **Impersonation tabs.** The persisted flag belongs to the super-admin's own
 *   identity in shared localStorage, not the account being supported, so it is
 *   meaningless here - and a support session must never be held behind the
 *   customer's verification state.
 */
export function shouldGateForEmailVerification(inputs: GateInputs): boolean {
  const { verifiedFlag, authType, isSuperadmin, impersonating } = inputs;
  if (impersonating) return false;
  if (authType === 'operator') return false;
  if (isSuperadmin === 'true') return false;
  // Positive evidence only - `null` (unknown) must never gate.
  return verifiedFlag === 'false';
}

/** Read the live session and apply {@link shouldGateForEmailVerification}. */
export function sessionNeedsEmailVerification(): boolean {
  return shouldGateForEmailVerification({
    verifiedFlag: getAuthItem('admin_is_verified'),
    authType: getAuthItem('auth_type'),
    isSuperadmin: getAuthItem('is_superadmin'),
    impersonating: isImpersonating(),
  });
}

/**
 * Build the `/verify-email?next=…` URL that round-trips the blocked deep link
 * through verification. Mirrors the open-redirect guard on the login bounce:
 * only same-origin relative paths survive, and `/verify-email` never nests
 * inside its own `next`.
 */
export function verifyUrlWithNext(pathname: string, search: string): string {
  const next = `${pathname}${search}`;
  const safe =
    next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/verify-email');
  return safe ? `/verify-email?next=${encodeURIComponent(next)}` : '/verify-email';
}


/**
 * Correct a locally-cached `admin_is_verified: 'true'` that the server denies.
 *
 * The gate above is positive-only by design: an absent or unreadable flag must
 * never lock out a session we have no evidence against. The cost of that
 * asymmetry is that a stale `'true'` is trusted forever. A stale `'false'`
 * already self-heals, because the verify screen asks `/auth/me` on mount and
 * releases a session the server considers verified; nothing did the reverse.
 *
 * That gap is not theoretical. It strands an account in the one state the
 * console cannot explain: past the gate, inside the shell, and refused by every
 * write the server gates on verification — which now includes creating the
 * first chatbot, because the trial is granted at verification rather than at
 * signup. The customer sees "an active subscription is required" on a first-run
 * screen they should never have reached.
 *
 * Returns true when the flag has just been corrected and the session should be
 * sent back to `/verify-email`.
 */
export function reconcileVerifiedFlag(serverIsVerified: boolean | undefined): boolean {
  // Only positive evidence FROM THE SERVER acts. `undefined` is "not loaded",
  // and treating it as unverified would bounce every session on first paint.
  if (serverIsVerified !== false) return false;
  if (getAuthItem('auth_type') === 'operator') return false;
  if (getAuthItem('is_superadmin') === 'true') return false;
  if (isImpersonating()) return false;
  return getAuthItem('admin_is_verified') !== 'false';
}
