import { describe, expect, it } from 'vitest';
import {
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
