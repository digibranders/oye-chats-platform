/**
 * What a webhook is for, said in the customer's words.
 *
 * The event names on the wire are `tier_transition`, `handoff_requested` and so
 * on. Nobody choosing which events to subscribe to is thinking in those terms,
 * and the console this replaces showed the raw strings in the delivery log — so
 * a failed delivery read `tier_transition 500` and told the reader nothing about
 * what had actually gone unnotified.
 */

export interface WebhookEventDefinition {
  value: string;
  label: string;
  description: string;
}

export const WEBHOOK_EVENTS: readonly WebhookEventDefinition[] = [
  {
    value: 'tier_transition',
    label: 'Lead qualified',
    description: 'A visitor moved up a qualification tier. This is the one most CRMs listen for.',
  },
  {
    value: 'lead_captured',
    label: 'Lead captured',
    description: 'A visitor gave their contact details.',
  },
  {
    value: 'handoff_requested',
    label: 'Handoff requested',
    description: 'A visitor asked to speak to a person.',
  },
  {
    value: 'chat_closed',
    label: 'Conversation closed',
    description: 'A conversation ended, with its transcript and outcome.',
  },
  {
    value: 'meeting_booked',
    label: 'Meeting booked',
    description: 'A visitor booked a slot through your scheduling link.',
  },
];

const BY_VALUE = new Map(WEBHOOK_EVENTS.map((event) => [event.value, event]));

/** The readable name for an event, falling back to the wire name for a new one. */
export function eventLabel(value: string): string {
  return BY_VALUE.get(value)?.label ?? value;
}

/** What a webhook subscribes to, in a sentence a table cell can hold. */
export function describeEvents(events: readonly string[]): string {
  if (events.length === 0) return 'No events, so nothing will be sent';
  if (events.length === WEBHOOK_EVENTS.length) return 'Every event';
  return events.map(eventLabel).join(', ');
}

export const DEFAULT_EVENTS: readonly string[] = ['tier_transition', 'lead_captured'];

/**
 * A delivery endpoint has to be reachable from our servers, which rules out
 * `localhost` and plain HTTP. Saying so before the save is kinder than a 422.
 */
export function validateWebhookUrl(raw: string): string | null {
  const value = raw.trim();
  if (!value) return 'Enter the URL that should receive the events.';
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'That is not a valid URL. It should start with https://';
  }
  if (url.protocol !== 'https:') {
    return 'Use https://. We will not send your customers’ details over an unencrypted connection.';
  }
  if (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname.endsWith('.local')) {
    return 'This address only exists on your own machine, so our servers cannot reach it. Use a tunnel such as ngrok while you are testing.';
  }
  return null;
}

export type DeliveryOutcome = 'delivered' | 'rejected' | 'pending';

/**
 * A delivery's outcome, decided once.
 *
 * 2xx is delivered. Anything else is a rejection *by the endpoint*, which is a
 * different problem from a delivery still in flight, and rendering both as a
 * red row made a queued retry look like a failure.
 */
export function deliveryOutcome(statusCode: number | null | undefined): DeliveryOutcome {
  if (statusCode == null) return 'pending';
  return statusCode >= 200 && statusCode < 300 ? 'delivered' : 'rejected';
}

export const DELIVERY_TONE: Record<DeliveryOutcome, 'success' | 'danger' | 'warning'> = {
  delivered: 'success',
  rejected: 'danger',
  pending: 'warning',
};

export const DELIVERY_LABEL: Record<DeliveryOutcome, string> = {
  delivered: 'Delivered',
  rejected: 'Rejected',
  pending: 'Waiting to retry',
};

/** The exact JSON an endpoint receives, so a CRM mapping can be written from it. */
export const PAYLOAD_EXAMPLE = `{
  "event": "tier_transition",
  "bot_id": 1,
  "timestamp": "2026-04-06T12:00:00Z",
  "data": {
    "session_id": "session_abc123",
    "old_tier": "mql",
    "new_tier": "sql",
    "score": 80,
    "behavioral_score": 15,
    "contact": {
      "name": "Jane",
      "email": "jane@acme.com",
      "phone": "+1234",
      "company": "Acme"
    },
    "dimensions": { "need": 25, "budget": 20, "authority": 15, "timeline": 20 }
  }
}`;
