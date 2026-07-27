import { type ReactElement, useEffect, useState } from 'react';
import {
  Bell,
  BellOff,
  Check,
  Download,
  Info,
  Loader2,
  MonitorSmartphone,
  ShieldAlert,
} from 'lucide-react';
import { Button, Card, SectionHeader, StatusBadge } from '../../design-system';
import { getVapidPublicKey, subscribePush, unsubscribePush } from '../../services/api';

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

/** The service worker this app ships (public/sw.js) — it owns the `push` handler. */
const SERVICE_WORKER_URL = '/sw.js';

function toMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

// ── Push state machine ───────────────────────────────────────────────────────
//
// Honesty note (mandate): this dashboard build can *manage* a web-push
// subscription that already exists on the device (persist it to the backend via
// the typed `subscribePush`, and remove it via `unsubscribePush`), and it can
// truthfully request + reflect the browser Notification permission. It cannot
// *create* a brand-new subscription, because `pushManager.subscribe()` needs the
// server's VAPID application key, which this frontend has no typed accessor for.
// So rather than fake a working "Enable" toggle, we gate down to what genuinely
// works and state plainly what's missing in the `incomplete` state.

type PushPhase =
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

/** Pure, synchronous read of the starting phase — no side effects, so it's a safe lazy initializer. */
function initialPushPhase(): PushPhase {
  if (!PUSH_SUPPORTED) return { status: 'unsupported' };
  const permission = Notification.permission;
  if (permission === 'denied') return { status: 'denied' };
  // Both 'granted' and 'default' need an async check (is there already a
  // subscription on this device?) before we can settle — start in `checking`.
  return { status: 'checking' };
}

// ── Notifications card ───────────────────────────────────────────────────────

