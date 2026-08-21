import { useMemo, useState } from 'react';
import {
  Alert,
  ConfirmDialog,
  Drawer,
  Field,
  Grid,
  Input,
  Measure,
  PropertyGrid,
  SaveBar,
  Section,
  Select,
  SettingGroup,
  SettingRow,
  Switch,
  Textarea,
  Well,
  formatNumber,
  toast,
} from '../../ui';
import { platform } from '../client';
import type { Plan, PlanWriteResult } from './types';
import {
  FEATURE_FIELDS,
  INTEGRATION_OPTIONS,
  LIMIT_FIELDS,
  PRICING_MODEL_OPTIONS,
  annualSavingPercent,
  canonicalSeatPrices,
  describePlanChanges,
  draftFromPlan,
  formatInr,
  formatSeats,
  formatUsd,
  parseIntegerField,
  planCreatePayload,
  planUpdatePayload,
  planWarnings,
  unknownKeys,
  validatePlanDraft,
  type LimitDraft,
  type PlanDraft,
} from './plan-model';

/**
 * The plan editor.
 *
 * Everything here follows from one fact: a plan row is not a record, it is the
 * permission set of everyone on it. `plan_entitlements_service` resolves a
 * customer's limits and features straight out of these two JSONB columns, with
 * a sixty-second cache, so a save takes effect on live accounts inside a minute
 * and there is no draft, no review and no rollback.
 *
 * The form is therefore built to make the blast radius visible rather than to be
 * quick to fill in:
 *
 * * Fields are grouped by **what they do**, not by column order — entitlements
 *   (what customers may do), commercials (what they pay), and the gateway
 *   identifiers (which are read-only here, because Razorpay mints them).
 * * Unlimited is a switch, never `-1` in a number box.
 * * The derived annual saving is shown beside the prices and never sent.
 * * Saving asks for confirmation with the change list and the number of
 *   subscriptions currently sitting on the plan.
 */

/**
 * A validation key's human name, for the save bar's blocking reason.
 *
 * The keys are either a plain draft field or `limits.<key>`, and the limit
 * labels already exist on `LIMIT_FIELDS` — so the only thing to write here is
 * the sentence-casing of the rest.
 */
