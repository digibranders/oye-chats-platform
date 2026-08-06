import { useState, type ReactElement } from 'react';
import { AlertCircle, Minus, Plus } from 'lucide-react';
import { Button, Modal } from '../../../design-system';
import { openRazorpayCheckout } from '../../../lib/razorpay';
import { changeOperatorSeats, recordBillingEvent, verifyRazorpaySubscription } from '../../../services/api';

export interface SeatChangeDialogProps {
  open: boolean;
  onClose: () => void;
  /** +1 to add a seat, -1 to remove one. */
  delta: number;
  /** Current total seat count, for the before/after summary. */
  currentSeats: number;
  /** Formatted per-seat price, e.g. "₹449/mo". */
  seatPriceLabel: string;
  /** Selected agent id: scopes the seat change to that agent's subscription (null = account). */
  botId?: number | null;
  /** Fired after a successful change with a status message. */
  onSuccess: (message: string) => void;
}

/**
 * SeatChangeDialog - confirms an operator-seat add/remove BEFORE touching the
 * subscription, so the customer sees the price + payment provider first. Ported
 * from the legacy `confirmSeatChange`: on a first seat purchase the backend
 * returns `requires_authorization` + a `checkout` payload, so we open Razorpay
 * to authorise the mandate; seats activate via webhook (we don't reflect them
 * until the reload). A user-dismissed modal is not an error.
 */
export function SeatChangeDialog({
  open,
  onClose,
  delta,
  currentSeats,
  seatPriceLabel,
  botId = null,
  onSuccess,
}: SeatChangeDialogProps): ReactElement | null {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const isAdd = delta > 0;
  const nextSeats = currentSeats + delta;

  async function confirm(): Promise<void> {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = (await changeOperatorSeats(delta, botId)) as Record<string, unknown>;

      if (result?.requires_authorization && result?.checkout) {
        const c = result.checkout as Record<string, unknown>;
        let cb: Awaited<ReturnType<typeof openRazorpayCheckout>>;
        try {
          cb = await openRazorpayCheckout({
            key: String(c.key_id),
            subscription_id: String(c.subscription_id),
            name: (c.name as string) || 'OyeChats operator seats',
            description: c.description as string | undefined,
            prefill: c.prefill as Record<string, unknown> | undefined,
            theme: c.theme as Record<string, unknown> | undefined,
          });
        } catch (err: unknown) {
          if ((err as { code?: string })?.code === 'dismissed') {
            void recordBillingEvent('checkout_abandoned', 'seat', { delta });
            setNotice('Seat purchase cancelled - you were not charged.');
            return;
          }
          if ((err as { code?: string })?.code === 'payment_failed') {
            void recordBillingEvent('payment_failed', 'seat', { delta });
          }
          throw err;
        }
        // Verify server-side like every other checkout on this page. Skipping it
        // left the seat mandate entirely dependent on the webhook: if that was
        // delayed or lost, the customer had authorised (and would be billed for)
        // seats this platform had no record of. Verify reconciles synchronously;
        // the webhook stays the canonical path and is idempotent against it.
        // A verification failure is NOT a purchase failure - the mandate is
        // already authorised - so it only softens the message.
        let reconciled = true;
        try {
          await verifyRazorpaySubscription({
            razorpay_payment_id: cb.razorpay_payment_id,
            razorpay_subscription_id: cb.razorpay_subscription_id || String(c.subscription_id),
            razorpay_signature: cb.razorpay_signature,
          });
        } catch {
          reconciled = false;
        }
        onSuccess(
          reconciled
            ? 'Seat add-on authorised - your seats will activate in a moment.'
            : 'Payment authorised - we’re finalising your seat change.',
        );
        onClose();
        return;
      }

      const qty = result?.operator_quantity;
      onSuccess(
        isAdd
          ? `Added a seat${qty != null ? ` (now ${qty} total)` : ''}.`
          : `Removed a seat${qty != null ? ` (now ${qty} total)` : ''}.`,
      );
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Couldn’t update your seats. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  if (!open) return null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      dismissible={!busy}
      size="sm"
      title={isAdd ? 'Add an operator seat' : 'Remove an operator seat'}
      description={
        isAdd
          ? 'An extra seat lets one more operator handle live chats.'
          : 'Freeing a seat reduces your next invoice.'
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant={isAdd ? 'primary' : 'danger'} onClick={() => void confirm()} disabled={busy}>
            {isAdd ? <Plus size={16} /> : <Minus size={16} />}
            {busy ? 'Saving…' : isAdd ? 'Add seat' : 'Remove seat'}
          </Button>
        </>
      }
    >
      <dl className="space-y-2.5 text-[13px]">
        <div className="flex items-center justify-between gap-3">
          <dt className="text-[var(--ds-text-muted)]">Seats after change</dt>
          <dd className="font-medium tabular-nums text-[var(--ds-text)]">
            {currentSeats} → {nextSeats}
          </dd>
        </div>
        <div className="flex items-center justify-between gap-3">
          <dt className="text-[var(--ds-text-muted)]">Per-seat price</dt>
          <dd className="font-medium text-[var(--ds-text)]">{seatPriceLabel}</dd>
        </div>
      </dl>

      <p className="mt-4 text-[12px] leading-relaxed text-[var(--ds-text-subtle)]">
        {isAdd
          ? `This is a recurring charge - ${seatPriceLabel} is added to your subscription every billing cycle until you remove the seat. Billed via Razorpay and prorated for the rest of the current cycle. If this is your first extra seat, a secure checkout opens to authorise the payment mandate.`
          : 'The seat is released at the end of your current billing cycle; you keep it until then.'}
      </p>

      {notice && (
        <p role="status" className="mt-3 text-[12px] text-[var(--ds-text-muted)]">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-3 flex items-start gap-1.5 text-[12px] text-[var(--ds-danger)]">
          <AlertCircle size={13} className="mt-0.5 shrink-0" />
          {error}
        </p>
      )}
    </Modal>
  );
}
