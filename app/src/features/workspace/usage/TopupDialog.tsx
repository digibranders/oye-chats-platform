import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Zap } from 'lucide-react';
import {
  Alert,
  Badge,
  Button,
  Dialog,
  EmptyState,
  ErrorState,
  LoadingRows,
  RadioCards,
  formatNumber,
} from '../../../ui';
import {
  getTopupPacks,
  initiateTopup,
  recordBillingEvent,
  verifyTopupPayment,
} from '../../../services/api';
import { openRazorpayCheckout } from '../../../lib/razorpay';
import { CHARGE_CURRENCY, errorMessage, formatMoneyMinor } from '../billingModel';
import { TaxNote } from '../billing/TaxNote';
import { describeTopupExpiry, type CreditBalance } from '../usage-model';

interface TopupPack {
  /** INR charge amount in MAJOR units (rupees) - the canonical price on the Razorpay rail. */
  inr?: number;
  /** Legacy alias for the INR charge amount. */
  amount?: number;
  /** USD display price. Never charged. */
  usd?: number;
  display_amount?: number;
  display_currency?: string;
  currency?: string;
  credits: number;
  bonus_pct?: number;
  badge?: string;
}

/** The INR amount Razorpay charges for a pack. Never the USD display figure. */
function chargeInr(pack: TopupPack): number {
  return Number(pack.inr ?? pack.amount ?? 0);
}

/** The single pack to promote: the first badged one, else the highest-bonus one. */
function featuredIndex(packs: TopupPack[]): number {
  const badged = packs.findIndex((pack) => pack.badge);
  if (badged !== -1) return badged;
  let best = -1;
  let bestBonus = 0;
  packs.forEach((pack, index) => {
    const bonus = pack.bonus_pct ?? 0;
    if (bonus > bestBonus) {
      bestBonus = bonus;
      best = index;
    }
  });
  return best;
}

export interface TopupDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Display currency from the geo profile. The charge is always INR. */
  displayCurrency: string;
  /** The whole-workspace balance, used only for the expiry claim. */
  balance: CreditBalance | null;
  /** Scope the purchase to one agent's isolated ledger. Null tops up the shared pool. */
  botId: number | null;
  botName: string | null;
  onPurchased: (message: string) => void;
  onBillingDetailsRequired: (missing: string[]) => void;
}

/**
 * Buying credits.
 *
 * Two things make this a money surface. The pack's INR price is the charge, and
 * the USD figure beside it for a non-IN buyer is display only - so the dialog
 * shows the INR amount alongside whenever the two differ rather than letting a
 * converted number stand in for the debit. And it cannot be dismissed while a
 * purchase is in flight: a customer who closes the sheet mid-charge cannot tell
 * whether they were charged, and neither can we until it settles.
 *
 * Expiry is stated from the customer's own ledger and never from a slogan.
 * "Top-up credits never expire" is a term of sale that is true only when the
 * server's `topup_expiry_months` is zero, which no endpoint exposes - so a
 * customer holding a dated grant is told the date, one holding undated grants
 * is told they do not expire, and one holding none is told nothing at all.
 */
