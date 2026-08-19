import type { Webhook } from '../../../types/domain';

/**
 * What actually happens when a lead crosses a tier.
 *
 * This module exists because the answer is surprising, and until now the console
 * did not tell anyone: **only SQL fires anything.** `rag_service` checks
 * `new_tier == "sql" and old_tier != "sql"` and, inside that branch alone, sends
 * the qualified-lead email and dispatches the `tier_transition` webhook
 * (api/app/services/rag_service.py:2572-2611). Reaching MQL or SAL updates the
 * lead's tier and nothing else — no email, no webhook, no handoff.
 *
 * A customer tuning three thresholds with no idea that two of them notify nobody
 * is configuring in the dark, so the page states it.
 */

/** The event name a webhook must subscribe to in order to hear about tiers. */
export const TIER_EVENT = 'tier_transition';

/**
 * Resolve the recipients of the qualified-lead email for a bot payload.
 *
 * A field-for-field port of `get_notification_recipients(bot, "qualified_lead")`
 * in api/app/services/email_service.py:328 — per-event list, then the default
 * list, then the legacy comma-separated single field, then nobody.
 */
export function qualifiedLeadRecipients(raw: Record<string, unknown>): string[] {
  const routing = raw.notification_emails;
  if (typeof routing === 'object' && routing !== null && !Array.isArray(routing)) {
    const map = routing as Record<string, unknown>;
    for (const key of ['qualified_lead', 'default']) {
      const list = map[key];
      if (Array.isArray(list)) {
        const cleaned = list
          .filter((item): item is string => typeof item === 'string')
          .map((item) => item.trim())
          .filter(Boolean);
        if (cleaned.length > 0) return cleaned;
      }
    }
  }
  const legacy = raw.notification_email;
  if (typeof legacy === 'string' && legacy.trim()) {
    return legacy
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

/** Webhooks that are switched on AND subscribed to `tier_transition`. */
export function listeningWebhooks(webhooks: readonly Webhook[]): Webhook[] {
  return webhooks.filter(
    (hook) => hook.is_active && Array.isArray(hook.events) && hook.events.includes(TIER_EVENT),
  );
}
