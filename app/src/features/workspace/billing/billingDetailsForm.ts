/**
 * Billing-details form logic — ported verbatim from the legacy
 * `components/billing/BillingDetailsCard.jsx` so the redesigned form issues the
 * exact same PATCH the backend expects (only changed fields; explicit null to
 * clear; GSTIN uppercased; state server-derived from the GSTIN when set).
 */

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
}

/** A 2-letter country that isn't India makes GSTIN/GST-state meaningless. */
export function isForeignCountry(raw: string | null | undefined): boolean {
  const country = (raw || '').trim().toUpperCase();
  return country.length === 2 && country !== 'IN';
}

/** Seed the edit form from the stored record (country falls back to account/IN). */
export function detailsToForm(
  details: BillingDetailsRaw | null,
  fallbackCountry?: string | null,
): BillingDetailsForm {
  const address = details?.billing_address || {};
  return {
    legal_name: details?.legal_name || '',
    gstin: details?.gstin || '',
    line1: address.line1 || '',
    line2: address.line2 || '',
    city: address.city || '',
    state: address.state || '',
    postal_code: address.postal_code || '',
    billing_state_code: details?.billing_state_code || '',
    billing_country: details?.billing_country || fallbackCountry || 'IN',
    billing_email: details?.billing_email || '',
  };
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
