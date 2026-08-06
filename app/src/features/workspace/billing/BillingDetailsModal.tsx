import { useEffect, useRef, useState, type ReactElement } from 'react';
import { AlertCircle, Loader2 } from 'lucide-react';
import { Button, Input, Modal, cn } from '../../../design-system';
import { useCurrency } from '../../../context/CurrencyContext';
import { getBillingDetails, updateBillingDetails } from '../../../services/api';
import {
  detailsToForm,
  formToPatch,
  isForeignCountry,
  validateBillingDetailsForm,
  type BillingDetailsErrorField,
  type BillingDetailsErrors,
  type BillingDetailsForm,
  type BillingDetailsRaw,
} from './billingDetailsForm';
import { gstStateName, isValidGstin } from './gstin';

/** Red border + ring applied to an input whose value failed validation. */
const INVALID_INPUT_CLASS =
  'border-[var(--ds-danger)] focus-visible:border-[var(--ds-danger)] focus-visible:shadow-[0_0_0_1px_var(--ds-danger)]';

export interface BillingDetailsModalProps {
  open: boolean;
  onClose: () => void;
  /** Fired after a successful save with a status message. */
  onSuccess: (message: string) => void;
  /**
   * Why the form opened, when it was triggered by a blocked checkout rather
   * than by the customer. Replaces the generic description so the modal never
   * appears unexplained mid-purchase.
   */
  prompt?: string | null;
}

/**
 * BillingDetailsModal - edit the legal/tax identity printed on invoices. Loads
 * the current record, saves only changed fields (PATCH semantics ported from
 * the legacy card), and propagates the country to `CurrencyProvider` so prices
 * across the app flip to the charged currency immediately. Not a payment flow.
 */
