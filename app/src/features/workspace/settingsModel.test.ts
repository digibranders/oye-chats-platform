import { describe, expect, it } from 'vitest';
import {
  assignableRoles,
  canManageTeam,
  roleChangeConsequence,
  roleDefinition,
  roleLabel,
  roleTone,
  validateConcurrentChats,
} from './roles';
import {
  AVAILABILITY_LABEL,
  availability,
  byPresenceThenName,
  departmentIdFromSelect,
  departmentName,
  inviteExpired,
  inviteExpiry,
  pendingInvitesFor,
  rosterFor,
  seatsUsed,
  selfSeat,
  unwrapList,
} from './teamModel';
import { changedValues, describeDirty, dirtyKeys } from './draft';
import {
  defaultBusinessHours,
  invalidDays,
  normalizeBusinessHours,
  type BusinessHours,
} from './businessHours';
import { resolveAirlockState, inviteRoleSentence } from './inviteAirlockModel';
import {
  DELIVERY_LABEL,
  deliveryOutcome,
  describeEvents,
  eventLabel,
  validateWebhookUrl,
} from './integrations/webhookModel';
import {
  MEETING_PROVIDERS,
  readEmailRouting,
  routingChanged,
  toBotPatch,
  validateMeetingUrl,
} from './integrations/emailModel';
import type { Bot, Operator, OperatorInvite } from '../../types/domain';

/**
 * The settings surfaces' arithmetic, pinned.
 *
 * Everything here is a decision the UI makes on the user's behalf, and each one
 * maps to something the console this replaces got wrong: a seat meter that
 * counted the wrong scope, a role picker with no notion of who may grant what,
 * a dirty check that fired on a trailing space, an airlock that could join the
 * wrong account to a workspace, and a booking link saved onto the wrong
 * provider's column.
 */

function operator(overrides: Partial<Operator> = {}): Operator {
  return {
    id: 1,
    name: 'Priya',
    email: 'priya@acme.com',
    role: 'operator',
    bot_id: 1,
    is_online: false,
    is_active: true,
    linked_client_id: null,
    max_concurrent_chats: 3,
    ...overrides,
  };
}

describe('roles', () => {
  it('names every role it offers, and falls back rather than rendering a blank', () => {
    expect(roleLabel('owner')).toBe('Owner');
    expect(roleLabel('operator')).toBe('Operator');
    expect(roleLabel('something-new')).toBe('Member');
    expect(roleTone('owner')).toBe('plan');
    expect(roleTone(null)).toBe('neutral');
  });

  it('says what each role can actually do, at the moment of choosing', () => {
    // "Admin" alone is not informative — the picker's hint is generated from
    // this, so an empty list would ship a bare dropdown again.
    for (const role of ['owner', 'admin', 'operator'] as const) {
      expect(roleDefinition(role)?.can.length).toBeGreaterThan(0);
      expect(roleDefinition(role)?.summary).not.toBe('');
    }
  });

  it('only offers Owner to somebody who may grant it', () => {
    // Mirrors `_prevent_role_escalation`: an admin offering an Owner option
    // would be offering a control that always 403s.
    expect(assignableRoles('admin').map((role) => role.value)).toEqual(['operator', 'admin']);
    expect(assignableRoles('owner').map((role) => role.value)).toContain('owner');
    // A client identity with no seat role is the solo-owner case.
    expect(assignableRoles(null).map((role) => role.value)).toContain('owner');
  });

  it('treats an absent role as the solo owner, not as an operator', () => {
    expect(canManageTeam(null)).toBe(true);
    expect(canManageTeam('admin')).toBe(true);
    expect(canManageTeam('operator')).toBe(false);
  });

  it('spells out the consequence of a promotion to owner, including billing', () => {
    const sentence = roleChangeConsequence('Priya', 'operator', 'owner');
    expect(sentence).toContain('billing');
    expect(sentence).toContain('API key');
    expect(sentence).toContain('Priya');
  });

  it('spells out what a demotion from owner takes away', () => {
    expect(roleChangeConsequence('Priya', 'owner', 'admin')).toContain('lose owner access');
  });

  it('refuses a capacity that would make an operator unroutable', () => {
    // `Number('')` is 0, which is an operator who can never be handed a chat.
    expect(validateConcurrentChats('').value).toBeNull();
    expect(validateConcurrentChats('0').error).not.toBeNull();
    expect(validateConcurrentChats('101').error).not.toBeNull();
    expect(validateConcurrentChats('3.5').error).not.toBeNull();
    expect(validateConcurrentChats(' 5 ')).toEqual({ value: 5, error: null });
  });
});