export function TopupDialog({
  open,
  onOpenChange,
  displayCurrency,
  balance,
  botId,
  botName,
  onPurchased,
  onBillingDetailsRequired,
}: TopupDialogProps) {
  const [busyAmount, setBusyAmount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // The pack the customer has selected, by index. Null means "fall back to the
  // recommended one", so the dialog always opens with a live, actionable choice.
  const [selectedValue, setSelectedValue] = useState<string | null>(null);

  const packs = useQuery({
    queryKey: ['billing', 'topup-packs'] as const,
    queryFn: async () => {
      const rows = await getTopupPacks();
      return (Array.isArray(rows) ? rows : []) as unknown as TopupPack[];
    },
    enabled: open,
    staleTime: 10 * 60_000,
  });

  useEffect(() => {
    if (open) {
      setError(null);
      setNotice(null);
      // Re-open with the recommended pack, not whatever was left selected last
      // time — the recommendation may have changed and the balance certainly has.
      setSelectedValue(null);
    }
  }, [open]);

  const showsUsd = displayCurrency.toUpperCase() === 'USD';
  const expiryNote = balance ? describeTopupExpiry(balance) : null;

  async function buy(pack: TopupPack) {
    const amount = chargeInr(pack);
    if (!amount) {
      setError('This pack is misconfigured and has no price. Please choose another.');
      return;
    }
    setBusyAmount(amount);
    setError(null);
    setNotice(null);
    try {
      const order = (await initiateTopup(amount, {
        botId: botId ?? undefined,
      })) as Record<string, unknown>;
      if (!order.key_id || !order.order_id || !order.amount) {
        setError('Checkout is temporarily unavailable. Please try again in a moment.');
        return;
      }
      const response = await openRazorpayCheckout({
        key: String(order.key_id),
        order_id: String(order.order_id),
        amount: Number(order.amount),
        currency: (order.currency as string) || CHARGE_CURRENCY,
        name: (order.name as string) || 'OyeChats credits',
        description: order.description as string | undefined,
        prefill: (order.prefill as Record<string, unknown>) || {},
        // Tokenise on success so a repeat top-up needs only a CVV. Razorpay
        // requires both fields; consent is collected inside its own UI and we
        // never see the card number.
        customer_id: order.customer_id as string | undefined,
        save: order.customer_id ? 1 : undefined,
      });
      try {
        await verifyTopupPayment({
          razorpay_order_id: response.razorpay_order_id ?? String(order.order_id),
          razorpay_payment_id: response.razorpay_payment_id,
          razorpay_signature: response.razorpay_signature,
        });
      } catch {
        // The money has already moved: the charge succeeded and only our
        // confirmation of it failed. This is deliberately OUR sentence and not
        // the server's, because the gateway's own wording ("verification
        // failed") reads as a payment failure and would send a customer who has
        // already paid back to the pay button.
        setError(
          'Your payment went through but we could not confirm it here. The credits usually appear within a minute. Contact support if they do not, and do not pay again.',
        );
        return;
      }
      onPurchased(`Payment received. ${formatNumber(pack.credits)} credits are on their way.`);
      onOpenChange(false);
    } catch (cause) {
      const code = (cause as { code?: string })?.code;
      if (code === 'dismissed') {
        void recordBillingEvent('checkout_abandoned', 'topup', { amount });
        setNotice('Payment cancelled. You have not been charged.');
        return;
      }
      if (code === 'payment_failed') {
        void recordBillingEvent('payment_failed', 'topup', { amount });
      }
      const detail =
        (
          cause as {
            detail?: unknown;
            response?: { data?: { detail?: unknown } };
          }
        )?.response?.data?.detail ?? (cause as { detail?: unknown })?.detail;
      if (
        detail &&
        typeof detail === 'object' &&
        (detail as { code?: string }).code === 'billing_details_required'
      ) {
        onOpenChange(false);
        onBillingDetailsRequired((detail as { missing?: string[] }).missing ?? []);
        return;
      }
      setError(errorMessage(cause, 'We could not start the checkout.'));
    } finally {
      setBusyAmount(null);
    }
  }

  const packsData = packs.data ?? [];
  const featured = featuredIndex(packsData);
  const busy = busyAmount !== null;

  // The selection, resolved: an explicit choice, else the recommended pack, else
  // the first one. Kept as a string because that is what a radiogroup value is.
  const defaultValue = packsData.length > 0 ? String(featured >= 0 ? featured : 0) : '';
  const effectiveValue = selectedValue ?? defaultValue;
  const selectedPack = packsData[Number(effectiveValue)] ?? null;

  const packItems = packsData.map((pack, index) => {
    const amountInr = chargeInr(pack);
    const usdMajor = Number(pack.usd ?? pack.display_amount ?? 0);
    const showUsd = showsUsd && usdMajor > 0;
    const price = showUsd
      ? formatMoneyMinor(Math.round(usdMajor * 100), 'USD')
      : formatMoneyMinor(amountInr * 100, CHARGE_CURRENCY);
    return {
      value: String(index),
      // The price leads; the badge names the one worth recommending, which is
      // how "best value" is highlighted now that the border means "selected".
      label: price,
      badge: pack.badge ? <Badge tone="plan">{pack.badge}</Badge> : undefined,
      description: (
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="figure font-semibold text-text-primary">
            {formatNumber(pack.credits)}
          </span>
          credits
          {(pack.bonus_pct ?? 0) > 0 ? <Badge tone="success">+{pack.bonus_pct}% bonus</Badge> : null}
          {showUsd ? (
            <span className="block w-full text-text-tertiary">
              Charged as {formatMoneyMinor(amountInr * 100, CHARGE_CURRENCY)}
            </span>
          ) : null}
        </span>
      ),
      disabled: amountInr <= 0,
    };
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && busy) return;
        onOpenChange(next);
      }}
      // Never dismissible mid-purchase.
      dismissible={!busy}
      title={botName ? `Top up ${botName}` : 'Buy credits'}
      description={`${
        botName
          ? `A one-time purchase that lands in ${botName}'s own balance, on top of its plan.`
          : 'A one-time purchase, on top of your plan allowance.'
      } Paid through Razorpay by UPI, card, NetBanking or wallet.${expiryNote ? ` ${expiryNote}` : ''}`}
      size="lg"
      // The purchase is now a deliberate two-step: choose a pack above, pay from
      // the footer. The primary action names the credits it buys rather than a
      // price, because the button commits to the gross (base + GST) while the
      // cards quote the base — naming a figure here would understate the debit.
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => selectedPack && void buy(selectedPack)}
            loading={busy}
            disabled={busy || !selectedPack}
          >
            {selectedPack ? `Buy ${formatNumber(selectedPack.credits)} credits` : 'Buy credits'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error ? (
          <Alert tone="danger" live title="That did not complete">
            {error}
          </Alert>
        ) : null}
        {notice && !error ? (
          <Alert tone="neutral" live>
            {notice}
          </Alert>
        ) : null}

        {packs.isPending ? (
          <LoadingRows rows={2} />
        ) : packs.isError ? (
          <ErrorState
            size="panel"
            title="We could not load the credit packs"
            description={errorMessage(packs.error, 'The pricing service did not answer.')}
            onRetry={() => void packs.refetch()}
          />
        ) : packsData.length === 0 ? (
          <EmptyState
            size="panel"
            icon={Zap}
            title="No credit packs are available right now"
            description="This is usually temporary. If it persists, contact support and we will arrange a top-up manually."
          />
        ) : (
          // Selecting a pack no longer starts a checkout: it marks the choice,
          // and the footer's pay button commits it. A card that charged money on
          // its first click had no control saying so, and its recommended pack
          // wore the same heavy border that now means "selected".
          <RadioCards
            label="Credit pack"
            columns={2}
            value={effectiveValue}
            onChange={setSelectedValue}
            items={packItems}
          />
        )}

        {/* The pack prices above are BASE prices; Razorpay debits the gross.
            This is the last screen before the payment sheet, so it is the last
            place the difference can be disclosed. */}
        <TaxNote />
      </div>
    </Dialog>
  );
}
