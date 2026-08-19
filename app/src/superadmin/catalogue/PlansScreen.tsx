import { useMemo, useState } from 'react';
import { Plus } from 'lucide-react';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  ConfirmDialog,
  DataTable,
  EmptyState,
  LockedState,
  Section,
  Stack,
  formatNumber,
  toast,
  type Column,
} from '../../ui';
import { platform } from '../client';
import { usePlatformList } from '../usePlatform';
import { PlanEditor } from './PlanEditor';
import { formatInr, formatLimit, formatSeats, formatUsd } from './plan-model';
import type { Plan } from './types';

/**
 * The catalogue's spine.
 *
 * Deliberately a short, complete table rather than a summary: there are five
 * plans, every column on this row is something a support conversation turns on,
 * and the alternative — open each plan to find out whether it can be bought — is
 * how a listed tier with no gateway id survives for a month.
 */
function checkoutState(plan: Plan): { tone: 'success' | 'warning' | 'neutral'; label: string } {
  const free = plan.monthly_price_cents === 0 && plan.annual_price_cents === 0;
  if (free) return { tone: 'neutral', label: 'Free — nothing to charge' };
  if (plan.razorpay_plan_id_monthly && plan.razorpay_plan_id_annual)
    return { tone: 'success', label: 'Wired' };
  if (plan.razorpay_plan_id_monthly || plan.razorpay_plan_id_annual)
    return { tone: 'warning', label: 'One cycle only' };
  return { tone: 'warning', label: 'Contact sales' };
}

