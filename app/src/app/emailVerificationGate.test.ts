import { beforeEach, describe, expect, it } from 'vitest';
import {
  reconcileVerifiedFlag,
  shouldGateForEmailVerification,
  verifyUrlWithNext,
  type GateInputs,
} from './emailVerificationGate';

/** A plain, unverified email/password client - the case the gate exists for. */
const UNVERIFIED_CLIENT: GateInputs = {
  verifiedFlag: 'false',
  authType: 'client',
  isSuperadmin: 'false',
  impersonating: false,
};

describe('shouldGateForEmailVerification', () => {
  it('gates an unverified client', () => {
    expect(shouldGateForEmailVerification(UNVERIFIED_CLIENT)).toBe(true);
  });

  it('lets a verified client through', () => {
    expect(
      shouldGateForEmailVerification({ ...UNVERIFIED_CLIENT, verifiedFlag: 'true' }),
    ).toBe(false);
  });

  it('never gates on unknown state', () => {
    // A missing flag is "don't know", not "unverified". Guessing here would
    // lock out sessions we have no evidence against.
    expect(shouldGateForEmailVerification({ ...UNVERIFIED_CLIENT, verifiedFlag: null })).toBe(
      false,
    );
    expect(shouldGateForEmailVerification({ ...UNVERIFIED_CLIENT, verifiedFlag: '' })).toBe(false);
  });

  it('never gates an operator', () => {
    // /auth/me reports the workspace OWNER's is_verified for an operator
    // session, so gating would trap an employee behind someone else's inbox
    // with no way to clear it.
    expect(shouldGateForEmailVerification({ ...UNVERIFIED_CLIENT, authType: 'operator' })).toBe(
      false,
    );
  });

  it('never gates a super-admin', () => {
    // Mirrors the backend bypass in require_verified_email.
    expect(shouldGateForEmailVerification({ ...UNVERIFIED_CLIENT, isSuperadmin: 'true' })).toBe(
      false,
    );
  });

  it('never gates an impersonation tab', () => {
    // The persisted flag belongs to the super-admin's own identity in shared
    // localStorage, not the account being supported.
    expect(shouldGateForEmailVerification({ ...UNVERIFIED_CLIENT, impersonating: true })).toBe(
      false,
    );
  });
});

describe('verifyUrlWithNext', () => {
  it('round-trips the blocked deep link', () => {
    expect(verifyUrlWithNext('/workspace/billing', '')).toBe(
      '/verify-email?next=%2Fworkspace%2Fbilling',
    );
  });

  it('preserves the query string', () => {
    expect(verifyUrlWithNext('/inbox', '?session=42')).toBe(
      '/verify-email?next=%2Finbox%3Fsession%3D42',
    );
  });

  it('refuses to nest /verify-email inside its own next', () => {
    // Guards the redirect loop: the gate must never send the verify screen
    // back to itself.
    expect(verifyUrlWithNext('/verify-email', '')).toBe('/verify-email');
    expect(verifyUrlWithNext('/verify-email', '?email=a%40b.com')).toBe('/verify-email');
  });

  it('drops a protocol-relative path (open-redirect guard)', () => {
    expect(verifyUrlWithNext('//evil.example/pwn', '')).toBe('/verify-email');
  });
});

describe('reconcileVerifiedFlag', () => {
  /**
   * The other direction. The gate is positive-only so it never locks out a
   * session on a guess, which means a stale `'true'` is believed forever. A
   * stale `'false'` already self-heals on the verify screen; this is the cure
   * for the opposite, and without it an account sits inside the shell being
   * refused by every write the server gates on verification.
   */
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('corrects a cached true that the server denies', () => {
    window.localStorage.setItem('admin_is_verified', 'true');
    expect(reconcileVerifiedFlag(false)).toBe(true);
  });

  it('does nothing before the answer has loaded', () => {
    window.localStorage.setItem('admin_is_verified', 'true');
    // `undefined` is "not loaded". Bouncing on it would send every session to
    // the verify screen on first paint.
    expect(reconcileVerifiedFlag(undefined)).toBe(false);
  });

  it('does nothing when the server agrees the session is verified', () => {
    window.localStorage.setItem('admin_is_verified', 'true');
    expect(reconcileVerifiedFlag(true)).toBe(false);
  });

  it('does not re-fire once the flag already says false', () => {
    // The gate itself handles it from here; acting again would fight it.
    window.localStorage.setItem('admin_is_verified', 'false');
    expect(reconcileVerifiedFlag(false)).toBe(false);
  });

  it('leaves operators alone, because /auth/me reports the OWNER', () => {
    window.localStorage.setItem('admin_is_verified', 'true');
    window.localStorage.setItem('auth_type', 'operator');
    expect(reconcileVerifiedFlag(false)).toBe(false);
  });

  it('leaves super-admins alone, matching the server bypass', () => {
    window.localStorage.setItem('admin_is_verified', 'true');
    window.localStorage.setItem('is_superadmin', 'true');
    expect(reconcileVerifiedFlag(false)).toBe(false);
  });
});
