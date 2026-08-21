import { useMemo, useState } from 'react';
import { Plus } from 'lucide-react';
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  ConfirmDialog,
  DataTable,
  Dialog,
  Drawer,
  EmptyState,
  Field,
  FieldSet,
  Grid,
  Input,
  LoadingRows,
  LockedState,
  Section,
  SettingGroup,
  SettingRow,
  Stack,
  StatRow,
  Switch,
  formatDate,
  formatDateTime,
  formatNumber,
  toast,
  type Column,
} from '../../ui';
import { platform } from '../client';
import { usePlatformList, usePlatformResource, useUrlState } from '../usePlatform';
import { PAGE_SIZE } from '../recordListState';
import {
  emptyPromotionDraft,
  promotionDraftFrom,
  promotionPayload,
  promotionState,
  promotionUsage,
  validatePromotionDraft,
  type PromotionDraft,
} from './offer-model';
import type { Plan, Promotion, PromotionRedemption, PromotionRedemptionsResponse } from './types';

const STATE_TONE = {
  active: 'success',
  scheduled: 'warning',
  exhausted: 'warning',
  expired: 'neutral',
  inactive: 'neutral',
} as const;

const STATE_LABEL = {
  active: 'Running',
  scheduled: 'Scheduled',
  exhausted: 'Slots gone',
  expired: 'Window closed',
  inactive: 'Paused',
} as const;



/**
 * Launch promotions.
 *
 * Unlike coupons, these are live: `promotion_service` resolves eligibility at
 * checkout, claims a slot atomically and mints a subscription with a free
 * period. That makes two numbers on this screen genuinely different rather than
 * redundant — `slots_claimed` is claimed at checkout, `subscriptions_created`
 * is minted when the mandate authorises, and the gap between them is in-flight
 * or abandoned checkouts. They are never merged.
 *
 * The list also shows the state a reader needs rather than the flag stored:
 * a campaign can read `is_active` while every eligibility check refuses it
 * because the window closed or the slots ran out.
 */
