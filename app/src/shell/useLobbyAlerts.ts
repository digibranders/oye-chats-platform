import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useInboxSocket } from '../features/inbox/inboxSocket';
import { playPing } from '../features/inbox/notifications';
import { useOperatorPresence } from './operatorPresenceContext';
import { alertsFrom, type LobbyAlert } from './lobbyModel';

/**
 * The alert stack's state: which cards, for how long, and when to make a noise.
 *
 * Split from the cards themselves so the awkward parts are testable without a
 * DOM: the repeating chime, the mute, per-visitor dismissal, and the arrival
 * order that keeps a new card from taking the top slot.
 */

const MUTE_KEY = 'oc_lobby_muted';
/** One clock for the whole stack, so ten cards are not ten timers. */
const TICK_MS = 1000;
/**
 * How often the chime repeats while somebody is still in the lobby.
 *
 * Once is not enough: the whole report was an operator missing a signal that
 * fired exactly once. Every 30 seconds is roughly the cadence of a desk phone
 * and is short enough that a visitor is not left for three minutes, while being
 * long enough not to become the reason somebody mutes it permanently. `playPing`
 * throttles itself at 1.5s, so a burst of arrivals is still one sound.
 */
const CHIME_EVERY_MS = 30_000;

function readMuted(): boolean {
  try {
    return window.sessionStorage.getItem(MUTE_KEY) === '1';
  } catch {
    return false;
  }
}

export interface LobbyAlertsState {
  alerts: LobbyAlert[];
  /** Ticks once a second while anything is on screen; frozen when nothing is. */
  now: number;
  muted: boolean;
  toggleMute: () => void;
  dismiss: (sessionId: string, since: string | null) => void;
  /** The connection is down, so the stack is stale rather than empty. */
  stale: boolean;
}

export function useLobbyAlerts(): LobbyAlertsState {
  const socket = useInboxSocket();
  const presence = useOperatorPresence();
  const location = useLocation();
  const onInboxPage = location.pathname.startsWith('/inbox');

  const [dismissed, setDismissed] = useState<ReadonlyMap<string, string | null>>(() => new Map());
  const [muted, setMuted] = useState(readMuted);
  const [now, setNow] = useState(() => Date.now());

  const enabled = presence.liveChat && !presence.unavailable && presence.isOnline;

  const alerts = useMemo(
    () =>
      alertsFrom({
        queue: socket.queue,
        activeChats: socket.activeChats,
        unreadBySession: socket.unreadBySession,
        messagesBySession: socket.messagesBySession,
        dismissed,
        enabled,
        onInboxPage,
      }),
    [
      socket.queue,
      socket.activeChats,
      socket.unreadBySession,
      socket.messagesBySession,
      dismissed,
      enabled,
      onInboxPage,
    ],
  );

  // The clock runs only while something is on screen. A timer ticking behind an
  // empty stack is a re-render a second, all day, for nothing.
  const hasAlerts = alerts.length > 0;
  useEffect(() => {
    if (!hasAlerts) return undefined;
    const tick = (): void => setNow(Date.now());
    // The clock is frozen while the stack is empty, so it can be minutes stale
    // by the time a card appears — an operator coming on duty to a queue that
    // is already three deep would see every wait as "0s" until the first tick.
    // Scheduled rather than called straight out of the effect body: a
    // synchronous setState here is a second render before the browser has
    // painted the first.
    const lead = window.setTimeout(tick, 0);
    const timer = window.setInterval(tick, TICK_MS);
    return () => {
      window.clearTimeout(lead);
      window.clearInterval(timer);
    };
  }, [hasAlerts]);

  // The chime, on a schedule rather than on an event. Driven by "is anybody
  // still waiting" instead of "did somebody arrive", because the failure being
  // fixed is a signal that happened once and was missed.
  const waitingCount = alerts.filter((alert) => alert.kind === 'waiting').length;
  const lastChimeRef = useRef(0);
  useEffect(() => {
    if (muted || waitingCount === 0) {
      lastChimeRef.current = 0;
      return undefined;
    }
    const ring = (): void => {
      lastChimeRef.current = Date.now();
      playPing();
    };
    // The first one is immediate: an operator should not wait 30 seconds to be
    // told somebody is here.
    if (lastChimeRef.current === 0) ring();
    const timer = window.setInterval(ring, CHIME_EVERY_MS);
    return () => window.clearInterval(timer);
  }, [muted, waitingCount]);

  const toggleMute = useCallback(() => {
    setMuted((current) => {
      const next = !current;
      try {
        // The session, not forever. Muting is a "not right now", and a mute
        // that outlives the shift is how an operator ends up wondering why the
        // console never makes a sound any more.
        window.sessionStorage.setItem(MUTE_KEY, next ? '1' : '0');
      } catch {
        /* storage blocked; the mute still holds for this page */
      }
      return next;
    });
  }, []);

  // Recorded against the moment, not the session id alone: see `LobbySources`.
  // The caller passes the alert's own `since`, which is the thing being closed.
  const dismiss = useCallback((sessionId: string, since: string | null) => {
    setDismissed((current) => new Map(current).set(sessionId, since));
  }, []);

  return {
    alerts,
    now,
    muted,
    toggleMute,
    dismiss,
    stale: enabled && (socket.status === 'reconnecting' || socket.status === 'connecting'),
  };
}
