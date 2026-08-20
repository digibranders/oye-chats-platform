import type { BadgeTone } from '../../ui';

/**
 * What a workspace role actually means, in one place.
 *
 * The console this replaces offered a role `<select>` with three bare words in
 * it — "Operator", "Admin", "Owner" — and no confirmation of any kind. Someone
 * could be promoted from Operator to Owner by a mis-click on a native dropdown,
 * and nothing on the screen said what that changed. "Admin" alone is not
 * informative: the person choosing it is deciding whether a teammate can remove
 * other teammates and rotate the workspace's API key, and they deserve to be
 * told that at the moment they choose, not afterwards.
 *
 * Every capability listed here is checked against the backend it describes:
 * `_require_team_management_access` and `_prevent_role_escalation` in
 * `api/app/api/operator_routes.py`, which is what actually enforces them.
 */

export type WorkspaceRole = 'owner' | 'admin' | 'operator';

export interface RoleDefinition {
  value: WorkspaceRole;
  label: string;
  /** One line, for a picker option and a table cell. */
  summary: string;
  /** What this role can do that the one below it cannot. Shown while choosing. */
  can: readonly string[];
  tone: BadgeTone;
}

export const ROLES: readonly RoleDefinition[] = [
  {
    value: 'operator',
    label: 'Operator',
    summary: 'Answers conversations. Cannot change how the workspace is set up.',
    can: [
      'Answer live chats and take conversations over from the chatbot',
      'See leads and visitor details',
    ],
    tone: 'neutral',
  },
  {
    value: 'admin',
    label: 'Admin',
    summary: 'Everything an operator can do, plus managing the team and the chatbots.',
    can: [
      'Everything an operator can do',
      'Invite, edit and remove teammates — but cannot make anyone an owner',
      'Change chatbot settings, knowledge and deployment',
    ],
    // Ink, not neutral. Admin and Operator both rendered `neutral`, so the Role
    // column could not distinguish the two roles that differ most — an admin can
    // remove teammates and an operator cannot — and colour was carrying no
    // signal for two of the three values.
    tone: 'ink',
  },
  {
    value: 'owner',
    label: 'Owner',
    summary: 'Full control, including billing and the workspace API key.',
    can: [
      'Everything an admin can do',
      'Promote anyone else to owner',
      'Change the plan, the payment method and the billing details',
      'Rotate the workspace API key',
    ],
    tone: 'plan',
  },
];

const BY_VALUE = new Map(ROLES.map((role) => [role.value, role]));

/** The definition for a role string, or `null` for a value the backend added later. */
export function roleDefinition(role: string | null | undefined): RoleDefinition | null {
  return role ? (BY_VALUE.get(role as WorkspaceRole) ?? null) : null;
}

export function roleLabel(role: string | null | undefined): string {
  return roleDefinition(role)?.label ?? 'Member';
}

export function roleTone(role: string | null | undefined): BadgeTone {
  return roleDefinition(role)?.tone ?? 'neutral';
}

/**
 * Which roles the caller may hand out.
 *
 * Mirrors `_prevent_role_escalation`: only a workspace owner (a client
 * identity, or an operator whose own role is `owner`) may assign `owner`. An
 * admin offering an Owner option they cannot use would be a control that
 * always 403s, which is worse than one that is not there.
 */
export function assignableRoles(callerRole: string | null | undefined): RoleDefinition[] {
  const canGrantOwner = callerRole == null || callerRole === 'owner';
  return ROLES.filter((role) => role.value !== 'owner' || canGrantOwner);
}

/**
 * Whether the caller may manage the team at all.
 *
 * `null` is the solo-owner case: a client identity that has never been given a
 * seat role still owns the workspace. Treating an absent role as "operator"
 * locked the only person in a one-person workspace out of their own team page.
 */
export function canManageTeam(callerRole: string | null | undefined): boolean {
  return callerRole !== 'operator';
}

/**
 * What changing a role does, phrased as a consequence rather than a value.
 *
 * Used verbatim as the confirmation body, so the sentence the user reads before
 * confirming is generated from the same table the picker was generated from and
 * cannot drift from it.
 */
export function roleChangeConsequence(
  name: string,
  from: string | null | undefined,
  to: WorkspaceRole,
): string {
  const target = roleDefinition(to);
  if (!target) return `${name} will be given the ${to} role.`;
  if (to === 'owner') {
    return `${name} will become an owner. Owners can change your plan, your payment method and your billing details, rotate the workspace API key, and make other people owners — including removing your own access. This cannot be undone by ${name}'s own account.`;
  }
  if (from === 'owner') {
    return `${name} will lose owner access: no more billing, no more API key rotation, and they will no longer be able to promote anyone. ${target.summary}`;
  }
  if (to === 'admin') {
    return `${name} will be able to invite, edit and remove teammates, and to change every chatbot's settings and knowledge. They still cannot touch billing or the API key.`;
  }
  return `${name} will keep answering conversations but will no longer be able to manage the team or change chatbot settings.`;
}

/**
 * Routing capacity, validated.
 *
 * The field is a text input, so clearing it yields `''` — and `Number('')` is
 * `0`, an operator who can never be handed a live chat. The backend accepts
 * 1..100 (`UpdateOperatorRequest.max_concurrent_chats`); this is the same range
 * so a valid form can never be rejected by the server.
 */
export const MAX_CONCURRENT_CHATS_MIN = 1;
export const MAX_CONCURRENT_CHATS_MAX = 100;

export function validateConcurrentChats(raw: string): { value: number | null; error: string | null } {
  const trimmed = raw.trim();
  if (!trimmed) return { value: null, error: 'Enter how many chats they can handle at once.' };
  if (!/^\d+$/.test(trimmed)) return { value: null, error: 'Use a whole number.' };
  const value = Number.parseInt(trimmed, 10);
  if (value < MAX_CONCURRENT_CHATS_MIN || value > MAX_CONCURRENT_CHATS_MAX) {
    return {
      value: null,
      error: `Choose between ${MAX_CONCURRENT_CHATS_MIN} and ${MAX_CONCURRENT_CHATS_MAX}.`,
    };
  }
  return { value, error: null };
}
