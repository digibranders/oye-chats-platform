import { describe, expect, it } from 'vitest';
import { TIER_EVENT, listeningWebhooks, qualifiedLeadRouting } from './tierOutcomes';
import type { Webhook } from '../../../types/domain';

function hook(overrides: Partial<Webhook>): Webhook {
  return { id: 1, url: 'https://example.test/hook', events: [], is_active: true, ...overrides };
}

describe('qualifiedLeadRouting', () => {
  /* A field-for-field port of `get_notification_recipients(bot, "qualified_lead")`
     in email_service.py. If this drifts, the page tells a customer an email will
     be sent that never is, or that nobody hears about a lead the owner is in
     fact emailed about. */

  const saved = (recipients: string[]) => ({ recipients, ownerFallback: false });

  it('prefers the per-event list', () => {
    expect(
      qualifiedLeadRouting({
        notification_emails: { qualified_lead: ['sales@example.test'], default: ['all@example.test'] },
        notification_email: 'legacy@example.test',
        owner_email: 'owner@example.test',
      }),
    ).toEqual(saved(['sales@example.test']));
  });

  it('falls back to the default list when the per-event list is empty', () => {
    expect(
      qualifiedLeadRouting({
        notification_emails: { qualified_lead: [], default: ['all@example.test'] },
      }),
    ).toEqual(saved(['all@example.test']));
  });

  it('falls back to the legacy comma-separated field next', () => {
    expect(
      qualifiedLeadRouting({
        notification_email: 'a@example.test, b@example.test',
        owner_email: 'owner@example.test',
      }),
    ).toEqual(saved(['a@example.test', 'b@example.test']));
  });

  it('ends at the account owner, as the server does', () => {
    expect(
      qualifiedLeadRouting({
        notification_emails: { default: ['  '] },
        notification_email: '',
        owner_email: ' owner@example.test ',
      }),
    ).toEqual({ recipients: ['owner@example.test'], ownerFallback: true });
  });

  it('returns nobody only when not even the owner is known', () => {
    expect(qualifiedLeadRouting({})).toEqual(saved([]));
    expect(
      qualifiedLeadRouting({ notification_emails: {}, notification_email: '', owner_email: null }),
    ).toEqual(saved([]));
  });

  it('ignores non-string entries rather than rendering them', () => {
    expect(
      qualifiedLeadRouting({ notification_emails: { qualified_lead: [42, 'ok@example.test'] } }),
    ).toEqual(saved(['ok@example.test']));
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
