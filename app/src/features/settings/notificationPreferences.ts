import type { NotificationPreferences } from '../../services/api';
import { t as translateNow } from '../../i18n/i18n';

/**
 * Per-event push preferences and quiet hours.
 *
 * `GET/PUT /operators/me/notification-preferences` has existed since push was
 * built, is consulted on every dispatch (`filter_operators_by_push_prefs` and
 * `client_wants_push`), and had **no client function and no UI at all** — so
 * the only way to stop being woken at 3am by a handoff request was to turn all
 * notifications off in the browser. That is the ledger entry this closes.
 *
 * The PUT replaces the whole `push` object rather than patching it, so
 * everything here works in complete states: a partial body silently resets the
 * fields it omits back to their defaults.
 */

export type PushEventKey = 'handoff_request' | 'chat_transferred' | 'offline_message';

export interface PushEventDefinition {
  key: PushEventKey;
  label: string;
  description: string;
}

/** Mirrors `_PUSH_EVENT_KEYS` in `api/app/api/operator_routes.py`. */
export const PUSH_EVENTS: readonly PushEventDefinition[] = [
  {
    key: 'handoff_request',
    label: 'A visitor asks for a person',
    description:
      'The one that is genuinely urgent. Somebody is waiting, and every second of silence is a second they might leave.',
  },
  {
    key: 'chat_transferred',
    label: 'A conversation is transferred to you',
    description: 'A teammate has handed you a conversation that is already in progress.',
  },
  {
    key: 'offline_message',
    label: 'Someone leaves a message while you are away',
    description: 'Nobody is waiting on the other end, so this one can usually be read later.',
  },
];

export interface QuietHours {
  start: string;
  end: string;
  tz: string;
}

export interface PushPreferences {
  enabled: boolean;
  events: Record<PushEventKey, boolean>;
  quietHours: QuietHours | null;
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function localTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** Everything on, no quiet hours — what the backend means by "no preferences set". */
export function defaultPreferences(): PushPreferences {
  return {
    enabled: true,
    events: { handoff_request: true, chat_transferred: true, offline_message: true },
    quietHours: null,
  };
}

/**
 * Read the wire format, tolerating an older or newer server.
 *
 * The backend already fully defaults its response, but this is the boundary and
 * a missing field must never read as "off" — telling somebody their alerts are
 * disabled when they are not is the failure that costs a live conversation.
 */
export function fromWire(raw: NotificationPreferences | null | undefined): PushPreferences {
  const base = defaultPreferences();
  const push = raw?.push;
  if (!push) return base;

  const events = { ...base.events };
  for (const { key } of PUSH_EVENTS) {
    const value = (push.events as unknown as Record<string, unknown> | undefined)?.[key];
    if (typeof value === 'boolean') events[key] = value;
  }

  const quiet = push.quiet_hours;
  return {
    enabled: typeof push.enabled === 'boolean' ? push.enabled : base.enabled,
    events,
    quietHours:
      quiet && HHMM.test(quiet.start ?? '') && HHMM.test(quiet.end ?? '')
        ? { start: quiet.start, end: quiet.end, tz: quiet.tz || 'UTC' }
        : null,
  };
}

export function toWire(preferences: PushPreferences): NotificationPreferences {
  return {
    push: {
      enabled: preferences.enabled,
      events: {
        handoff_request: preferences.events.handoff_request,
        chat_transferred: preferences.events.chat_transferred,
        offline_message: preferences.events.offline_message,
      },
      quiet_hours: preferences.quietHours
        ? {
            start: preferences.quietHours.start,
            end: preferences.quietHours.end,
            tz: preferences.quietHours.tz || 'UTC',
          }
        : null,
    },
  };
}

export function preferencesChanged(a: PushPreferences, b: PushPreferences): boolean {
  return JSON.stringify(toWire(a)) !== JSON.stringify(toWire(b));
}

/** Server-side rule: `HH:MM`, 24-hour. Returns the reason it failed, or `null`. */
export function validateTime(value: string): string | null {
  return HHMM.test(value) ? null : translateNow('settings.useA24HourTime') || 'Use a 24-hour time, like 22:00.';
}

/**
 * Quiet hours in a sentence, including the case that trips people up.
 *
 * A window from 22:00 to 07:00 wraps midnight — it is nine hours, not
 * negative fifteen — and a control that renders it as a plain range leaves the
 * reader unsure whether it silenced one hour or twenty-three.
 */
export function describeQuietHours(quiet: QuietHours | null): string {
  if (!quiet) return translateNow('settings.alertsCanReachYouAt') || 'Alerts can reach you at any hour.';
  const wraps = quiet.start > quiet.end;
  return wraps
    ? `Silenced from ${quiet.start} until ${quiet.end} the next morning, ${quiet.tz} time.`
    : `Silenced from ${quiet.start} until ${quiet.end}, ${quiet.tz} time.`;
}

/** True when nothing can reach the user, whatever the individual switches say. */
export function isFullySilenced(preferences: PushPreferences): boolean {
  if (!preferences.enabled) return true;
  return PUSH_EVENTS.every(({ key }) => !preferences.events[key]);
}
