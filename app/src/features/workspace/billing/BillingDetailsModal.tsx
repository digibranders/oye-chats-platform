import { useEffect, useRef, useState, type ReactElement } from 'react';
import { AlertCircle, Loader2 } from 'lucide-react';
import { Button, Input, Modal } from '../../../design-system';
import { useCurrency } from '../../../context/CurrencyContext';
import { getBillingDetails, updateBillingDetails } from '../../../services/api';
import {
  detailsToForm,
  formToPatch,
  isForeignCountry,
  type BillingDetailsForm,
  type BillingDetailsRaw,
} from './billingDetailsForm';

export interface BillingDetailsModalProps {
  open: boolean;
  onClose: () => void;
  /** Fired after a successful save with a status message. */
  onSuccess: (message: string) => void;
}

/**
 * BillingDetailsModal — edit the legal/tax identity printed on invoices. Loads
 * the current record, saves only changed fields (PATCH semantics ported from
 * the legacy card), and propagates the country to `CurrencyProvider` so prices
 * across the app flip to the charged currency immediately. Not a payment flow.
 */
export function BillingDetailsModal({ open, onClose, onSuccess }: BillingDetailsModalProps): ReactElement | null {
  const { country: acctCountry, setCountry: setGlobalCountry } = useCurrency();
  const [details, setDetails] = useState<BillingDetailsRaw | null>(null);
  const [form, setForm] = useState<BillingDetailsForm>(() => detailsToForm(null));
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');

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

  const setField =
    (key: keyof BillingDetailsForm) =>
    (e: React.ChangeEvent<HTMLInputElement>): void => {
      const raw = e.target.value;
      setForm((prev) => ({ ...prev, [key]: key === 'gstin' ? raw.toUpperCase() : raw }));
    };

  const foreign = isForeignCountry(form.billing_country);
  const gstinSet = Boolean(form.gstin.trim());

  async function handleSave(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    const patch = formToPatch(form, details);
    if (Object.keys(patch).length === 0) {
      onClose();
      return;
    }
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
      description="The legal identity printed on your invoices and used for tax."
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
          <Field label="Legal name">
            <Input
              value={form.legal_name}
              onChange={setField('legal_name')}
              placeholder="Acme Pvt Ltd"
              autoComplete="organization"
            />
          </Field>

          <Field label="Billing email">
            <Input
              type="email"
              value={form.billing_email}
              onChange={setField('billing_email')}
              placeholder="billing@acme.com"
              autoComplete="email"
            />
          </Field>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Country" hint="ISO-2 code — drives your billing currency.">
              <Input
                value={form.billing_country}
                onChange={(e) =>
                  setForm((prev) => ({ ...prev, billing_country: e.target.value.toUpperCase() }))
                }
                placeholder="IN"
                maxLength={2}
                className="uppercase"
              />
            </Field>
            <Field
              label="GSTIN"
              hint={foreign ? 'Not applicable outside India.' : 'Your state is derived from this.'}
            >
              <Input
                value={form.gstin}
                onChange={setField('gstin')}
                placeholder="22AAAAA0000A1Z5"
                disabled={foreign}
                className="font-mono uppercase tracking-wide"
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
            <Field label="State" hint="Only needed when no GSTIN is set.">
              <Input
                value={form.billing_state_code}
                onChange={setField('billing_state_code')}
                placeholder="e.g. 27 (Maharashtra)"
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
  children,
}: {
  label: string;
  hint?: string;
  children: ReactElement;
}): ReactElement {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[12px] font-medium text-[var(--ds-text-muted)]">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-[var(--ds-text-subtle)]">{hint}</span>}
    </label>
  );
}
