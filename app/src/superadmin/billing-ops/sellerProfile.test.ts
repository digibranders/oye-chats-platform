import { describe, expect, it } from 'vitest';
import {
  MAX_TAX_RATE_BPS,
  RESERVED_PREFIXES,
  ratePercent,
  toDraft,
  toPatch,
  validateSellerDraft,
  type SellerDraft,
} from './sellerProfile';
import type { SellerProfile } from './types';

const STORED: SellerProfile = {
  configured: true,
  gst_enabled: true,
  legal_name: 'Digibranders Private Limited',
  trade_name: 'OyeChats',
  gstin: '29AABCU9603R1ZM',
  address_lines: ['1 Example Road', 'Bengaluru 560001'],
  state_code: '29',
  country: 'IN',
  sac_code: '997331',
  tax_rate_bps: 1800,
  price_inclusive: true,
  lut_active: false,
  lut_number: null,
  invoice_prefix: 'DB',
  logo_url: null,
  cin: null,
  phone: null,
  website: null,
  support_email: null,
};

function draft(overrides: Partial<SellerDraft> = {}): SellerDraft {
  return { ...toDraft(STORED), ...overrides };
}

describe('reading the stored profile into a form', () => {
  it('turns the address array into editable lines', () => {
    expect(toDraft(STORED).address_lines).toBe('1 Example Road\nBengaluru 560001');
  });

  it('renders every nullable field as an empty string, never as "null"', () => {
    const empty = toDraft({ ...STORED, gstin: null, cin: null, website: null, logo_url: null });
    expect(empty.gstin).toBe('');
    expect(empty.cin).toBe('');
    expect(empty.website).toBe('');
    expect(empty.logo_url).toBe('');
  });
});

describe('validation that can happen before the round trip', () => {
  it('accepts the stored profile unchanged', () => {
    expect(validateSellerDraft(draft())).toEqual({});
  });

  it('requires a legal name, because it is printed on every document', () => {
    expect(validateSellerDraft(draft({ legal_name: '   ' })).legal_name).toBeTruthy();
  });

  it('holds the Rule 46 three-character prefix limit', () => {
    expect(validateSellerDraft(draft({ invoice_prefix: 'ABCD' })).invoice_prefix).toBeTruthy();
    expect(validateSellerDraft(draft({ invoice_prefix: 'AB-' })).invoice_prefix).toBeTruthy();
    expect(validateSellerDraft(draft({ invoice_prefix: '' })).invoice_prefix).toBeTruthy();
    expect(validateSellerDraft(draft({ invoice_prefix: 'A1B' })).invoice_prefix).toBeUndefined();
  });

  it('refuses the prefixes reserved for other document series', () => {
    for (const reserved of RESERVED_PREFIXES) {
      expect(validateSellerDraft(draft({ invoice_prefix: reserved })).invoice_prefix).toBeTruthy();
    }
  });

  it('bounds the tax rate the way the service does', () => {
    expect(validateSellerDraft(draft({ tax_rate_bps: '1800' })).tax_rate_bps).toBeUndefined();
    expect(validateSellerDraft(draft({ tax_rate_bps: '-1' })).tax_rate_bps).toBeTruthy();
    expect(validateSellerDraft(draft({ tax_rate_bps: String(MAX_TAX_RATE_BPS + 1) })).tax_rate_bps).toBeTruthy();
    expect(validateSellerDraft(draft({ tax_rate_bps: '18.5' })).tax_rate_bps).toBeTruthy();
    expect(validateSellerDraft(draft({ tax_rate_bps: '' })).tax_rate_bps).toBeTruthy();
  });

  it('checks the SAC is four to eight digits', () => {
    expect(validateSellerDraft(draft({ sac_code: '997331' })).sac_code).toBeUndefined();
    expect(validateSellerDraft(draft({ sac_code: '99' })).sac_code).toBeTruthy();
    expect(validateSellerDraft(draft({ sac_code: '99733a' })).sac_code).toBeTruthy();
  });

  it('requires a LUT number while the LUT is active', () => {
    expect(validateSellerDraft(draft({ lut_active: true, lut_number: '' })).lut_number).toBeTruthy();
    expect(validateSellerDraft(draft({ lut_active: true, lut_number: 'AD290..' })).lut_number).toBeUndefined();
    expect(validateSellerDraft(draft({ lut_active: false, lut_number: '' })).lut_number).toBeUndefined();
  });

  it('validates a CIN only when one is given', () => {
    expect(validateSellerDraft(draft({ cin: '' })).cin).toBeUndefined();
    expect(validateSellerDraft(draft({ cin: 'U74999KA2019PTC123456' })).cin).toBeUndefined();
    expect(validateSellerDraft(draft({ cin: 'NOT-A-CIN' })).cin).toBeTruthy();
  });

  it('insists a website carries its scheme', () => {
    expect(validateSellerDraft(draft({ website: 'oyechats.com' })).website).toBeTruthy();
    expect(validateSellerDraft(draft({ website: 'https://oyechats.com' })).website).toBeUndefined();
    expect(validateSellerDraft(draft({ website: '' })).website).toBeUndefined();
  });

  it('checks the country is a two-letter code', () => {
    expect(validateSellerDraft(draft({ country: 'India' })).country).toBeTruthy();
    expect(validateSellerDraft(draft({ country: 'in' })).country).toBeUndefined();
  });

  it('does not attempt the GSTIN checksum, which is the server’s job', () => {
    // Re-implementing it here is how two allow-lists drift apart.
    expect(validateSellerDraft(draft({ gstin: 'CLEARLY-NOT-VALID' })).gstin).toBeUndefined();
  });
});

