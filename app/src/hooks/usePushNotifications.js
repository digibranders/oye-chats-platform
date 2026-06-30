/**
 * usePushNotifications — manages a single operator's Web Push subscription
 * for the OyeChats admin dashboard.
 *
 * Lifecycle the hook owns end-to-end:
 *
 *   1. Detect support (Service Worker + PushManager + Notification APIs).
 *   2. Register /sw.js on mount.
 *   3. Read the current permission state and surface it to the caller so the
 *      AdminLayout can render the PushPermissionBanner when appropriate.
 *   4. When permission is `granted` AND we don't already have a registered
 *      subscription, fetch the server's VAPID public key, call
 *      pushManager.subscribe(), and POST it to the backend.
 *   5. Expose request()/disable() callbacks so the banner has buttons to
 *      drive permission state transitions.
 *
 * Why this hook is dashboard-only (not in the public widget):
 *   - Push is operator-side. Visitors don't need notifications because the
 *     widget is the thing they actively look at; the chat UI does that work.
 *   - Subscribing requires the operator to be authenticated (the subscribe
 *     route is gated to `auth["type"] == "operator"`).
 *
 * Key contracts the hook honours:
 *   - Never prompts for permission automatically. The prompt only fires when
 *     the caller invokes `request()` — typically from a banner button click,
 *     which is required by browsers anyway (user-gesture rule).
 *   - Survives re-renders: the registration + subscription work runs once
 *     per (authType, permission) tuple. No infinite-loop hazards.
 *   - Defensive against stale subscriptions: if the SW reports a subscription
 *     but the backend rejected it (e.g. operator was deleted), we silently
 *     re-subscribe on next mount. The backend's unique constraint on endpoint
 *     handles the upsert.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { getAuthItem } from '../utils/authStorage';
import {
  getVapidPublicKey,
  subscribePush,
  unsubscribePush,
} from '../services/api';

const SUPPORTED =
  typeof window !== 'undefined' &&
  'serviceWorker' in navigator &&
  'PushManager' in window &&
  'Notification' in window;

/** Convert a URL-safe base64 VAPID public key into a Uint8Array for subscribe(). */
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const output = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i += 1) output[i] = rawData.charCodeAt(i);
  return output;
}

function readPermission() {
  if (!SUPPORTED) return 'unsupported';
  try {
    return Notification.permission; // 'default' | 'granted' | 'denied'
  } catch {
    return 'unsupported';
  }
}

export default function usePushNotifications() {
  const [permission, setPermission] = useState(readPermission());
  const [subscribed, setSubscribed] = useState(false);
  const [error, setError] = useState(null);
  // ``initializing`` blocks the banner from rendering during the brief
  // window between mount and the hook's first subscribe pass completing.
  // Without this, returning users (permission already "granted", subscription
  // already exists at the browser layer) see a 10ms flash of the indigo
  // "Enable notifications" card while the hook checks `getSubscription()`
  // and posts to the backend. ``true`` until the first useEffect cycle
  // resolves to either subscribed=true, an error, or a state that should
  // genuinely show the banner (e.g. permission='default').
  const [initializing, setInitializing] = useState(true);
  // Guard against re-running the subscribe pipeline across re-renders. The
  // pipeline is idempotent on the backend (upsert by endpoint), but a noisy
  // duplicate POST every render is wasteful.
  const subscribingRef = useRef(false);

  const authType = getAuthItem('auth_type');
  // Push is available to *any* authenticated dashboard user — both operators
  // and workspace owners (client logins). The backend's subscribe route looks
  // at the auth header and stores either operator_id or client_id accordingly.
  // Anonymous / unauthenticated visits skip the whole pipeline.
  const isAuthenticated = authType === 'operator' || authType === 'client';
  // Kept in the return value for backwards compatibility with the banner
  // which used to render differently for operators — now both render the
  // same thing.
  const isOperator = authType === 'operator';

  // Register the service worker exactly once per mount. We don't unregister
  // on unmount — the SW outlives the React tree and may handle a push that
  // arrives while no dashboard tab is loaded.
  useEffect(() => {
    if (!SUPPORTED || !isAuthenticated) return;
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      console.warn('[OyeChats] SW registration failed:', err);
    });
  }, [isAuthenticated]);

  // Whenever permission becomes "granted" while the user is logged in, make
  // sure the backend has our subscription. This runs at mount when the user
  // already granted permission previously (returning user), AND immediately
  // after `request()` flips the state.
  useEffect(() => {
    // Unsupported / anonymous users have no pipeline to wait for — drop the
    // initializing flag immediately so the banner doesn't get stuck hidden
    // for them (it would have returned null anyway, but explicit is better).
    if (!SUPPORTED || !isAuthenticated) {
      setInitializing(false);
      return;
    }
    if (permission !== 'granted') {
      // Permission is 'default' or 'denied' — there's nothing to subscribe to
      // until the user clicks "Enable". Surface the banner now; ``initializing``
      // is no longer holding it back.
      setSubscribed(false);
      setInitializing(false);
      return;
    }
    if (subscribingRef.current) return;

    const run = async () => {
      subscribingRef.current = true;
      try {
        const registration = await navigator.serviceWorker.ready;
        const existing = await registration.pushManager.getSubscription();
        let subscription = existing;

        if (!subscription) {
          // Fetch the server VAPID key only when we actually need to
          // subscribe — saves one HTTP call on re-renders for already-
          // subscribed operators.
          const { public_key: publicKey, enabled } = await getVapidPublicKey();
          if (!enabled || !publicKey) {
            setError('Push notifications are not configured on the server.');
            return;
          }
          subscription = await registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(publicKey),
          });
        }

        await subscribePush(subscription);
        setSubscribed(true);
        setError(null);
      } catch (err) {
        console.warn('[OyeChats] push subscribe failed:', err);
        setError(err?.message || 'Could not enable push notifications.');
      } finally {
        subscribingRef.current = false;
        // First-pass complete — banner may now show whatever final state we
        // settled into (subscribed = hidden, error = retry, etc.).
        setInitializing(false);
      }
    };
    run();
  }, [permission, isAuthenticated]);

  /**
   * Prompt the user for notification permission. Must be called from a
   * user-gesture handler — browsers ignore the request otherwise.
   */
  const request = useCallback(async () => {
    if (!SUPPORTED) return 'unsupported';
    setError(null);
    try {
      const result = await Notification.requestPermission();
      setPermission(result);
      return result;
    } catch (err) {
      setError(err?.message || 'Permission prompt failed.');
      return 'default';
    }
  }, []);

  /**
   * Remove the subscription locally and on the backend. The OS-level
   * permission is *not* revoked (browsers don't allow programmatic revoke);
   * the operator must do that from browser settings if they want a full
   * teardown.
   */
  const disable = useCallback(async () => {
    if (!SUPPORTED) return;
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) {
        const json = subscription.toJSON();
        try {
          await unsubscribePush(json.endpoint, {
            p256dh: json.keys?.p256dh,
            auth: json.keys?.auth,
          });
        } catch {
          // best-effort — still unsubscribe locally
        }
        await subscription.unsubscribe();
      }
      setSubscribed(false);
    } catch (err) {
      console.warn('[OyeChats] push disable failed:', err);
    }
  }, []);

  return {
    supported: SUPPORTED,
    isAuthenticated,
    // Kept for any caller that still cares about the operator/client split.
    isOperator,
    permission,
    subscribed,
    error,
    initializing,
    request,
    disable,
  };
}
