import { t as translateNow } from '../i18n/i18n';
/**
 * Razorpay Checkout JS loader.
 *
 * Razorpay's checkout script is ~80KB and only needed when a customer
 * actually initiates a payment, so we lazy-load it the first time openRazorpay
 * is called and cache the promise. Subsequent opens reuse the same global
 * `Razorpay` constructor without re-injecting the script tag.
 *
 * Reference: https://razorpay.com/docs/payments/payment-gateway/web-integration/standard/payment-flow/
 */
const RAZORPAY_SCRIPT_URL = 'https://checkout.razorpay.com/v1/checkout.js';

/** Fields Razorpay returns in the success callback. */
export interface RazorpayCallback {
  razorpay_payment_id: string;
  razorpay_order_id?: string;
  razorpay_subscription_id?: string;
  razorpay_signature: string;
}

/** Options passed to Razorpay Checkout. Only the fields we set are declared. */
export interface RazorpayCheckoutOptions {
  key: string;
  /** Subscription flow. */
  subscription_id?: string;
  /** One-off order flow (top-ups). */
  order_id?: string;
  amount?: number;
  currency?: string;
  name?: string;
  description?: string;
  prefill?: Record<string, unknown>;
  theme?: Record<string, unknown>;
  method?: Record<string, boolean>;
  modal?: Record<string, unknown>;
  /** Razorpay customer to tokenise the instrument against (top-up `save: 1`). */
  customer_id?: string;
  /** `1` asks Razorpay to save the instrument for one-click reuse. */
  save?: 0 | 1;
}

/** Razorpay's `payment.failed` event payload, as much of it as we read. */
interface RazorpayFailureResponse {
  error?: { description?: string; [key: string]: unknown };
}

/**
 * Why a checkout attempt ended without a payment.
 *
 * `dismissed` is the customer closing the modal, which is a normal outcome and
 * must not be reported as a failure. `payment_failed` is the gateway declining.
 * Callers branch on this, so it is a discriminated field rather than a message
 * string they would otherwise have to pattern-match.
 */
export type RazorpayErrorCode = 'dismissed' | 'payment_failed';

/**
 * Checkout rejection carrying a machine-readable cause.
 *
 * Was previously a plain Error with `code` bolted on at the call site, which
 * the shim did not describe at all - so every consumer read `err.code` through
 * an implicit `any`. A real subclass makes `instanceof` narrowing work.
 */
export class RazorpayError extends Error {
  readonly code: RazorpayErrorCode;
  readonly detail?: unknown;

  constructor(message: string, code: RazorpayErrorCode, detail?: unknown) {
    super(message);
    this.name = 'RazorpayError';
    this.code = code;
    this.detail = detail;
  }
}

/** Minimal shape of the constructor Razorpay's script hangs off `window`. */
interface RazorpayConstructor {
  new (options: Record<string, unknown>): {
    open: () => void;
    on: (event: 'payment.failed', handler: (response: RazorpayFailureResponse) => void) => void;
  };
}

declare global {
  interface Window {
    Razorpay?: RazorpayConstructor;
  }
}

let scriptPromise: Promise<RazorpayConstructor> | null = null;

function loadRazorpayScript(): Promise<RazorpayConstructor> {
  if (scriptPromise) return scriptPromise;
  // Already loaded earlier (e.g. via SSR or extension) - reuse.
  if (typeof window !== 'undefined' && window.Razorpay) {
    scriptPromise = Promise.resolve(window.Razorpay);
    return scriptPromise;
  }
  scriptPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${RAZORPAY_SCRIPT_URL}"]`);
    if (existing) {
      existing.addEventListener('load', () => {
        // `window.Razorpay` is only populated once the tag finishes evaluating.
        // Resolving it unchecked would hand callers `undefined` as a constructor.
        if (window.Razorpay) resolve(window.Razorpay);
        else reject(new Error(translateNow('app.razorpayLoadedButConstructorMissing') || 'Razorpay loaded but constructor missing'));
      });
      existing.addEventListener('error', () => reject(new Error(translateNow('app.failedToLoadRazorpayCheckout') || 'Failed to load Razorpay Checkout')));
      return;
    }
    const tag = document.createElement('script');
    tag.src = RAZORPAY_SCRIPT_URL;
    tag.async = true;
    tag.crossOrigin = 'anonymous';
    tag.onload = () => {
      if (window.Razorpay) resolve(window.Razorpay);
      else reject(new Error(translateNow('app.razorpayLoadedButConstructorMissing') || 'Razorpay loaded but constructor missing'));
    };
    tag.onerror = () => {
      scriptPromise = null;
      reject(new Error(translateNow('app.failedToLoadRazorpayCheckout') || 'Failed to load Razorpay Checkout'));
    };
    document.head.appendChild(tag);
  });
  return scriptPromise;
}

/**
 * Open the Razorpay Checkout modal with the given options. Returns a promise
 * that resolves with `{ razorpay_payment_id, razorpay_order_id?,
 * razorpay_subscription_id?, razorpay_signature }` on success, or rejects with
 * a {@link RazorpayError} on dismissal / gateway failure.
 *
 * The caller is responsible for verifying the signature server-side via the
 * appropriate `/credits/topup/verify` or subscription verification endpoint
 * before treating the payment as confirmed.
 */
export async function openRazorpayCheckout(
  options: RazorpayCheckoutOptions,
): Promise<RazorpayCallback> {
  const Razorpay = await loadRazorpayScript();
  return new Promise<RazorpayCallback>((resolve, reject) => {
    const merged = {
      ...options,
      handler: (response: RazorpayCallback) => resolve(response),
      modal: {
        ...(options.modal || {}),
        ondismiss: () => {
          reject(new RazorpayError(
            translateNow('app.checkoutDismissedByUser') || 'Checkout dismissed by user',
            'dismissed',
          ));
        },
      },
    };
    try {
      const rzp = new Razorpay(merged);
      rzp.on('payment.failed', (resp) => {
        reject(new RazorpayError(
          resp?.error?.description || translateNow('app.paymentFailedPleaseTryAgain') || 'Payment failed. Please try again.',
          'payment_failed',
          resp?.error,
        ));
      });
      rzp.open();
    } catch (err) {
      reject(err);
    }
  });
}