function fieldLabel(key: string): string {
  if (key === 'seats') return 'Included operator seats';
  const limit = key.startsWith('limits.')
    ? LIMIT_FIELDS.find((field) => field.key === key.slice('limits.'.length))
    : undefined;
  if (limit) return limit.label;
  const words = key.replace(/_cents$/, '').replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

interface PlanEditorProps {
  open: boolean;
  /** `null` opens the create form. */
  plan: Plan | null;
  /** The whole catalogue: slug uniqueness, and the canonical seat price. */
  plans: readonly Plan[];
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}

function LimitControl({
  label,
  hint,
  error,
  draft,
  allowsUnlimited,
  onChange,
}: {
  label: string;
  hint: string;
  error?: string;
  draft: LimitDraft;
  allowsUnlimited: boolean;
  onChange: (next: LimitDraft) => void;
}) {
  return (
    <Well>
      {/* The switch sits outside the Field on purpose: every control inside one
          is handed the same id, so a second one would duplicate it and the
          label would name whichever rendered last. */}
      <Field
        label={label}
        hint={
          draft.absent ? (
            <>
              <span className="text-warning">Not set on this plan — entitlements resolve it to 0.</span>{' '}
              {hint}
            </>
          ) : (
            hint
          )
        }
        error={error}
      >
        <Input
          size="sm"
          inputMode="numeric"
          autoComplete="off"
          className="figure"
          value={draft.unlimited ? '' : draft.value}
          disabled={draft.unlimited}
          placeholder={draft.unlimited ? 'Unlimited' : draft.absent ? 'Not set' : '0'}
          // Any edit ends the absent state: from here the key is one this save
          // will write, which is exactly what the operator just asked for.
          onChange={(event) => onChange({ ...draft, value: event.target.value, absent: false })}
        />
      </Field>
      {allowsUnlimited ? (
        <div className="mt-2.5">
          <Switch
            size="sm"
            label={`Unlimited — ${label.toLowerCase()}`}
            checked={draft.unlimited}
            onCheckedChange={(checked) => onChange({ ...draft, unlimited: checked, absent: false })}
          />
        </div>
      ) : null}
    </Well>
  );
}

function MoneyField({
  label,
  hint,
  error,
  value,
  onChange,
  currency,
}: {
  label: string;
  hint: string;
  error?: string;
  value: string;
  onChange: (next: string) => void;
  currency: 'INR' | 'USD';
}) {
  const parsed = parseIntegerField(value);
  return (
    <Field
      label={label}
      hint={
        <>
          {hint}{' '}
          <span className="figure">
            {parsed == null ? '' : currency === 'INR' ? formatInr(parsed) : formatUsd(parsed)}
          </span>
        </>
      }
      error={error}
    >
      <Input
        inputMode="numeric"
        autoComplete="off"
        className="figure"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </Field>
  );
}

export function PlanEditor({ open, plan, plans, onOpenChange, onSaved }: PlanEditorProps) {
  const isCreate = plan === null;
  // Keyed off the plan id so reopening the drawer on another row starts from
  // that row rather than from the previous edit.
  const [draft, setDraft] = useState<PlanDraft>(() => draftFromPlan(plan));
  const [editingId, setEditingId] = useState<number | null>(plan?.id ?? null);
  const [showErrors, setShowErrors] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [resultWarnings, setResultWarnings] = useState<string[]>([]);

  if (open && editingId !== (plan?.id ?? null)) {
    setEditingId(plan?.id ?? null);
    setDraft(draftFromPlan(plan));
    setShowErrors(false);
    setSaveError(null);
    setResultWarnings([]);
  }

  const takenSlugs = useMemo(() => plans.map((entry) => entry.slug), [plans]);
  const errors = useMemo(
    () => validatePlanDraft(draft, { isCreate, takenSlugs }),
    [draft, isCreate, takenSlugs],
  );
  const errorCount = Object.keys(errors).length;
  const shown = showErrors ? errors : {};

  const payload = useMemo(
    () => (plan ? planUpdatePayload(draft, plan) : planCreatePayload(draft)),
    [draft, plan],
  );
  const changes = useMemo(() => (plan ? describePlanChanges(payload, plan) : []), [payload, plan]);
  const warnings = useMemo(() => planWarnings(draft, plan), [draft, plan]);

  // A new plan is always pending; an existing one is pending only where the
  // payload differs. `changes` is what the confirm dialog lists, so the bar and
  // the dialog cannot disagree about what is about to happen.
  const dirty = isCreate || Object.keys(payload).length > 0;
  const changeSummary = isCreate
    ? 'a new plan'
    : changes.map((change) => change.label).join(', ');
  const blockingKey = Object.keys(errors)[0];
  const blockedReason =
    showErrors && blockingKey ? `${fieldLabel(blockingKey)} — ${errors[blockingKey]}` : null;

  const saving = annualSavingPercent(
    parseIntegerField(draft.monthly_price_cents),
    parseIntegerField(draft.annual_price_cents),
  );

  const seatPrices = useMemo(() => canonicalSeatPrices(plans), [plans]);

  const extraLimitKeys = unknownKeys(plan?.limits, LIMIT_FIELDS.map((field) => field.key));
  const extraFeatureKeys = unknownKeys(plan?.features, [
    ...FEATURE_FIELDS.map((field) => field.key),
    'integrations',
  ]);

  function update(patch: Partial<PlanDraft>): void {
    setDraft((current) => ({ ...current, ...patch }));
  }

  function attemptSave(): void {
    setSaveError(null);
    if (errorCount > 0) {
      setShowErrors(true);
      return;
    }
    if (plan && Object.keys(payload).length === 0) {
      toast('Nothing to save — this plan already looks like that.');
      return;
    }
    setConfirmOpen(true);
  }

  async function commit(): Promise<void> {
    try {
      const result = plan
        ? await platform.put<PlanWriteResult>(`/plans/${plan.id}`, payload)
        : await platform.post<PlanWriteResult>('/plans', payload);
      setConfirmOpen(false);
      const advisories = result?.warnings ?? [];
      setResultWarnings(advisories);
      toast.success(result?.message ?? (plan ? 'Plan updated.' : 'Plan created.'));
      onSaved();
      // A clean save closes; one that came back with advisories stays open so
      // they are read where the fields that caused them are still on screen.
      if (advisories.length === 0) onOpenChange(false);
    } catch (error) {
      setConfirmOpen(false);
      setSaveError(error instanceof Error ? error.message : 'The plan could not be saved.');
    }
  }

  const affected = plan?.active_subscriptions ?? 0;

  return (
    <>
      <Drawer
        open={open}
        onOpenChange={onOpenChange}
        width="xl"
        title={isCreate ? 'New plan' : `Edit ${plan.name}`}
        description={
          isCreate
            ? 'A new plan is live as soon as it is listed. Nothing here is a draft.'
            : `Entitlements resolve from this row with a 60-second cache, so a save reaches ${formatNumber(affected)} live subscription${affected === 1 ? '' : 's'} within a minute.`
        }
      >
        {/* `Measure` re-declares `@container/page`, so every `Grid` below asks how
            wide the *drawer* is. Without it they query the page behind the
            overlay and a three-up grid renders three 230px columns in a 728px
            panel — which is what `lg:grid-cols-3` was doing here.

            Which then produced the opposite fault, and a worse one: the card
            ramp's first step is 48rem and the drawer's body is ~44, so *every*
            grid here collapsed and the editor rendered thirty full-width fields
            one per row — 4,710px of scroll inside an 787px panel. `pairs` is the
            step written for this exact box: two short fields on one line from
            24rem of container. */}
        <Measure width="full" className="flex flex-col gap-6">
          {resultWarnings.length > 0 ? (
            <Alert tone="warning" live title="Saved, with warnings">
              <ul className="list-disc space-y-1 pl-4">
                {resultWarnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </Alert>
          ) : null}

          {warnings.length > 0 ? (
            <Alert tone="warning" title="Worth knowing before you save">
              <ul className="list-disc space-y-1 pl-4">
                {warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </Alert>
          ) : null}

          <Section title="Identity" description="How the plan is named, ordered and listed.">
            <Grid cols="pairs">
              <Field label="Name" required error={shown.name} hint="Shown on the pricing page and the invoice.">
                <Input value={draft.name} onChange={(event) => update({ name: event.target.value })} />
              </Field>
              <Field
                label="Slug"
                required={isCreate}
                error={shown.slug}
                hint={
                  isCreate
                    ? 'Lowercase. Entitlements resolve against it.'
                    : 'Fixed after creation.'
                }
              >
                <Input
                  value={draft.slug}
                  disabled={!isCreate}
                  className="figure"
                  onChange={(event) => update({ slug: event.target.value })}
                />
              </Field>
              <Field label="Description" className="@sm/page:col-span-2" hint="One line, under the plan name.">
                <Textarea
                  rows={2}
                  value={draft.description}
                  onChange={(event) => update({ description: event.target.value })}
                />
              </Field>
              <Field label="Pricing model" hint="How the tier is meant to scale.">
                <Select
                  label="Pricing model"
                  options={PRICING_MODEL_OPTIONS}
                  value={draft.pricing_model}
                  onValueChange={(value) => update({ pricing_model: value })}
                />
              </Field>
              <Field label="Sort order" error={shown.sort_order} hint="Ascending. Controls the order on the pricing page.">
                <Input
                  inputMode="numeric"
                  className="figure"
                  value={draft.sort_order}
                  onChange={(event) => update({ sort_order: event.target.value })}
                />
              </Field>
            </Grid>
            <SettingGroup className="mt-4">
              <SettingRow label="Listed" description="On the public pricing page, and selectable at checkout.">
                <Switch
                  label="Listed"
                  hideLabel
                  checked={draft.is_active}
                  onCheckedChange={(checked) => update({ is_active: checked })}
                />
              </SettingRow>
              <SettingRow
                label="Default plan"
                description="Every new account lands here. Exactly one plan holds it."
                error={shown.is_default}
              >
                <Switch
                  label="Default plan"
                  hideLabel
                  checked={draft.is_default}
                  onCheckedChange={(checked) => update({ is_default: checked })}
                />
              </SettingRow>
            </SettingGroup>
          </Section>

          <Section
            title="Entitlements — limits"
            description="Numeric caps. plan_entitlements_service reads these directly; an unknown key resolves to zero, which is why a limit is never simply deleted."
          >
            <Grid cols="pairs" align="start">
              {LIMIT_FIELDS.map((field) => (
                <LimitControl
                  key={field.key}
                  label={field.label}
                  hint={field.description}
                  error={shown[`limits.${field.key}`]}
                  allowsUnlimited={field.allowsUnlimited}
                  draft={draft.limits[field.key]}
                  onChange={(next) => update({ limits: { ...draft.limits, [field.key]: next } })}
                />
              ))}
            </Grid>
            {extraLimitKeys.length > 0 ? (
              <Section
                className="mt-4"
                title="Other limit keys on this plan"
                description="Not modelled here. A save merges key by key, so they are left as they are."
              >
                <PropertyGrid
                  columns={2}
                  density="compact"
                  items={extraLimitKeys.map((entry) => ({
                    label: entry.key,
                    value: <span className="figure">{JSON.stringify(entry.value)}</span>,
                  }))}
                />
              </Section>
            ) : null}
          </Section>

          <Section
            title="Entitlements — features"
            description="Boolean gates. has_feature defaults an unknown feature to false, so turning one off locks the surface immediately for everyone on this plan."
          >
            <SettingGroup>
              {FEATURE_FIELDS.map((field) => (
                <SettingRow key={field.key} label={field.label} description={field.description}>
                  <Switch
                    label={field.label}
                    hideLabel
                    checked={draft.features[field.key]}
                    onCheckedChange={(checked) =>
                      update({ features: { ...draft.features, [field.key]: checked } })
                    }
                  />
                </SettingRow>
              ))}
            </SettingGroup>
            <div className="mt-3">
              <Field
                label="Integrations"
                hint="A string feature rather than a boolean; the integration surfaces branch on its value."
              >
                <Select
                  label="Integrations"
                  options={INTEGRATION_OPTIONS}
                  value={draft.integrations}
                  onValueChange={(value) => update({ integrations: value })}
                />
              </Field>
            </div>
            {extraFeatureKeys.length > 0 ? (
              <Section className="mt-4" title="Other feature keys on this plan">
                <PropertyGrid
                  columns={2}
                  density="compact"
                  items={extraFeatureKeys.map((entry) => ({
                    label: entry.key,
                    value: <span className="figure">{JSON.stringify(entry.value)}</span>,
                  }))}
                />
              </Section>
            ) : null}
          </Section>

          <Section
            title="Commercials"
            description="Plans are INR-primary: the *_cents columns are paise and are what Razorpay debits. The USD columns are the international rail."
          >
            <Grid cols="pairs" align="start">
              <MoneyField
                label="Monthly price (INR paise)"
                hint="Charged monthly."
                currency="INR"
                error={shown.monthly_price_cents}
                value={draft.monthly_price_cents}
                onChange={(value) => update({ monthly_price_cents: value })}
              />
              <MoneyField
                label="Annual price (INR paise)"
                hint="Charged once a year."
                currency="INR"
                error={shown.annual_price_cents}
                value={draft.annual_price_cents}
                onChange={(value) => update({ annual_price_cents: value })}
              />
              <MoneyField
                label="Monthly price (US cents)"
                hint="Blank leaves the international rail unpriced."
                currency="USD"
                error={shown.monthly_price_usd_cents}
                value={draft.monthly_price_usd_cents}
                onChange={(value) => update({ monthly_price_usd_cents: value })}
              />
              <MoneyField
                label="Annual price (US cents)"
                hint="Blank leaves the international rail unpriced."
                currency="USD"
                error={shown.annual_price_usd_cents}
                value={draft.annual_price_usd_cents}
                onChange={(value) => update({ annual_price_usd_cents: value })}
              />
              <Field
                label="Trial days"
                error={shown.trial_days}
                hint="Zero means no trial on this tier."
              >
                <Input
                  inputMode="numeric"
                  className="figure"
                  value={draft.trial_days}
                  onChange={(event) => update({ trial_days: event.target.value })}
                />
              </Field>
              <Field
                label="Credits per month"
                error={shown.credits_per_month}
                hint="Keep it equal to the credits limit above."
              >
                <Input
                  inputMode="numeric"
                  className="figure"
                  value={draft.credits_per_month}
                  onChange={(event) => update({ credits_per_month: event.target.value })}
                />
              </Field>
              <Field
                label="Overage rate (paise)"
                error={shown.overage_rate_cents}
                hint="Charged per unit beyond the allowance."
              >
                <Input
                  inputMode="numeric"
                  className="figure"
                  value={draft.overage_rate_cents}
                  onChange={(event) => update({ overage_rate_cents: event.target.value })}
                />
              </Field>
              <LimitControl
                label="Included operator seats"
                hint="Unlimited is the only meaningful non-positive value; zero is rejected."
                error={shown.seats}
                allowsUnlimited
                draft={draft.seats}
                onChange={(next) => update({ seats: next })}
              />
            </Grid>

            {/* Derived, never written. The reasons each one is read-only ride as
                tooltips rather than as a paragraph under every row. */}
            <PropertyGrid
              className="mt-4"
              label="Derived commercials"
              items={[
                {
                  label: 'Annual saving',
                  note: 'Derived from the two INR prices. Sending a different figure is refused with a 422.',
                  value: (
                    <span className="figure">
                      {saving > 0 ? `${saving}%` : 'No annual saving'}
                    </span>
                  ),
                },
                {
                  label: 'Extra seat price',
                  note: 'Fixed by the Razorpay seat add-on in the environment; the API accepts only that amount or zero.',
                  value: (
                    <span className="figure">
                      {plan
                        ? `${formatInr(plan.extra_seat_price_cents)} · ${formatUsd(plan.extra_seat_price_usd_cents)}`
                        : seatPrices.inr == null
                          ? 'Set by the API on create'
                          : `${formatInr(seatPrices.inr)} · ${formatUsd(seatPrices.usd)}`}
                    </span>
                  ),
                },
                {
                  label: 'Currency',
                  note: 'Plans are INR-primary. A non-INR value is refused with a 422.',
                  value: <span className="figure">INR</span>,
                },
              ]}
            />
          </Section>

          <Section
            title="Gateway"
            description="Razorpay plans are immutable, so these are minted by the API when a price changes and cannot be typed in here."
          >
            <PropertyGrid
              label="Gateway identifiers"
              items={[
                {
                  label: 'Monthly plan id (INR)',
                  value: <span className="figure">{plan?.razorpay_plan_id_monthly ?? 'Not wired'}</span>,
                },
                {
                  label: 'Annual plan id (INR)',
                  value: <span className="figure">{plan?.razorpay_plan_id_annual ?? 'Not wired'}</span>,
                },
                {
                  label: 'USD plan ids',
                  note: 'GET /superadmin/plans does not return them, so this console cannot show them.',
                  value: <span className="figure">Not served</span>,
                },
              ]}
            />
          </Section>

          <Section title="Marketing" description="Copy rendered on the public pricing card.">
            <Grid cols="pairs">
              <Field label="Tagline" hint="One sentence under the plan name.">
                <Input value={draft.tagline} onChange={(event) => update({ tagline: event.target.value })} />
              </Field>
              <Field label="Badge" hint='A ribbon, e.g. "Most Popular". Blank removes it.'>
                <Input value={draft.badge} onChange={(event) => update({ badge: event.target.value })} />
              </Field>
            </Grid>
          </Section>

          <SaveBar
            dirty={dirty}
            saveError={saveError}
            blockedReason={blockedReason}
            summary={changeSummary}
            saveLabel={isCreate ? 'Create plan' : 'Review and save'}
            onSave={attemptSave}
            onDiscard={() => {
              setDraft(draftFromPlan(plan));
              setShowErrors(false);
              setSaveError(null);
            }}
            guard={isCreate ? 'this new plan' : 'this plan'}
          />
        </Measure>
      </Drawer>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={isCreate ? 'Publish this plan?' : `Apply ${changes.length} change${changes.length === 1 ? '' : 's'}?`}
        confirmLabel={isCreate ? 'Create plan' : 'Save plan'}
        onConfirm={commit}
        description={
          <div className="space-y-3">
            <p>
              {isCreate ? (
                draft.is_active ? (
                  <>
                    This plan is listed, so it appears on the pricing page as soon as it is created.
                  </>
                ) : (
                  <>This plan is created delisted, so nobody can reach it until you list it.</>
                )
              ) : (
                <>
                  <span className="figure font-medium">{formatNumber(affected)}</span> active, trialing or
                  past-due subscription{affected === 1 ? '' : 's'} resolve their entitlements from this row.
                  The change reaches them within about a minute.
                </>
              )}
            </p>
            {changes.length > 0 ? (
              <div className="max-h-56 overflow-y-auto">
                <PropertyGrid
                  label="What changes"
                  density="compact"
                  items={changes.map((change) => ({
                    label: change.label,
                    value: (
                      <span className="figure">
                        <span className="text-text-tertiary">{change.before}</span>
                        {' → '}
                        <span className="font-medium">{change.after}</span>
                      </span>
                    ),
                  }))}
                />
              </div>
            ) : null}
            {isCreate ? (
              <p className="text-xs">
                Seats: {formatSeats(draft.seats.unlimited ? -1 : Number(draft.seats.value))} ·{' '}
                {formatInr(parseIntegerField(draft.monthly_price_cents))} monthly.
              </p>
            ) : null}
            {warnings.length > 0 ? (
              <p className="text-xs text-warning">
                {warnings.length} warning{warnings.length === 1 ? '' : 's'} above.
              </p>
            ) : null}
          </div>
        }
      />
    </>
  );
}
