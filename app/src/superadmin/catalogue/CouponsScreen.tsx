import { useMemo, useState } from 'react';
import { Plus } from 'lucide-react';
import {
  Alert,
  Badge,
  Button,
  ConfirmDialog,
  DataTable,
  DatePicker,
  Dialog,
  EmptyState,
  Field,
  Input,
  LockedState,
  SegmentedControl,
  Section,
  SettingGroup,
  SettingRow,
  Stack,
  Switch,
  formatDate,
  formatNumber,
  toast,
  type Column,
  type SegmentedItem,
} from '../../ui';
import { platform } from '../client';
import { usePlatformList, useUrlState } from '../usePlatform';
import { PAGE_SIZE } from '../recordListState';
import { FORBIDDEN_TITLE, forbiddenDescription } from '../forbidden';
import {
  couponCreatePayload,
  couponDiscount,
  couponDraftFrom,
  couponPatchPayload,
  couponState,
  emptyCouponDraft,
  validateCouponDraft,
  type CouponDraft,
  type OfferState,
} from './offer-model';
import type { Coupon } from './types';

const STATE_TONE: Record<OfferState, 'success' | 'warning' | 'neutral'> = {
  active: 'success',
  exhausted: 'warning',
  expired: 'neutral',
  inactive: 'neutral',
};

const STATE_LABEL: Record<OfferState, string> = {
  active: 'Valid',
  exhausted: 'Fully redeemed',
  expired: 'Expired',
  inactive: 'Deactivated',
};


/**
 * Coupons.
 *
 * The screen leads with the thing that makes it unlike every other coupon
 * manager: there is no online redemption. `_validate_coupon` in
 * `subscription_routes` refuses a *valid* code at checkout with "coupon codes
 * can't be redeemed online yet, contact us" — deliberately, because the field
 * used to be accepted and silently ignored, which charged people full price
 * while they believed a discount had applied.
 *
 * So a coupon here is a record of an offer someone will honour by hand. Saying
 * that once, at the top, is worth more than any control on the page.
 */
