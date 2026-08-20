import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  Field,
  Grid,
  Input,
  LoadingRows,
  LockedState,
  SaveBar,
  Section,
  Stack,
  Switch,
  Textarea,
  toast,
} from '../../ui';
import { platform } from '../client';
import { FORBIDDEN_TITLE, forbiddenDescription } from '../forbidden';
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
/** Field labels, so the save bar can name what is blocking it. */
const FIELD_LABELS: Record<string, string> = {
  legal_name: 'Registered legal name',
  cin: 'CIN',
  country: 'Country',
  sac_code: 'SAC / HSN',
  tax_rate_bps: 'Tax rate',
  invoice_prefix: 'Invoice prefix',
  lut_number: 'LUT number',
  support_email: 'Support email',
  website: 'Website',
};

function sameDraft(a: SellerDraft, b: SellerDraft): boolean {
  return (Object.keys(a) as (keyof SellerDraft)[]).every((key) => a[key] === b[key]);
}

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
  // Named, never "fix the highlighted fields": this form is fourteen fields over
  // three cards, and the reader would have to hunt all three to find the one.
  const blockingKey = (Object.keys(errors) as (keyof SellerDraft)[])[0];
  const blockedReason = blockingKey
    ? `${FIELD_LABELS[blockingKey] ?? blockingKey} — ${errors[blockingKey]}`
    : null;
  const dirty = Boolean(draft && profile.data && !sameDraft(draft, toDraft(profile.data)));

  function set<K extends keyof SellerDraft>(key: K, value: SellerDraft[K]): void {
    setDraft((current) => (current ? { ...current, [key]: value } : current));
    setSaved(false);
  }

  async function save(): Promise<void> {
    if (!draft || invalid) return;
    setSaving(true);
    setError(null);
    try {
      // The draft is reset from what the server stored rather than from what was
      // typed: the server derives the state code and normalises the identity, so
      // a form still showing the typed value is showing something that is not
      // what any future invoice will carry.
      const stored = await platform.put<SellerProfile>('/billing/seller-profile', toPatch(draft));
      setDraft(toDraft(stored));
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
        title={FORBIDDEN_TITLE}
        description={forbiddenDescription('the seller-of-record identity')}
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

      <Section title="Status" description="The first two are derived by the server: a stored GSTIN is what turns receipts into tax invoices.">
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
          </CardBody>
        </Card>
      </Section>

      <Section
        title="Legal identity"
        description="Printed on documents numbered from now on. Documents already issued keep their own snapshot — editing this never rewrites them."
      >
        <Card>
          <CardBody>
            <Grid cols={2}>
            <Field
              label="Registered legal name"
              required
              error={errors.legal_name}
              hint="Exactly as registered."
              className="sm:col-span-2"
            >
              <Input value={draft.legal_name} onChange={(event) => set('legal_name', event.target.value)} />
            </Field>
            <Field label="Trading name" hint="If it differs from the legal name.">
              <Input value={draft.trade_name} onChange={(event) => set('trade_name', event.target.value)} />
            </Field>
            <Field
              label="CIN"
              error={errors.cin}
              hint="Blank if the seller is not a company."
            >
              <Input
                value={draft.cin}
                onChange={(event) => set('cin', event.target.value.toUpperCase())}
                autoComplete="off"
              />
            </Field>
            <Field
              label="Registered address"
              hint="One line per line."
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
                  ? 'Derived from the GSTIN while one is stored.'
                  : 'Two digits. Decides intra- or inter-state supply.'
              }
            >
              <Input
                value={gstinSet ? draft.gstin.slice(0, 2) : draft.state_code}
                disabled={gstinSet}
                maxLength={2}
                onChange={(event) => set('state_code', event.target.value)}
              />
            </Field>
            </Grid>
          </CardBody>
        </Card>
      </Section>

      <Section
        title="Tax"
        description="Prices are tax-inclusive and cannot be otherwise: checkout collects the sticker price, so the server refuses the alternative."
      >
        <Card>
          <CardBody>
            <Grid cols={2}>
            <Field
              label="GSTIN"
              hint="Clearing it turns every future document into a plain receipt."
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
              hint="One to three characters. RCT and CN are reserved."
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
                description="Exports are zero-rated. The number is required while this is on."
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
            </Grid>
          </CardBody>
        </Card>
      </Section>

      <Section title="Contact" description="The billing contact printed on the document.">
        <Card>
          <CardBody>
            <Grid cols={2}>
            <Field label="Support email" error={errors.support_email} hint="Falls back to platform support.">
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
            <Field label="Logo URL" hint="Blank for no logo.">
              <Input value={draft.logo_url} onChange={(event) => set('logo_url', event.target.value)} />
            </Field>
            </Grid>
          </CardBody>
        </Card>
      </Section>

      {/* Outside all three cards, because the fields are spread across all three:
          anchoring the control to the last one meant editing the legal name in
          the first card and then scrolling past fourteen fields to save it. */}
      <SaveBar
        dirty={dirty}
        saving={saving}
        saved={saved}
        saveError={error}
        blockedReason={blockedReason}
        summary="the seller of record"
        saveLabel="Save seller profile"
        onSave={() => void save()}
        onDiscard={() => {
          setDraft(toDraft(stored));
          setError(null);
          setSaved(false);
        }}
        guard="the seller profile"
      />
    </Stack>
  );
}
