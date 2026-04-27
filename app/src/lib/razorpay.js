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

let scriptPromise = null;

function loadRazorpayScript() {
  if (scriptPromise) return scriptPromise;
  // Already loaded earlier (e.g. via SSR or extension) — reuse.
  if (typeof window !== 'undefined' && window.Razorpay) {
    scriptPromise = Promise.resolve(window.Razorpay);
    return scriptPromise;
  }
  scriptPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${RAZORPAY_SCRIPT_URL}"]`);
    if (existing) {
      existing.addEventListener('load', () => resolve(window.Razorpay));
      existing.addEventListener('error', () => reject(new Error('Failed to load Razorpay Checkout')));
      return;
    }
    const tag = document.createElement('script');
    tag.src = RAZORPAY_SCRIPT_URL;
    tag.async = true;
    tag.crossOrigin = 'anonymous';
    tag.onload = () => {
      if (window.Razorpay) resolve(window.Razorpay);
      else reject(new Error('Razorpay loaded but constructor missing'));
    };
    tag.onerror = () => {
      scriptPromise = null;
      reject(new Error('Failed to load Razorpay Checkout (network error)'));
    };
    document.head.appendChild(tag);
  });
  return scriptPromise;
}

/**
 * Open the Razorpay Checkout modal with the given options. Returns a promise
 * that resolves with `{ razorpay_payment_id, razorpay_order_id?,
 * razorpay_subscription_id?, razorpay_signature }` on success or rejects on
 * dismiss / error.
 *
 * The caller is responsible for verifying the signature server-side via the
 * appropriate `/credits/topup/verify` or subscription verification endpoint
 * before treating the payment as confirmed.
 */
export async function openRazorpayCheckout(options) {
  const Razorpay = await loadRazorpayScript();
  return new Promise((resolve, reject) => {
    const merged = {
      ...options,
      handler: (response) => resolve(response),
      modal: {
        ...(options.modal || {}),
        ondismiss: () => {
          const dismissError = new Error('Checkout dismissed by user');
          dismissError.code = 'dismissed';
          reject(dismissError);
        },
      },
    };
    try {
      const rzp = new Razorpay(merged);
      rzp.on('payment.failed', (resp) => {
        const failureError = new Error(
          resp?.error?.description || 'Payment failed. Please try again.',
        );
        failureError.code = 'payment_failed';
        failureError.detail = resp?.error;
        reject(failureError);
      });
      rzp.open();
    } catch (err) {
      reject(err);
    }
  });
}
