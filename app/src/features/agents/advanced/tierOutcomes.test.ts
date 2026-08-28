import { describe, expect, it } from 'vitest';
import { TIER_EVENT, listeningWebhooks, qualifiedLeadRecipients } from './tierOutcomes';
import type { Webhook } from '../../../types/domain';

function hook(overrides: Partial<Webhook>): Webhook {
  return { id: 1, url: 'https://example.test/hook', events: [], is_active: true, ...overrides };
}

describe('qualifiedLeadRecipients', () => {
  /* A field-for-field port of `get_notification_recipients(bot, "qualified_lead")`
     in email_service.py. If this drifts, the page tells a customer an email will
     be sent that never is — which is the exact failure the panel exists to
     prevent. */

  it('prefers the per-event list', () => {
    expect(
      qualifiedLeadRecipients({
        notification_emails: { qualified_lead: ['sales@example.test'], default: ['all@example.test'] },
        notification_email: 'legacy@example.test',
      }),
    ).toEqual(['sales@example.test']);
  });

  it('falls back to the default list when the per-event list is empty', () => {
    expect(
      qualifiedLeadRecipients({
        notification_emails: { qualified_lead: [], default: ['all@example.test'] },
      }),
    ).toEqual(['all@example.test']);
  });

  it('falls back to the legacy comma-separated field last', () => {
    expect(
      qualifiedLeadRecipients({ notification_email: 'a@example.test, b@example.test' }),
    ).toEqual(['a@example.test', 'b@example.test']);
  });

  it('returns nobody when nothing is configured', () => {
    expect(qualifiedLeadRecipients({})).toEqual([]);
    expect(qualifiedLeadRecipients({ notification_emails: {}, notification_email: '' })).toEqual([]);
  });

  it('ignores non-string entries rather than rendering them', () => {
    expect(
      qualifiedLeadRecipients({ notification_emails: { qualified_lead: [42, 'ok@example.test'] } }),
    ).toEqual(['ok@example.test']);
  });
});

describe('listeningWebhooks', () => {
  it('counts only webhooks that are active AND subscribed to the tier event', () => {
    const hooks = [
      hook({ id: 1, events: [TIER_EVENT] }),
      hook({ id: 2, events: [TIER_EVENT], is_active: false }),
      hook({ id: 3, events: ['lead_captured'] }),
    ];
    expect(listeningWebhooks(hooks).map((item) => item.id)).toEqual([1]);
  });

  it('survives a payload with no events array', () => {
    expect(listeningWebhooks([hook({ events: undefined as unknown as string[] })])).toEqual([]);
  });
});
