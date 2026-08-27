import { useEffect, useState } from 'react';
import { t as translateNow } from '../i18n/i18n';
import { getVapidPublicKey, subscribePush, unsubscribePush } from '../services/api';

// ── Capability detection ─────────────────────────────────────────────────────

/**
 * True web-push support: a Service Worker to receive the push, a PushManager to
 * subscribe, and the Notification API to prompt + display. All three are
 * required; missing any means the feature genuinely can't run here.
 */
const PUSH_SUPPORTED =
  typeof window !== 'undefined' &&
  'serviceWorker' in navigator &&
  'PushManager' in window &&
  'Notification' in window;

/** The service worker this app ships (public/sw.js) - it owns the `push` handler. */
const SERVICE_WORKER_URL = '/sw.js';

function toMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

// ── Push state machine ───────────────────────────────────────────────────────
//
// Honesty note: this hook can *manage* a web-push subscription that already
// exists on the device (persist it to the backend via `subscribePush`, and
// remove it via `unsubscribePush`), and it can truthfully request + reflect
// the browser Notification permission. It cannot *create* a subscription when
// the server hasn't published a VAPID key - rather than fake a working
// "Enable" toggle, it gates down to what genuinely works and states plainly
// what's missing via the `disabled` phase.

export type PushPhase =
  | { readonly status: 'checking' }
  | { readonly status: 'unsupported' }
  | { readonly status: 'denied' }
  | { readonly status: 'subscribed' }
  | { readonly status: 'default' }
  | { readonly status: 'incomplete' }
  | { readonly status: 'disabled' }
  | { readonly status: 'error'; readonly message: string };

/** Decode a URL-safe base64 VAPID key into the byte array `pushManager.subscribe` wants.
 *  Backed by an explicit ArrayBuffer so the result is a `BufferSource` (not the
 *  wider `Uint8Array<ArrayBufferLike>` TS infers from `new Uint8Array(length)`). */
function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(normalized);
  const output = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i);
  return output;
}

/**
 * Mint a fresh push subscription using the server's VAPID key and persist it.
 * Returns `disabled` when the server has push turned off (no key), so the UI
 * stays honest rather than looping on a subscribe that can't succeed.
 */
async function mintSubscription(registration: ServiceWorkerRegistration): Promise<PushPhase> {
  const { public_key, enabled } = await getVapidPublicKey();
  if (!enabled || !public_key) return { status: 'disabled' };
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(public_key),
  });
  await subscribePush(subscription);
  return { status: 'subscribed' };
}

/** Pure, synchronous read of the starting phase - no side effects, so it's a safe lazy initializer. */
function initialPushPhase(): PushPhase {
  if (!PUSH_SUPPORTED) return { status: 'unsupported' };
  const permission = Notification.permission;
  if (permission === 'denied') return { status: 'denied' };
  // Both 'granted' and 'default' need an async check (is there already a
  // subscription on this device?) before we can settle - start in `checking`.
  return { status: 'checking' };
}

export interface UsePushSubscriptionResult {
  readonly supported: boolean;
  readonly phase: PushPhase;
  readonly busy: boolean;
  readonly actionError: string;
  /** Request permission (a real user-gesture browser action) and subscribe if we genuinely can. */
  readonly enable: () => Promise<void>;
  /** Remove the subscription on this device and on the backend. */
  readonly disable: () => Promise<void>;
  /** Re-derive the true state from scratch - also the retry path for `denied`/`error`. */
  readonly recheck: () => void;
}

/**
 * usePushSubscription - the single source of truth for this device's Web Push
 * subscription state, shared by the Settings ▸ Notifications card and the
 * app-wide {@link PushPermissionNudge} banner so the two surfaces never drift.
 */
export function usePushSubscription(): UsePushSubscriptionResult {
  const [phase, setPhase] = useState<PushPhase>(initialPushPhase);
  const [reloadToken, setReloadToken] = useState(0);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');

  // Resolve the true state: register the SW, then look for an existing
  // subscription. First `setState` always follows an await, so the `checking`
  // phase is a genuine derived state - never a synchronous set in the effect body.
  useEffect(() => {
    if (!PUSH_SUPPORTED) return;
    let active = true;
    void (async () => {
      try {
        const registration = await navigator.serviceWorker.register(SERVICE_WORKER_URL);
        if (!active) return;
        if (Notification.permission === 'denied') {
          setPhase({ status: 'denied' });
          return;
        }
        const existing = await registration.pushManager.getSubscription();
        if (!active) return;
        if (existing) {
          // Idempotent upsert (backend keys on endpoint) so the server knows
          // this device. Best-effort: a failed persist doesn't change the fact
          // that the browser holds a subscription.
          try {
            await subscribePush(existing);
          } catch {
            // Ignore - still reflect the browser truth below.
          }
          if (!active) return;
          setPhase({ status: 'subscribed' });
          return;
        }
        // No subscription on the device yet. If permission is already granted,
        // mint one with the server VAPID key; otherwise wait for the user to
        // enable. `mintSubscription` returns `disabled` when server push is off.
        if (Notification.permission === 'granted') {
          const next = await mintSubscription(registration);
          if (active) setPhase(next);
        } else {
          setPhase({ status: 'default' });
        }
      } catch (error) {
        if (!active) return;
        setPhase({
          status: 'error',
          message: toMessage(error, translateNow('app.couldntCheckYourNotificationStatus') || 'Couldn’t check your notification status.'),
        });
      }
    })();
    return () => {
      active = false;
    };
  }, [reloadToken]);

  const recheck = (): void => {
    setActionError('');
    setPhase({ status: 'checking' });
    setReloadToken((token) => token + 1);
  };

  const enable = async (): Promise<void> => {
    setBusy(true);
    setActionError('');
    try {
      const result = await Notification.requestPermission();
      if (result === 'denied') {
        setPhase({ status: 'denied' });
        return;
      }
      if (result !== 'granted') {
        // Dismissed - permission stays 'default'; nothing changed.
        return;
      }
      // Granted - reuse an existing device subscription, else mint one with the
      // server VAPID key.
      const registration = await navigator.serviceWorker.ready;
      const existing = await registration.pushManager.getSubscription();
      if (existing) {
        await subscribePush(existing);
        setPhase({ status: 'subscribed' });
        return;
      }
      setPhase(await mintSubscription(registration));
    } catch (error) {
      setActionError(toMessage(error, translateNow('app.couldntEnableNotificationsPleaseTry') || 'Couldn’t enable notifications. Please try again.'));
    } finally {
      setBusy(false);
    }
  };

  const disable = async (): Promise<void> => {
    setBusy(true);
    setActionError('');
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) {
        const json = subscription.toJSON();
        const endpoint = json.endpoint;
        if (endpoint) {
          try {
            await unsubscribePush(endpoint, { p256dh: json.keys?.p256dh, auth: json.keys?.auth });
          } catch {
            // Best-effort backend removal - still unsubscribe locally below.
          }
        }
        await subscription.unsubscribe();
      }
      // Permission is still 'granted' but there's no deliverable subscription -
      // that's exactly the honest `incomplete` state.
      setPhase({ status: 'incomplete' });
    } catch (error) {
      setActionError(toMessage(error, translateNow('app.couldntTurnOffNotificationsPlease') || 'Couldn’t turn off notifications. Please try again.'));
    } finally {
      setBusy(false);
    }
  };

  return { supported: PUSH_SUPPORTED, phase, busy, actionError, enable, disable, recheck };
}
