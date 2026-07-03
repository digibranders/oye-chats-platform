import { useCallback, useEffect, useState } from 'react';
import {
  Building2,
  Check,
  FileText,
  Landmark,
  Loader2,
  Mail,
  MapPin,
  Pencil,
  X,
} from 'lucide-react';
import { getBillingDetails, updateBillingDetails } from '../../services/api';
import { useToast } from '../../context/ToastContext';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '../ui/Card';
import { Button } from '../ui/Button';
import { cn } from '../../lib/utils';

// GST state codes 01–38 + 97 (Other Territory) — mirrors the backend's
// VALID_STATE_CODES set in api/app/core/gstin.py.
const GST_STATES = [
  ['01', 'Jammu & Kashmir'],
  ['02', 'Himachal Pradesh'],
  ['03', 'Punjab'],
  ['04', 'Chandigarh'],
  ['05', 'Uttarakhand'],
  ['06', 'Haryana'],
  ['07', 'Delhi'],
  ['08', 'Rajasthan'],
  ['09', 'Uttar Pradesh'],
  ['10', 'Bihar'],
  ['11', 'Sikkim'],
  ['12', 'Arunachal Pradesh'],
  ['13', 'Nagaland'],
  ['14', 'Manipur'],
  ['15', 'Mizoram'],
  ['16', 'Tripura'],
  ['17', 'Meghalaya'],
  ['18', 'Assam'],
  ['19', 'West Bengal'],
  ['20', 'Jharkhand'],
  ['21', 'Odisha'],
  ['22', 'Chhattisgarh'],
  ['23', 'Madhya Pradesh'],
  ['24', 'Gujarat'],
  ['25', 'Daman & Diu'],
  ['26', 'Dadra & Nagar Haveli and Daman & Diu'],
  ['27', 'Maharashtra'],
  ['28', 'Andhra Pradesh (old)'],
  ['29', 'Karnataka'],
  ['30', 'Goa'],
  ['31', 'Lakshadweep'],
  ['32', 'Kerala'],
  ['33', 'Tamil Nadu'],
  ['34', 'Puducherry'],
  ['35', 'Andaman & Nicobar Islands'],
  ['36', 'Telangana'],
  ['37', 'Andhra Pradesh'],
  ['38', 'Ladakh'],
  ['97', 'Other Territory'],
];

const STATE_NAME_BY_CODE = Object.fromEntries(GST_STATES);

const INPUT_CLASSES = cn(
  'w-full px-3 py-2 rounded-xl border border-surface-200 dark:border-surface-600 text-sm',
  'bg-white dark:bg-surface-800 text-surface-900 dark:text-surface-100',
  'placeholder:text-surface-400 dark:placeholder:text-surface-500',
  'focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500 outline-none transition-all',
  'disabled:opacity-60 disabled:cursor-not-allowed',
);

// eslint-disable-next-line no-unused-vars -- Icon IS used in JSX below; the lint setup misses renamed component props (same suppression as Subscription.jsx).
function ReadonlyRow({ icon: Icon, label, value }) {
  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <span className="flex items-center gap-2 text-sm text-surface-500 dark:text-surface-400">
        <Icon className="w-3.5 h-3.5" />
        {label}
      </span>
      <span className="text-sm font-medium text-surface-900 dark:text-surface-50 truncate max-w-[60%] text-right">
        {value || '—'}
      </span>
    </div>
  );
}

function FieldLabel({ htmlFor, children }) {
  return (
    <label
      htmlFor={htmlFor}
      className="text-xs font-medium text-surface-500 dark:text-surface-400 mb-1 block"
    >
      {children}
    </label>
  );
}

