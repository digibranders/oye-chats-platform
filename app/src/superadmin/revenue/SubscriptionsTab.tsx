import { useEffect, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Combobox,
  Drawer,
  EmptyState,
  Field,
  Input,
  Section,
  Select,
  Stack,
  Toolbar,
  formatDate,
  formatNumber,
  toast,
  type Column,
} from '../../ui';
import { platform } from '../client';
import { usePlatformList, useUrlState } from '../usePlatform';
import { RecordList } from '../RecordList';
import { byDate, byNumber, byText, usePagedRows } from '../recordListState';
import { SUBSCRIPTION_STATUSES, subscriptionLabel, subscriptionTone } from './status';
import type { Plan } from '../catalogue/types';
import type { SubscriptionOverride, SubscriptionRow } from './types';

/**
 * The subscription book, and the manual override on top of it.
 *
 * The endpoint is honest about its limits and so is this screen: it returns at
 * most **200 rows**, newest first, and accepts exactly two filters (`status`,
 * `plan_id`). It has no page parameter, so the console pages and sorts the
 * *whole* response through `usePagedRows` and says plainly when that response
 * was the server's cap. It used to page twenty-five at a time over the same
 * 200 and sort the slice, which reported "1–25 of 200" for a platform with two
 * thousand subscriptions and ordered a quarter of a truncated window.
 */

/** `list_subscriptions` caps its query at 200 (`superadmin_plan_routes.py`). */
const SERVER_CAP = 200;

const STATUS_OPTIONS = [
  { value: '', label: 'Any status' },
  ...SUBSCRIPTION_STATUSES.map((status) => ({ value: status, label: subscriptionLabel(status) })),
];

const CYCLE_OPTIONS = [
  { value: '', label: 'Leave unchanged' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'annual', label: 'Annual' },
];

export function SubscriptionsTab() {
  const url = useUrlState();
  const status = url.get('status');
  const planId = url.get('plan_id');
  const [editing, setEditing] = useState<SubscriptionRow | null>(null);

  const list = usePlatformList<SubscriptionRow>('/subscriptions', {
    params: { status: status || undefined, plan_id: planId || undefined },
  });
  // The catalogue, so the plan filter can be a name rather than an integer id
  // nobody knows. It is the same list the Catalogue section reads.
  const plans = usePlatformList<Plan>('/plans');

  const paged = usePagedRows(list.items, {
    url,
    comparators: {
      client: byText((row) => row.client_name),
      plan: byText((row) => row.plan_name),
      status: byText((row) => row.status),
      seats: byNumber((row) => row.operator_quantity),
      period_end: byDate((row) => row.current_period_end),
      trial_end: byDate((row) => row.trial_end),
    },
  });

  const columns: readonly Column<SubscriptionRow>[] = [
    {
      key: 'client',
      header: 'Customer',
      pinned: true,
      width: '16rem',
      sortable: true,
      render: (row) => (
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-text-primary">{row.client_name}</p>
          <p className="figure truncate text-2xs text-text-tertiary">
            {row.client_email ?? `client #${row.client_id}`}
          </p>
        </div>
      ),
    },
    {
      key: 'plan',
      header: 'Plan',
      sortable: true,
      render: (row) => (
        <div className="min-w-0">
          <p className="truncate text-sm text-text-primary">{row.plan_name}</p>
          <p className="figure text-2xs text-text-tertiary">
            {row.billing_cycle ?? 'cycle not set'} · plan #{row.plan_id}
          </p>
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      width: '9rem',
      sortable: true,
      render: (row) => (
        <Badge tone={subscriptionTone(row.status)} dot>
          {subscriptionLabel(row.status)}
        </Badge>
      ),
    },
    {
      key: 'seats',
      header: 'Seats',
      align: 'right',
      width: '6rem',
      secondary: true,
      sortable: true,
      render: (row) => (
        <span className="figure">
          {row.operator_quantity == null ? '—' : formatNumber(row.operator_quantity)}
        </span>
      ),
    },
    {
      key: 'period_end',
      header: 'Period ends',
      width: '10rem',
      secondary: true,
      sortable: true,
      render: (row) => <span className="figure text-sm">{formatDate(row.current_period_end)}</span>,
    },
    {
      key: 'trial_end',
      header: 'Trial ends',
      width: '10rem',
      secondary: true,
      sortable: true,
      render: (row) => <span className="figure text-sm">{formatDate(row.trial_end)}</span>,
    },
    {
      key: 'provider',
      header: 'Gateway',
      width: '8rem',
      secondary: true,
      render: (row) => <span className="text-sm text-text-secondary">{row.payment_provider ?? '—'}</span>,
    },
  ];

  return (
    <Stack>
      <Section title="Subscriptions">
        <Toolbar sticky className="mb-3">
          <div className="w-48">
            <Select
              size="sm"
              aria-label="Filter by status"
              options={STATUS_OPTIONS}
              value={status}
              onChange={(event) => url.set({ status: event.target.value })}
            />
          </div>
          <div className="w-48">
            <Combobox
              size="sm"
              label="Filter by plan"
              value={planId || null}
              onValueChange={(next) => url.set({ plan_id: next })}
              options={plans.items.map((entry) => ({
                value: String(entry.id),
                label: entry.name,
                keywords: entry.slug,
              }))}
              placeholder="Any plan"
              clearable
            />
          </div>
          {status || planId ? (
            <Button size="sm" variant="ghost" onClick={() => url.set({ status: null, plan_id: null })}>
              Clear filters
            </Button>
          ) : null}
        </Toolbar>

        <RecordList
          caption="Subscriptions, newest first"
          columns={columns}
          paged={paged}
          rowKey={(row) => String(row.id)}
          rowNoun="subscription"
          what="the subscription book"
          loading={list.loading}
          error={list.error}
          forbidden={list.forbidden}
          onRetry={list.reload}
          onRowClick={setEditing}
          loaded={list.items.length}
          cap={SERVER_CAP}
          note="Newest first, and filtered by the server. Narrow by status or plan rather than scrolling."
          empty={
            <EmptyState
              title={status || planId ? 'Nothing matched those filters' : 'No subscriptions yet'}
              description={
                status || planId
                  ? 'No subscription has that status and plan combination.'
                  : 'Nobody has started a subscription — not even a trial. Check the catalogue has a plan with checkout wired.'
              }
              action={
                status || planId ? (
                  <Button size="sm" onClick={() => url.set({ status: null, plan_id: null })}>
                    Clear filters
                  </Button>
                ) : undefined
              }
            />
          }
        />
      </Section>

      <OverrideDrawer
        subscription={editing}
        plans={plans.items}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          list.reload();
        }}
      />
    </Stack>
  );
}