export function CouponsScreen() {
  const coupons = usePlatformList<Coupon>('/coupons');
  const url = useUrlState();
  const page = url.getNumber('page', 1);
  const state = url.get('state', 'all');

  const [editing, setEditing] = useState<Coupon | null>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<CouponDraft>(() => emptyCouponDraft());
  const [showErrors, setShowErrors] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<Coupon | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const stateFilters: SegmentedItem<string>[] = [
    { value: 'all', label: 'All', count: coupons.items.length },
    { value: 'active', label: 'Valid' },
    { value: 'expired', label: 'Expired' },
    { value: 'inactive', label: 'Deactivated' },
  ];

  const isCreate = creating;
  const open = creating || editing !== null;
  const errors = useMemo(() => validateCouponDraft(draft, isCreate), [draft, isCreate]);
  const shown = showErrors ? errors : {};

  const filtered = useMemo(() => {
    if (state === 'all') return coupons.items;
    return coupons.items.filter((coupon) => couponState(coupon) === state);
  }, [coupons.items, state]);

  // The endpoint returns every coupon in one response (capped server-side), so
  // paging is honest client-side paging over a set the table genuinely holds.
  const pageRows = useMemo(
    () => filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    [filtered, page],
  );

  function startCreate(): void {
    setDraft(emptyCouponDraft());
    setEditing(null);
    setCreating(true);
    setShowErrors(false);
    setDialogError(null);
  }

  function startEdit(coupon: Coupon): void {
    setDraft(couponDraftFrom(coupon));
    setCreating(false);
    setEditing(coupon);
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
      if (isCreate) {
        await platform.post('/coupons', couponCreatePayload(draft));
        toast.success(`Coupon ${draft.code.trim()} created.`);
      } else if (editing) {
        const payload = couponPatchPayload(draft, editing);
        if (Object.keys(payload).length === 0) {
          toast('Nothing changed.');
          setBusy(false);
          closeDialog();
          return;
        }
        await platform.patch(`/coupons/${editing.id}`, payload);
        toast.success(`Coupon ${editing.code} updated.`);
      }
      setCreating(false);
      setEditing(null);
      coupons.reload();
    } catch (error) {
      setDialogError(error instanceof Error ? error.message : 'The coupon could not be saved.');
    } finally {
      setBusy(false);
    }
  }

  async function confirmRemove(): Promise<void> {
    if (!removing) return;
    try {
      await platform.remove(`/coupons/${removing.id}`);
      toast.success(
        (removing.redemptions ?? 0) > 0
          ? `${removing.code} deactivated — its redemption history is kept.`
          : `${removing.code} deleted.`,
      );
      setRemoving(null);
      coupons.reload();
    } catch (error) {
      setRemoving(null);
      setActionError(error instanceof Error ? error.message : 'The coupon could not be removed.');
    }
  }

  const columns: Column<Coupon>[] = [
    {
      key: 'code',
      header: 'Code',
      pinned: true,
      sortable: (a, b) => a.code.localeCompare(b.code),
      render: (coupon) => <span className="figure font-medium text-text-primary">{coupon.code}</span>,
    },
    {
      key: 'discount',
      header: 'Discount',
      align: 'right',
      render: (coupon) => couponDiscount(coupon),
    },
    {
      key: 'state',
      header: 'State',
      render: (coupon) => {
        const value = couponState(coupon);
        return <Badge tone={STATE_TONE[value]}>{STATE_LABEL[value]}</Badge>;
      },
    },
    {
      key: 'redemptions',
      header: 'Redeemed',
      align: 'right',
      sortable: (a, b) => (a.redemptions ?? 0) - (b.redemptions ?? 0),
      render: (coupon) =>
        coupon.max_redemptions == null
          ? `${formatNumber(coupon.redemptions ?? 0)} · uncapped`
          : `${formatNumber(coupon.redemptions ?? 0)} of ${formatNumber(coupon.max_redemptions)}`,
    },
    {
      key: 'expires',
      header: 'Expires',
      secondary: true,
      render: (coupon) => (coupon.expires_at ? formatDate(coupon.expires_at) : 'Never'),
    },
    {
      key: 'plans',
      header: 'Scope',
      secondary: true,
      render: (coupon) =>
        coupon.applies_to_plan_ids && coupon.applies_to_plan_ids.length > 0
          ? `${formatNumber(coupon.applies_to_plan_ids.length)} plan${coupon.applies_to_plan_ids.length === 1 ? '' : 's'}`
          : 'Every plan',
    },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      render: (coupon) => (
        <span className="flex justify-end gap-1.5">
          <Button size="sm" variant="ghost" onClick={() => startEdit(coupon)}>
            Edit
          </Button>
          {/* A row already deactivated and already redeemed has nothing left to
              offer: it cannot be deleted (the redemptions are a record) and it
              cannot be deactivated twice. It was still showing "Deactivate",
              which does nothing. */}
          {coupon.is_active || (coupon.redemptions ?? 0) === 0 ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setActionError(null);
                setRemoving(coupon);
              }}
            >
              {(coupon.redemptions ?? 0) > 0 ? 'Deactivate' : 'Delete'}
            </Button>
          ) : null}
        </span>
      ),
    },
  ];

  if (coupons.forbidden) {
    return (
      <LockedState title={FORBIDDEN_TITLE} description={forbiddenDescription('coupons')} />
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
        title="Coupons"
        description="Recorded here and honoured by hand; there is no online redemption."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <SegmentedControl
              size="sm"
              label="Coupon state"
              value={state}
              onChange={(next) => url.set({ state: next === 'all' ? null : next })}
              items={stateFilters}
            />
            <Button variant="primary" size="sm" onClick={startCreate} iconLeft={<Plus aria-hidden className="h-3.5 w-3.5" />}>
              New coupon
            </Button>
          </div>
        }
      >
        <DataTable
          caption="Coupons"
          columns={columns}
          rows={pageRows}
          rowKey={(coupon) => String(coupon.id)}
          rowLabel={(coupon) => coupon.code}
          rowNoun="coupon"
          loading={coupons.loading && coupons.items.length === 0}
          error={coupons.error}
          onRetry={coupons.reload}
          pageSize={PAGE_SIZE}
          page={page}
          onPageChange={(next) => url.set({ page: next })}
          rowCount={filtered.length}
          empty={
            <EmptyState
              title={state === 'all' ? 'No coupons exist' : 'No coupon is in that state'}
              description={
                state === 'all'
                  ? 'Nothing has been created. Because redemption is manual, a coupon is only worth creating when somebody is going to honour it.'
                  : 'Clear the filter to see the rest.'
              }
              action={
                state === 'all' ? (
                  <Button size="sm" onClick={startCreate}>
                    New coupon
                  </Button>
                ) : (
                  <Button size="sm" onClick={() => url.set({ state: null })}>
                    Clear filter
                  </Button>
                )
              }
            />
          }
        />
      </Section>

      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next) closeDialog();
        }}
        dismissible={!busy}
        title={isCreate ? 'New coupon' : `Edit ${editing?.code ?? 'coupon'}`}
        description="A coupon carries exactly one kind of discount. The API refuses a row with both or neither."
        footer={
          <>
            <Button variant="ghost" disabled={busy} onClick={closeDialog}>
              Cancel
            </Button>
            <Button variant="primary" loading={busy} onClick={save}>
              {isCreate ? 'Create coupon' : 'Save coupon'}
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

          <Field label="Code" required={isCreate} error={shown.code} hint="What somebody quotes when they ask for the discount.">
            <Input
              className="figure"
              autoComplete="off"
              value={draft.code}
              onChange={(event) => setDraft({ ...draft, code: event.target.value })}
            />
          </Field>

          <SegmentedControl
            label="Discount kind"
            value={draft.kind}
            onChange={(next) => setDraft({ ...draft, kind: next })}
            items={[
              { value: 'percent', label: 'Percentage' },
              { value: 'amount', label: 'Fixed amount' },
            ]}
          />

          {draft.kind === 'percent' ? (
            <Field label="Percent off" error={shown.percent_off} hint="0 to 100.">
              <Input
                className="figure"
                inputMode="numeric"
                value={draft.percent_off}
                onChange={(event) => setDraft({ ...draft, percent_off: event.target.value })}
              />
            </Field>
          ) : (
            <Field label="Amount off (INR paise)" error={shown.amount_off_cents} hint="Minor units, matching the plan columns.">
              <Input
                className="figure"
                inputMode="numeric"
                value={draft.amount_off_cents}
                onChange={(event) => setDraft({ ...draft, amount_off_cents: event.target.value })}
              />
            </Field>
          )}

          <Field
            label="Maximum redemptions"
            optional
            error={shown.max_redemptions}
            hint="Blank for uncapped."
          >
            <Input
              className="figure"
              inputMode="numeric"
              value={draft.max_redemptions}
              onChange={(event) => setDraft({ ...draft, max_redemptions: event.target.value })}
            />
          </Field>

          <Field label="Expires" error={shown.expires_at} hint="Blank never expires.">
            <DatePicker
              label="Expires"
              value={draft.expires_at || null}
              onValueChange={(value) => setDraft({ ...draft, expires_at: value ?? '' })}
              clearable
            />
          </Field>

          {!isCreate ? (
            <SettingGroup>
              <SettingRow label="Active" description="A deactivated coupon is refused even when its window is still open.">
                <Switch
                  label="Active"
                  hideLabel
                  checked={draft.is_active}
                  onCheckedChange={(checked) => setDraft({ ...draft, is_active: checked })}
                />
              </SettingRow>
            </SettingGroup>
          ) : null}
        </div>
      </Dialog>

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(next) => {
          if (!next) setRemoving(null);
        }}
        destructive
        title={
          (removing?.redemptions ?? 0) > 0
            ? `Deactivate ${removing?.code ?? 'this coupon'}?`
            : `Delete ${removing?.code ?? 'this coupon'}?`
        }
        confirmLabel={(removing?.redemptions ?? 0) > 0 ? 'Deactivate' : 'Delete'}
        onConfirm={confirmRemove}
        description={
          (removing?.redemptions ?? 0) > 0 ? (
            <>
              This coupon has been redeemed, so it is deactivated rather than deleted and its attribution
              history stays intact.
            </>
          ) : (
            <>
              This coupon has never been redeemed, so it is deleted outright. There is nothing to recover it
              from.
            </>
          )
        }
      />
    </Stack>
  );
}