function formToPatch(form, details) {
  const trim = (v) => (v || '').trim();
  const patch = {};

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
  const gstin = trim(form.gstin).toUpperCase();
  if (gstin !== stored.gstin) {
    patch.gstin = gstin || null;
  }

  const ADDRESS_KEYS = ['line1', 'line2', 'city', 'postal_code'];
  const address = {};
  for (const key of ADDRESS_KEYS) {
    const v = trim(form[key]);
    if (v) address[key] = v;
  }
  const newAddress = Object.keys(address).length > 0 ? address : null;
  const oldAddress = details?.billing_address || null;
  // Field-by-field comparison — Postgres JSONB does not preserve key order,
  // so a JSON.stringify diff would flag an unchanged address on every save.
  const addressChanged = ADDRESS_KEYS.some(
    (key) => (address[key] || '') !== ((oldAddress && oldAddress[key]) || ''),
  );
  if (addressChanged) {
    patch.billing_address = newAddress;
  }

  const country = trim(form.billing_country).toUpperCase();
  // The form seeds 'IN' as a display default when no country is stored yet
  // (see detailsToForm) — only send that value if the user actually touched
  // the field, so an untouched default is never persisted on first save.
  if (
    country !== stored.billing_country &&
    (stored.billing_country || form.billing_country_touched)
  ) {
    patch.billing_country = country || null;
  }
  // State is server-derived from the GSTIN when one is set — only send an
  // explicit state when the form has no GSTIN, otherwise a stale select
  // value could 422 against the GSTIN's own state digits.
  if (!gstin) {
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

function detailsToForm(details) {
  const address = details?.billing_address || {};
  return {
    legal_name: details?.legal_name || '',
    gstin: details?.gstin || '',
    line1: address.line1 || '',
    line2: address.line2 || '',
    city: address.city || '',
    postal_code: address.postal_code || '',
    billing_state_code: details?.billing_state_code || '',
    billing_country: details?.billing_country || 'IN',
    billing_email: details?.billing_email || '',
    // Distinguishes a user-entered country from the seeded 'IN' default so
    // formToPatch never persists a default the user did not choose.
    billing_country_touched: false,
  };
}

/**
 * BillingDetailsCard — the buyer tax identity printed on invoices.
 *
 * Readonly rows with an inline edit form (same pattern as Settings →
 * ProfileTab). Saves with PATCH semantics: only changed fields go over the
 * wire, clearing a field sends an explicit null. When a GSTIN is set the
 * state select is disabled — the backend derives the state from the
 * GSTIN's first two digits.
 */
export default function BillingDetailsCard() {
  const { showToast } = useToast();

  const [details, setDetails] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState(() => detailsToForm(null));
  const [saving, setSaving] = useState(false);

  const loadDetails = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      const data = await getBillingDetails();
      setDetails(data);
    } catch (err) {
      setLoadError(err?.message || 'Failed to load billing details');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadDetails();
  }, [loadDetails]);

  const setField = (key) => (e) => {
    const raw = e.target.value;
    setForm((prev) => ({
      ...prev,
      [key]: key === 'gstin' || key === 'billing_country' ? raw.toUpperCase() : raw,
      ...(key === 'billing_country' ? { billing_country_touched: true } : {}),
    }));
  };

  function startEditing() {
    setForm(detailsToForm(details));
    setEditing(true);
  }

  async function handleSave(e) {
    e.preventDefault();
    const patch = formToPatch(form, details);
    if (Object.keys(patch).length === 0) {
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      const updated = await updateBillingDetails(patch);
      setDetails(updated);
      setEditing(false);
      showToast('Billing details saved.', 'success');
    } catch (err) {
      // 422s carry a human-readable detail (invalid GSTIN, state mismatch, …).
      showToast(err?.message || 'Failed to save billing details', 'error');
    } finally {
      setSaving(false);
    }
  }

  const gstinSet = editing ? !!form.gstin.trim() : !!details?.gstin;
  const address = details?.billing_address || null;
  const addressLine = address
    ? [address.line1, address.line2, address.city, address.postal_code].filter(Boolean).join(', ')
    : '';
  const stateCode = details?.billing_state_code || '';
  const stateLabel = stateCode
    ? `${STATE_NAME_BY_CODE[stateCode] || 'Unknown state'} (${stateCode})`
    : '';

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle>
              <span className="flex items-center gap-2">
                <Landmark className="w-4 h-4 text-surface-500" /> Billing details
              </span>
            </CardTitle>
            <CardDescription>
              Printed on your invoices. Add your GSTIN to claim input tax credit.
            </CardDescription>
          </div>
          {!loading && !loadError && !editing && (
            <Button variant="outline" size="sm" onClick={startEditing}>
              <Pencil className="w-3.5 h-3.5" />
              Edit
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="flex items-center gap-2 py-6 text-sm text-surface-500 dark:text-surface-400">
            <Loader2 className="w-4 h-4 animate-spin" />
            Loading billing details…
          </div>
        ) : loadError ? (
          <div className="py-4">
            <p className="text-sm text-rose-600 dark:text-rose-400 mb-2">{loadError}</p>
            <Button variant="outline" size="sm" onClick={loadDetails}>
              Try again
            </Button>
          </div>
        ) : editing ? (
          <form onSubmit={handleSave} className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <FieldLabel htmlFor="bd-legal-name">Legal name</FieldLabel>
                <input
                  id="bd-legal-name"
                  type="text"
                  value={form.legal_name}
                  onChange={setField('legal_name')}
                  placeholder="Registered business or personal name"
                  className={INPUT_CLASSES}
                />
              </div>
              <div>
                <FieldLabel htmlFor="bd-gstin">GSTIN</FieldLabel>
                <input
                  id="bd-gstin"
                  type="text"
                  value={form.gstin}
                  onChange={setField('gstin')}
                  placeholder="e.g. 27ABCDE1234F1Z5"
                  maxLength={15}
                  autoCapitalize="characters"
                  spellCheck={false}
                  className={cn(INPUT_CLASSES, 'font-mono uppercase tracking-wide')}
                />
                <p className="mt-1 text-[11px] text-surface-500 dark:text-surface-400">
                  15-character GSTIN — adds GST breakup to your invoices for input tax credit
                </p>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <FieldLabel htmlFor="bd-line1">Address line 1</FieldLabel>
                <input
                  id="bd-line1"
                  type="text"
                  value={form.line1}
                  onChange={setField('line1')}
                  placeholder="Street address"
                  className={INPUT_CLASSES}
                />
              </div>
              <div>
                <FieldLabel htmlFor="bd-line2">Address line 2</FieldLabel>
                <input
                  id="bd-line2"
                  type="text"
                  value={form.line2}
                  onChange={setField('line2')}
                  placeholder="Apartment, suite, area (optional)"
                  className={INPUT_CLASSES}
                />
              </div>
              <div>
                <FieldLabel htmlFor="bd-city">City</FieldLabel>
                <input
                  id="bd-city"
                  type="text"
                  value={form.city}
                  onChange={setField('city')}
                  placeholder="City"
                  className={INPUT_CLASSES}
                />
              </div>
              <div>
                <FieldLabel htmlFor="bd-postal">Postal code</FieldLabel>
                <input
                  id="bd-postal"
                  type="text"
                  value={form.postal_code}
                  onChange={setField('postal_code')}
                  placeholder="PIN / postal code"
                  className={INPUT_CLASSES}
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <FieldLabel htmlFor="bd-state">State (GST)</FieldLabel>
                <select
                  id="bd-state"
                  value={gstinSet ? form.gstin.trim().slice(0, 2) : form.billing_state_code}
                  onChange={setField('billing_state_code')}
                  disabled={gstinSet}
                  className={INPUT_CLASSES}
                >
                  <option value="">Select a state…</option>
                  {GST_STATES.map(([code, name]) => (
                    <option key={code} value={code}>
                      {code} — {name}
                    </option>
                  ))}
                </select>
                {gstinSet && (
                  <p className="mt-1 text-[11px] text-surface-500 dark:text-surface-400">
                    Derived from the first 2 digits of your GSTIN.
                  </p>
                )}
              </div>
              <div>
                <FieldLabel htmlFor="bd-country">Country</FieldLabel>
                <input
                  id="bd-country"
                  type="text"
                  value={form.billing_country}
                  onChange={setField('billing_country')}
                  placeholder="IN"
                  maxLength={2}
                  autoCapitalize="characters"
                  spellCheck={false}
                  className={cn(INPUT_CLASSES, 'uppercase')}
                />
                <p className="mt-1 text-[11px] text-surface-500 dark:text-surface-400">
                  2-letter ISO code, e.g. IN.
                </p>
              </div>
            </div>

            <div>
              <FieldLabel htmlFor="bd-email">Billing email</FieldLabel>
              <input
                id="bd-email"
                type="email"
                value={form.billing_email}
                onChange={setField('billing_email')}
                placeholder="accounts@yourcompany.com"
                className={INPUT_CLASSES}
              />
              <p className="mt-1 text-[11px] text-surface-500 dark:text-surface-400">
                Optional — invoices go to your account email unless set.
              </p>
            </div>

            <div className="flex items-center gap-2 pt-1">
              <Button type="submit" size="sm" disabled={saving}>
                {saving ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Check className="w-3.5 h-3.5" />
                )}
                Save details
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setEditing(false)}
                disabled={saving}
              >
                <X className="w-3.5 h-3.5" />
                Cancel
              </Button>
            </div>
          </form>
        ) : (
          <div className="divide-y divide-surface-100 dark:divide-surface-800">
            <ReadonlyRow icon={Building2} label="Legal name" value={details?.legal_name || details?.company_name} />
            <ReadonlyRow icon={FileText} label="GSTIN" value={details?.gstin} />
            <ReadonlyRow icon={MapPin} label="Address" value={addressLine} />
            <ReadonlyRow icon={MapPin} label="State" value={stateLabel} />
            <ReadonlyRow icon={MapPin} label="Country" value={details?.billing_country} />
            <ReadonlyRow icon={Mail} label="Billing email" value={details?.billing_email} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
