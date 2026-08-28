import { useCallback, useEffect, useRef, useState } from 'react';
import {
  cancelBrandingAddon,
  getEntitlements,
  purchaseBrandingAddon,
  recordBillingEvent,
  verifyRazorpaySubscription,
} from '../../../services/api';
import { openRazorpayCheckout } from '../../../lib/razorpay';
import { pollUntil } from '../../../lib/pollUntil';
import { useEntitlements } from '../../../hooks/useEntitlements';
import { useCurrency } from '../../../context/CurrencyContext';
import { formatMoneyMinor } from '../billingModel';
import type { PurchasePhase } from '../../../ui';

/**
 * useBrandingAddon - the one money-path for the branding-removal add-on.
 *
 * Branding removal is not part of any plan tier. It is sold on its own Razorpay
 * mandate, so this mirrors the extra-operator-seat flow in `SeatChangeDialog`
 * step for step: POST, open Razorpay when the server answers
 * `requires_authorization`, verify the signature server-side, then WAIT for the
 * entitlement instead of asserting it. The entitlement is flipped by the
 * `subscription.activated` webhook, which lands seconds after the checkout sheet
 * closes; claiming success on the POST alone would show a customer an unlocked
 * toggle that the next page load takes away again.
 *
 * Two surfaces consume this: the Billing add-on card and the agent's
 * Experience ▸ Branding section. Both read `active` from the entitlements
 * context, so a purchase completed on one unlocks the other without a reload.
 */

/**
 * List price of the add-on, in minor units, per charge currency. A BASE price,
 * exclusive of tax, like every other price published by this platform.
 *
 * Mirrors `RAZORPAY_BRANDING_PLAN_PRICE_CENTS` / `BRANDING_ADDON_PRICE_USD_CENTS`
 * in `api/app/config.py`. No endpoint quotes this price before a purchase is
 * started (the server returns `price_cents` / `gross_price_cents` only
 * alongside a minted mandate), and a buy button with no price on it is not a
 * purchase a customer can consent to. Every response we DO get overrides this -
 * see `absorbQuote` below - so a config change on the server corrects the label
 * the moment the customer acts, and only the pre-purchase label can ever be
 * stale. Callers are told which kind of figure they hold via `priceIncludesTax`,
 * so a base price is never presented as the amount payable.
 */
const LIST_PRICE_MINOR: Readonly<Record<string, number>> = {
  INR: 49900,
  USD: 500,
};

/** Fallback used when a workspace's charge currency has no listed price. */
const FALLBACK_CURRENCY = 'INR';

function listPriceFor(currency: string): { minor: number; currency: string } {
  const code = currency.toUpperCase();
  const minor = LIST_PRICE_MINOR[code];
  if (typeof minor === 'number') return { minor, currency: code };
  return { minor: LIST_PRICE_MINOR[FALLBACK_CURRENCY], currency: FALLBACK_CURRENCY };
}

