import type { Bot } from '../../types/domain';

/**
 * How a conversation reaches the team.
 *
 * Three numbers that decide what a visitor experiences while they wait, and
 * none of them had a control anywhere in the console — they sat on the chatbot
 * row at their defaults and were read by the live-chat state machine on every
 * handoff. That is the ledger's "queue analytics / routing" corner, minus the
 * part the backend cannot yet accept (see below).
 *
 * **What is deliberately absent.** `Bot.live_chat_routing_strategy`,
 * `Bot.visitor_disconnect_timeout` and `Bot.operator_disconnect_timeout` exist
 * on the model and are read at runtime, but `UpdateBotRequest` in
 * `api/app/api/bot_routes.py` has no field for any of them, so no client can
 * write them. Rendering a control for a value the server will silently drop is
 * worse than not rendering one, so they are not here — the gap is a backend
 * item, not a UI one.
 *
 * The bounds mirror the server's own `Field(ge=…, le=…)` exactly, so a form
 * this accepts can never be rejected by the API.
 */

export interface BotQueueSettings {
  operator_timeout_seconds?: number;
  live_chat_queue_timeout_seconds?: number;
  live_chat_max_queue_size?: number;
}

export type BotWithQueue = Bot & BotQueueSettings;

export interface QueueSettings {
  /** Seconds an operator has to accept before the chat goes back to the queue. */
  acceptSeconds: string;
  /** Seconds a visitor waits before falling back to the offline form. */
  waitSeconds: string;
  /** How many visitors may queue at once. */
  maxQueue: string;
}

interface Bound {
  min: number;
  max: number;
  /** What the number means, phrased as the consequence of getting it wrong. */
  tooSmall: string;
  tooLarge: string;
}

export const QUEUE_BOUNDS: Record<keyof QueueSettings, Bound> = {
  acceptSeconds: {
    min: 5,
    max: 3600,
    tooSmall: 'Give them at least 5 seconds — anything less and nobody can answer in time.',
    tooLarge: 'Keep it under an hour. A visitor will not wait that long in silence.',
  },
  waitSeconds: {
    min: 5,
    max: 600,
    tooSmall: 'At least 5 seconds, or the offline form appears before anyone can pick up.',
    tooLarge: 'Ten minutes is the most we will hold a visitor before offering the form.',
  },
  maxQueue: {
    min: 1,
    max: 100,
    tooSmall: 'At least one, or nobody can ever wait.',
    tooLarge: 'A hundred is the ceiling. Past that, the wait is the problem, not the queue.',
  },
};

export function readQueueSettings(bot: Bot): QueueSettings {
  const settings = bot as BotWithQueue;
  return {
    acceptSeconds: String(settings.operator_timeout_seconds ?? 120),
    waitSeconds: String(settings.live_chat_queue_timeout_seconds ?? 20),
    maxQueue: String(settings.live_chat_max_queue_size ?? 10),
  };
}

/** The reason a value is unacceptable, or `null`. Mirrors the server's bounds. */
export function validateQueueField(field: keyof QueueSettings, raw: string): string | null {
  const bound = QUEUE_BOUNDS[field];
  const trimmed = raw.trim();
  if (!trimmed) return 'Enter a number.';
  if (!/^\d+$/.test(trimmed)) return 'Use a whole number.';
  const value = Number.parseInt(trimmed, 10);
  if (value < bound.min) return bound.tooSmall;
  if (value > bound.max) return bound.tooLarge;
  return null;
}

export function validateQueueSettings(
  settings: QueueSettings,
): Partial<Record<keyof QueueSettings, string>> {
  const errors: Partial<Record<keyof QueueSettings, string>> = {};
  for (const field of Object.keys(QUEUE_BOUNDS) as (keyof QueueSettings)[]) {
    const reason = validateQueueField(field, settings[field]);
    if (reason) errors[field] = reason;
  }
  return errors;
}

export function toQueuePatch(settings: QueueSettings): Record<string, number> {
  return {
    operator_timeout_seconds: Number.parseInt(settings.acceptSeconds, 10),
    live_chat_queue_timeout_seconds: Number.parseInt(settings.waitSeconds, 10),
    live_chat_max_queue_size: Number.parseInt(settings.maxQueue, 10),
  };
}

export function queueSettingsChanged(a: QueueSettings, b: QueueSettings): boolean {
  return (
    a.acceptSeconds.trim() !== b.acceptSeconds.trim() ||
    a.waitSeconds.trim() !== b.waitSeconds.trim() ||
    a.maxQueue.trim() !== b.maxQueue.trim()
  );
}
