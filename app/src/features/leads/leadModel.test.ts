import { describe, expect, it } from 'vitest';
import { companyDisplay, formatLocation } from './leadModel';

/**
 * `ChatSession.location` is stored by the backend as
 * `"<City>, <Country> | <IP>"` (or `"<Country> | <IP>"`, or the raw
 * `"IP: <addr>"` stamp written before geolocation resolves).
 *
 * A visitor's IP address is personal data under GDPR/DPDP, so it must never
 * be rendered in the dashboard. These tests pin the stripping rules — the
 * Leads table was previously printing the stored string verbatim, putting
 * raw IPv6 addresses on screen.
 */
describe('formatLocation', () => {
  it('strips the IPv6 address the backend appends', () => {
    expect(formatLocation('Mumbai, India | 2401:4900:88b1:7265:cdd1:3f28:b37:8f91')).toBe(
      'Mumbai, India',
    );
  });

  it('strips an IPv4 address', () => {
    expect(formatLocation('Bengaluru, India | 103.21.244.12')).toBe('Bengaluru, India');
  });

  it('handles a country-only location', () => {
    expect(formatLocation('India | 103.21.244.12')).toBe('India');
  });

  it('never leaks an IP even with unexpected spacing', () => {
    expect(formatLocation('Pune, India|1.2.3.4')).toBe('Pune, India');
  });

  it('treats the raw pre-geolocation stamp as unknown', () => {
    // "IP: x" is written by the request handler before the background
    // resolver replaces it. It carries no geography — showing it would be
    // strictly worse than saying nothing.
    expect(formatLocation('IP: 103.21.244.12')).toBe('Unknown');
  });

  it('falls back to Unknown for empty input', () => {
    expect(formatLocation(null)).toBe('Unknown');
    expect(formatLocation(undefined)).toBe('Unknown');
    expect(formatLocation('')).toBe('Unknown');
    expect(formatLocation('   ')).toBe('Unknown');
  });

  it('passes through a clean location unchanged', () => {
    expect(formatLocation('Mumbai, India')).toBe('Mumbai, India');
  });

  it('never returns a string containing a colon-delimited IPv6 or dotted IPv4', () => {
    const samples = [
      'Mumbai, India | 2401:4900:88b1:7265:cdd1:3f28:b37:8f91',
      'India | 103.21.244.12',
      'IP: 2401:4900::1',
    ];
    for (const s of samples) {
      const out = formatLocation(s);
      expect(out).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
      expect(out).not.toMatch(/[0-9a-f]{1,4}:[0-9a-f]{0,4}:/i);
    }
  });
});

describe('companyDisplay', () => {
  /* `company` is the raw email domain and always present; `company_name` is
     the Professional-gated resolved identity and frequently absent —
     resolution can fail, be switched off per agent, or still be in flight.
     The resolved name must APPEND to the domain, never replace it: rendering
     only `company_name` would blank the company row for every lead on a lower
     plan, a regression against behaviour that predates the feature. */
  it('shows the resolved name with the domain beneath it', () => {
    expect(companyDisplay({ company: 'infosys.com', company_name: 'Infosys Limited' })).toEqual({
      value: 'Infosys Limited',
      secondary: 'infosys.com',
    });
  });

  it('falls back to the bare domain when nothing was resolved', () => {
    expect(companyDisplay({ company: 'infosys.com', company_name: null })).toEqual({
      value: 'infosys.com',
    });
  });

  it('returns nothing when there is no domain either', () => {
    expect(companyDisplay({ company: null, company_name: null })).toBeNull();
    expect(companyDisplay(null)).toBeNull();
    expect(companyDisplay(undefined)).toBeNull();
  });

  it('treats whitespace as absent rather than rendering a blank row', () => {
    expect(companyDisplay({ company: '   ', company_name: '  ' })).toBeNull();
    expect(companyDisplay({ company: 'infosys.com', company_name: '   ' })).toEqual({
      value: 'infosys.com',
    });
  });
});
