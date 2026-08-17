/**
 * `isLocalHostname` keeps developer-machine traffic out of shared observability
 * (Sentry) — including a production bundle served locally via `vite preview`.
 * A false positive silences a real deployed host; a false negative leaks local
 * noise into prod telemetry. Both matter, so the exact allowlist is pinned here.
 */
import { describe, expect, it } from 'vitest';

import { isLocalHostname } from './isLocalHostname';

describe('isLocalHostname', () => {
  it('matches the canonical local hosts', () => {
    expect(isLocalHostname('localhost')).toBe(true);
    expect(isLocalHostname('127.0.0.1')).toBe(true);
    expect(isLocalHostname('0.0.0.0')).toBe(true);
    expect(isLocalHostname('::1')).toBe(true);
    expect(isLocalHostname('[::1]')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isLocalHostname('LOCALHOST')).toBe(true);
    expect(isLocalHostname('MyBox.LOCAL')).toBe(true);
  });

  it('matches the .localhost and .local suffixes', () => {
    expect(isLocalHostname('app.localhost')).toBe(true);
    expect(isLocalHostname('foo.bar.localhost')).toBe(true);
    expect(isLocalHostname('macbook.local')).toBe(true);
  });

  it('rejects deployed hostnames', () => {
    expect(isLocalHostname('api.oyechats.com')).toBe(false);
    expect(isLocalHostname('app.oyechats.com')).toBe(false);
    expect(isLocalHostname('cdn.oyechats.com')).toBe(false);
  });

  it('rejects look-alikes that only contain the local tokens', () => {
    // Substring, not suffix/exact: these are real remote hosts.
    expect(isLocalHostname('localhost.evil.com')).toBe(false);
    expect(isLocalHostname('notlocalhost')).toBe(false);
    expect(isLocalHostname('mylocal')).toBe(false);
    expect(isLocalHostname('local.example.com')).toBe(false);
    expect(isLocalHostname('127.0.0.1.nip.io')).toBe(false);
  });

  it('rejects an empty hostname', () => {
    expect(isLocalHostname('')).toBe(false);
  });
});
