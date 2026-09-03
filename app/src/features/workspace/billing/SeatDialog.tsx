import { useEffect, useRef, useState } from 'react';
import { Minus, Plus } from 'lucide-react';
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

/** Hard cap on the stepper when a plan defines no `limits.operators`. */
const ABSOLUTE_MAX_SEATS = 100;

export interface SeatDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  plan: PlanView | null;
  /** Seats currently provisioned on the subscription. */
  currentSeats: number;
  /** Seats actually filled by an active operator. See {@link seatsUsedScope}. */
  seatsUsed: number;
  /**
   * WHOSE operators `seatsUsed` counts.
   *
   * `'chatbot'` is this subscription's own filled seats, and only that count is
   * a floor for a reduction: the server checks the seats on THIS chatbot.
   * `'workspace'` is the account-wide figure, which the caller falls back to
   * when the per-chatbot count is unavailable. It is stated, never enforced:
   * blocking on it refused reductions the server would have accepted.
   */
  seatsUsedScope?: 'chatbot' | 'workspace';
  /**
   * What ONE extra seat debits per month, tax included, in the charge currency.
   * From the server, NOT from `plan.extraSeatPriceMinor` — see below. Null while
   * the charge currency is resolving, and a null is never quoted.
   */
  grossSeatPriceMinor: number | null;
  /** GST rate behind that figure. 0 on the export rail. */
  taxRateBps: number | null;
  botId?: number | null;
  onChanged: (message: string) => void;
  /**
   * Open the plan picker. The only useful action on a plan with no seat
   * headroom, and it is a dialog rather than a route: this one is already ON
   * the billing page, so a link back to it would go nowhere.
   */
  onUpgrade?: () => void;
}

/**
 * Adding or removing operator seats.
 *
 * **The price comes from the server, not from the plan row.** Every extra seat
 * bills against one global Razorpay seat plan, so the amount charged is the
 * canonical seat price. A plan row carries a copy of it that is deliberately `0`
 * on Free, the trial and Enterprise — tiers that sell no seats. This dialog used
 * to multiply that copy, so on exactly those tiers it quoted nothing and then
 * told the customer "these seats are within your plan allowance, so nothing
 * extra is charged" while the server would have charged the canonical price. A
 * purchase surface that names the wrong number is worse than one that names no
 * number, and this one named zero.
 *
 * **Three different plans reach this dialog and only one can buy.** A plan may
 * include unlimited seats (nothing to sell), or grant no headroom at all between
 * its included count and its `limits.operators` ceiling (nothing to sell, and on
 * Free nothing that could even be used, because the ceiling also caps operator
 * creation). Both are answered in words here rather than by a stepper that
 * cannot move and a server error the customer has to trigger to read.
 *
 * Adding a seat can open a Razorpay authorisation, so the dialog holds itself
 * open while that is in flight: a customer who dismisses mid-charge cannot tell
 * whether they were charged. Removing one applies immediately and is free, and
 * the two are told apart in the copy so a reduction never reads as a purchase.
 */