/** Reads a numeric field off an untyped API envelope. */
function readNumber(source: Record<string, unknown>, key: string): number | null {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Reads a string field off an untyped API envelope. */
function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/** The error shape axios + `buildApiError` produce for a structured FastAPI detail. */
function readDetail(err: unknown): Record<string, unknown> | null {
  const detail =
    (err as { response?: { data?: { detail?: unknown } }; detail?: unknown })?.response?.data
      ?.detail ?? (err as { detail?: unknown })?.detail;
  return detail && typeof detail === 'object' ? (detail as Record<string, unknown>) : null;
}

export interface UseBrandingAddonOptions {
  /** Agent whose subscription carries the add-on. `null` targets the account. */
  botId: number | null;
  /** Called after a settled purchase or cancellation, with a status message. */
  onSettled?: (message: string) => void;
}

export interface UseBrandingAddonResult {
  /** True once the entitlement is granted. Read from the entitlements context. */
  active: boolean;
  /**
   * True while entitlements or the billing currency are still resolving:
   * `active` is not yet trustworthy and `priceLabel` is still null.
   */
  loading: boolean;
  /** A purchase or cancellation is in flight. */
  busy: boolean;
  /**
   * Recurring price, formatted (e.g. "₹499"). Null until the charge currency
   * resolves - a price shown in the wrong currency and corrected a moment later
   * reads as a price change on a surface with a buy button on it.
   */
  priceLabel: string | null;
  /**
   * True when `priceLabel` is the GROSS the mandate debits (the server quoted
   * `gross_price_cents`), false while it is still the base list price. A
   * surface showing a base price has to disclose that tax is added on top; one
   * showing the gross must not, because nothing is added.
   */
  priceIncludesTax: boolean;
  /** Hard failure. Rendered in error styling. */
  error: string | null;
  /** Non-failure information: an abandoned checkout, or a policy notice. */
  notice: string | null;
  /** True while we are waiting on the activation webhook after a paid checkout. */
  awaitingActivation: boolean;
  /**
   * Where the purchase is in the confirm → processing → activating → done flow,
   * for a `PurchaseDialog` to render. Driven here rather than derived in the
   * card because only this hook can tell a settled purchase from an abandoned
   * one — both end with `busy` false and no error.
   */
  phase: PurchasePhase;
  purchase: () => Promise<void>;
  cancel: () => Promise<void>;
  /** Reset the flow to `confirm` and clear transient copy, when the dialog opens. */
  reset: () => void;
}

export function useBrandingAddon({
  botId,
  onSettled,
}: UseBrandingAddonOptions): UseBrandingAddonResult {
  const { hasFeature, loading: entitlementsLoading, refresh } = useEntitlements();
  // The account's charge currency, from `GET /subscriptions/geo`. Held back
  // while it resolves so the price is never rendered in the wrong one.
  const { currency, loading: currencyLoading } = useCurrency();
  const active = hasFeature('branding_removable');
  const loading = entitlementsLoading || currencyLoading;

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [awaitingActivation, setAwaitingActivation] = useState(false);
  const [phase, setPhase] = useState<PurchasePhase>('confirm');
  // Set from any add-on response, which quotes the real charge. Preferred over
  // the list price the moment we have it. `isGross` records whether the server
  // sent `gross_price_cents` (base + tax) or only the base, so no caller has to
  // guess which of the two it is holding.
  const [quoted, setQuoted] = useState<{ minor: number; currency: string; isGross: boolean } | null>(
    null,
  );

  // A settle poll outlives a navigation, so it needs an unmount signal: without
  // it the poll keeps reading for its full budget and then notifies a surface
  // that is gone.
  const unmountedRef = useRef(false);
  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
    };
  }, []);

  // A server-quoted price is an answer whatever geo is doing; the list price is
  // only trustworthy once the charge currency has resolved. The list price is
  // always a base, so it never claims to include tax.
  const price = quoted ?? (currencyLoading ? null : { ...listPriceFor(currency), isGross: false });
  const priceLabel = price ? formatMoneyMinor(price.minor, price.currency) : null;
  const priceIncludesTax = price?.isGross ?? false;

  const reset = useCallback((): void => {
    setError(null);
    setNotice(null);
    setPhase('confirm');
  }, []);

  /**
   * Record the price the server quoted so every later label matches the charge.
   *
   * `gross_price_cents` is base + tax, which is what the mandate debits, so it
   * wins wherever the server sends it. `price_cents` is the base and is only a
   * fallback for a response that predates the tax fields; taking it is a
   * deliberate understatement, flagged via `isGross: false` so the surface
   * keeps disclosing that tax is added on top. Nothing is computed here: a
   * response without a gross does not get one invented for it.
   */
  const absorbQuote = useCallback((result: Record<string, unknown>): void => {
    const gross = readNumber(result, 'gross_price_cents');
    const minor = gross ?? readNumber(result, 'price_cents');
    if (minor === null) return;
    setQuoted({
      minor,
      currency: (readString(result, 'currency') ?? FALLBACK_CURRENCY).toUpperCase(),
      isGross: gross !== null,
    });
  }, []);

  /**
   * Wait for the entitlement the webhook grants, then refresh the shared
   * context so every gated surface unlocks at once. On timeout the payment is
   * still real and the webhook will still land, so we say what we know rather
   * than asserting an entitlement we cannot see.
   */
  const settleActivation = useCallback(
    async (settledMessage: string, pendingMessage: string): Promise<void> => {
      setAwaitingActivation(true);
      setPhase('activating');
      try {
        const outcome = await pollUntil({
          read: getEntitlements,
          done: (entitlements) => entitlements.features.branding_removable === true,
          cancelled: () => unmountedRef.current,
        });
        if (outcome.status === 'cancelled') return;
        await refresh();
        if (unmountedRef.current) return;
        const message = outcome.status === 'settled' ? settledMessage : pendingMessage;
        setNotice(message);
        // Both a settled entitlement and a slow-but-paid one land on the
        // celebration: the money is in either way, and the copy already tells
        // the two apart. Only a hard failure earns the error phase.
        setPhase('done');
        onSettled?.(message);
      } finally {
        if (!unmountedRef.current) setAwaitingActivation(false);
      }
    },
    [refresh, onSettled],
  );

  const purchase = useCallback(async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setNotice(null);
    setPhase('processing');
    try {
      const result = (await purchaseBrandingAddon(botId)) as Record<string, unknown>;
      absorbQuote(result);

      if (result.requires_authorization && result.checkout) {
        const checkout = result.checkout as Record<string, unknown>;
        let callback: Awaited<ReturnType<typeof openRazorpayCheckout>>;
        try {
          callback = await openRazorpayCheckout({
            key: String(checkout.key_id),
            subscription_id: String(checkout.subscription_id),
            name: readString(checkout, 'name') ?? 'OyeChats branding removal',
            description: readString(checkout, 'description') ?? undefined,
            prefill: checkout.prefill as Record<string, unknown> | undefined,
            theme: checkout.theme as Record<string, unknown> | undefined,
          });
        } catch (checkoutErr: unknown) {
          // A dismissed sheet is a decision, not a failure: nothing was
          // authorized and nothing was charged. It is still the drop-off the
          // funnel exists to measure, so it is logged under this add-on's own
          // `branding` surface rather than folded into another one.
          if ((checkoutErr as { code?: string })?.code === 'dismissed') {
            void recordBillingEvent('checkout_abandoned', 'branding');
            setNotice('Purchase cancelled. You were not charged.');
            // Back to the confirm step, notice in hand, so a customer who backs
            // out and looks again is told plainly that nothing happened.
            setPhase('confirm');
            return;
          }
          if ((checkoutErr as { code?: string })?.code === 'payment_failed') {
            void recordBillingEvent('payment_failed', 'branding');
          }
          throw checkoutErr;
        }

        // Verify server-side like every other checkout in this app. The webhook
        // stays the canonical reconciler and is idempotent against this, so a
        // verification failure is NOT a purchase failure - the mandate is
        // already authorized. It only softens the message.
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

        await settleActivation(
          'Branding removal is active. The badge is gone from your widget.',
          reconciled
            ? 'Payment authorised. Branding removal switches on in a moment.'
            : 'Payment authorised. We are finalising your add-on.',
        );
        return;
      }

      // No mandate to authorize: the add-on was already on this subscription.
      await refresh();
      if (unmountedRef.current) return;
      const message = readString(result, 'message') ?? 'Branding removal is active.';
      setNotice(message);
      setPhase('done');
      onSettled?.(message);
    } catch (err: unknown) {
      const detail = readDetail(err);
      // International USD billing is not open yet. A policy answer, not a
      // fault - same contact-sales contract the plan checkout renders. It stays
      // on the confirm step: there is nothing to retry and nothing failed.
      if (detail && detail.reason === 'intl_usd_pending') {
        setNotice(
          readString(detail, 'message') ??
            'USD billing for international customers is coming soon. Please contact sales.',
        );
        setPhase('confirm');
        return;
      }
      // 502 from the gateway, a Free-plan 400, or anything else: the server's
      // own sentence is the clearest thing we can show.
      setError(
        err instanceof Error ? err.message : 'Could not start the add-on. Please try again.',
      );
      setPhase('error');
    } finally {
      if (!unmountedRef.current) setBusy(false);
    }
  }, [botId, absorbQuote, refresh, settleActivation, onSettled]);

  const cancel = useCallback(async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = (await cancelBrandingAddon(botId)) as Record<string, unknown>;
      absorbQuote(result);
      await refresh();
      if (unmountedRef.current) return;
      const message =
        readString(result, 'message') ?? 'Branding removal cancelled. The badge will reappear shortly.';
      setNotice(message);
      onSettled?.(message);
    } catch (err: unknown) {
      setError(
        err instanceof Error ? err.message : 'Could not cancel the add-on. Please try again.',
      );
    } finally {
      if (!unmountedRef.current) setBusy(false);
    }
  }, [botId, absorbQuote, refresh, onSettled]);

  return {
    active,
    loading,
    busy,
    priceLabel,
    priceIncludesTax,
    error,
    notice,
    awaitingActivation,
    phase,
    purchase,
    cancel,
    reset,
  };
}