interface DraftState {
  plan_id: string;
  status: string;
  operator_quantity: string;
  billing_cycle: string;
  extend_trial_days: string;
}

function emptyDraft(subscription: SubscriptionRow | null): DraftState {
  return {
    plan_id: subscription ? String(subscription.plan_id) : '',
    status: subscription?.status ?? '',
    operator_quantity: subscription?.operator_quantity == null ? '' : String(subscription.operator_quantity),
    billing_cycle: '',
    extend_trial_days: '',
  };
}

/**
 * The manual override.
 *
 * `PUT /superadmin/subscriptions/{id}` applies whatever it is given and writes
 * nothing to the gateway, so this form only sends fields the operator actually
 * changed — a full-object PUT would re-stamp the plan and cycle on every save
 * and make an audit entry that claims four edits where one happened.
 *
 * The trial extension is disabled when the subscription has no `trial_end`,
 * because the handler's condition is `extend_trial_days is not None and
 * sub.trial_end` — sending days for a subscription that never had a trial is
 * silently ignored and the console would report a success that did not occur.
 */
function OverrideDrawer({
  subscription,
  plans,
  onClose,
  onSaved,
}: {
  subscription: SubscriptionRow | null;
  /** The catalogue, so the plan is picked by name rather than by integer id. */
  plans: readonly Plan[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<DraftState>(() => emptyDraft(subscription));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(emptyDraft(subscription));
    setError(null);
  }, [subscription]);

  if (!subscription) return null;

  const hasTrial = Boolean(subscription.trial_end);
  const patch: SubscriptionOverride = {};
  const changes: string[] = [];

  const planId = Number(draft.plan_id);
  if (draft.plan_id !== '' && Number.isInteger(planId) && planId > 0 && planId !== subscription.plan_id) {
    patch.plan_id = planId;
    changes.push(`plan ${subscription.plan_id} → ${planId}`);
  }
  if (draft.status && draft.status !== subscription.status) {
    patch.status = draft.status;
    changes.push(`status ${subscriptionLabel(subscription.status)} → ${subscriptionLabel(draft.status)}`);
  }
  const seats = Number(draft.operator_quantity);
  if (
    draft.operator_quantity !== '' &&
    Number.isInteger(seats) &&
    seats >= 0 &&
    seats !== subscription.operator_quantity
  ) {
    patch.operator_quantity = seats;
    changes.push(`seats ${subscription.operator_quantity ?? '—'} → ${seats}`);
  }
  if (draft.billing_cycle === 'monthly' || draft.billing_cycle === 'annual') {
    if (draft.billing_cycle !== subscription.billing_cycle) {
      patch.billing_cycle = draft.billing_cycle;
      changes.push(`cycle ${subscription.billing_cycle ?? '—'} → ${draft.billing_cycle}`);
    }
  }
  const extraDays = Number(draft.extend_trial_days);
  if (hasTrial && draft.extend_trial_days !== '' && Number.isInteger(extraDays) && extraDays > 0) {
    patch.extend_trial_days = extraDays;
    changes.push(`trial extended by ${extraDays} day${extraDays === 1 ? '' : 's'}`);
  }

  async function save(): Promise<void> {
    if (!subscription || changes.length === 0) return;
    setSaving(true);
    setError(null);
    try {
      await platform.put(`/subscriptions/${subscription.id}`, patch);
      toast.success(`Subscription #${subscription.id} updated.`);
      onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The server refused this override.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Drawer
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      eyebrow={`${subscription.client_name} · ${subscription.plan_name}`}
      title={`Override subscription #${subscription.id}`}
      description="Writes to the customer's account and not to the gateway: nothing here charges, refunds or re-mandates anything at Razorpay."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={saving}
            disabled={changes.length === 0}
            onClick={() => void save()}
          >
            Apply override
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        {error ? (
          <Alert tone="danger" live title="The override was refused">
            {error}
          </Alert>
        ) : null}

        <Field label="Plan">
          <Combobox
            label="Plan"
            value={draft.plan_id || null}
            onValueChange={(next) => setDraft({ ...draft, plan_id: next ?? '' })}
            options={plans.map((entry) => ({
              value: String(entry.id),
              label: entry.name,
              description: entry.slug,
              keywords: entry.slug,
            }))}
            placeholder="Leave unchanged"
            clearable
          />
        </Field>

        <Field label="Status">
          <Select
            options={SUBSCRIPTION_STATUSES.map((value) => ({ value, label: subscriptionLabel(value) }))}
            value={draft.status}
            onChange={(event) => setDraft({ ...draft, status: event.target.value })}
          />
        </Field>

        <Field
          label="Operator seats"
          hint="The total, including the seats the plan already covers."
        >
          <Input
            type="number"
            min={0}
            max={1000}
            inputMode="numeric"
            value={draft.operator_quantity}
            onChange={(event) => setDraft({ ...draft, operator_quantity: event.target.value })}
          />
        </Field>

        <Field label="Billing cycle" hint="Leave unchanged unless you are correcting a mis-set cycle.">
          <Select
            options={CYCLE_OPTIONS}
            value={draft.billing_cycle}
            onChange={(event) => setDraft({ ...draft, billing_cycle: event.target.value })}
          />
        </Field>

        <Field
          label="Extend trial by (days)"
          disabled={!hasTrial}
          hint={
            hasTrial
              ? `Added to the current trial end, ${formatDate(subscription.trial_end)}. Maximum 365.`
              : 'No trial end date, so the server would ignore this.'
          }
        >
          <Input
            type="number"
            min={1}
            max={365}
            inputMode="numeric"
            disabled={!hasTrial}
            value={draft.extend_trial_days}
            onChange={(event) => setDraft({ ...draft, extend_trial_days: event.target.value })}
          />
        </Field>

        <div className="rounded-md border border-border bg-surface-sunken px-3 py-2.5">
          <p className="font-mono text-2xs uppercase tracking-eyebrow text-text-tertiary">
            What will be sent
          </p>
          {changes.length === 0 ? (
            <p className="mt-1.5 text-xs text-text-secondary">
              Nothing yet. Change a field above and it appears here before you apply it.
            </p>
          ) : (
            <ul className="mt-1.5 list-disc space-y-1 pl-4 text-xs text-text-secondary">
              {changes.map((change) => (
                <li key={change}>{change}</li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Drawer>
  );
}