export function BillingDetailsModal({
  open,
  onClose,
  onSuccess,
  prompt,
}: BillingDetailsModalProps): ReactElement | null {
  const { country: acctCountry, setCountry: setGlobalCountry } = useCurrency();
  const [details, setDetails] = useState<BillingDetailsRaw | null>(null);
  const [form, setForm] = useState<BillingDetailsForm>(() => detailsToForm(null));
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [errors, setErrors] = useState<BillingDetailsErrors>({});

  // Keep the latest account country in a ref so the fetch effect can seed the
  // form with it WITHOUT depending on it. Depending on `acctCountry` would
  // re-run the effect (and re-seed the form) when /geo resolves mid-edit,
  // silently wiping whatever the user has already typed.
  const acctCountryRef = useRef(acctCountry);
  acctCountryRef.current = acctCountry;

  // Fetch + seed once per open transition only.
  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    setLoading(true);
    setLoadError('');
    setSaveError('');
    setErrors({});
    getBillingDetails()
      .then((data) => {
        if (cancelled) return;
        const raw = (data as BillingDetailsRaw) ?? null;
        setDetails(raw);
        setForm(detailsToForm(raw, acctCountryRef.current));
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : 'Failed to load billing details');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  /** Clear a resolved field error so it doesn't linger while the user retypes. */
  const clearError = (key: BillingDetailsErrorField): void =>
    setErrors((prev) => (prev[key] ? { ...prev, [key]: undefined } : prev));

  const setField =
    (key: keyof BillingDetailsForm) =>
    (e: React.ChangeEvent<HTMLInputElement>): void => {
      const raw = e.target.value;
      setForm((prev) => ({ ...prev, [key]: key === 'gstin' ? raw.toUpperCase() : raw }));
      if (key in errors) clearError(key as BillingDetailsErrorField);
    };

  const foreign = isForeignCountry(form.billing_country);
  // A GSTIN turns the name field into a statutory match: the recipient name on
  // a tax invoice must equal the GST registration, or the buyer's GSTR-2B
  // reconciliation fails and they lose the input tax credit. No GSTIN simply
  // means the customer isn't GST-registered, which is perfectly normal (B2C).
  const gstinEntered = !foreign && Boolean(form.gstin.trim());
  const gstinSet = Boolean(form.gstin.trim());

  // Live place-of-supply echo: reassures the user their GSTIN/state resolves to
  // the state that will be printed on the invoice, before they ever save.
  const gstinStateName =
    gstinSet && isValidGstin(form.gstin) ? gstStateName(form.gstin.slice(0, 2)) : null;
  const manualStateName = !gstinSet && !foreign ? gstStateName(form.billing_state_code.trim()) : null;

  async function handleSave(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    const patch = formToPatch(form, details);
    if (Object.keys(patch).length === 0) {
      onClose();
      return;
    }
    // Validate only when there's actually something to save, so an unchanged
    // form never blocks on a legacy record's missing field.
    const nextErrors = validateBillingDetailsForm(form);
    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors);
      setSaveError('');
      return;
    }
    setErrors({});
    setSaving(true);
    setSaveError('');
    try {
      const updated = (await updateBillingDetails(patch)) as BillingDetailsRaw;
      if ('billing_country' in patch) setGlobalCountry(updated?.billing_country || null);
      onSuccess('Billing details saved.');
      onClose();
    } catch (err: unknown) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save billing details');
    } finally {
      setSaving(false);
    }
  }

  if (!open) return null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      dismissible={!saving}
      size="lg"
      title="Billing details"
      description={prompt || 'The legal identity printed on your invoices and used for tax.'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" form="billing-details-form" disabled={saving || loading}>
            {saving && <Loader2 size={16} className="animate-spin" />}
            {saving ? 'Saving…' : 'Save details'}
          </Button>
        </>
      }
    >
      {loading ? (
        <div className="flex items-center justify-center gap-2 py-10 text-[13px] text-[var(--ds-text-muted)]">
          <Loader2 size={18} className="animate-spin" />
          Loading…
        </div>
      ) : loadError ? (
        <p role="alert" className="py-8 text-center text-[13px] text-[var(--ds-danger)]">
          {loadError}
        </p>
      ) : (
        <form id="billing-details-form" onSubmit={(e) => void handleSave(e)} className="space-y-4">
          <Field
            label={gstinEntered ? 'Registered business name' : 'Legal name'}
            hint={
              gstinEntered
                ? 'Exactly as it appears on your GST certificate - a mismatch can block your input tax credit.'
                : 'Optional - any name you want on your invoices (defaults to your account name). Only GST-registered businesses need their exact registered name.'
            }
            error={errors.legal_name}
          >
            <Input
              value={form.legal_name}
              onChange={setField('legal_name')}
              placeholder={gstinEntered ? 'Name as per GST certificate' : 'Acme Pvt Ltd'}
              autoComplete="organization"
              aria-invalid={errors.legal_name ? true : undefined}
              className={cn(errors.legal_name && INVALID_INPUT_CLASS)}
            />
          </Field>

          <Field label="Billing email" error={errors.billing_email}>
            <Input
              type="email"
              value={form.billing_email}
              onChange={setField('billing_email')}
              placeholder="billing@acme.com"
              autoComplete="email"
              aria-invalid={errors.billing_email ? true : undefined}
              className={cn(errors.billing_email && INVALID_INPUT_CLASS)}
            />
          </Field>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field
              label="Country"
              hint="ISO-2 code - drives your billing currency."
              error={errors.billing_country}
            >
              <Input
                value={form.billing_country}
                onChange={(e) => {
                  setForm((prev) => ({ ...prev, billing_country: e.target.value.toUpperCase() }));
                  if (errors.billing_country) clearError('billing_country');
                }}
                placeholder="IN"
                maxLength={2}
                aria-invalid={errors.billing_country ? true : undefined}
                className={cn('uppercase', errors.billing_country && INVALID_INPUT_CLASS)}
              />
            </Field>
            <Field
              label="GSTIN"
              hint={
                foreign
                  ? 'Not applicable outside India.'
                  : gstinStateName
                    ? `Place of supply: ${gstinStateName}.`
                    : 'Leave blank if you aren’t GST registered. Your state is derived from this.'
              }
              error={errors.gstin}
            >
              <Input
                value={form.gstin}
                onChange={setField('gstin')}
                placeholder="22AAAAA0000A1Z5"
                disabled={foreign}
                aria-invalid={errors.gstin ? true : undefined}
                className={cn('font-mono uppercase tracking-wide', errors.gstin && INVALID_INPUT_CLASS)}
              />
            </Field>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Address line 1">
              <Input value={form.line1} onChange={setField('line1')} placeholder="Street address" />
            </Field>
            <Field label="Address line 2">
              <Input value={form.line2} onChange={setField('line2')} placeholder="Suite, floor (optional)" />
            </Field>
            <Field label="City">
              <Input value={form.city} onChange={setField('city')} placeholder="City" />
            </Field>
            <Field label="Postal code">
              <Input value={form.postal_code} onChange={setField('postal_code')} placeholder="ZIP / PIN" />
            </Field>
          </div>

          {!gstinSet && !foreign && (
            <Field
              label="State"
              hint={
                manualStateName ? `${manualStateName}.` : 'GST state code - only needed when no GSTIN is set.'
              }
              error={errors.billing_state_code}
            >
              <Input
                value={form.billing_state_code}
                onChange={setField('billing_state_code')}
                placeholder="e.g. 27 (Maharashtra)"
                aria-invalid={errors.billing_state_code ? true : undefined}
                className={cn(errors.billing_state_code && INVALID_INPUT_CLASS)}
              />
            </Field>
          )}

          {saveError && (
            <p role="alert" className="flex items-start gap-1.5 text-[12px] text-[var(--ds-danger)]">
              <AlertCircle size={13} className="mt-0.5 shrink-0" />
              {saveError}
            </p>
          )}
        </form>
      )}
    </Modal>
  );
}

function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: ReactElement;
}): ReactElement {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[12px] font-medium text-[var(--ds-text-muted)]">{label}</span>
      {children}
      {/* Error wins over the hint - one line of guidance beneath the field. */}
      {error ? (
        <span className="mt-1 flex items-start gap-1 text-[11px] text-[var(--ds-danger)]">
          <AlertCircle size={12} className="mt-px shrink-0" />
          {error}
        </span>
      ) : (
        hint && <span className="mt-1 block text-[11px] text-[var(--ds-text-subtle)]">{hint}</span>
      )}
    </label>
  );
}