describe('teamModel', () => {
  it('unwraps both list shapes the API actually returns', () => {
    expect(unwrapList<number>([1, 2], 'operators')).toEqual([1, 2]);
    expect(unwrapList<number>({ operators: [1] }, 'operators')).toEqual([1]);
    expect(unwrapList<number>({ other: [1] }, 'operators')).toEqual([]);
    expect(unwrapList<number>(null, 'operators')).toEqual([]);
  });

  it('counts seats per chatbot and ignores a deactivated one', () => {
    const operators = [
      operator({ id: 1, bot_id: 1 }),
      operator({ id: 2, bot_id: 1, is_active: false }),
      operator({ id: 3, bot_id: 2 }),
    ];
    expect(seatsUsed(operators, 1)).toBe(1);
    expect(seatsUsed(operators, 2)).toBe(1);
    // A workspace-wide count would disagree with the server's own per-bot gate.
    expect(seatsUsed(operators, null)).toBe(2);
  });

  it('keeps a deactivated seat visible on the roster it belongs to', () => {
    const operators = [operator({ id: 1, bot_id: 1, is_active: false })];
    expect(rosterFor(operators, 1)).toHaveLength(1);
    expect(availability(operators[0])).toBe('deactivated');
    expect(AVAILABILITY_LABEL.deactivated).toBe('Left live chat');
  });

  it('finds the caller by their linked client id, never by a shared email', () => {
    const operators = [
      operator({ id: 1, linked_client_id: null, email: 'owner@acme.com' }),
      operator({ id: 2, linked_client_id: 42 }),
    ];
    expect(selfSeat(operators, 42, 1)?.id).toBe(2);
    expect(selfSeat(operators, 7, 1)).toBeNull();
    expect(selfSeat(operators, null, 1)).toBeNull();
  });

  it('does not count a deactivated self seat as being on the roster', () => {
    const operators = [operator({ id: 2, linked_client_id: 42, is_active: false })];
    expect(selfSeat(operators, 42, 1)).toBeNull();
  });

  it('sorts online first, then offline, then people who have left', () => {
    const rows = [
      operator({ id: 1, name: 'Zoe', is_active: false }),
      operator({ id: 2, name: 'Anil' }),
      operator({ id: 3, name: 'Meera', is_online: true }),
    ].sort(byPresenceThenName);
    expect(rows.map((row) => row.name)).toEqual(['Meera', 'Anil', 'Zoe']);
  });

  it('shows only outstanding invitations, scoped to the chatbot', () => {
    const invites = [
      { id: 1, bot_id: 1, status: 'pending' },
      { id: 2, bot_id: 1, status: 'accepted' },
      { id: 3, bot_id: 2, status: 'pending' },
    ] as OperatorInvite[];
    expect(pendingInvitesFor(invites, 1).map((invite) => invite.id)).toEqual([1]);
  });

  it('reads an expiry as time remaining, which is the question being asked', () => {
    const now = Date.parse('2026-08-19T12:00:00Z');
    expect(inviteExpiry('2026-08-19T18:00:00Z', now)).toBe('Expires today');
    expect(inviteExpiry('2026-08-20T18:00:00Z', now)).toBe('Expires tomorrow');
    expect(inviteExpiry('2026-08-25T12:00:00Z', now)).toBe('Expires in 6 days');
    expect(inviteExpiry('2026-08-18T12:00:00Z', now)).toBe('Expired');
    expect(inviteExpiry(null, now)).toBe('No expiry');
    expect(inviteExpired('2026-08-18T12:00:00Z', now)).toBe(true);
    expect(inviteExpired(null, now)).toBe(false);
  });

  it('reads an empty department select as no department, not as department zero', () => {
    expect(departmentIdFromSelect('')).toBeNull();
    expect(departmentIdFromSelect('4')).toBe(4);
    expect(departmentName([{ id: 4, name: 'Billing' }], 4)).toBe('Billing');
    expect(departmentName([], 4)).toBeNull();
    expect(departmentName([], null)).toBeNull();
  });
});

