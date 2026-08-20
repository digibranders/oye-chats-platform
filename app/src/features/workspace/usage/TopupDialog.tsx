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
  Spinner,
  cn,
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

  const featured = featuredIndex(packs.data ?? []);
  const busy = busyAmount !== null;

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
      // The two sentences are in the description, not alone on the sunken
      // button bar the footer slot paints — a bar with no control in it.
      footer={
        <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
          Done
        </Button>
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
        ) : (packs.data?.length ?? 0) === 0 ? (
          <EmptyState
            size="panel"
            icon={Zap}
            title="No credit packs are available right now"
            description="This is usually temporary. If it persists, contact support and we will arrange a top-up manually."
          />
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2">
            {(packs.data ?? []).map((pack, index) => {
              const amountInr = chargeInr(pack);
              const usdMajor = Number(pack.usd ?? pack.display_amount ?? 0);
              const showUsd = showsUsd && usdMajor > 0;
              const isBusy = busyAmount === amountInr;
              return (
                <li key={`${amountInr}-${pack.credits}-${index}`}>
                  <button
                    type="button"
                    onClick={() => void buy(pack)}
                    disabled={busy}
                    aria-busy={isBusy || undefined}
                    className={cn(
                      'w-full rounded-lg border bg-surface p-4 text-left transition-colors',
                      'hover:border-border-strong hover:bg-surface-hover',
                      'disabled:cursor-not-allowed disabled:opacity-60',
                      index === featured
                        ? 'border-plan shadow-[inset_0_0_0_1px_var(--color-plan)]'
                        : 'border-border',
                    )}
                  >
                    <span className="flex items-baseline justify-between gap-2">
                      <span className="figure text-lg font-semibold text-text-primary">
                        {showUsd
                          ? formatMoneyMinor(Math.round(usdMajor * 100), 'USD')
                          : formatMoneyMinor(amountInr * 100, CHARGE_CURRENCY)}
                      </span>
                      {pack.badge ? <Badge tone="plan">{pack.badge}</Badge> : null}
                    </span>
                    {showUsd ? (
                      <span className="mt-0.5 block text-xs text-text-secondary">
                        Charged as {formatMoneyMinor(amountInr * 100, CHARGE_CURRENCY)}
                      </span>
                    ) : null}
                    <span className="mt-2 flex flex-wrap items-center gap-1.5 text-base text-text-secondary">
                      {/* No pseudo-CTA. A blue "Pay securely" that is neither a
                          link nor focusable, inside a card that *is* the button,
                          makes blue mean "the thing around me is interactive" —
                          the collision DESIGN.md §2 exists to prevent. */}
                      {isBusy ? <Spinner /> : null}
                      <span className="figure font-semibold text-text-primary">
                        {formatNumber(pack.credits)}
                      </span>
                      credits
                      {(pack.bonus_pct ?? 0) > 0 ? (
                        <Badge tone="success">+{pack.bonus_pct}% bonus</Badge>
                      ) : null}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Dialog>
  );
}
