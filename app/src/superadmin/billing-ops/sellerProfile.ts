import type { SellerProfile, SellerProfilePatch } from './types';

/**
 * The seller-of-record form, as data.
 *
 * This profile is snapshotted onto every invoice at the moment it is numbered,
 * so a mistake here does not just look wrong — it is printed on statutory
 * documents that cannot then be edited. The service validates all of it and
 * answers 422 with a sentence, which the form shows; the checks below are the
 * subset that can be made *before* the round trip, so an operator is not told
 * about a three-character prefix limit after saving.
 *
 * Nothing here duplicates a rule the server does not have. Where the two could
 * drift — the GSTIN checksum, the GST state-code set — the client deliberately
 * does not guess, and lets the server be the authority.
 */

export interface SellerDraft {
  legal_name: string;
  trade_name: string;
  gstin: string;
  address_lines: string;
  state_code: string;
  country: string;
  sac_code: string;
  tax_rate_bps: string;
  lut_active: boolean;
  lut_number: string;
  invoice_prefix: string;
  logo_url: string;
  cin: string;
  phone: string;
  website: string;
  support_email: string;
}

/** Prefixes reserved for the receipt and credit-note serial series. */
export const RESERVED_PREFIXES = ['RCT', 'CN'] as const;

/** Rule 46 caps the serial at 16 characters, which leaves three for the prefix. */
const PREFIX_PATTERN = /^[A-Z0-9]{1,3}$/;
const SAC_PATTERN = /^[0-9]{4,8}$/;
const COUNTRY_PATTERN = /^[A-Z]{2}$/;
const CIN_PATTERN = /^[LU]\d{5}[A-Z]{2}\d{4}[A-Z]{3}\d{6}$/;

/** The service's sanity ceiling on the tax rate. */
export const MAX_TAX_RATE_BPS = 4000;

export function toDraft(profile: SellerProfile): SellerDraft {
  return {
    legal_name: profile.legal_name ?? '',
    trade_name: profile.trade_name ?? '',
    gstin: profile.gstin ?? '',
    address_lines: (profile.address_lines ?? []).join('\n'),
    state_code: profile.state_code ?? '',
    country: profile.country ?? 'IN',
    sac_code: profile.sac_code ?? '',
    tax_rate_bps: String(profile.tax_rate_bps ?? 0),
    lut_active: Boolean(profile.lut_active),
    lut_number: profile.lut_number ?? '',
    invoice_prefix: profile.invoice_prefix ?? '',
    logo_url: profile.logo_url ?? '',
    cin: profile.cin ?? '',
    phone: profile.phone ?? '',
    website: profile.website ?? '',
    support_email: profile.support_email ?? '',
  };
}

export type SellerErrors = Partial<Record<keyof SellerDraft, string>>;

export function validateSellerDraft(draft: SellerDraft): SellerErrors {
  const errors: SellerErrors = {};

  if (!draft.legal_name.trim()) {
    errors.legal_name = 'The registered legal name is required — it is printed on every document.';
  }

  const prefix = draft.invoice_prefix.trim().toUpperCase();
  if (!PREFIX_PATTERN.test(prefix)) {
    errors.invoice_prefix = 'One to three characters, A–Z and 0–9 only.';
  } else if ((RESERVED_PREFIXES as readonly string[]).includes(prefix)) {
    errors.invoice_prefix = `${prefix} is reserved for another document series. Choose something else.`;
  }

  if (!SAC_PATTERN.test(draft.sac_code.trim())) {
    errors.sac_code = 'Four to eight digits. The platform’s SAC is 997331.';
  }

  // `Number('')` is 0, so an emptied field would otherwise validate and post a
  // zero-rated seller profile — every future invoice issued with no tax.
  const rawRate = draft.tax_rate_bps.trim();
  const rate = rawRate === '' ? Number.NaN : Number(rawRate);
  if (!Number.isInteger(rate) || rate < 0 || rate > MAX_TAX_RATE_BPS) {
    errors.tax_rate_bps = `A whole number of basis points between 0 and ${MAX_TAX_RATE_BPS} (1800 = 18%).`;
  }

  if (!COUNTRY_PATTERN.test(draft.country.trim().toUpperCase())) {
    errors.country = 'A two-letter ISO country code, e.g. IN.';
  }

  if (draft.lut_active && !draft.lut_number.trim()) {
    errors.lut_number = 'A LUT number is required while the LUT is active.';
  }

  const cin = draft.cin.trim().toUpperCase();
  if (cin && !CIN_PATTERN.test(cin)) {
    errors.cin = 'A 21-character Corporate Identity Number, or blank if the seller is not a company.';
  }

  const email = draft.support_email.trim();
  if (email && !email.includes('@')) {
    errors.support_email = 'That is not an email address.';
  }

  const website = draft.website.trim();
  if (website && !/^https?:\/\//.test(website)) {
    errors.website = 'Must start with http:// or https://.';
  }

  return errors;
}

/**
 * The body to PUT.
 *
 * Every field is sent, including the ones the operator did not touch: the
 * service merges over what is stored and validates the merged whole, so a
 * partial body is fine — but sending the full form is what makes "clear this
 * field" work at all. An omitted key keeps the stored value; an explicit null
 * clears it, and that is the only way to remove a GSTIN or a LUT number.
 *
 * `state_code` is omitted whenever a GSTIN is present, because the service
 * derives it from the GSTIN's first two digits and would ignore ours anyway.
 */
export function toPatch(draft: SellerDraft): SellerProfilePatch {
  const gstin = draft.gstin.trim().toUpperCase();
  const patch: SellerProfilePatch = {
    legal_name: draft.legal_name.trim(),
    trade_name: draft.trade_name.trim(),
    gstin: gstin || null,
    address_lines: draft.address_lines
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean),
    country: draft.country.trim().toUpperCase(),
    sac_code: draft.sac_code.trim(),
    tax_rate_bps: Number(draft.tax_rate_bps),
    lut_active: draft.lut_active,
    lut_number: draft.lut_number.trim() || null,
    invoice_prefix: draft.invoice_prefix.trim().toUpperCase(),
    logo_url: draft.logo_url.trim() || null,
    cin: draft.cin.trim().toUpperCase() || null,
    phone: draft.phone.trim() || null,
    website: draft.website.trim() || null,
    support_email: draft.support_email.trim() || null,
  };

  if (!gstin) {
    patch.state_code = draft.state_code.trim() || null;
  }
  return patch;
}

/** `1800` → `18%`, for the rate field's hint. */
export function ratePercent(bps: string): string {
  const value = Number(bps);
  if (!Number.isFinite(value)) return '—';
  const percent = value / 100;
  return `${Number.isInteger(percent) ? percent : percent.toFixed(2)}%`;
}