describe('draft', () => {
  const baseline = { name: 'Acme', website: '' };

  it('does not call a trailing space a change', () => {
    expect(dirtyKeys(baseline, { name: 'Acme ', website: '' })).toEqual([]);
    expect(dirtyKeys(baseline, { name: 'Acme Ltd', website: '' })).toEqual(['name']);
  });

  it('sends only what moved, trimmed', () => {
    expect(changedValues(baseline, { name: ' Acme Ltd ', website: '' })).toEqual({
      name: 'Acme Ltd',
    });
    expect(changedValues(baseline, baseline)).toEqual({});
  });

  it('names the changed fields rather than announcing an anonymous change', () => {
    const labels = { name: 'Workspace name', website: 'Website' };
    expect(describeDirty([], labels)).toBe('');
    expect(describeDirty(['name'], labels)).toBe('Workspace name');
    expect(describeDirty(['name', 'website'], labels)).toBe('Workspace name and Website');
  });
});

describe('businessHours', () => {
  it('treats a null schedule as always open', () => {
    expect(normalizeBusinessHours(null).enabled).toBe(false);
    expect(defaultBusinessHours().days.sat.enabled).toBe(false);
    expect(defaultBusinessHours().days.mon.enabled).toBe(true);
  });

  it('fills in the days a partially-stored schedule is missing', () => {
    const stored = { enabled: true, timezone: 'Asia/Kolkata', days: { mon: { enabled: true, start: '10:00', end: '18:00' } } };
    const merged = normalizeBusinessHours(stored as unknown as BusinessHours);
    expect(merged.days.mon.start).toBe('10:00');
    expect(merged.days.fri).toBeDefined();
    expect(merged.timezone).toBe('Asia/Kolkata');
  });

  it('catches a day that closes before it opens, which the resolver reads as closed', () => {
    const hours = normalizeBusinessHours(null);
    hours.enabled = true;
    hours.days.mon = { enabled: true, start: '17:00', end: '09:00' };
    expect(invalidDays(hours)).toEqual(['mon']);
    hours.enabled = false;
    expect(invalidDays(hours)).toEqual([]);
  });
});

describe('inviteAirlockModel', () => {
  const base = {
    token: 'abc',
    invite: { status: 'pending', email: 'priya@acme.com', workspace_name: 'Acme' },
    inviteFailed: false,
    signedIn: false,
    operatorSession: false,
    currentEmail: null,
  };

  it('is invalid without a token, and without waiting for a request', () => {
    expect(resolveAirlockState({ ...base, token: '' })).toEqual({ kind: 'invalid' });
    expect(resolveAirlockState({ ...base, inviteFailed: true })).toEqual({ kind: 'invalid' });
  });

  it('separates a used, revoked and expired invitation from a broken link', () => {
    for (const status of ['accepted', 'revoked', 'expired'] as const) {
      expect(resolveAirlockState({ ...base, invite: { ...base.invite, status } })).toEqual({
        kind: 'resolved',
        status,
      });
    }
  });

  it('offers sign-in and sign-up to a signed-out visitor', () => {
    expect(resolveAirlockState(base)).toEqual({ kind: 'anonymous' });
  });

  it('catches an operator session before the accept button, not after it', () => {
    // `POST /invites/by-token/{token}/accept` needs a client identity, so this
    // would otherwise be a 401 on click with nothing explaining it.
    expect(
      resolveAirlockState({ ...base, signedIn: true, operatorSession: true }),
    ).toEqual({ kind: 'operator-session' });
  });

  it('waits for the profile rather than flashing "wrong account" at everyone', () => {
    expect(
      resolveAirlockState({ ...base, signedIn: true, currentEmail: undefined }),
    ).toEqual({ kind: 'identifying' });
  });

  it('never silently joins the wrong account to a workspace', () => {
    expect(
      resolveAirlockState({ ...base, signedIn: true, currentEmail: 'someone@else.com' }),
    ).toEqual({ kind: 'mismatch' });
    expect(
      resolveAirlockState({ ...base, signedIn: true, currentEmail: ' Priya@Acme.com ' }),
    ).toEqual({ kind: 'ready' });
  });

  it('says what the invited role actually allows', () => {
    expect(inviteRoleSentence('admin', 'Acme')).toContain('manage the team');
    expect(inviteRoleSentence('operator', 'Acme')).toContain('answer live conversations');
  });
});