describe('the body that gets sent', () => {
  it('splits the address back into lines and drops the blanks', () => {
    const patch = toPatch(draft({ address_lines: ' 1 Example Road \n\n Bengaluru 560001 \n' }));
    expect(patch.address_lines).toEqual(['1 Example Road', 'Bengaluru 560001']);
  });

  it('sends explicit null to clear an optional field', () => {
    // Omitting the key keeps the stored value, so null is the only way to
    // remove a GSTIN or a LUT number.
    const patch = toPatch(draft({ gstin: '', lut_number: '', cin: '', website: '' }));
    expect(patch.gstin).toBeNull();
    expect(patch.lut_number).toBeNull();
    expect(patch.cin).toBeNull();
    expect(patch.website).toBeNull();
  });

  it('omits the state code whenever a GSTIN is present', () => {
    // The service derives it from the GSTIN's first two digits and ignores ours.
    expect(toPatch(draft({ gstin: '29AABCU9603R1ZM' })).state_code).toBeUndefined();
    expect(toPatch(draft({ gstin: '', state_code: '29' })).state_code).toBe('29');
    expect(toPatch(draft({ gstin: '', state_code: '' })).state_code).toBeNull();
  });

  it('upper-cases the identifiers the server stores upper-cased', () => {
    const patch = toPatch(draft({ gstin: '29aabcu9603r1zm', invoice_prefix: 'db', country: 'in', cin: 'u74999ka2019ptc123456' }));
    expect(patch.gstin).toBe('29AABCU9603R1ZM');
    expect(patch.invoice_prefix).toBe('DB');
    expect(patch.country).toBe('IN');
    expect(patch.cin).toBe('U74999KA2019PTC123456');
  });

  it('sends the tax rate as a number, not as the input’s string', () => {
    expect(toPatch(draft({ tax_rate_bps: '1800' })).tax_rate_bps).toBe(1800);
  });

  it('never sends price_inclusive, which the service rejects when false', () => {
    expect('price_inclusive' in toPatch(draft())).toBe(false);
  });
});

describe('the rate hint', () => {
  it('reads basis points back as a percentage', () => {
    expect(ratePercent('1800')).toBe('18%');
    expect(ratePercent('1875')).toBe('18.75%');
    expect(ratePercent('')).toBe('0%');
    expect(ratePercent('abc')).toBe('—');
  });
});
