/**
 * Billing-details form logic - ported verbatim from the legacy
 * `components/billing/BillingDetailsCard.jsx` so the redesigned form issues the
 * exact same PATCH the backend expects (only changed fields; explicit null to
 * clear; GSTIN uppercased; state server-derived from the GSTIN when set).
 */

import { GST_STATE_CODES, isValidGstin } from './gstin';

export interface BillingDetailsForm {
  legal_name: string;
  gstin: string;
  line1: string;
  line2: string;
  city: string;
  state: string;
  postal_code: string;
  billing_state_code: string;
  billing_country: string;
  billing_email: string;
}

/** Raw billing-details record from `getBillingDetails`. */
export interface BillingDetailsRaw {
  legal_name?: string | null;
  gstin?: string | null;
  billing_country?: string | null;
  billing_state_code?: string | null;
  billing_email?: string | null;
  billing_address?: {
    line1?: string | null;
    line2?: string | null;
    city?: string | null;
    state?: string | null;
    postal_code?: string | null;
  } | null;
  /** Account fields the backend returns read-only, used to prefill the form. */
  company_name?: string | null;
  account_email?: string | null;
}

/** A 2-letter country that isn't India makes GSTIN/GST-state meaningless. */
export function isForeignCountry(raw: string | null | undefined): boolean {
  const country = (raw || '').trim().toUpperCase();
  return country.length === 2 && country !== 'IN';
}

/**
 * Seed the edit form from the stored record. Since every account already has a
 * single billing identity, we prefill from the data we already hold: the legal
 * name falls back to the account company name, the billing email to the account
 * login email, and the country to the account country (set at signup) or IN.
 * These prefilled-but-unsaved values persist on the first save via `formToPatch`.
 */
export function detailsToForm(
  details: BillingDetailsRaw | null,
  fallbackCountry?: string | null,
): BillingDetailsForm {
  const address = details?.billing_address || {};
  return {
    legal_name: details?.legal_name || details?.company_name || '',
    gstin: details?.gstin || '',
    line1: address.line1 || '',
    line2: address.line2 || '',
    city: address.city || '',
    state: address.state || '',
    postal_code: address.postal_code || '',
    billing_state_code: details?.billing_state_code || '',
    billing_country: details?.billing_country || fallbackCountry || 'IN',
    billing_email: details?.billing_email || details?.account_email || '',
  };
}

/** The subset of form fields that can carry a validation error. */
export type BillingDetailsErrorField =
  | 'legal_name'
  | 'billing_email'
  | 'billing_country'
  | 'gstin'
  | 'billing_state_code';

export type BillingDetailsErrors = Partial<Record<BillingDetailsErrorField, string>>;

/** A pragmatic email shape check (matches the HTML5 `type=email` intent). */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Validate the form BEFORE building a PATCH - mirrors the backend's rules
 * (`subscription_routes.update_billing_details`) so obvious mistakes surface
 * inline instead of as a 422. Only rules the backend also enforces are hard
 * errors; the sole product-level addition is requiring a legal name, since a
 * tax invoice cannot be issued without the buyer's legal identity.
 *
 * Cross-field GSTIN/country/state conflicts can't be assembled from this UI
 * (GSTIN is disabled for a foreign country, and the state field is hidden once
 * a GSTIN is present), so they need no client check - the backend still guards
 * them for direct-API callers.
 */
export function validateBillingDetailsForm(form: BillingDetailsForm): BillingDetailsErrors {
  const errors: BillingDetailsErrors = {};
  const trim = (v: string | undefined): string => (v || '').trim();
  const foreign = isForeignCountry(form.billing_country);

  if (!trim(form.legal_name)) {
    errors.legal_name = 'Legal name is required - it’s printed on your invoices.';
  }

  const email = trim(form.billing_email);
  if (email && !EMAIL_RE.test(email)) {
    errors.billing_email = 'Enter a valid email address.';
  }

  const country = trim(form.billing_country).toUpperCase();
  if (country && !/^[A-Z]{2}$/.test(country)) {
    errors.billing_country = 'Use a 2-letter ISO country code (e.g. IN).';
  }

  const gstin = trim(form.gstin).toUpperCase();
  if (!foreign && gstin && !isValidGstin(gstin)) {
    errors.gstin = 'Enter a valid 15-character GSTIN.';
  }

  // The state field is only meaningful (and only shown) with no GSTIN in India.
  if (!foreign && !gstin) {
    const rawState = trim(form.billing_state_code);
    if (rawState) {
      const state = rawState.padStart(2, '0');
      if (!GST_STATE_CODES.has(state)) {
        errors.billing_state_code = 'Enter a valid GST state code (01–38, or 97).';
      }
    }
  }

  return errors;
}

type PatchValue = string | null | Record<string, string> | undefined;

/** Build a minimal PATCH: only changed fields; explicit null clears a field. */
export function formToPatch(
  form: BillingDetailsForm,
  details: BillingDetailsRaw | null,
): Record<string, PatchValue> {
  const trim = (v: string | undefined): string => (v || '').trim();
  const patch: Record<string, PatchValue> = {};

  const stored = {
    legal_name: details?.legal_name || '',
    gstin: details?.gstin || '',
    billing_country: details?.billing_country || '',
    billing_state_code: details?.billing_state_code || '',
    billing_email: details?.billing_email || '',
  };

  if (trim(form.legal_name) !== stored.legal_name) {
    patch.legal_name = trim(form.legal_name) || null;
  }

  const foreign = isForeignCountry(form.billing_country);
  const gstin = foreign ? '' : trim(form.gstin).toUpperCase();
  if (gstin !== stored.gstin) {
    patch.gstin = gstin || null;
  }

  const ADDRESS_KEYS = ['line1', 'line2', 'city', 'state', 'postal_code'] as const;
  const address: Record<string, string> = {};
  for (const key of ADDRESS_KEYS) {
    const v = trim(form[key]);
    if (v) address[key] = v;
  }
  const newAddress = Object.keys(address).length > 0 ? address : null;
  const oldAddress = details?.billing_address || null;
  const addressChanged = ADDRESS_KEYS.some(
    (key) => (address[key] || '') !== ((oldAddress && oldAddress[key]) || ''),
  );
  if (addressChanged) {
    patch.billing_address = newAddress;
  }

  const country = trim(form.billing_country).toUpperCase();
  if (country && country !== stored.billing_country) {
    patch.billing_country = country;
  }

  if (foreign) {
    if (stored.billing_state_code) patch.billing_state_code = null;
  } else if (!gstin) {
    const state = trim(form.billing_state_code);
    if (state !== stored.billing_state_code) {
      patch.billing_state_code = state || null;
    }
  }

  if (trim(form.billing_email) !== stored.billing_email) {
    patch.billing_email = trim(form.billing_email) || null;
  }

  return patch;
}