export function PromotionsScreen() {
  const promotions = usePlatformList<Promotion>('/promotions', { key: 'promotions' });
  const plans = usePlatformList<Plan>('/plans');
  const url = useUrlState();
  const page = url.getNumber('page', 1);
  const openId = url.get('promotion');

  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Promotion | null>(null);
  const [draft, setDraft] = useState<PromotionDraft>(() => emptyPromotionDraft());
  const [showErrors, setShowErrors] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<Promotion | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const isCreate = creating;
  const dialogOpen = creating || editing !== null;
  const endsChanged = editing ? promotionDraftFrom(editing).ends_at !== draft.ends_at : false;
  const errors = useMemo(
    () => validatePromotionDraft(draft, { isCreate, endsAtChanged: endsChanged }),
    [draft, isCreate, endsChanged],
  );
  const shown = showErrors ? errors : {};

  const rows = promotions.items;
  const pageRows = useMemo(() => rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE), [rows, page]);

  const detail = usePlatformResource<PromotionRedemptionsResponse>(
    openId ? `/promotions/${openId}/redemptions` : null,
  );

  function startCreate(): void {
    setDraft(emptyPromotionDraft());
    setEditing(null);
    setCreating(true);
    setShowErrors(false);
    setDialogError(null);
  }

  function startEdit(promotion: Promotion): void {
    setDraft(promotionDraftFrom(promotion));
    setCreating(false);
    setEditing(promotion);
    setShowErrors(false);
    setDialogError(null);
  }

  function closeDialog(): void {
    if (busy) return;
    setCreating(false);
    setEditing(null);
  }

  async function save(): Promise<void> {
    if (Object.keys(errors).length > 0) {
      setShowErrors(true);
      return;
    }
    setBusy(true);
    setDialogError(null);
    try {
      const payload = promotionPayload(draft);
      if (isCreate) await platform.post('/promotions', payload);
      else if (editing) await platform.put(`/promotions/${editing.id}`, payload);
      toast.success(isCreate ? 'Campaign created.' : 'Campaign updated.');
      setCreating(false);
      setEditing(null);
      promotions.reload();
    } catch (error) {
      setDialogError(error instanceof Error ? error.message : 'The campaign could not be saved.');
    } finally {
      setBusy(false);
    }
  }

  async function confirmRemove(): Promise<void> {
    if (!removing) return;
    try {
      await platform.remove(`/promotions/${removing.id}`);
      toast.success(`${removing.name} deleted.`);
      setRemoving(null);
      promotions.reload();
    } catch (error) {
      setRemoving(null);
      setActionError(error instanceof Error ? error.message : 'The campaign could not be deleted.');
    }
  }

  const columns: Column<Promotion>[] = [
    {
      key: 'name',
      header: 'Campaign',
      pinned: true,
      // The only width here. It was on all eight, which laid the table out
      // fixed and then ellipsised the cells that mattered: "48 of 500 cl…" on
      // every row of "Slots claimed", and a window truncated to "11 Mar 2026 →
      // 19 Mar 2…", while 300px of the card sat empty to the right. The reason
      // given was a table that ran past the card — that was `Column.secondary`
      // querying the viewport instead of the container, and it is fixed at the
      // primitive. A campaign name is genuinely unbounded, so it keeps a width.
      width: '13rem',
      sortable: (a, b) => a.name.localeCompare(b.name),
      render: (promotion) => (
        <div className="min-w-0">
          <p className="truncate font-medium text-text-primary">{promotion.name}</p>
          <p className="figure truncate text-2xs text-text-tertiary">
            {promotion.code ?? 'no code — automatic'}
          </p>
        </div>
      ),
    },
    {
      key: 'state',
      header: 'State',
      render: (promotion) => {
        const value = promotionState(promotion);
        return <Badge tone={STATE_TONE[value]}>{STATE_LABEL[value]}</Badge>;
      },
    },
    {
      key: 'window',
      header: 'Window',
      secondary: true,
      render: (promotion) => (
        // Days, not minutes: the times doubled this column's width for a
        // precision no reader of a campaign window uses.
        <span className="figure text-xs">
          {formatDate(promotion.starts_at)} → {formatDate(promotion.ends_at)}
        </span>
      ),
    },
    {
      key: 'free_cycles',
      header: 'Free cycles',
      align: 'right',
      render: (promotion) => formatNumber(promotion.free_cycles),
    },
    {
      key: 'slots',
      header: 'Slots claimed',
      align: 'right',
      sortable: (a, b) => a.slots_claimed - b.slots_claimed,
      render: (promotion) => promotionUsage(promotion),
    },
    {
      key: 'created',
      header: 'Subscriptions',
      align: 'right',
      secondary: true,
      render: (promotion) => formatNumber(promotion.stats?.subscriptions_created ?? 0),
    },
    {
      key: 'converted',
      header: 'Converted',
      align: 'right',
      render: (promotion) => formatNumber(promotion.stats?.converted ?? 0),
    },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      render: (promotion) => (
        <span className="flex justify-end gap-1.5">
          <Button size="sm" variant="ghost" onClick={() => startEdit(promotion)}>
            Edit
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setActionError(null);
              setRemoving(promotion);
            }}
          >
            Delete
          </Button>
        </span>
      ),
    },
  ];

  const redemptionColumns: Column<PromotionRedemption>[] = [
    {
      key: 'client',
      header: 'Account',
      pinned: true,
      render: (row) => (
        <div className="min-w-0">
          <p className="font-medium text-text-primary">{row.client_name ?? `Client ${row.client_id}`}</p>
          <p className="figure text-2xs text-text-tertiary">{row.client_email ?? '—'}</p>
        </div>
      ),
    },
    { key: 'bot', header: 'Chatbot', secondary: true, render: (row) => row.bot_name ?? '—' },
    { key: 'plan', header: 'Plan', render: (row) => row.plan_name ?? '—' },
    {
      key: 'status',
      header: 'Subscription',
      render: (row) => (
        <Badge tone={row.status === 'active' ? 'success' : row.status === 'past_due' ? 'danger' : 'neutral'}>
          {row.status}
        </Badge>
      ),
    },
    {
      key: 'free',
      header: 'Free until',
      align: 'right',
      render: (row) =>
        row.promo_free_until
          ? `${formatDateTime(row.promo_free_until)}${row.in_free_period ? '' : ' · past'}`
          : '—',
    },
  ];

  if (promotions.forbidden) {
    return (
      <LockedState
        title="You cannot read promotions"
        description="Your super-admin account is not permitted to load campaigns. Nothing was created or changed."
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

      <Section
        title="Campaigns"
        description="Newest first. Every figure is read live from the subscriptions carrying the campaign."
        actions={
          <Button variant="primary" size="sm" onClick={startCreate} iconLeft={<Plus aria-hidden className="h-3.5 w-3.5" />}>
            New campaign
          </Button>
        }
      >
        <DataTable
          caption="Launch promotions"
          columns={columns}
          rows={pageRows}
          rowKey={(promotion) => String(promotion.id)}
          rowLabel={(promotion) => promotion.name}
          rowNoun="campaign"
          loading={promotions.loading && rows.length === 0}
          error={promotions.error}
          onRetry={promotions.reload}
          onRowClick={(promotion) => url.set({ promotion: promotion.id })}
          pageSize={PAGE_SIZE}
          page={page}
          onPageChange={(next) => url.set({ page: next })}
          rowCount={rows.length}
          empty={
            <EmptyState
              title="No campaigns"
              description="Nothing has been launched. A campaign gives a signup a number of free billing cycles and counts its own conversions."
              action={
                <Button size="sm" onClick={startCreate}>
                  New campaign
                </Button>
              }
            />
          }
        />
      </Section>

      <Dialog
        open={dialogOpen}
        onOpenChange={(next) => {
          if (!next) closeDialog();
        }}
        dismissible={!busy}
        title={isCreate ? 'New campaign' : `Edit ${editing?.name ?? 'campaign'}`}
        description="The window is stored in UTC; the fields below are your local time."
        footer={
          <>
            <Button variant="ghost" disabled={busy} onClick={closeDialog}>
              Cancel
            </Button>
            <Button variant="primary" loading={busy} onClick={save}>
              {isCreate ? 'Launch campaign' : 'Save campaign'}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          {dialogError ? (
            <Alert tone="danger" live title="Not saved">
              {dialogError}
            </Alert>
          ) : null}

          <Field label="Name" required error={shown.name} hint="Internal — it identifies the campaign in reporting.">
            <Input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
          </Field>

          <Field
            label="Code"
            optional
            error={shown.code}
            hint="Blank for a campaign that applies automatically to anyone eligible."
          >
            <Input
              className="figure"
              autoComplete="off"
              value={draft.code}
              onChange={(event) => setDraft({ ...draft, code: event.target.value })}
            />
          </Field>

          <Grid cols={2}>
            <Field label="Starts" required error={shown.starts_at} hint="Local time.">
              <Input
                type="datetime-local"
                className="figure"
                value={draft.starts_at}
                onChange={(event) => setDraft({ ...draft, starts_at: event.target.value })}
              />
            </Field>
            <Field
              label="Ends"
              required
              error={shown.ends_at}
              hint="Must be in the future when it is set — a past end saves an offer nobody can redeem."
            >
              <Input
                type="datetime-local"
                className="figure"
                value={draft.ends_at}
                onChange={(event) => setDraft({ ...draft, ends_at: event.target.value })}
              />
            </Field>
            <Field label="Free cycles" required error={shown.free_cycles} hint="1 to 36 billing cycles at no charge.">
              <Input
                className="figure"
                inputMode="numeric"
                value={draft.free_cycles}
                onChange={(event) => setDraft({ ...draft, free_cycles: event.target.value })}
              />
            </Field>
            <Field label="Maximum redemptions" optional error={shown.max_redemptions} hint="Blank for uncapped.">
              <Input
                className="figure"
                inputMode="numeric"
                value={draft.max_redemptions}
                onChange={(event) => setDraft({ ...draft, max_redemptions: event.target.value })}
              />
            </Field>
          </Grid>

          <FieldSet legend="Eligible plans" hint="None selected means every plan.">
            <div className="grid gap-2 @lg/page:grid-cols-2">
              {plans.items.map((plan) => (
                <Checkbox
                  key={plan.id}
                  label={`${plan.name} (${plan.slug})`}
                  checked={draft.eligible_plan_ids.includes(plan.id)}
                  onCheckedChange={(checked) =>
                    setDraft({
                      ...draft,
                      eligible_plan_ids:
                        checked === true
                          ? [...draft.eligible_plan_ids, plan.id]
                          : draft.eligible_plan_ids.filter((id) => id !== plan.id),
                    })
                  }
                />
              ))}
              {plans.items.length === 0 ? (
                <p className="text-xs text-text-tertiary">
                  {plans.loading ? 'Loading plans…' : 'No plans to scope this to.'}
                </p>
              ) : null}
            </div>
          </FieldSet>

          <SettingGroup>
            <SettingRow label="Active" description="Off freezes new redemptions without touching the subscriptions already on it.">
              <Switch
                label="Active"
                hideLabel
                checked={draft.is_active}
                onCheckedChange={(checked) => setDraft({ ...draft, is_active: checked })}
              />
            </SettingRow>
          </SettingGroup>
        </div>
      </Dialog>

      <Drawer
        open={openId !== ''}
        onOpenChange={(next) => {
          if (!next) url.set({ promotion: null, page: page });
        }}
        width="xl"
        title={detail.data?.promotion.name ?? 'Campaign'}
        description="Every subscription minted through this campaign."
      >
        {detail.forbidden ? (
          <LockedState
            title="You cannot read these redemptions"
            description="Your super-admin account is not permitted to load them."
          />
        ) : detail.loading && !detail.data ? (
          <LoadingRows rows={6} />
        ) : detail.error && !detail.data ? (
          <Alert
            tone="danger"
            title="The redemptions could not be loaded"
            action={
              <Button size="sm" onClick={detail.reload}>
                Try again
              </Button>
            }
          >
            {detail.error}
          </Alert>
        ) : detail.data ? (
          <div className="flex flex-col gap-5">
            {/* One strip, one window. "At checkout" is where a slot is claimed,
                not a period, so it is a hint — `period` carried it only while
                `StatRow` was dropping the window it was handed. */}
            <StatRow
              label="Campaign performance"
              period="All time"
              items={[
                {
                  label: 'Slots claimed',
                  value: formatNumber(detail.data.promotion.slots_claimed),
                  hint: 'Counted at checkout',
                },
                {
                  label: 'Subscriptions',
                  value: formatNumber(detail.data.promotion.stats?.subscriptions_created ?? 0),
                },
                {
                  label: 'In the free period',
                  value: formatNumber(detail.data.promotion.stats?.in_free_period ?? 0),
                  period: 'Right now',
                },
                {
                  label: 'Converted',
                  value: formatNumber(detail.data.promotion.stats?.converted ?? 0),
                },
              ]}
            />

            <DataTable
              caption="Campaign redemptions"
              columns={redemptionColumns}
              rows={detail.data.redemptions}
              rowKey={(row) => String(row.subscription_id)}
              rowLabel={(row) => row.client_name ?? `Client ${row.client_id}`}
              rowNoun="redemption"
              pageSize={PAGE_SIZE}
              empty={
                <EmptyState
                  title="Nobody has redeemed this yet"
                  description="Slots are claimed at checkout; a subscription appears here once the mandate authorises."
                />
              }
            />
          </div>
        ) : null}
      </Drawer>

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(next) => {
          if (!next) setRemoving(null);
        }}
        destructive
        title={`Delete ${removing?.name ?? 'this campaign'}?`}
        confirmLabel="Delete campaign"
        onConfirm={confirmRemove}
        description={
          <>
            The {formatNumber(removing?.stats?.subscriptions_created ?? 0)} subscription
            {(removing?.stats?.subscriptions_created ?? 0) === 1 ? '' : 's'} created under it keep their free
            period, but lose the link back to this campaign, so its conversion figures disappear with it.
            Pausing keeps both.
          </>
        }
      />
    </Stack>
  );
}
