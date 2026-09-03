import { describe, expect, it } from 'vitest';
import { loginUrlWithNext } from './loginRedirect';

describe('loginUrlWithNext', () => {
  it('round-trips a deep link with its query string', () => {
    expect(loginUrlWithNext('/leads', '?tier=sql')).toBe('/login?next=%2Fleads%3Ftier%3Dsql');
  });

  it('refuses a protocol-relative path', () => {
    expect(loginUrlWithNext('//evil.example', '')).toBe('/login');
  });

  it('does not point the sign-in page back at itself', () => {
    expect(loginUrlWithNext('/login', '')).toBe('/login');
  });
});
