import { describe, expect, it } from 'vitest';
import { GST_STATE_OPTIONS, gstStateFromPin } from './gstin';
import { COUNTRY_OPTIONS } from '../../../data/countries';

describe('gstStateFromPin', () => {
  it('maps major-metro PINs to their GST state', () => {
    expect(gstStateFromPin('400001')).toBe('27'); // Mumbai → Maharashtra
    expect(gstStateFromPin('110001')).toBe('07'); // Delhi
    expect(gstStateFromPin('560001')).toBe('29'); // Bengaluru → Karnataka
    expect(gstStateFromPin('600001')).toBe('33'); // Chennai → Tamil Nadu
    expect(gstStateFromPin('700001')).toBe('19'); // Kolkata → West Bengal
    expect(gstStateFromPin('380001')).toBe('24'); // Ahmedabad → Gujarat
  });

  it('resolves the enclaves that live inside a neighbour prefix range', () => {
    expect(gstStateFromPin('403506')).toBe('30'); // Goa inside the 40x Maharashtra range
    expect(gstStateFromPin('737101')).toBe('11'); // Sikkim inside the WB range
    expect(gstStateFromPin('744101')).toBe('35'); // Andaman & Nicobar
    expect(gstStateFromPin('795001')).toBe('14'); // Manipur
    expect(gstStateFromPin('834001')).toBe('20'); // Ranchi → Jharkhand, not Bihar
    expect(gstStateFromPin('160017')).toBe('04'); // Chandigarh, not Punjab
  });

  it('returns null for incomplete or unknown input', () => {
    expect(gstStateFromPin('4000')).toBeNull();
    expect(gstStateFromPin('')).toBeNull();
    expect(gstStateFromPin('990001')).toBeNull();
  });
});

describe('picker options', () => {
  it('every GST state option resolves to a named state', () => {
    expect(GST_STATE_OPTIONS.length).toBeGreaterThan(35);
    for (const opt of GST_STATE_OPTIONS) expect(opt.label.length).toBeGreaterThan(2);
  });

  it('India is pinned first in the country list', () => {
    expect(COUNTRY_OPTIONS[0]).toMatchObject({ value: 'IN', label: 'India' });
    expect(COUNTRY_OPTIONS.some((o) => o.value === 'US')).toBe(true);
  });
});