describe('webhookModel', () => {
  it('shows event names a customer can act on, never the wire names', () => {
    expect(eventLabel('tier_transition')).toBe('Lead qualified');
    expect(eventLabel('some_future_event')).toBe('some_future_event');
    expect(describeEvents([])).toContain('nothing will be sent');
    expect(describeEvents(['tier_transition'])).toBe('Lead qualified');
  });

  it('refuses a URL our servers demonstrably cannot reach', () => {
    expect(validateWebhookUrl('https://hooks.example.com/x')).toBeNull();
    expect(validateWebhookUrl('')).not.toBeNull();
    expect(validateWebhookUrl('not a url')).not.toBeNull();
    expect(validateWebhookUrl('http://hooks.example.com')).toContain('https');
    expect(validateWebhookUrl('https://localhost:3000/hook')).toContain('own machine');
  });

  it('separates a rejection by the endpoint from a delivery still in flight', () => {
    expect(deliveryOutcome(200)).toBe('delivered');
    expect(deliveryOutcome(500)).toBe('rejected');
    expect(deliveryOutcome(null)).toBe('pending');
    expect(DELIVERY_LABEL.pending).toBe('Waiting to retry');
  });
});

describe('emailModel', () => {
  const bot = { id: 1, name: 'Acme Support' } as Bot;

  it('reads an unconfigured chatbot as notifying, because the backend does', () => {
    const routing = readEmailRouting(bot);
    expect(routing.onQualified).toBe(true);
    expect(routing.onHandoff).toBe(true);
    expect(routing.recipients).toEqual([]);
  });

  it('omits an empty per-event override rather than saving "send to nobody"', () => {
    const routing = readEmailRouting(bot);
    const patch = toBotPatch({ ...routing, recipients: ['a@b.com'] });
    expect(patch.notification_emails).toEqual({ default: ['a@b.com'] });

    const withOverride = toBotPatch({
      ...routing,
      recipients: ['a@b.com'],
      qualifiedLead: ['sales@b.com'],
    });
    expect(withOverride.notification_emails).toEqual({
      default: ['a@b.com'],
      qualified_lead: ['sales@b.com'],
    });
  });

  it('reports a change only when the saved shape would differ', () => {
    const routing = readEmailRouting(bot);
    expect(routingChanged(routing, { ...routing })).toBe(false);
    expect(routingChanged(routing, { ...routing, onOffline: false })).toBe(true);
  });

  it('refuses a booking link from the wrong provider', () => {
    const calendly = MEETING_PROVIDERS[0];
    const zcal = MEETING_PROVIDERS[1];
    expect(validateMeetingUrl(calendly, 'https://calendly.com/me/30min')).toBeNull();
    expect(validateMeetingUrl(zcal, 'https://calendly.com/me/30min')).toContain('Zcal');
    expect(validateMeetingUrl(calendly, '')).toContain('Calendly');
    expect(validateMeetingUrl(calendly, 'http://calendly.com/me')).toContain('https');
  });
});
