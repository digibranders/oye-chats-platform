import { useRef, useState } from 'react';
import { Alert, Button, Dialog, Field, Input } from '../../../ui';
import { changeOperatorSeats, verifyRazorpaySubscription } from '../../../services/api';
import { openRazorpayCheckout } from '../../../lib/razorpay';
import {
  CHARGE_CURRENCY,
  formatMoneyMinor,
  formatSeatAllowance,
  UNLIMITED_LIMIT,
  type PlanView,
} from '../billingModel';
import { TaxNote } from './TaxNote';

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
  const [notice, setNotice] = useState<string | null>(null);
  // A ref latch, not just `busy`: two clicks dispatched in the same React batch
  // both read the pre-update state, and each would mint its own seat mandate.
  // Same contract `usePlanCheckout` documents for the plan path.
  const inFlight = useRef(false);

  const included = plan?.includedSeats ?? 0;
  const unlimited = included === UNLIMITED_LIMIT;
  const parsed = Number.parseInt(target, 10);
  const valid = Number.isFinite(parsed) && parsed >= 0 && parsed <= 999;
  const delta = valid ? parsed - currentSeats : 0;
  const extra = unlimited ? 0 : Math.max(parsed - included, 0);
  const monthlyExtraMinor = unlimited ? 0 : extra * (plan?.extraSeatPriceMinor ?? 0);
  const belowUsed = valid && parsed < seatsUsed;

  async function submit() {
    if (!valid || delta === 0 || belowUsed || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = (await changeOperatorSeats(delta, botId)) as Record<string, unknown>;

      // The FIRST extra seat has no mandate yet, so the server answers
      // `requires_authorization` with a checkout and deliberately leaves
      // `operator_quantity` untouched. Discarding that (as this dialog used to)
      // told the customer their seats were added while no payment sheet had
      // opened and the backend had granted nothing.
      if (result.requires_authorization && result.checkout) {
        const checkout = result.checkout as Record<string, unknown>;
        let callback: Awaited<ReturnType<typeof openRazorpayCheckout>>;
        try {
          callback = await openRazorpayCheckout({
            key: String(checkout.key_id),
            subscription_id: String(checkout.subscription_id),
            name: typeof checkout.name === 'string' ? checkout.name : 'OyeChats operator seats',
            description: typeof checkout.description === 'string' ? checkout.description : undefined,
            prefill: checkout.prefill as Record<string, unknown> | undefined,
            theme: checkout.theme as Record<string, unknown> | undefined,
          });
        } catch (checkoutErr: unknown) {
          // A dismissed sheet is a decision, not a failure: nothing was
          // authorised and nothing was charged. Say exactly that, and do NOT
          // report a seat change upstream.
          if ((checkoutErr as { code?: string })?.code === 'dismissed') {
            setNotice('Seat purchase cancelled. You have not been charged.');
            return;
          }
          throw checkoutErr;
        }

        // Verify server-side like every other checkout here. The activation
        // webhook stays the canonical reconciler and is idempotent against
        // this, so a verification failure is NOT a purchase failure.
        let reconciled = true;
        try {
          await verifyRazorpaySubscription({
            razorpay_payment_id: callback.razorpay_payment_id,
            razorpay_subscription_id:
              callback.razorpay_subscription_id || String(checkout.subscription_id),
            razorpay_signature: callback.razorpay_signature,
          });
        } catch {
          reconciled = false;
        }

        // Deliberately does NOT name a new seat total: the entitlement moves
        // when the seat add-on's `activated` webhook lands, seconds from now.
        onChanged(
          reconciled
            ? 'Payment authorised. Your new seats switch on in a moment.'
            : 'Payment authorised. We are finalising your seats.',
        );
        onOpenChange(false);
        return;
      }

      // No mandate to authorise: a reduction, or an edit against an already
      // authorised add-on. The server applied it, so the count is real.
      onChanged(
        delta > 0
          ? `Added ${delta} seat${delta === 1 ? '' : 's'}. Your workspace now has ${parsed}.`
          : `Removed ${-delta} seat${delta === -1 ? '' : 's'}. Your workspace now has ${parsed}.`,
      );
      onOpenChange(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'We could not change your seat count.');
    } finally {
      inFlight.current = false;
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

        {/* Only where a seat charge is actually quoted. Removing seats and
            staying inside the plan allowance both name no figure, and a tax
            note there would qualify nothing. */}
        {valid && delta > 0 && monthlyExtraMinor > 0 ? <TaxNote /> : null}

        {/* An abandoned checkout is not a failure, so it gets neutral tone and
            its own line — red here would read as "your payment broke". */}
        {notice && !error ? (
          <Alert tone="neutral" live>
            {notice}
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
