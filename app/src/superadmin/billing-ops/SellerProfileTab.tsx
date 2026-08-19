import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardFooter,
  Field,
  Input,
  LoadingRows,
  LockedState,
  Section,
  Stack,
  Switch,
  Textarea,
  toast,
} from '../../ui';
import { platform } from '../client';
import { usePlatformResource } from '../usePlatform';
import {
  MAX_TAX_RATE_BPS,
  ratePercent,
  toDraft,
  toPatch,
  validateSellerDraft,
  type SellerDraft,
} from './sellerProfile';
import type { SellerProfile } from './types';

/**
 * The seller of record.
 *
 * The single most consequential form in the console, and the least obviously
 * so: this identity is snapshotted onto every invoice at the moment it is
 * numbered, and numbering is *blocked entirely* until the profile has been
 * saved once. A platform charging customers with this unsaved produces captured
 * payments and no tax documents — which is exactly the `unnumbered_charges`
 * anomaly on the Reconciliation tab.
 *
 * So the screen leads with whether it is configured at all, and the two fields
 * the server derives rather than accepts are shown as derived rather than as
 * editable controls that silently do nothing.
 */
export function SellerProfileTab() {
  const profile = usePlatformResource<SellerProfile>('/billing/seller-profile');
  const [draft, setDraft] = useState<SellerDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (profile.data) setDraft(toDraft(profile.data));
  }, [profile.data]);

  const errors = useMemo(() => (draft ? validateSellerDraft(draft) : {}), [draft]);
  const invalid = Object.keys(errors).length > 0;

  function set<K extends keyof SellerDraft>(key: K, value: SellerDraft[K]): void {
    setDraft((current) => (current ? { ...current, [key]: value } : current));
    setSaved(false);
  }

  async function save(): Promise<void> {
    if (!draft || invalid) return;
    setSaving(true);
    setError(null);
    try {
      await platform.put<SellerProfile>('/billing/seller-profile', toPatch(draft));
      toast.success('Seller profile saved.');
      setSaved(true);
      profile.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The seller profile could not be saved.');
    } finally {
      setSaving(false);
    }
  }

  if (profile.forbidden) {
    return (
      <LockedState
        title="You cannot read the seller profile"
        description="Your super-admin account is not permitted to read the seller-of-record identity. Nothing was loaded."
      />
    );
  }

  if (profile.error && !profile.data) {
    return (
      <Alert
        tone="danger"
        live
        title="The seller profile could not be loaded"
        action={
          <Button size="sm" variant="secondary" onClick={profile.reload}>
            Try again
          </Button>
        }
      >
        {profile.error}
      </Alert>
    );
  }

  if (!draft || !profile.data) {
    return (
      <Card>
        <CardBody>
          <LoadingRows rows={6} />
        </CardBody>
      </Card>
    );
  }

  const stored = profile.data;
  const gstinSet = draft.gstin.trim().length > 0;

  return (
    <Stack>
      {!stored.configured ? (
        <Alert tone="danger" title="No seller profile has ever been saved">
          Invoice numbering is blocked until this is saved once. Until then every payment the
          platform captures becomes a legacy row with no invoice number, and the customer holds no
          tax document at all.
        </Alert>
      ) : null}

      {saved ? (
        <Alert tone="success" live title="Saved">
          Documents numbered from now on carry this identity. Documents already issued keep the
          snapshot they were made with — editing this never rewrites them.
        </Alert>
      ) : null}

      {error ? (
        <Alert tone="danger" live title="The seller profile was refused">
          {error}
        </Alert>
      ) : null}

      <Section title="Status">
        <Card>
          <CardBody className="flex flex-wrap items-center gap-3">
            <Badge tone={stored.configured ? 'success' : 'danger'} dot>
              {stored.configured ? 'Configured' : 'Never saved'}
            </Badge>
            <Badge tone={stored.gst_enabled ? 'success' : 'neutral'} dot>
              {stored.gst_enabled ? 'GST tax invoices' : 'Plain receipts — no GSTIN stored'}
            </Badge>
            <Badge tone={stored.lut_active ? 'plan' : 'neutral'}>
              {stored.lut_active ? `LUT active · ${stored.lut_number ?? 'no number'}` : 'No LUT'}
            </Badge>
            <p className="w-full text-xs text-text-secondary">
              Both of the first two are derived by the server, not set here: a stored GSTIN is what
              turns receipts into tax invoices.
            </p>
          </CardBody>
        </Card>
      </Section>

      <Section title="Legal identity" description="Printed on every document this platform issues.">
        <Card>
          <CardBody className="grid max-w-3xl gap-5 sm:grid-cols-2">
            <Field
              label="Registered legal name"
              required
              error={errors.legal_name}
              hint="Exactly as registered. This is the name on the invoice."
              className="sm:col-span-2"
            >
              <Input value={draft.legal_name} onChange={(event) => set('legal_name', event.target.value)} />
            </Field>
            <Field label="Trading name" hint="The name customers know, if it differs.">
              <Input value={draft.trade_name} onChange={(event) => set('trade_name', event.target.value)} />
            </Field>
            <Field
              label="CIN"
              error={errors.cin}
              hint="Companies Act s.12(3)(c). Blank if the seller is not a company."
            >
              <Input
                value={draft.cin}
                onChange={(event) => set('cin', event.target.value.toUpperCase())}
                autoComplete="off"
              />
            </Field>
            <Field
              label="Registered address"
              hint="One line per line. Blank lines are dropped."
              className="sm:col-span-2"
            >
              <Textarea
                rows={4}
                value={draft.address_lines}
                onChange={(event) => set('address_lines', event.target.value)}
              />
            </Field>
            <Field label="Country" error={errors.country} hint="Two-letter ISO code.">
              <Input
                value={draft.country}
                maxLength={2}
                onChange={(event) => set('country', event.target.value.toUpperCase())}
              />
            </Field>
            <Field
              label="GST state code"
              disabled={gstinSet}
              hint={
                gstinSet
                  ? 'Derived from the first two digits of the GSTIN. The server ignores anything sent here while a GSTIN is stored.'
                  : 'Two digits. Used to decide whether a supply is intra- or inter-state.'
              }
            >
              <Input
                value={gstinSet ? draft.gstin.slice(0, 2) : draft.state_code}
                disabled={gstinSet}
                maxLength={2}
                onChange={(event) => set('state_code', event.target.value)}
              />
            </Field>
          </CardBody>
        </Card>
      </Section>

      <Section title="Tax" description="What the platform charges, and under which registration.">
        <Card>
          <CardBody className="grid max-w-3xl gap-5 sm:grid-cols-2">
            <Field
              label="GSTIN"
              hint="Format and checksum are validated by the server. Clearing it turns every future document into a plain receipt."
              className="sm:col-span-2"
            >
              <Input
                value={draft.gstin}
                onChange={(event) => set('gstin', event.target.value.toUpperCase())}
                autoComplete="off"
              />
            </Field>
            <Field label="SAC / HSN" error={errors.sac_code} hint="Four to eight digits.">
              <Input value={draft.sac_code} onChange={(event) => set('sac_code', event.target.value)} />
            </Field>
            <Field
              label="Tax rate (basis points)"
              error={errors.tax_rate_bps}
              hint={`Currently ${ratePercent(draft.tax_rate_bps)}. Whole basis points, 0 to ${MAX_TAX_RATE_BPS}.`}
            >
              <Input
                type="number"
                min={0}
                max={MAX_TAX_RATE_BPS}
                inputMode="numeric"
                value={draft.tax_rate_bps}
                onChange={(event) => set('tax_rate_bps', event.target.value)}
              />
            </Field>
            <Field
              label="Invoice prefix"
              error={errors.invoice_prefix}
              hint="One to three characters. RCT and CN are reserved for the receipt and credit-note series."
            >
              <Input
                value={draft.invoice_prefix}
                maxLength={3}
                onChange={(event) => set('invoice_prefix', event.target.value.toUpperCase())}
              />
            </Field>
            <div className="sm:col-span-2">
              <Switch
                checked={draft.lut_active}
                onCheckedChange={(next) => set('lut_active', next)}
                label="LUT active"
                description="Exports are zero-rated under a Letter of Undertaking. The number is required while this is on."
              />
            </div>
            <Field
              label="LUT number"
              error={errors.lut_number}
              disabled={!draft.lut_active}
              hint="The ARN of the accepted LUT."
            >
              <Input
                value={draft.lut_number}
                disabled={!draft.lut_active}
                onChange={(event) => set('lut_number', event.target.value)}
              />
            </Field>
            <div className="sm:col-span-2">
              <Alert tone="neutral" title="Prices are tax-inclusive, and cannot be otherwise">
                Checkout collects the sticker price, so exclusive pricing would invoice more tax than
                was ever collected. The server rejects the change outright, which is why there is no
                control for it here.
              </Alert>
            </div>
          </CardBody>
        </Card>
      </Section>

      <Section title="Contact" description="The billing contact printed on the document.">
        <Card>
          <CardBody className="grid max-w-3xl gap-5 sm:grid-cols-2">
            <Field label="Support email" error={errors.support_email} hint="Falls back to the platform support address when blank.">
              <Input
                type="email"
                value={draft.support_email}
                onChange={(event) => set('support_email', event.target.value)}
              />
            </Field>
            <Field label="Phone">
              <Input value={draft.phone} onChange={(event) => set('phone', event.target.value)} />
            </Field>
            <Field label="Website" error={errors.website} hint="Must include http:// or https://.">
              <Input value={draft.website} onChange={(event) => set('website', event.target.value)} />
            </Field>
            <Field label="Logo URL" hint="Printed at the top of the document. Blank for no logo.">
              <Input value={draft.logo_url} onChange={(event) => set('logo_url', event.target.value)} />
            </Field>
          </CardBody>
          <CardFooter>
            <Button
              variant="ghost"
              disabled={saving}
              onClick={() => {
                setDraft(toDraft(stored));
                setError(null);
                setSaved(false);
              }}
            >
              Discard changes
            </Button>
            <Button variant="primary" loading={saving} disabled={invalid} onClick={() => void save()}>
              Save seller profile
            </Button>
          </CardFooter>
        </Card>
        {invalid ? (
          <p className="mt-2 text-xs text-danger">
            Fix the highlighted fields before saving. Nothing is sent until they are valid.
          </p>
        ) : null}
      </Section>
    </Stack>
  );
}