export function SeatDialog({
  open,
  onOpenChange,
  plan,
  currentSeats,
  seatsUsed,
  seatsUsedScope = 'chatbot',
  grossSeatPriceMinor,
  taxRateBps,
  botId = null,
  onChanged,
  onUpgrade,
}: SeatDialogProps) {
  const [target, setTarget] = useState(String(currentSeats));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // A ref latch, not just `busy`: two clicks dispatched in the same React batch
  // both read the pre-update state, and each would mint its own seat mandate.
  // Same contract `usePlanCheckout` documents for the plan path.
  const inFlight = useRef(false);

  // Reset on open. `notice` in particular: it used to be cleared only inside
  // `submit`, so "Seat purchase cancelled. You have not been charged." survived
  // a close and reappeared over a fresh, untouched dialog — telling someone who
  // had just opened it that a purchase they had not made was cancelled.
  useEffect(() => {
    if (!open) return;
    setTarget(String(currentSeats));
    setError(null);
    setNotice(null);
  }, [open, currentSeats]);

  const included = plan?.includedSeats ?? 0;
  const unlimited = included === UNLIMITED_LIMIT;

  // `limits.operators` is the hard ceiling: it caps what billing may sell AND
  // what `operator_routes.create_operator` will let the workspace create, so a
  // seat sold above it is capacity that can never be used.
  const rawCeiling = plan?.limits?.operators;
  const hasCeiling = typeof rawCeiling === 'number' && rawCeiling !== UNLIMITED_LIMIT;
  const maxSeats = hasCeiling ? rawCeiling : ABSOLUTE_MAX_SEATS;
  const noHeadroom = !unlimited && hasCeiling && maxSeats <= included;

  const parsed = Number.parseInt(target, 10);
  const valid = Number.isFinite(parsed) && parsed >= 0 && parsed <= ABSOLUTE_MAX_SEATS;
  const delta = valid ? parsed - currentSeats : 0;
  const extra = unlimited ? 0 : Math.max(parsed - included, 0);
  const priceKnown = grossSeatPriceMinor !== null && grossSeatPriceMinor > 0;
  const monthlyExtraMinor = priceKnown ? extra * (grossSeatPriceMinor as number) : 0;
  // Only a per-chatbot count is a floor. The account-wide fallback counts
  // operators on chatbots this subscription does not pay for, so enforcing it
  // refused reductions `POST /subscriptions/seats` would have accepted, and
  // said "deactivate one" about people the customer would have had to find on
  // another chatbot entirely.
  const perChatbotCount = seatsUsedScope === 'chatbot';
  const below = valid && parsed < seatsUsed;
  const belowUsed = below && perChatbotCount;
  const belowWorkspaceUsed = below && !perChatbotCount;
  const aboveCeiling = valid && parsed > maxSeats;
  // Never let someone commit to a charge whose figure we could not load.
  const quoteMissing = valid && delta > 0 && extra > 0 && !priceKnown;
  const taxIncluded = (taxRateBps ?? 0) > 0;

  const blocked = !valid || delta === 0 || belowUsed || aboveCeiling || quoteMissing;

  function step(by: number) {
    const from = Number.isFinite(parsed) ? parsed : currentSeats;
    const next = Math.min(Math.max(from + by, 0), maxSeats);
    setNotice(null);
    setTarget(String(next));
  }

  async function submit() {
    if (blocked || inFlight.current) return;
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

  // ── Plans with nothing to sell ────────────────────────────────────────────
  // Answered in words, and with the one control that helps, rather than with a
  // stepper that cannot move.
  const informational = unlimited || noHeadroom;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && busy) return;
        onOpenChange(next);
      }}
      // A seat increase can open a payment authorisation. Never dismissible
      // while that is in flight.
      dismissible={!busy}
      title="Operator seats"
      description={
        unlimited
          ? 'Your plan includes unlimited operator seats.'
          : `${formatSeatAllowance(included)} included in your plan.`
      }
      size="sm"
      footer={
        informational ? (
          <>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Close
            </Button>
            {noHeadroom && onUpgrade ? (
              <Button
                onClick={() => {
                  onOpenChange(false);
                  onUpgrade();
                }}
              >
                See plans
              </Button>
            ) : null}
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={() => void submit()} disabled={busy || blocked}>
              {busy ? 'Working…' : delta > 0 ? 'Continue to checkout' : 'Update seats'}
            </Button>
          </>
        )
      }
    >
      {informational ? (
        <div className="space-y-3 text-prose text-text-secondary">
          {unlimited ? (
            <p>
              Every teammate you add gets a seat at no extra cost, so there is nothing to buy or
              remove here.
            </p>
          ) : (
            <p>
              {included > 0
                ? `Your plan allows ${included} operator seat${included === 1 ? '' : 's'} and cannot take more.`
                : 'Your plan does not include operator seats.'}{' '}
              A larger plan comes with more seats, and lets you buy extra ones on top.
            </p>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          <Field
            label="Total operator seats"
            /* Every term is this chatbot's, so none of them needs qualifying.
               When the filled count is the account-wide fallback it says so,
               rather than sitting unlabelled beside two per-chatbot figures. */
            hint={`${seatsUsed} filled${perChatbotCount ? '' : ' across this workspace'} · ${included} included · up to ${maxSeats} on this plan`}
            error={
              belowUsed
                ? `You have ${seatsUsed} active operator${seatsUsed === 1 ? '' : 's'} on this chatbot. Deactivate one before reducing to ${parsed}.`
                : aboveCeiling
                  ? `Your plan allows up to ${maxSeats} seats. Upgrade for more.`
                  : !valid
                    ? `Enter a whole number between 0 and ${ABSOLUTE_MAX_SEATS}.`
                    : undefined
            }
          >
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                aria-label="Remove one seat"
                disabled={busy || (Number.isFinite(parsed) ? parsed <= 0 : false)}
                onClick={() => step(-1)}
                iconLeft={<Minus aria-hidden />}
              />
              <Input
                type="number"
                min={0}
                max={maxSeats}
                inputMode="numeric"
                className="figure w-24 text-center"
                value={target}
                onChange={(event) => {
                  setNotice(null);
                  setTarget(event.target.value);
                }}
              />
              <Button
                variant="secondary"
                size="sm"
                aria-label="Add one seat"
                disabled={busy || (Number.isFinite(parsed) ? parsed >= maxSeats : false)}
                onClick={() => step(1)}
                iconLeft={<Plus aria-hidden />}
              />
            </div>
          </Field>

          {/* The price, always, whether or not the current target crosses the
              included allowance. Someone deciding whether to add a seat needs
              the per-seat figure before they touch the stepper. */}
          {priceKnown ? (
            <div className="rounded-md border border-border bg-surface-sunken px-3 py-2.5 text-sm">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-text-secondary">Each extra seat</span>
                <span className="figure font-medium text-text-primary">
                  {formatMoneyMinor(grossSeatPriceMinor as number, CHARGE_CURRENCY)}/mo
                </span>
              </div>
              <div className="mt-1.5 flex items-baseline justify-between gap-3 border-t border-border pt-1.5">
                <span className="text-text-secondary">
                  {extra > 0 ? `${extra} extra seat${extra === 1 ? '' : 's'}` : 'No extra seats'}
                </span>
                <span className="figure font-semibold text-text-primary">
                  {formatMoneyMinor(monthlyExtraMinor, CHARGE_CURRENCY)}/mo
                </span>
              </div>
              {taxIncluded ? (
                <p className="mt-1.5 text-xs text-text-tertiary">GST included.</p>
              ) : null}
            </div>
          ) : quoteMissing ? (
            <Alert tone="warning">
              We could not load the seat price just now, so we will not start a purchase. Reopen
              this in a moment.
            </Alert>
          ) : null}

          {/* A caution, not a refusal. The figure is real but it is the wrong
              scope to bound this subscription, so it explains what could come
              back from the server instead of pre-empting it. */}
          {belowWorkspaceUsed ? (
            <Alert tone="warning">
              {`${seatsUsed} operators are active across this workspace, on every chatbot together. If more than ${parsed} of them are on this chatbot, this change is refused and we will say so.`}
            </Alert>
          ) : null}

          {valid && delta !== 0 && !belowUsed && !aboveCeiling ? (
            <Alert tone={delta > 0 ? 'plan' : 'neutral'}>
              {delta > 0
                ? monthlyExtraMinor > 0
                  ? 'A secure checkout opens so you can authorise the new monthly amount.'
                  : 'These seats are within the allowance your plan already includes, so nothing extra is charged.'
                : 'Removing seats applies straight away and reduces your next charge. You are not refunded for the current period.'}
            </Alert>
          ) : null}

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
      )}
    </Dialog>
  );
}
