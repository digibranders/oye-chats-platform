import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Building2 } from 'lucide-react';
import {
  ABSENT,
  Alert,
  Button,
  Card,
  CardBody,
  CardHeader,
  Combobox,
  DefinitionList,
  Dialog,
  Field,
  Input,
} from '../../../ui';
import { updateBillingDetails } from '../../../services/api';
import { keys } from '../../../query/keys';
import type { BillingDetailsView } from '../billingModel';
import {
  detailsToForm,
  formToPatch,
  isForeignCountry,
  validateBillingDetailsForm,
  type BillingDetailsErrors,
  type BillingDetailsForm,
  type BillingDetailsRaw,
} from './billingDetailsForm';
import { GST_STATE_OPTIONS, gstStateFromPin, gstStateName, normalizeGstin } from './gstin';
import { COUNTRY_OPTIONS } from './countries';

/**
 * The buyer identity printed on every tax invoice.
 *
 * This is not a preference. An Indian registered buyer whose GSTIN is missing
 * gets an invoice they cannot reconcile in GSTR-2B and therefore cannot claim
 * input tax credit on, and the checkout path 409s `billing_details_required`
 * before it will charge them at all - which is why the picker hands off here
 * rather than showing an error.
 */
export function BillingIdentitySection({
  details,
  raw,
  loading,
  error,
  /** Set when checkout refused for missing fields, so the form opens focused on the gap. */
  demandedFields,
  onDemandCleared,
  fallbackCountry,
}: {
  details: BillingDetailsView | null;
  raw: BillingDetailsRaw | null;
  loading: boolean;
  error: string | null;
  demandedFields: string[] | null;
  onDemandCleared: () => void;
  fallbackCountry: string | null;
}) {
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<BillingDetailsForm>(() => detailsToForm(raw, fallbackCountry));
  const [errors, setErrors] = useState<BillingDetailsErrors>({});

  // Checkout refusing for missing tax fields is not an error state, it is a
  // form that has not been filled in. Open it rather than stranding the
  // customer on a banner with nothing to click.
  //
  // Adjusted during render rather than in an effect: an effect would paint the
  // closed form for one frame and then open it, which reads as a flicker at the
  // exact moment the customer is being told why their payment stopped. This is
  // React's documented pattern for state that derives from a changing prop, and
  // the `seen` guard is what keeps it from re-opening a form the customer has
  // deliberately closed while the same demand is still on screen.
  //
  // Seeded with `null`, NOT with the incoming prop: a page that mounts already
  // carrying a demand (a reload after a refused checkout, or a deep link back
  // from the top-up dialog) would otherwise start out having "already seen" it
  // and never open the form at all.
  const [seenDemand, setSeenDemand] = useState<string[] | null>(null);
  if (seenDemand !== demandedFields) {
    setSeenDemand(demandedFields);
    if (demandedFields && demandedFields.length > 0) setOpen(true);
  }

  const save = useMutation({
    mutationFn: (patch: Record<string, unknown>) => updateBillingDetails(patch),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.billing.details() });
      setOpen(false);
      onDemandCleared();
    },
  });

  const foreign = isForeignCountry(form.billing_country);

  function startEditing() {
    setForm(detailsToForm(raw, fallbackCountry));
    setErrors({});
    save.reset();
    setOpen(true);
  }

  function submit() {
    const found = validateBillingDetailsForm(form);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    const patch = formToPatch(form, raw);
    if (Object.keys(patch).length === 0) {
      setOpen(false);
      onDemandCleared();
      return;
    }
    save.mutate(patch);
  }

  const address = details?.address ?? null;
  const addressLines = address
    ? [address.line1, address.line2, address.city, address.state, address.postal_code]
        .filter((part): part is string => Boolean(part))
        .join(', ')
    : null;

  return (
    <Card>
      <CardHeader
        eyebrow="Tax identity"
        title="Billing details"
        titleAs="h2"
        description="Printed on every invoice we issue. A GSTIN here is what lets your accountant claim input tax credit on what you spend with us."
        actions={
          <Button size="sm" variant="secondary" onClick={startEditing} disabled={loading}>
            {details && !details.isEmpty ? 'Edit' : 'Add details'}
          </Button>
        }
      />
      <CardBody>
        {error ? (
          <Alert tone="warning">We could not load your billing details. {error}</Alert>
        ) : details && details.isEmpty ? (
          <div className="flex items-start gap-2.5">
            <Building2 aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-text-tertiary" />
            <p className="text-prose text-text-secondary">
              No tax identity on record. Invoices will be issued to your account email with no legal
              name or GSTIN, and a registered buyer cannot reclaim the GST on them.
            </p>
          </div>
        ) : (
          <DefinitionList
            columns={2}
            items={[
              { label: 'Legal name', value: details?.legalName ?? ABSENT },
              { label: 'GSTIN', value: details?.gstin ? <span className="figure">{details.gstin}</span> : ABSENT },
              { label: 'Billing email', value: details?.email ?? details?.accountEmail ?? ABSENT },
              {
                label: 'Place of supply',
                value: details?.stateCode
                  ? (gstStateName(details.stateCode) ?? details.stateCode)
                  : (details?.country ?? ABSENT),
              },
              { label: 'Address', value: addressLines ?? ABSENT },
            ]}
          />
        )}
      </CardBody>

      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next && save.isPending) return;
          if (!next) onDemandCleared();
          setOpen(next);
        }}
        dismissible={!save.isPending}
        title="Billing details"
        description="These appear on your tax invoices. Everything except the legal name is optional."
        size="md"
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={save.isPending}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={save.isPending}>
              {save.isPending ? 'Saving…' : 'Save details'}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {demandedFields && demandedFields.length > 0 ? (
            <Alert tone="warning" title="We need these before we can charge you" live>
              {`Indian tax rules require ${demandedFields.join(', ')} on the invoice for a purchase of this size. Nothing has been charged yet.`}
            </Alert>
          ) : null}

          <Field
            label="Legal name"
            required
            error={errors.legal_name}
            hint="The business or person the invoice is made out to."
          >
            <Input
              value={form.legal_name}
              onChange={(event) => setForm({ ...form, legal_name: event.target.value })}
              autoComplete="organization"
            />
          </Field>

          <Field label="Billing country" error={errors.billing_country}>
            <Combobox
              label="Billing country"
              options={COUNTRY_OPTIONS}
              value={form.billing_country || null}
              onValueChange={(next) => setForm({ ...form, billing_country: next ?? '' })}
            />
          </Field>

          {!foreign ? (
            <Field
              label="GSTIN"
              error={errors.gstin}
              hint="Optional. With a GSTIN we issue a B2B tax invoice and derive your place of supply from it."
            >
              <Input
                value={form.gstin}
                onChange={(event) => setForm({ ...form, gstin: normalizeGstin(event.target.value) })}
                className="figure"
                maxLength={15}
              />
            </Field>
          ) : null}

          {!foreign && !form.gstin ? (
            <Field
              label="State"
              error={errors.billing_state_code}
              hint="Decides whether GST is charged as CGST + SGST or as IGST."
            >
              <Combobox
                label="State"
                options={GST_STATE_OPTIONS}
                value={form.billing_state_code || null}
                onValueChange={(next) => setForm({ ...form, billing_state_code: next ?? '' })}
              />
            </Field>
          ) : null}

          <Field label="Billing email" error={errors.billing_email} hint="Where invoices are sent.">
            <Input
              type="email"
              value={form.billing_email}
              onChange={(event) => setForm({ ...form, billing_email: event.target.value })}
              autoComplete="email"
            />
          </Field>

          <Field label="Address line 1">
            <Input
              value={form.line1}
              onChange={(event) => setForm({ ...form, line1: event.target.value })}
              autoComplete="address-line1"
            />
          </Field>
          <Field label="Address line 2">
            <Input
              value={form.line2}
              onChange={(event) => setForm({ ...form, line2: event.target.value })}
              autoComplete="address-line2"
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="City">
              <Input
                value={form.city}
                onChange={(event) => setForm({ ...form, city: event.target.value })}
                autoComplete="address-level2"
              />
            </Field>
            <Field label="Postal code">
              <Input
                value={form.postal_code}
                className="figure"
                onChange={(event) => {
                  const postal_code = event.target.value;
                  // An Indian PIN identifies the state closely enough to fill
                  // the field for the customer. Only ever a prefill: the
                  // control stays editable and the server still validates.
                  const derived =
                    !foreign && !form.gstin && !form.billing_state_code
                      ? gstStateFromPin(postal_code)
                      : null;
                  setForm({
                    ...form,
                    postal_code,
                    billing_state_code: derived ?? form.billing_state_code,
                  });
                }}
                autoComplete="postal-code"
              />
            </Field>
          </div>

          {save.isError ? (
            <Alert tone="danger" live>
              {save.error instanceof Error
                ? save.error.message
                : 'We could not save your billing details.'}
            </Alert>
          ) : null}
        </div>
      </Dialog>
    </Card>
  );
}