export function PlansScreen() {
  const plans = usePlatformList<Plan>('/plans');
  const [editing, setEditing] = useState<Plan | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [deleting, setDeleting] = useState<Plan | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const rows = useMemo(
    () => [...plans.items].sort((a, b) => a.sort_order - b.sort_order),
    [plans.items],
  );

  function openPlan(plan: Plan | null): void {
    setActionError(null);
    setEditing(plan);
    setEditorOpen(true);
  }

  async function confirmDelete(): Promise<void> {
    if (!deleting) return;
    try {
      await platform.remove(`/plans/${deleting.id}`);
      toast.success(`${deleting.name} delisted.`);
      setDeleting(null);
      plans.reload();
    } catch (error) {
      setDeleting(null);
      setActionError(error instanceof Error ? error.message : 'The plan could not be delisted.');
    }
  }

  const columns: Column<Plan>[] = [
    {
      key: 'name',
      header: 'Plan',
      pinned: true,
      sortable: (a, b) => a.sort_order - b.sort_order,
      render: (plan) => (
        <div className="min-w-0">
          <p className="font-medium text-text-primary">{plan.name}</p>
          <p className="figure text-2xs text-text-tertiary">{plan.slug}</p>
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (plan) => (
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge tone={plan.is_active ? 'success' : 'neutral'} dot>
            {plan.is_active ? 'Listed' : 'Delisted'}
          </Badge>
          {plan.is_default ? <Badge tone="plan">Default</Badge> : null}
        </div>
      ),
    },
    {
      key: 'monthly',
      header: 'Monthly',
      align: 'right',
      sortable: (a, b) => a.monthly_price_cents - b.monthly_price_cents,
      render: (plan) => (
        <span>
          {formatInr(plan.monthly_price_cents)}
          <span className="block text-2xs text-text-tertiary">{formatUsd(plan.monthly_price_usd_cents)}</span>
        </span>
      ),
    },
    {
      key: 'annual',
      header: 'Annual',
      align: 'right',
      secondary: true,
      sortable: (a, b) => a.annual_price_cents - b.annual_price_cents,
      render: (plan) => (
        <span>
          {formatInr(plan.annual_price_cents)}
          <span className="block text-2xs text-text-tertiary">
            {plan.annual_discount_percent > 0 ? `${plan.annual_discount_percent}% saving` : 'No saving'}
          </span>
        </span>
      ),
    },
    {
      key: 'credits',
      header: 'Credits / mo',
      align: 'right',
      sortable: (a, b) => a.credits_per_month - b.credits_per_month,
      render: (plan) => formatNumber(plan.credits_per_month),
    },
    {
      key: 'seats',
      header: 'Seats',
      align: 'right',
      secondary: true,
      render: (plan) => formatSeats(plan.included_operator_seats),
    },
    {
      key: 'bots',
      header: 'Chatbots',
      align: 'right',
      secondary: true,
      render: (plan) => formatLimit(typeof plan.limits?.bots === 'number' ? plan.limits.bots : null),
    },
    {
      key: 'checkout',
      header: 'Checkout',
      secondary: true,
      render: (plan) => {
        const state = checkoutState(plan);
        return <Badge tone={state.tone}>{state.label}</Badge>;
      },
    },
    {
      key: 'subscriptions',
      header: 'On this plan',
      align: 'right',
      sortable: (a, b) => a.active_subscriptions - b.active_subscriptions,
      render: (plan) => formatNumber(plan.active_subscriptions),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (plan) => (
        <Button
          size="sm"
          variant="danger"
          disabled={plan.active_subscriptions > 0}
          onClick={() => {
            setActionError(null);
            setDeleting(plan);
          }}
        >
          Delist
        </Button>
      ),
    },
  ];

  if (plans.forbidden) {
    return (
      <LockedState
        title="You cannot read the plan catalogue"
        description="Your super-admin account is not permitted to load plans. Nothing was requested beyond the list itself."
      />
    );
  }

  return (
    <Stack>
      {actionError ? (
        <Alert tone="danger" live title="That did not work">
          {actionError}
        </Alert>
      ) : null}

      <Alert tone="neutral" title="A plan row is a permission set">
        Limits and features here are what <span className="figure">plan_entitlements_service</span> resolves
        for every account on the plan, cached for sixty seconds. There is no draft state and no rollback:
        saving changes what live customers may do.
      </Alert>

      <Section
        title="Plans"
        description="Ordered as the pricing page lists them."
        actions={
          <Button variant="primary" size="sm" onClick={() => openPlan(null)} iconLeft={<Plus aria-hidden className="h-3.5 w-3.5" />}>
            New plan
          </Button>
        }
      >
        <DataTable
          caption="Pricing plans"
          columns={columns}
          rows={rows}
          rowKey={(plan) => String(plan.id)}
          rowLabel={(plan) => plan.name}
          loading={plans.loading && rows.length === 0}
          error={plans.error}
          onRetry={plans.reload}
          onRowClick={openPlan}
          defaultSort={{ key: 'name', direction: 'asc' }}
          empty={
            <EmptyState
              title="No plans exist"
              description="Nothing is seeded, so every new account falls back to the hardcoded Free limits in plan_entitlements_service. Create a plan, or run scripts/seed_plans.py."
              action={
                <Button size="sm" onClick={() => openPlan(null)}>
                  New plan
                </Button>
              }
            />
          }
        />
      </Section>

      <Section title="What the catalogue costs to run" description="Read straight from the rows above.">
        <Card>
          <CardBody className="grid gap-4 sm:grid-cols-3">
            <div>
              <p className="text-xs text-text-tertiary">Listed plans</p>
              <p className="figure mt-1 text-lg font-semibold text-text-primary">
                {formatNumber(rows.filter((plan) => plan.is_active).length)}
              </p>
            </div>
            <div>
              <p className="text-xs text-text-tertiary">Subscriptions across all plans</p>
              <p className="figure mt-1 text-lg font-semibold text-text-primary">
                {formatNumber(rows.reduce((total, plan) => total + plan.active_subscriptions, 0))}
              </p>
            </div>
            <div>
              <p className="text-xs text-text-tertiary">Default plan</p>
              <p className="mt-1 text-lg font-semibold text-text-primary">
                {rows.find((plan) => plan.is_default)?.name ?? 'None — new accounts fall back to Free limits'}
              </p>
            </div>
          </CardBody>
        </Card>
      </Section>

      <PlanEditor
        open={editorOpen}
        plan={editing}
        plans={rows}
        onOpenChange={setEditorOpen}
        onSaved={plans.reload}
      />

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        destructive
        title={`Delist ${deleting?.name ?? 'this plan'}?`}
        confirmLabel="Delist plan"
        onConfirm={confirmDelete}
        description={
          <>
            The plan is deactivated, not deleted, and loses the default flag if it holds it. It disappears
            from the pricing page and from checkout immediately. Existing subscriptions are untouched — the
            API refuses to delist a plan that has any, which is why this is only offered on empty ones.
          </>
        }
      />
    </Stack>
  );
}
