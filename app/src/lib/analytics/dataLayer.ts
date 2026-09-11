/**
 * The one way the console hands an event to Google Tag Manager.
 *
 * The head bootstrap (`consentBootstrap.ts`) creates `window.dataLayer` before
 * any module runs, and injects `gtm.js` on the visitor's first interaction. An
 * event pushed before that waits in the queue and is processed when the
 * container loads, so no caller has to wait for GTM. Whether an event may set
 * cookies or reach Google at all is decided inside the container by Consent
 * Mode, not here.
 */

export type DataLayerValue = string | number | boolean;

export interface DataLayerEvent {
  event: string;
  [parameter: string]: DataLayerValue;
}

declare global {
  interface Window {
    dataLayer?: unknown[];
  }
}

export function pushDataLayerEvent(payload: DataLayerEvent): void {
  try {
    // Append, never assign a fresh array: GTM wraps `push` on the array it
    // found when it loaded, and a replacement would be invisible to it.
    window.dataLayer = window.dataLayer || [];
    window.dataLayer.push(payload);
  } catch {
    // A blocker replaced the queue with something that is not an array.
    // Measurement is lost for this event; the flow that reported it is not.
  }
}