function NotificationsCard(): ReactElement {
  const [phase, setPhase] = useState<PushPhase>(initialPushPhase);
  const [reloadToken, setReloadToken] = useState(0);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');

  // Resolve the true state: register the SW, then look for an existing
  // subscription. First `setState` always follows an await, so the `checking`
  // phase is a genuine derived state — never a synchronous set in the effect body.
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
            // Ignore — still reflect the browser truth below.
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
          message: toMessage(error, 'Couldn’t check your notification status.'),
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

  /** Request permission (a real user-gesture browser action) and subscribe if we genuinely can. */
  const handleEnable = async (): Promise<void> => {
    setBusy(true);
    setActionError('');
    try {
      const result = await Notification.requestPermission();
      if (result === 'denied') {
        setPhase({ status: 'denied' });
        return;
      }
      if (result !== 'granted') {
        // Dismissed — permission stays 'default'; nothing changed.
        return;
      }
      // Granted — reuse an existing device subscription, else mint one with the
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
      setActionError(toMessage(error, 'Couldn’t enable notifications. Please try again.'));
    } finally {
      setBusy(false);
    }
  };

  /** Remove the subscription on this device and on the backend. */
  const handleDisable = async (): Promise<void> => {
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
            // Best-effort backend removal — still unsubscribe locally below.
          }
        }
        await subscription.unsubscribe();
      }
      // Permission is still 'granted' but there's no deliverable subscription —
      // that's exactly the honest `incomplete` state.
      setPhase({ status: 'incomplete' });
    } catch (error) {
      setActionError(toMessage(error, 'Couldn’t turn off notifications. Please try again.'));
    } finally {
      setBusy(false);
    }
  };

  const badge = ((): { tone: 'neutral' | 'success' | 'warning'; label: string } => {
    switch (phase.status) {
      case 'subscribed':
        return { tone: 'success', label: 'Enabled' };
      case 'denied':
        return { tone: 'warning', label: 'Blocked' };
      case 'unsupported':
        return { tone: 'neutral', label: 'Unavailable' };
      default:
        return { tone: 'neutral', label: 'Off' };
    }
  })();

  return (
    <Card>
      <div className="p-5 sm:p-6">
        <SectionHeader
          title={
            <span className="inline-flex items-center gap-2">
              <Bell size={16} aria-hidden="true" className="text-[var(--ds-text-subtle)]" />
              Browser notifications
            </span>
          }
          description="Get alerted the moment a visitor wants to chat, even when this tab is in the background."
          actions={<StatusBadge tone={badge.tone}>{badge.label}</StatusBadge>}
        />

        <div aria-live="polite" className="mt-4 empty:hidden">
          {actionError && (
            <div
              role="alert"
              className="rounded-lg border border-[var(--ds-danger)] bg-[var(--ds-danger-soft)] px-3 py-2 text-[13px] text-[var(--ds-danger)]"
            >
              {actionError}
            </div>
          )}
        </div>

        <div className="mt-4">
          {phase.status === 'checking' && (
            <p className="flex items-center gap-2 py-1 text-[13px] text-[var(--ds-text-muted)]">
              <Loader2 size={15} aria-hidden="true" className="animate-spin" />
              Checking notification status…
            </p>
          )}

          {phase.status === 'unsupported' && (
            <div className="flex items-start gap-3 rounded-xl border border-[var(--ds-border)] bg-[var(--ds-bg-sunken)] px-4 py-3">
              <ShieldAlert
                size={16}
                aria-hidden="true"
                className="mt-0.5 shrink-0 text-[var(--ds-text-subtle)]"
              />
              <p className="text-[13px] text-[var(--ds-text-muted)]">
                This browser doesn’t support web push notifications. Try a recent version of Chrome,
                Edge, or Firefox on desktop.
              </p>
            </div>
          )}

          {phase.status === 'denied' && (
            <div className="space-y-4">
              <div className="flex items-start gap-3 rounded-xl border border-[var(--ds-warning)] bg-[var(--ds-warning-soft)] px-4 py-3">
                <BellOff
                  size={16}
                  aria-hidden="true"
                  className="mt-0.5 shrink-0 text-[var(--ds-warning)]"
                />
                <div className="text-[13px] text-[var(--ds-warning)]">
                  <p className="font-medium">Notifications are blocked in your browser</p>
                  <p className="mt-1 leading-relaxed">
                    Click the lock icon next to the address bar → Notifications → Allow, then re-check
                    below.
                  </p>
                </div>
              </div>
              <Button variant="outline" onClick={recheck}>
                <Bell size={16} aria-hidden="true" />
                Re-check permission
              </Button>
            </div>
          )}

          {phase.status === 'subscribed' && (
            <div className="space-y-4">
              <p className="flex items-center gap-2 text-[13px] text-[var(--ds-success)]">
                <Check size={15} aria-hidden="true" />
                You’re subscribed on this device.
              </p>
              <Button variant="outline" onClick={() => void handleDisable()} disabled={busy}>
                {busy ? (
                  <Loader2 size={16} aria-hidden="true" className="animate-spin" />
                ) : (
                  <BellOff size={16} aria-hidden="true" />
                )}
                Turn off
              </Button>
            </div>
          )}

          {phase.status === 'default' && (
            <Button onClick={() => void handleEnable()} disabled={busy}>
              {busy ? (
                <Loader2 size={16} aria-hidden="true" className="animate-spin" />
              ) : (
                <Bell size={16} aria-hidden="true" />
              )}
              Enable notifications
            </Button>
          )}

          {phase.status === 'incomplete' && (
            <div className="flex items-start gap-3 rounded-xl border border-[var(--ds-border)] bg-[var(--ds-bg-sunken)] px-4 py-3">
              <Info
                size={16}
                aria-hidden="true"
                className="mt-0.5 shrink-0 text-[var(--ds-text-subtle)]"
              />
              <div className="text-[13px] text-[var(--ds-text-muted)]">
                <p className="font-medium text-[var(--ds-text)]">
                  Notifications are allowed in your browser
                </p>
                <p className="mt-1 leading-relaxed">
                  But web push isn’t fully set up for this dashboard yet — delivering alerts needs the
                  push service key enabled on the server, which isn’t available to the app here. There’s
                  nothing more to do on this device until that’s switched on.
                </p>
              </div>
            </div>
          )}

          {phase.status === 'disabled' && (
            <div className="flex items-start gap-3 rounded-xl border border-[var(--ds-border)] bg-[var(--ds-bg-sunken)] px-4 py-3">
              <Info
                size={16}
                aria-hidden="true"
                className="mt-0.5 shrink-0 text-[var(--ds-text-subtle)]"
              />
              <div className="text-[13px] text-[var(--ds-text-muted)]">
                <p className="font-medium text-[var(--ds-text)]">Push notifications aren’t enabled yet</p>
                <p className="mt-1 leading-relaxed">
                  Your browser is ready, but web push is currently turned off on the server, so alerts can’t
                  be delivered. It’ll start working here automatically once it’s switched on — nothing more to
                  do on this device.
                </p>
              </div>
            </div>
          )}

          {phase.status === 'error' && (
            <div className="space-y-4">
              <div
                role="alert"
                className="rounded-lg border border-[var(--ds-danger)] bg-[var(--ds-danger-soft)] px-3 py-2 text-[13px] text-[var(--ds-danger)]"
              >
                {phase.message}
              </div>
              <Button variant="outline" onClick={recheck}>
                Try again
              </Button>
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}

// ── Install-as-app (PWA) ─────────────────────────────────────────────────────

/** The `beforeinstallprompt` event isn't in the standard DOM lib — model just what we use. */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

/** True when the app is already running as an installed PWA (standalone display). */
function readInstalled(): boolean {
  if (typeof window === 'undefined') return false;
  if (window.matchMedia?.('(display-mode: standalone)').matches) return true;
  const nav = navigator as Navigator & { standalone?: boolean };
  return nav.standalone === true;
}

function isIOS(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /iphone|ipad|ipod/i.test(navigator.userAgent);
}

/**
 * InstallAsAppCard — a PWA install affordance for Settings.
 *
 * Honest by construction: we only render a real "Install" button when the
 * browser has actually fired `beforeinstallprompt` (so a click leads to a real
 * native prompt). When that event isn't available — iOS Safari, or a browser
 * that never offers programmatic install — we show platform-appropriate manual
 * guidance instead of a dead button.
 */
function InstallAsAppCard(): ReactElement {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState<boolean>(readInstalled);
  const [installing, setInstalling] = useState(false);

  useEffect(() => {
    const onBeforeInstall = (event: Event): void => {
      // Stop Chrome's mini-infobar so this card owns the install moment.
      event.preventDefault();
      setDeferredPrompt(event as BeforeInstallPromptEvent);
    };
    const onInstalled = (): void => {
      setInstalled(true);
      setDeferredPrompt(null);
    };
    window.addEventListener('beforeinstallprompt', onBeforeInstall);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstall);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  const handleInstall = async (): Promise<void> => {
    if (!deferredPrompt) return;
    setInstalling(true);
    try {
      await deferredPrompt.prompt();
      const choice = await deferredPrompt.userChoice;
      // The prompt can only be used once — drop it either way.
      setDeferredPrompt(null);
      if (choice.outcome === 'accepted') setInstalled(true);
    } finally {
      setInstalling(false);
    }
  };

  return (
    <Card>
      <div className="p-5 sm:p-6">
        <SectionHeader
          title={
            <span className="inline-flex items-center gap-2">
              <MonitorSmartphone size={16} aria-hidden="true" className="text-[var(--ds-text-subtle)]" />
              Install as app
            </span>
          }
          description="Add OyeChats to your dock or home screen so incoming chats reach you even when the browser is closed."
        />

        <div className="mt-4">
          {installed ? (
            <p className="flex items-center gap-2 text-[13px] text-[var(--ds-success)]">
              <Check size={15} aria-hidden="true" />
              You’re running OyeChats as an installed app on this device.
            </p>
          ) : deferredPrompt ? (
            <Button onClick={() => void handleInstall()} disabled={installing}>
              {installing ? (
                <Loader2 size={16} aria-hidden="true" className="animate-spin" />
              ) : (
                <Download size={16} aria-hidden="true" />
              )}
              {installing ? 'Installing…' : 'Install OyeChats'}
            </Button>
          ) : (
            <div className="flex items-start gap-3 rounded-xl border border-[var(--ds-border)] bg-[var(--ds-bg-sunken)] px-4 py-3">
              <Info
                size={16}
                aria-hidden="true"
                className="mt-0.5 shrink-0 text-[var(--ds-text-subtle)]"
              />
              <p className="text-[13px] text-[var(--ds-text-muted)]">
                {isIOS() ? (
                  <>
                    To install, tap the <strong className="text-[var(--ds-text)]">Share</strong> icon
                    in Safari, then choose{' '}
                    <strong className="text-[var(--ds-text)]">Add to Home Screen</strong>.
                  </>
                ) : (
                  <>
                    Your browser doesn’t offer a one-click install here. Open the browser menu and
                    look for <strong className="text-[var(--ds-text)]">Install app</strong> or{' '}
                    <strong className="text-[var(--ds-text)]">Add to Home Screen</strong>.
                  </>
                )}
              </p>
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}

// ── Section ──────────────────────────────────────────────────────────────────

/**
 * NotificationsSection — the Settings ▸ Notifications surface: manage browser
 * web-push honestly (real permission state, subscribe/unsubscribe when the
 * platform genuinely allows it) plus a PWA "Install as app" affordance.
 */
export function NotificationsSection(): ReactElement {
  return (
    <section aria-labelledby="notifications-heading" className="space-y-4">
      <SectionHeader
        title={<span id="notifications-heading">Notifications</span>}
        description="Choose how OyeChats reaches you on this device."
      />
      <div className="space-y-4">
        <NotificationsCard />
        <InstallAsAppCard />
      </div>
    </section>
  );
}
