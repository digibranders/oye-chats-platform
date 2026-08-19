import { useMemo, useState, type ReactNode } from 'react';
import {
  Alert,
  Badge,
  Button,
  ConfirmDialog,
  Drawer,
  Field,
  Input,
  Section,
  Select,
  Switch,
  Textarea,
  cn,
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
    <div className="rounded-md border border-border bg-surface-sunken px-3 py-3">
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
    </div>
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

function ReadOnlyRow({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-border py-2 last:border-b-0">
      <div className="min-w-0">
        <p className="text-xs text-text-secondary">{label}</p>
        {hint ? <p className="mt-0.5 text-2xs leading-snug text-text-tertiary">{hint}</p> : null}
      </div>
      <div className="figure shrink-0 text-right text-sm text-text-primary">{value}</div>
    </div>
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
        footer={
          <>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={attemptSave}>
              {isCreate ? 'Create plan' : 'Review and save'}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-6">
          {saveError ? (
            <Alert tone="danger" live title="The plan was not saved">
              {saveError}
            </Alert>
          ) : null}

          {resultWarnings.length > 0 ? (
            <Alert tone="warning" live title="Saved, with warnings">
              <ul className="list-disc space-y-1 pl-4">
                {resultWarnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </Alert>
          ) : null}

          {showErrors && errorCount > 0 ? (
            <Alert tone="danger" live title="This plan cannot be saved yet">
              {errorCount === 1 ? 'One field needs attention.' : `${errorCount} fields need attention.`}
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
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Name" required error={shown.name} hint="Shown on the pricing page and the invoice.">
                <Input value={draft.name} onChange={(event) => update({ name: event.target.value })} />
              </Field>
              <Field
                label="Slug"
                required={isCreate}
                error={shown.slug}
                hint={
                  isCreate
                    ? 'Lowercase identifier. Entitlements and the gateway mapping resolve against it.'
                    : 'Fixed after creation — entitlement lookups and gateway mappings point at it.'
                }
              >
                <Input
                  value={draft.slug}
                  disabled={!isCreate}
                  className="figure"
                  onChange={(event) => update({ slug: event.target.value })}
                />
              </Field>
              <Field label="Description" className="sm:col-span-2" hint="One line, shown under the plan name.">
                <Textarea
                  rows={2}
                  value={draft.description}
                  onChange={(event) => update({ description: event.target.value })}
                />
              </Field>
              <Field label="Pricing model" hint="How the tier is meant to scale.">
                <Select
                  options={PRICING_MODEL_OPTIONS}
                  value={draft.pricing_model}
                  onChange={(event) => update({ pricing_model: event.target.value })}
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
              <div className="rounded-md border border-border bg-surface-sunken px-3 py-3 sm:col-span-2">
                <Switch
                  label="Listed"
                  description="Visible on the public pricing page and selectable at checkout."
                  checked={draft.is_active}
                  onCheckedChange={(checked) => update({ is_active: checked })}
                />
                <div className="mt-3 border-t border-border pt-3">
                  <Switch
                    label="Default plan"
                    description="Every new account lands here. Exactly one plan holds this; saving moves it."
                    checked={draft.is_default}
                    onCheckedChange={(checked) => update({ is_default: checked })}
                  />
                  {shown.is_default ? (
                    <p role="status" className="mt-1.5 text-xs text-danger">
                      {shown.is_default}
                    </p>
                  ) : null}
                </div>
              </div>
            </div>
          </Section>

          <Section
            title="Entitlements — limits"
            description="Numeric caps. plan_entitlements_service reads these directly; an unknown key resolves to zero, which is why a limit is never simply deleted."
          >
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
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
            </div>
            {extraLimitKeys.length > 0 ? (
              <div className="mt-3 rounded-md border border-border bg-surface px-3 py-3">
                <p className="text-xs font-medium text-text-primary">
                  Other limit keys on this plan
                </p>
                <p className="mt-0.5 text-xs text-text-secondary">
                  This editor does not model them. A save merges key by key, so they are left exactly as
                  they are.
                </p>
                <dl className="mt-2 grid gap-1.5 sm:grid-cols-2">
                  {extraLimitKeys.map((entry) => (
                    <div key={entry.key} className="flex items-baseline justify-between gap-3">
                      <dt className="figure text-xs text-text-secondary">{entry.key}</dt>
                      <dd className="figure text-xs text-text-primary">{JSON.stringify(entry.value)}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            ) : null}
          </Section>

          <Section
            title="Entitlements — features"
            description="Boolean gates. has_feature defaults an unknown feature to false, so turning one off locks the surface immediately for everyone on this plan."
          >
            <div className="rounded-md border border-border bg-surface">
              {FEATURE_FIELDS.map((field) => (
                <div key={field.key} className="border-b border-border px-3 py-3 last:border-b-0">
                  <Switch
                    label={field.label}
                    description={field.description}
                    checked={draft.features[field.key]}
                    onCheckedChange={(checked) =>
                      update({ features: { ...draft.features, [field.key]: checked } })
                    }
                  />
                </div>
              ))}
            </div>
            <div className="mt-3">
              <Field
                label="Integrations"
                hint="A string feature rather than a boolean; the integration surfaces branch on its value."
              >
                <Select
                  options={INTEGRATION_OPTIONS}
                  value={draft.integrations}
                  onChange={(event) => update({ integrations: event.target.value })}
                />
              </Field>
            </div>
            {extraFeatureKeys.length > 0 ? (
              <div className="mt-3 rounded-md border border-border bg-surface px-3 py-3">
                <p className="text-xs font-medium text-text-primary">Other feature keys on this plan</p>
                <dl className="mt-2 grid gap-1.5 sm:grid-cols-2">
                  {extraFeatureKeys.map((entry) => (
                    <div key={entry.key} className="flex items-baseline justify-between gap-3">
                      <dt className="figure text-xs text-text-secondary">{entry.key}</dt>
                      <dd className="figure text-xs text-text-primary">{JSON.stringify(entry.value)}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            ) : null}
          </Section>

          <Section
            title="Commercials"
            description="Plans are INR-primary: the *_cents columns are paise and are what Razorpay debits. The USD columns are the international rail."
          >
            <div className="grid gap-4 sm:grid-cols-2">
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
                hint="The allowance granted each period. Keep it equal to the credits limit above — the public catalogue serialises that copy."
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
              <div>
                <LimitControl
                  label="Included operator seats"
                  hint="Seats the price already covers. Unlimited is the only meaningful non-positive value; zero is rejected."
                  error={shown.seats}
                  allowsUnlimited
                  draft={draft.seats}
                  onChange={(next) => update({ seats: next })}
                />
              </div>
            </div>

            <div className="mt-4 rounded-md border border-border bg-surface px-3 py-3">
              <ReadOnlyRow
                label="Annual saving"
                hint="Derived from the two INR prices, never stored from this form. Sending a different figure is refused with a 422."
                value={saving > 0 ? `${saving}%` : 'No annual saving'}
              />
              <ReadOnlyRow
                label="Extra seat price"
                hint="Fixed by the Razorpay seat add-on in the environment. The API accepts only that amount or zero, and serves neither, so this form never writes it."
                value={
                  plan
                    ? `${formatInr(plan.extra_seat_price_cents)} · ${formatUsd(plan.extra_seat_price_usd_cents)}`
                    : seatPrices.inr == null
                      ? 'Set by the API on create'
                      : `${formatInr(seatPrices.inr)} · ${formatUsd(seatPrices.usd)}`
                }
              />
              <ReadOnlyRow
                label="Currency"
                hint="Plans are INR-primary. A non-INR value is refused with a 422."
                value="INR"
              />
            </div>
          </Section>

          <Section
            title="Gateway"
            description="Razorpay plans are immutable, so these are minted by the API when a price changes and cannot be typed in here."
          >
            <div className="rounded-md border border-border bg-surface px-3 py-3">
              <ReadOnlyRow
                label="Monthly plan id (INR)"
                value={plan?.razorpay_plan_id_monthly ?? 'Not wired'}
              />
              <ReadOnlyRow
                label="Annual plan id (INR)"
                value={plan?.razorpay_plan_id_annual ?? 'Not wired'}
              />
              <ReadOnlyRow
                label="USD plan ids"
                hint="GET /superadmin/plans does not return them, so this console cannot show them."
                value="Not served"
              />
            </div>
          </Section>

          <Section title="Marketing" description="Copy rendered on the public pricing card.">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Tagline" hint="One sentence under the plan name.">
                <Input value={draft.tagline} onChange={(event) => update({ tagline: event.target.value })} />
              </Field>
              <Field label="Badge" hint='A ribbon, e.g. "Most Popular". Blank removes it on the next save.'>
                <Input value={draft.badge} onChange={(event) => update({ badge: event.target.value })} />
              </Field>
            </div>
          </Section>
        </div>
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
              <dl className="max-h-56 overflow-y-auto rounded-md border border-border">
                {changes.map((change) => (
                  <div
                    key={change.key}
                    className={cn(
                      'flex items-baseline justify-between gap-3 border-b border-border px-3 py-1.5',
                      'last:border-b-0',
                    )}
                  >
                    <dt className="min-w-0 text-xs text-text-secondary">{change.label}</dt>
                    <dd className="figure shrink-0 text-xs text-text-primary">
                      <span className="text-text-tertiary">{change.before}</span>
                      {' → '}
                      <span className="font-medium">{change.after}</span>
                    </dd>
                  </div>
                ))}
              </dl>
            ) : null}
            {isCreate ? (
              <p className="text-xs">
                Seats: {formatSeats(draft.seats.unlimited ? -1 : Number(draft.seats.value))} ·{' '}
                {formatInr(parseIntegerField(draft.monthly_price_cents))} monthly.
              </p>
            ) : null}
            {warnings.length > 0 ? (
              <Badge tone="warning">
                {warnings.length} warning{warnings.length === 1 ? '' : 's'} above
              </Badge>
            ) : null}
          </div>
        }
      />
    </>
  );
}
