import { useState } from 'react';
import { Alert, Button, Dialog, Field, Input } from '../../../ui';
import { changeOperatorSeats } from '../../../services/api';
import {
  CHARGE_CURRENCY,
  formatMoneyMinor,
  formatSeatAllowance,
  UNLIMITED_LIMIT,
  type PlanView,
} from '../billingModel';

export interface SeatDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  plan: PlanView | null;
  /** Seats currently provisioned on the subscription. */
  currentSeats: number;
  /** Seats actually filled by an active operator. The floor for a reduction. */
  seatsUsed: number;
  botId?: number | null;
  onChanged: (message: string) => void;
}

/**
 * Adding or removing operator seats.
 *
 * Adding a seat can open a Razorpay authorisation for the new mandate amount,
 * so the dialog holds itself open while the request is in flight: a customer
 * who dismisses mid-charge cannot tell whether they were charged. Removing one
 * applies immediately and is free, and the two are told apart in the copy so a
 * reduction never reads as a purchase.
 */
export function SeatDialog({
  open,
  onOpenChange,
  plan,
  currentSeats,
  seatsUsed,
  botId = null,
  onChanged,
}: SeatDialogProps) {
  const [target, setTarget] = useState(String(currentSeats));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const included = plan?.includedSeats ?? 0;
  const unlimited = included === UNLIMITED_LIMIT;
  const parsed = Number.parseInt(target, 10);
  const valid = Number.isFinite(parsed) && parsed >= 0 && parsed <= 999;
  const delta = valid ? parsed - currentSeats : 0;
  const extra = unlimited ? 0 : Math.max(parsed - included, 0);
  const monthlyExtraMinor = unlimited ? 0 : extra * (plan?.extraSeatPriceMinor ?? 0);
  const belowUsed = valid && parsed < seatsUsed;

  async function submit() {
    if (!valid || delta === 0 || belowUsed) return;
    setBusy(true);
    setError(null);
    try {
      await changeOperatorSeats(delta, botId);
      onChanged(
        delta > 0
          ? `Added ${delta} seat${delta === 1 ? '' : 's'}. Your workspace now has ${parsed}.`
          : `Removed ${-delta} seat${delta === -1 ? '' : 's'}. Your workspace now has ${parsed}.`,
      );
      onOpenChange(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'We could not change your seat count.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && busy) return;
        if (next) {
          setTarget(String(currentSeats));
          setError(null);
        }
        onOpenChange(next);
      }}
      // A seat increase can open a payment authorisation. Never dismissible
      // while that is in flight.
      dismissible={!busy}
      title="Operator seats"
      description={`${formatSeatAllowance(included)} are included in your plan. Extra seats are billed monthly alongside it.`}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={busy || !valid || delta === 0 || belowUsed}>
            {busy ? 'Working…' : delta > 0 ? 'Add seats' : 'Update seats'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field
          label="Total operator seats"
          hint={`${seatsUsed} of ${currentSeats} filled.`}
          error={
            belowUsed
              ? `You have ${seatsUsed} active operators. Deactivate one before reducing to ${parsed}.`
              : !valid
                ? 'Enter a whole number between 0 and 999.'
                : undefined
          }
        >
          <Input
            type="number"
            min={0}
            max={999}
            inputMode="numeric"
            value={target}
            onChange={(event) => setTarget(event.target.value)}
          />
        </Field>

        {valid && delta !== 0 ? (
          <Alert tone={delta > 0 ? 'plan' : 'neutral'}>
            {delta > 0
              ? monthlyExtraMinor > 0
                ? `Your monthly charge for extra seats becomes ${formatMoneyMinor(monthlyExtraMinor, CHARGE_CURRENCY)}. You may be asked to authorise the new amount.`
                : 'These seats are within your plan allowance, so nothing extra is charged.'
              : 'Removing seats applies straight away and reduces your next charge. You are not refunded for the current period.'}
          </Alert>
        ) : null}

        {error ? (
          <Alert tone="danger" live>
            {error}
          </Alert>
        ) : null}
      </div>
    </Dialog>
  );
}
