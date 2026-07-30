/**
 * Operator alert helpers - a short WebAudio chime plus optional native browser
 * notifications, ported from the legacy operator console (`pages/LiveChat.jsx`
 * `playNotification` / `sendBrowserNotification`).
 *
 * Sound uses a lazily-created, gesture-resumed `AudioContext` (the operator has
 * already clicked "Go online", so autoplay policies are satisfied). Browser
 * notifications only fire when the tab is hidden and permission was granted, so
 * a focused operator is never double-alerted. Every call is best-effort and
 * swallows failures - a missing capability must never break the socket.
 */

const PING_THROTTLE_MS = 1500;
const FAVICON = '/oye_favicon_cropped.png';

let audioCtx: AudioContext | null = null;
let lastPingAt = 0;

type WebkitWindow = Window & { webkitAudioContext?: typeof AudioContext };

/** Play a short two-stage chime. Throttled so a burst of events beeps once. */
export function playPing(): void {
  if (typeof window === 'undefined') return;
  const now = Date.now();
  if (now - lastPingAt < PING_THROTTLE_MS) return;
  lastPingAt = now;
  try {
    const Ctx = window.AudioContext || (window as WebkitWindow).webkitAudioContext;
    if (!Ctx) return;
    if (!audioCtx) audioCtx = new Ctx();
    if (audioCtx.state === 'suspended') void audioCtx.resume();
    const ctx = audioCtx;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.setValueAtTime(660, ctx.currentTime + 0.12);
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.14, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.3);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.31);
  } catch {
    /* audio unavailable - ignore */
  }
}

/** Request notification permission once, if the user hasn't decided yet. */
export function ensureNotificationPermission(): void {
  try {
    if (typeof Notification === 'undefined') return;
    if (Notification.permission === 'default') void Notification.requestPermission();
  } catch {
    /* ignore */
  }
}

/**
 * Show a native notification - only when the tab is hidden and permission was
 * granted. Clicking it refocuses the dashboard. Uses a stable `tag` so repeated
 * alerts collapse instead of stacking.
 */
export function notifyBrowser(title: string, body?: string): void {
  try {
    if (typeof Notification === 'undefined' || typeof document === 'undefined') return;
    if (Notification.permission !== 'granted' || !document.hidden) return;
    const notification = new Notification(title, {
      body,
      icon: FAVICON,
      tag: 'oyechats-livechat',
    });
    notification.onclick = () => {
      try {
        window.focus();
      } finally {
        notification.close();
      }
    };
  } catch {
    /* ignore */
  }
}

/** Fire both channels for a new-activity event. */
export function alertOperator(title: string, body?: string): void {
  playPing();
  notifyBrowser(title, body);
}
