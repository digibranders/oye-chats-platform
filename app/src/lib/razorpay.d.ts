/**
 * Type shim for the legacy Razorpay Checkout loader (`lib/razorpay.js`).
 * Runtime stays in the `.js`; this only types the surface new TS code calls.
 */

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

/**
 * Opens the Razorpay Checkout modal. Resolves with the callback on success;
 * rejects on failure or dismissal. A user dismissal rejects with an error whose
 * `code === 'dismissed'`; a gateway failure rejects with `code === 'payment_failed'`.
 */
export function openRazorpayCheckout(options: RazorpayCheckoutOptions): Promise<RazorpayCallback>;
